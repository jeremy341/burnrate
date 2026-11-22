//! Provider list and the generic CLI sign-in flow routes (docs/CONTRACTS.md section 15).
//!
//! `GET  /api/providers` is served from `provider_list` (lib.rs delegates to it).
//! `POST /api/accounts/<providerId>/login/start`      body `{name?, force?}` -> `{flowId}`
//! `GET  /api/accounts/flows/<flowId>`                -> `{state, url?, error?, providerId}`
//! `POST /api/accounts/flows/<flowId>/code`           body `{code}`
//! `DELETE /api/accounts/flows/<flowId>`
//! The older `/api/accounts/claude/*` routes stay in lib.rs and call the same runner.
use super::Resp;
use crate::accounts::{self, StartError, SubmitError};
use crate::providers::{self, Auth, Category, Provider};
use crate::readers;
use crate::{json_response, State};
use serde_json::{json, Value};
use tiny_http::{Method, Request};

/// Account names that are new or hold a different key after an import. Names only: a secret never
/// leaves the key store through this response.
fn imported_names(before: &[(String, String)], after: &[(String, String)]) -> Vec<String> {
    let mut names: Vec<String> = after.iter().filter(|pair| !before.contains(pair)).map(|(name, _)| name.clone()).collect();
    names.sort();
    names
}

/// Folders the user listed for this provider in Settings (`providers.sources`), each with whether it exists,
/// so a mistyped path shows up in the UI instead of silently reading nothing. Paths only; no file is read.
fn source_status(paths: &[std::path::PathBuf]) -> Vec<Value> {
    paths.iter().map(|p| json!({"path": p.to_string_lossy(), "found": p.is_dir()})).collect()
}

/// Which `providers.sources` list feeds a provider, if any. `claude` and `vibe` feed the
/// `claudeAgent` and `mistral` providers; the file-based agents use their own reader id, and the
/// OpenCode Go definition folds the `opencode` reader in.
fn source_key(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "claudeAgent" => Some("claude"),
        "mistral" => Some("vibe"),
        "opencode-go" => Some("opencode"),
        id => readers::sources::SOURCE_IDS.iter().find(|s| **s == id).copied(),
    }
}

fn error(status: u16, code: &str) -> Resp {
    json_response(status, &json!({"error": code}))
}

/// HTTP status and body for a failed start. `cli-not-found` carries the install page so the UI can
/// link to it without knowing every agent.
fn start_error(provider_id: &str, e: StartError) -> (u16, Value) {
    match e {
        StartError::AlreadyConnected => (400, json!({"error": "already-connected"})),
        StartError::InvalidName => (400, json!({"error": "invalid-name"})),
        StartError::CliNotFound => {
            let mut body = json!({"error": "cli-not-found"});
            if let Some(spec) = accounts::spec_for(provider_id) {
                body["installUrl"] = json!(spec.install_url);
                body["command"] = json!(spec.display);
            }
            (400, body)
        }
        StartError::AlreadyRunning => (409, json!({"error": "already-running"})),
        StartError::TooManyFlows => (429, json!({"error": "too-many-flows"})),
        StartError::NotSupported => (400, json!({"error": "login-not-supported"})),
        StartError::SpawnFailed => (500, json!({"error": "sign-in-failed"})),
    }
}

pub fn handle(state: &State, request: &mut Request, method: &Method, path: &str) -> Option<Resp> {
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if parts.len() < 4 || parts[0] != "api" || parts[1] != "accounts" {
        return None;
    }
    // POST /api/accounts/<providerId>/login/start
    if parts.len() == 5 && parts[3] == "login" && parts[4] == "start" && *method == Method::Post {
        let provider_id = parts[2];
        if !state.providers.iter().any(|p| p.id() == provider_id) {
            return Some(error(404, "unknown provider"));
        }
        let Some(body) = crate::read_body(request) else { return Some(error(400, "invalid body")) };
        let name = body.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty());
        let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
        return Some(match accounts::start_login(provider_id, name, force) {
            Ok(flow_id) => json_response(200, &json!({"flowId": flow_id})),
            Err(e) => {
                let (status, body) = start_error(provider_id, e);
                json_response(status, &body)
            }
        });
    }
    // POST /api/accounts/mistral/import-local: copy the key Mistral Vibe already holds (explicit click only).
    if parts.len() == 4 && parts[2] == "mistral" && parts[3] == "import-local" && *method == Method::Post {
        let before = state.keys.list("mistral");
        return Some(match providers::import_mistral_from_vibe(&state.keys) {
            Ok(source) => json_response(200, &json!({"ok": true, "source": source, "imported": imported_names(&before, &state.keys.list("mistral"))})),
            Err(providers::VibeImportError::NoKey) => error(404, "no-local-key"),
            Err(providers::VibeImportError::Rejected(message)) => json_response(400, &json!({"error": format!("Mistral did not accept the key Vibe holds ({message}).")})),
        });
    }
    // POST /api/accounts/opencode-go/import-local: opt in to reading the Go key OpenCode already holds
    // (explicit click only), then prove it works by reading the usage once.
    if parts.len() == 4 && parts[2] == "opencode-go" && parts[3] == "import-local" && *method == Method::Post {
        return Some(enable_opencode_go_local(state));
    }
    // POST /api/accounts/opencode-go/disconnect: stop reading the Go key OpenCode holds (turns the opt-in off).
    // OpenCode's own files and a Go key saved in Burnrate are not touched.
    if parts.len() == 4 && parts[2] == "opencode-go" && parts[3] == "disconnect" && *method == Method::Post {
        let _ = state.settings.patch(&json!({"advanced": {"experimental": {"opencodeGoLocalCredentials": false}}}));
        return Some(json_response(200, &json!({"ok": true})));
    }
    // POST /api/accounts/codex/signout: sign the Codex CLI out (deletes its auth.json, like `codex logout`).
    // The UI asks for an explicit confirmation that names the file before calling this.
    if parts.len() == 4 && parts[2] == "codex" && parts[3] == "signout" && *method == Method::Post {
        return Some(match accounts::codex_signout() {
            Ok(()) => json_response(200, &json!({"ok": true})),
            Err(accounts::CodexSignoutError::NoLogin) => error(404, "no-login"),
            Err(accounts::CodexSignoutError::Failed) => error(500, "sign-out-failed"),
        });
    }
    // POST /api/accounts/<providerId>/open-folder: opens a local-log provider's own data folder in
    // the OS file manager. The server resolves the folder itself (a folder its reader already
    // looks in), no path is taken from the request, and only loopback callers may ask.
    if parts.len() == 4 && parts[3] == "open-folder" && *method == Method::Post {
        if !request.remote_addr().is_some_and(|addr| addr.ip().is_loopback()) {
            return Some(error(403, "loopback only"));
        }
        return Some(match state.providers.iter().find(|p| p.id() == parts[2]).and_then(|p| p.local_stats()) {
            Some(stats) => match crate::diagnostics::open_in_file_manager(&stats.folder) {
                Ok(()) => json_response(200, &json!({"ok": true, "folder": stats.folder.to_string_lossy()})),
                Err(_) => error(500, "could not open data folder"),
            },
            None => error(404, "no-local-data-folder"),
        });
    }
    if parts[2] != "flows" {
        return None;
    }
    let id = parts[3];
    match (method, parts.len()) {
        (Method::Get, 4) => Some(match accounts::status(id) {
            Some(flow) => json_response(200, &flow),
            None => error(404, "unknown flow"),
        }),
        (Method::Delete, 4) => Some(if accounts::cancel(id) { json_response(200, &json!({"ok": true})) } else { error(404, "unknown flow") }),
        (Method::Post, 5) if parts[4] == "code" => {
            let Some(body) = crate::read_body(request) else { return Some(error(400, "invalid code")) };
            let code = body.get("code").and_then(Value::as_str).unwrap_or("");
            Some(match accounts::submit_code(id, code) {
                Ok(()) => json_response(200, &json!({"ok": true})),
                Err(SubmitError::InvalidCode) => error(400, "invalid code"),
                Err(SubmitError::UnknownFlow) => error(404, "unknown flow"),
                Err(SubmitError::TerminalPhase) | Err(SubmitError::NoStdin) => error(409, "flow-ended"),
            })
        }
        _ => None,
    }
}

// ---------------------------------------------------------------- GET /api/providers

const DETECTED: &str = "Detected on this computer";

fn category_rank(c: Category) -> u8 {
    match c {
        Category::Agent => 0,
        Category::ApiKey => 1,
        Category::LocalLogs => 2,
        Category::Admin => 3,
    }
}

struct Entry {
    category: Category,
    value: Value,
}

/// The one account the Codex row lists: the ChatGPT login the Codex CLI holds. Its discovered
/// label is the signed-in e-mail where the local token carries one; `nicknames::apply` in
/// `base_entry` then puts the user's nickname for it on top (`codex/chatgpt-login`).
fn codex_accounts(login_present: bool) -> Vec<Value> {
    if !login_present {
        return Vec::new();
    }
    vec![json!({"id": "chatgpt-login", "label": crate::providers::codex::chatgpt_label()})]
}

fn base_entry(state: &State, p: &dyn Provider) -> (Vec<Value>, bool) {
    let names = if p.auth() == Auth::ApiKey { state.keys.names(p.id()) } else { Vec::new() };
    let accounts = if p.auth() == Auth::LocalLogin {
        if p.id() == "claudeAgent" {
            accounts::claude_accounts()
        } else if p.id() == "codex" {
            codex_accounts(p.has_login())
        } else {
            Vec::new()
        }
    } else {
        names.iter().map(|n| json!({"id": n, "label": n})).collect::<Vec<_>>()
    };
    let mut accounts = accounts;
    crate::nicknames::apply(&mut accounts, Some(p.id()));
    let connected = if p.auth() == Auth::ApiKey {
        !names.is_empty()
    } else if p.id() == "claudeAgent" {
        // A freshly signed-in account can exist in a config dir before the CLI's
        // own login marker is present, so either signal is enough.
        !accounts.is_empty() || p.has_login()
    } else {
        p.has_login()
    };
    (accounts, connected)
}

fn entry_for(state: &State, p: &dyn Provider, local_go_connected: Option<bool>) -> Entry {
    let (accounts, mut connected) = base_entry(state, p);
    let mut detected = connected && p.auth() != Auth::ApiKey;
    // A provider connected through a saved key needs no "paste a key" prompt.
    let mut hint = if detected {
        DETECTED.to_string()
    } else if connected && p.auth() == Auth::ApiKey {
        String::new()
    } else {
        p.hint().to_string()
    };
    if let Some(has_key) = local_go_connected {
        detected = has_key;
        connected = connected || has_key;
        hint = if has_key {
            DETECTED.into()
        } else if !accounts.is_empty() {
            "Using the key you saved".into()
        } else {
            "Paste your Go key, or sign in to OpenCode".into()
        };
    }
    // A Mistral Vibe install means the key may already be on this computer: offer a one-click import.
    // It stays on offer after one key is saved while another Vibe profile (for example `~/.vibe2`) still
    // holds a key that has not been imported. Only file existence is checked here, never a secret.
    let vibe_import = p.id() == "mistral"
        && if connected {
            !readers::vibe::unimported_accounts(&accounts.iter().filter_map(|a| a["id"].as_str().map(str::to_string)).collect::<Vec<_>>()).is_empty()
        } else {
            providers::vibe_present()
        };
    if vibe_import && !connected {
        hint = "Mistral Vibe found. Import its key in one click".into();
    }
    let mut value = json!({
        "id": p.id(), "label": p.label(), "color": p.color(), "auth": p.auth().as_str(), "connected": connected,
        "accounts": accounts,
        "accountsRenamable": p.auth() == Auth::ApiKey,
        "category": p.category().as_str(),
        "login": accounts::login_info(p.id()),
        "detected": detected,
    });
    if !hint.is_empty() {
        value["hint"] = json!(hint);
    }
    if let Some(url) = p.key_url() {
        value["keyUrl"] = json!(url);
    }
    if p.custom() {
        value["custom"] = json!(true);
    }
    if vibe_import {
        value["localImport"] = json!({"source": "Mistral Vibe"});
    }
    if let Some(key) = source_key(p.id()) {
        let configured = source_status(&readers::sources::configured(key));
        if !configured.is_empty() {
            value["sources"] = Value::Array(configured);
        }
    }
    // Local-log providers that Burnrate can count (Pi, Muse) also say what their files measured.
    if let Some(stats) = p.local_stats() {
        value["stats"] = stats.json();
    }
    Entry { category: p.category(), value }
}

/// Every provider the server can read, grouped agents -> API keys -> local logs -> admin (stable
/// within a group). OpenCode appears once: when the `opencode-go` definition is enabled it carries
/// the Go key store and the native `opencode` reader is folded into it.
pub fn provider_list(state: &State) -> Value {
    build_list_with(state, providers::opencode_go_key_present, providers::opencode_local_install_present)
}

/// Turns the opt-in on, then reads the Go usage once so the answer is real. Any failure puts the
/// opt-in back, so a failed attempt leaves nothing enabled behind.
fn enable_opencode_go_local(state: &State) -> Resp {
    let set = |on: bool| {
        let _ = state.settings.patch(&json!({"advanced": {"experimental": {"opencodeGoLocalCredentials": on}}}));
    };
    // A Go key already saved in Burnrate owns the quota and the native reader stays out of the way,
    // so opting in would only read back nothing. Say that, rather than "no Go plan" or "no key found".
    if !state.keys.list("opencode-go").is_empty() {
        return json_response(400, &json!({"error": "Burnrate already reads the Go key you pasted, so OpenCode's login is not needed."}));
    }
    if !providers::opencode_go_key_present() {
        return error(404, "no-local-key");
    }
    set(true);
    let reader = state.providers.iter().find(|p| p.id() == "opencode");
    let accounts = reader.map(|p| p.read(&state.keys)).unwrap_or_default();
    match go_connect_outcome(&accounts) {
        Ok(summary) => json_response(200, &json!({"ok": true, "source": "OpenCode", "summary": summary})),
        Err(message) => {
            set(false);
            json_response(400, &json!({"error": message}))
        }
    }
}

/// `Ok("Go session 0% used")` when the key read a Go plan; otherwise the reason, in plain words.
fn go_connect_outcome(accounts: &[Value]) -> Result<String, String> {
    let Some(account) = accounts.first() else {
        return Err("OpenCode holds a key, but it has no Go plan or Go refused it. Paste a Go key instead.".into());
    };
    let limits = &account["limits"];
    if let Some(message) = limits["unavailable"]["message"].as_str() {
        return Err(format!("{message} Try again, or paste a Go key instead."));
    }
    let windows = limits["windows"].as_array().cloned().unwrap_or_default();
    let first = windows
        .iter()
        .find(|w| w["id"] == "go_rolling")
        .or_else(|| windows.first())
        .ok_or_else(|| "OpenCode's key returned no Go usage. Paste a Go key instead.".to_string())?;
    let label = first["label"].as_str().unwrap_or("Go").trim_start_matches("Go · ").to_lowercase();
    let used = first["usedPercent"].as_f64().unwrap_or(0.0).round() as i64;
    Ok(format!("Go {label} {used}% used"))
}

#[cfg(test)]
fn build_list(state: &State, go_key_present: impl FnOnce() -> bool) -> Value {
    build_list_with(state, go_key_present, || false)
}

#[cfg(test)]
mod codex_row_tests {
    use super::*;

    /// The Codex row lists the ChatGPT login only when it really exists, under the id the
    /// nickname route and the limits report both use. The discovered label is the e-mail when
    /// the local token says one, never a secret from it.
    #[test]
    fn the_row_shows_one_chatgpt_login_only_when_signed_in() {
        assert!(codex_accounts(false).is_empty(), "signed out: no account to manage");
        let accounts = codex_accounts(true);
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0]["id"], "chatgpt-login");
        let label = accounts[0]["label"].as_str().unwrap();
        assert!(!label.is_empty(), "always a label: the e-mail or the plain words");
    }
}

fn build_list_with(
    state: &State,
    go_key_present: impl FnOnce() -> bool,
    local_install: impl FnOnce() -> bool,
) -> Value {
    let go_def = state.providers.iter().any(|p| p.id() == "opencode-go");
    let opted_in = crate::defs::experimental_enabled("opencodeGoLocalCredentials", &state.settings.raw());
    // Before the opt-in nothing is read: only whether OpenCode left files here decides if the
    // one-click "use my local login" is offered. A Go key saved in Burnrate already owns the quota,
    // so there is nothing to import while it is saved.
    let saved_go_key = !state.keys.list("opencode-go").is_empty();
    let offer_local = !opted_in && !saved_go_key && local_install();
    let local_go_connected = opted_in && go_key_present();
    let mut entries: Vec<Entry> = Vec::new();
    for p in &state.providers {
        match p.id() {
            "opencode" if go_def => continue,
            "opencode-go" | "opencode" => {
                let mut entry = entry_for(state, p.as_ref(), Some(local_go_connected));
                if offer_local && p.id() == "opencode-go" {
                    entry.value["localImport"] = json!({"source": "OpenCode"});
                    if entry.value["connected"] != true {
                        entry.value["hint"] = json!("OpenCode found. Use its Go key in one click");
                    }
                }
                entries.push(entry);
            }
            _ => entries.push(entry_for(state, p.as_ref(), None)),
        }
    }
    // `sort_by_key` is stable: provider order inside a group is the order of `providers::all()`.
    entries.sort_by_key(|e| category_rank(e.category));
    Value::Array(entries.into_iter().map(|e| e.value).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;
    use crate::keys::KeyStore;
    use crate::settings::SettingsStore;

    fn test_state(tag: &str) -> (State, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("burnrate-providers-{tag}-{}-{}", std::process::id(), providers::iso_now().replace([':', '.'], "")));
        std::fs::create_dir_all(&dir).unwrap();
        let state = State {
            port: 0,
            web_dir: dir.clone(),
            keys: KeyStore::open(&dir),
            settings: SettingsStore::open(&dir),
            engine: Engine::new(dir.clone()),
            providers: providers::all(),
        };
        (state, dir)
    }

    fn find<'a>(list: &'a Value, id: &str) -> Option<&'a Value> {
        list.as_array()?.iter().find(|p| p["id"] == id)
    }

    #[test]
    fn configured_source_folders_report_whether_they_exist() {
        let dir = std::env::temp_dir().join(format!("burnrate-sources-status-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("nope");
        let status = source_status(&[dir.clone(), missing.clone()]);
        assert_eq!(status[0], json!({"path": dir.to_string_lossy(), "found": true}));
        assert_eq!(status[1], json!({"path": missing.to_string_lossy(), "found": false}));
        assert!(source_status(&[]).is_empty(), "nothing configured, nothing reported");
        assert_eq!((source_key("claudeAgent"), source_key("mistral"), source_key("opencode-go")), (Some("claude"), Some("vibe"), Some("opencode")));
        // The file-based agents map to their reader ids; an unrelated provider has no source.
        for id in ["codex", "opencode", "antigravity", "gemini", "copilot", "grok", "pi", "muse", "qwen", "goose", "crush"] {
            assert_eq!(source_key(id), Some(id), "{id} is its own source key");
        }
        assert_eq!(source_key("cursor"), None, "Cursor keeps no local files Burnrate reads");
        assert_eq!(source_key("nope"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn imported_names_lists_new_and_refreshed_accounts_without_keys() {
        let before = vec![("Vibe".to_string(), "k1".to_string()), ("Work".to_string(), "k2".to_string())];
        let after = vec![("Vibe".to_string(), "k1".to_string()), ("Work".to_string(), "k2-rotated".to_string()), ("Vibe 2".to_string(), "k3".to_string())];
        assert_eq!(imported_names(&before, &after), vec!["Vibe 2".to_string(), "Work".to_string()]);
        assert!(imported_names(&after, &after).is_empty(), "importing again adds nothing");
    }

    #[test]
    fn every_provider_has_a_category_and_a_login_field() {
        let (state, dir) = test_state("meta");
        let list = provider_list(&state);
        let entries = list.as_array().unwrap();
        assert!(entries.len() > 10);
        for p in entries {
            let category = p["category"].as_str().unwrap_or_else(|| panic!("{} has no category", p["id"]));
            assert!(["agent", "apiKey", "admin", "localLogs"].contains(&category), "{} -> {category}", p["id"]);
            assert!(p.get("login").is_some(), "{} must carry `login` (null when there is none)", p["id"]);
            assert!(p["login"].is_null() || p["login"]["kind"] == "cli");
            assert!(p["connected"].is_boolean() && p["accounts"].is_array() && p["label"].is_string());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agents_come_first_then_keys_then_logs_then_admin() {
        let (state, dir) = test_state("order");
        let list = provider_list(&state);
        let ranks: Vec<u8> = list.as_array().unwrap().iter().map(|p| match p["category"].as_str().unwrap() {
            "agent" => 0,
            "apiKey" => 1,
            "localLogs" => 2,
            _ => 3,
        }).collect();
        assert!(ranks.windows(2).all(|w| w[0] <= w[1]), "not grouped: {ranks:?}");
        let ids: Vec<&str> = list.as_array().unwrap().iter().filter(|p| p["category"] == "agent").filter_map(|p| p["id"].as_str()).collect();
        assert_eq!(&ids[..3], &["claudeAgent", "codex", "grok"], "native agents keep their order");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn native_agents_carry_their_login_and_hint() {
        let (state, dir) = test_state("login");
        let list = provider_list(&state);
        for (id, command) in [("claudeAgent", "claude auth login"), ("codex", "codex login"), ("grok", "grok login")] {
            let p = find(&list, id).unwrap_or_else(|| panic!("{id} listed"));
            assert_eq!(p["category"], "agent");
            assert_eq!(p["login"]["command"], command);
            assert!(p["login"]["installed"].is_boolean());
            assert!(p["login"]["installUrl"].as_str().unwrap().starts_with("https://"));
            assert!(p["hint"].as_str().is_some_and(|h| !h.is_empty()));
        }
        // Providers without a documented non-interactive login say so with null and give a key page.
        let cursor = find(&list, "cursor").unwrap();
        assert!(cursor["login"].is_null());
        assert_eq!(cursor["category"], "agent");
        assert!(cursor["keyUrl"].as_str().unwrap().starts_with("https://"));
        let mistral = find(&list, "mistral").unwrap();
        assert_eq!(mistral["category"], "apiKey");
        assert!(mistral["keyUrl"].as_str().unwrap().starts_with("https://"));
        for id in ["antigravity", "pi", "muse"] {
            assert_eq!(find(&list, id).unwrap()["category"], "localLogs");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_log_stats_have_a_public_shape_or_are_absent() {
        let (state, dir) = test_state("stats");
        let list = provider_list(&state);
        let mut seen = 0;
        for p in list.as_array().unwrap() {
            let Some(stats) = p.get("stats") else { continue };
            seen += 1;
            assert_eq!(p["auth"], "localLogs", "only local-log providers carry stats");
            assert!(stats["sessions"].as_u64().is_some(), "sessions is a count");
            assert!(stats["folder"].as_str().is_some_and(|s| !s.is_empty()), "names the folder read");
            assert!(stats.get("lastUsedAt").is_none() || stats["lastUsedAt"].as_str().is_some());
        }
        assert!(seen <= 3, "Pi, Muse and at most one other localLogs entry carry stats");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn admin_definitions_are_admin_and_key_definitions_are_api_keys() {
        let (state, dir) = test_state("defs");
        let list = provider_list(&state);
        for id in ["anthropic-admin", "openai-admin"] {
            // openai-admin is experimental: only listed when enabled, so check the definition itself too.
            if let Some(p) = find(&list, id) {
                assert_eq!(p["category"], "admin", "{id}");
                assert!(p["keyUrl"].as_str().unwrap().starts_with("https://"), "{id}");
                assert!(p["login"].is_null());
            }
        }
        assert_eq!(find(&list, "anthropic-admin").unwrap()["category"], "admin");
        for id in ["openrouter", "deepseek", "moonshot", "ollama"] {
            let p = find(&list, id).unwrap_or_else(|| panic!("{id} listed"));
            assert_eq!(p["category"], "apiKey", "{id}");
            assert!(p["keyUrl"].as_str().unwrap().starts_with("https://"), "{id}");
        }
        let defs = crate::defs::all_definitions();
        for id in ["anthropic-admin", "openai-admin"] {
            let entry = defs.iter().find(|d| d.def.id == id).unwrap();
            assert_eq!(entry.def.category.as_str(), "admin");
        }
        // Admin entries sort after everything else.
        let last = list.as_array().unwrap().last().unwrap();
        assert_eq!(last["category"], "admin");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn opencode_appears_once_with_the_go_key_path() {
        let (state, dir) = test_state("opencode");
        let list = provider_list(&state);
        let ids: Vec<&str> = list.as_array().unwrap().iter().filter_map(|p| p["id"].as_str()).collect();
        assert!(ids.contains(&"opencode-go"), "the Go entry is listed (the definition is enabled by default)");
        assert!(!ids.contains(&"opencode"), "no second OpenCode entry for the same quota");
        let go = find(&list, "opencode-go").unwrap();
        assert_eq!(go["category"], "agent");
        assert_eq!(go["keyUrl"], "https://opencode.ai/auth");
        assert_eq!(go["auth"], "apiKey", "keys are pasted through /api/providers/opencode-go/keys");
        assert!(go["login"].is_null());
        assert!(go["hint"].is_string());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_saved_go_key_connects_the_entry_and_is_not_read_twice() {
        let (state, dir) = test_state("gokey");
        state.keys.set("opencode-go", "work", "throwaway-key-for-tests");
        let list = build_list(&state, || panic!("a saved key does not opt in to local discovery"));
        let go = find(&list, "opencode-go").unwrap();
        assert_eq!(go["connected"], true);
        assert_eq!(go["accounts"][0]["id"], "work");
        assert_eq!(go["hint"], "Using the key you saved", "a pasted key is not 'detected'");
        assert_eq!(go["detected"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_saved_go_keys_pool_under_one_opencode_go_entry() {
        let (state, dir) = test_state("two-go-keys");
        state.keys.set("opencode-go", "work", "throwaway-key-for-tests-1");
        state.keys.set("opencode-go", "home", "throwaway-key-for-tests-2");
        let list = build_list(&state, || panic!("saved keys do not opt in to local discovery"));
        let entries: Vec<&Value> = list.as_array().unwrap().iter().filter(|p| p["id"] == "opencode-go").collect();
        assert_eq!(entries.len(), 1, "one OpenCode Go entry, however many keys are saved");
        assert!(find(&list, "opencode").is_none(), "no OpenCode entry beside it");
        let mut names: Vec<&str> = entries[0]["accounts"].as_array().unwrap().iter().filter_map(|a| a["id"].as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["home", "work"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_saved_go_key_is_not_offered_the_local_login_again() {
        let (state, dir) = test_state("saved-no-offer");
        state.keys.set("opencode-go", "work", "throwaway-key-for-tests");
        let list = build_list_with(&state, || false, || true);
        let go = find(&list, "opencode-go").unwrap();
        assert!(go.get("localImport").is_none(), "the pasted key already owns the quota: nothing to import");
        // Control: with no key saved, OpenCode's own login is offered.
        let (bare, bare_dir) = test_state("no-saved-offer");
        let offered = build_list_with(&bare, || false, || true);
        assert_eq!(find(&offered, "opencode-go").unwrap()["localImport"]["source"], "OpenCode");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&bare_dir);
    }

    #[test]
    fn importing_the_local_login_is_refused_while_a_saved_go_key_covers_the_quota() {
        use std::io::Read;
        let (state, dir) = test_state("import-refused");
        state.keys.set("opencode-go", "work", "throwaway-key-for-tests");
        let resp = enable_opencode_go_local(&state);
        assert_eq!(resp.status_code().0, 400);
        let mut body = String::new();
        resp.into_reader().read_to_string(&mut body).unwrap();
        assert!(body.contains("already reads the Go key you pasted"), "a clear refusal, not 'no Go plan': {body}");
        assert!(!crate::defs::experimental_enabled("opencodeGoLocalCredentials", &state.settings.raw()), "nothing was opted in");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_opencode_credentials_do_not_connect_by_default() {
        let (state, dir) = test_state("octl");
        let list = build_list(&state, || panic!("local credentials must not be read before opt-in"));
        let go = find(&list, "opencode-go").unwrap();
        assert_eq!(go["connected"], false);
        assert_eq!(go["detected"], false);
        assert_eq!(go["accounts"], json!([]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn explicit_opencode_connection_requires_a_local_key() {
        let (mut state, dir) = test_state("oc-connect");
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        state.port = addr.port();
        std::thread::scope(|scope| {
            let state = &state;
            scope.spawn(|| {
                let mut request = server.recv_timeout(std::time::Duration::from_secs(5)).unwrap().unwrap();
                let response = crate::handle_api(state, &mut request, "/api/settings");
                request.respond(response).unwrap();
            });
            let client = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(5)).try_proxy_from_env(false).build();
            let response = client.patch(&format!("http://{addr}/api/settings"))
                .set("X-Burnrate", "1")
                .send_json(json!({"patch": {"advanced": {"experimental": {"opencodeGoLocalCredentials": true}}}}))
                .unwrap();
            assert_eq!(response.status(), 200);
        });
        state.settings = SettingsStore::open(&dir);
        let list = build_list(&state, || true);
        let go = find(&list, "opencode-go").unwrap();
        assert_eq!(go["connected"], true);
        assert_eq!(go["detected"], true);
        assert_eq!(go["accounts"], json!([]));

        let list = build_list(&state, || false);
        let go = find(&list, "opencode-go").unwrap();
        assert_eq!(go["connected"], false);
        assert_eq!(go["detected"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_opencode_login_is_offered_before_opt_in_without_reading_any_key() {
        let (state, dir) = test_state("oc-offer");
        let list = build_list_with(&state, || panic!("no credential may be read before opt-in"), || true);
        let go = find(&list, "opencode-go").unwrap();
        assert_eq!(go["localImport"], json!({"source": "OpenCode"}));
        assert_eq!(go["connected"], false);
        assert_eq!(go["hint"], "OpenCode found. Use its Go key in one click");
        let list = build_list_with(&state, || panic!("not read"), || false);
        assert!(find(&list, "opencode-go").unwrap().get("localImport").is_none(), "nothing local, nothing offered");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn go_connect_outcome_reports_real_usage_or_the_real_reason() {
        let ok = json!([{ "limits": { "windows": [
            {"id": "go_weekly", "label": "Go · Weekly", "usedPercent": 3.0},
            {"id": "go_rolling", "label": "Go · Session", "usedPercent": 0.0}
        ]}}]);
        assert_eq!(go_connect_outcome(ok.as_array().unwrap()), Ok("Go session 0% used".to_string()));
        assert!(go_connect_outcome(&[]).unwrap_err().contains("Paste a Go key"));
        let failed = json!([{ "limits": { "windows": [], "unavailable": {"message": "OpenCode Go could not read usage (HTTP 500)."}}}]);
        let message = go_connect_outcome(failed.as_array().unwrap()).unwrap_err();
        assert!(message.contains("HTTP 500") && message.contains("Try again"));
    }

    #[test]
    fn start_errors_map_to_the_contract_codes() {
        assert_eq!(start_error("codex", StartError::AlreadyConnected), (400, json!({"error": "already-connected"})));
        assert_eq!(start_error("codex", StartError::InvalidName), (400, json!({"error": "invalid-name"})));
        assert_eq!(start_error("codex", StartError::AlreadyRunning).0, 409);
        assert_eq!(start_error("codex", StartError::TooManyFlows).0, 429);
        assert_eq!(start_error("cursor", StartError::NotSupported), (400, json!({"error": "login-not-supported"})));
        let (status, body) = start_error("codex", StartError::CliNotFound);
        assert_eq!(status, 400);
        assert_eq!(body["error"], "cli-not-found");
        assert_eq!(body["command"], "codex login");
        assert!(body["installUrl"].as_str().unwrap().starts_with("https://"));
    }
}
