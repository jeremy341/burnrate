mod accounts;
mod alerts;
mod budgets;
mod defs;
mod diagnostics;
mod history;
mod hub;
mod scheduler;
mod themes;
pub mod net_guard;
mod engine;
mod keys;
mod nicknames;
mod pricing;
mod providers;
mod readers;
mod routes;
mod settings;
mod store;
mod types;

use engine::{Engine, SummaryInput};
use keys::KeyStore;
use providers::Provider;
use serde_json::{json, Value};
use settings::SettingsStore;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

pub(crate) struct State {
    port: u16,
    web_dir: PathBuf,
    keys: KeyStore,
    settings: SettingsStore,
    engine: Engine,
    providers: Vec<Box<dyn Provider>>,
}

fn json_response(status: u16, body: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(serde_json::to_vec(body).unwrap_or_default())
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
        .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap())
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("json") => "application/json",
        Some("woff2") => "font/woff2",
        Some("webmanifest") => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query(url: &str) -> std::collections::HashMap<String, String> {
    url.split_once('?')
        .map(|(_, q)| q.split('&').filter_map(|p| p.split_once('=')).map(|(k, v)| (percent_decode(k), percent_decode(v))).collect())
        .unwrap_or_default()
}

fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.ends_with('.')
        && !s.bytes().all(|c| c == b'.')
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}

/// `GET /api/providers`: id, label, color, auth, connected, accounts plus `category`, `login`,
/// `keyUrl`, `hint`, `detected` (docs/CONTRACTS.md section 15). Built in `routes/accounts_api.rs`.
fn provider_info(state: &State) -> Value {
    routes::provider_list(state)
}

/// Reads every provider's limits at once: each is a network call.
fn limits_report(state: &State) -> Value {
    let results: Vec<Vec<Value>> = std::thread::scope(|scope| {
        let handles: Vec<_> = state.providers.iter().map(|p| scope.spawn(|| p.read(&state.keys))).collect();
        handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    });
    let mut accounts: Vec<Value> = Vec::new();
    let mut notices: Vec<String> = Vec::new();
    for batch in results {
        accounts.extend(batch);
    }
    accounts.extend(budgets::accounts(state));
    nicknames::apply(&mut accounts, None);
    for a in &accounts {
        if let Some(message) = a.pointer("/limits/unavailable/message").and_then(Value::as_str) {
            let name = a.get("displayName").or_else(|| a.get("label")).and_then(Value::as_str).unwrap_or("");
            notices.push(format!("{name}: {message}"));
        }
    }
    let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "this computer".into());
    json!({"createdAt": providers::iso_now(), "hostLabel": host, "accounts": accounts, "notices": notices})
}

fn read_body(request: &mut Request) -> Option<Value> {
    let mut body = Vec::new();
    request.as_reader().take(16_385).read_to_end(&mut body).ok()?;
    if body.len() > 16_384 {
        return None;
    }
    if body.is_empty() {
        return Some(json!({}));
    }
    serde_json::from_slice(&body).ok()
}

fn handle_api(state: &State, request: &mut Request, path: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let method = request.method().clone();
    if method != Method::Get {
        // Cross-site pages cannot send this header without a CORS preflight, which is never granted.
        let has_header = request.headers().iter().any(|h| h.field.equiv("X-Burnrate") && h.value.as_str() == "1");
        if !has_header {
            return json_response(403, &json!({"error": "forbidden"}));
        }
        if let Some(origin) = request.headers().iter().find(|h| h.field.equiv("Origin")).map(|h| h.value.as_str().to_string()) {
            let host = origin.split("://").nth(1).unwrap_or("");
            if host != format!("127.0.0.1:{}", state.port) && host != format!("localhost:{}", state.port) {
                return json_response(403, &json!({"error": "forbidden"}));
            }
        }
    }
    let url = request.url().to_string();
    match (&method, path) {
        (Method::Get, "/api/providers") => return json_response(200, &provider_info(state)),
        (Method::Get, "/api/limits") => {
            // A client asking for limits counts as an active consumer for the background scheduler.
            scheduler::note_limits_request();
            return json_response(200, &limits_report(state));
        }
        // Scan progress only (files done / total per provider); cheap enough to poll while the UI shows a scanning line.
        (Method::Get, "/api/usage/progress") => return json_response(200, &state.engine.progress()),
        (Method::Get, "/api/usage") => {
            let q = query(&url);
            let since = q.get("since").cloned().unwrap_or_default();
            let until = q.get("until").cloned().unwrap_or_default();
            if !is_day(&since) || !is_day(&until) {
                return json_response(400, &json!({"error": "invalid window"}));
            }
            let since_time_text = q.get("sinceTime");
            let until_time_text = q.get("untilTime");
            if since_time_text.is_some() != until_time_text.is_some() {
                return json_response(400, &json!({"error": "invalid window"}));
            }
            let since_time = since_time_text.and_then(|t| crate::types::parse_rfc3339_ms(t));
            let until_time = until_time_text.and_then(|t| crate::types::parse_rfc3339_ms(t));
            if (since_time_text.is_some() && since_time.is_none())
                || (until_time_text.is_some() && until_time.is_none())
                || matches!((since_time, until_time), (Some(lo), Some(hi)) if hi <= lo)
            {
                return json_response(400, &json!({"error": "invalid window"}));
            }
            let input = SummaryInput {
                since_day: since,
                until_day: until,
                time_zone: q.get("tz").filter(|t| !t.is_empty()).cloned().unwrap_or_else(|| "UTC".into()),
                hourly: q.get("resolution").is_some_and(|r| r == "hour"),
                since_time,
                until_time,
            };
            return json_response(200, &state.engine.summary(&input, &state.settings.get()));
        }
        _ => {}
    }
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    // Claude account sign-in flows.
    if parts.len() >= 3 && parts[0] == "api" && parts[1] == "accounts" && parts[2] == "claude" {
        if method == Method::Post && parts.len() == 3 {
            let Some(body) = read_body(request) else { return json_response(400, &json!({"error": "invalid-name"})) };
            let name = body.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
            if !accounts::valid_name(name) {
                return json_response(400, &json!({"error": "invalid-name"}));
            }
            return match accounts::start(name) {
                Ok(flow_id) => json_response(200, &json!({"flowId": flow_id})),
                Err(accounts::StartError::AlreadyConnected) => json_response(400, &json!({"error": "already-connected"})),
                Err(accounts::StartError::CliNotFound) => json_response(400, &json!({"error": "claude-not-found"})),
                Err(accounts::StartError::InvalidName) => json_response(400, &json!({"error": "invalid-name"})),
                Err(accounts::StartError::AlreadyRunning) => json_response(409, &json!({"error": "already-running"})),
                Err(accounts::StartError::TooManyFlows) => json_response(429, &json!({"error": "too-many-flows"})),
                Err(_) => json_response(500, &json!({"error": "sign-in-failed"})),
            };
        }
        if method == Method::Get && parts.len() == 4 {
            return match accounts::status(parts[3]) {
                Some(state) => json_response(200, &state),
                None => json_response(404, &json!({"error": "unknown flow"})),
            };
        }
        if method == Method::Post && parts.len() == 5 && parts[4] == "code" {
            let Some(body) = read_body(request) else { return json_response(400, &json!({"error": "invalid code"})) };
            let code = body.get("code").and_then(Value::as_str).unwrap_or("");
            return match accounts::submit_code(parts[3], code) {
                Ok(()) => json_response(200, &json!({"ok": true})),
                Err(accounts::SubmitError::InvalidCode) => json_response(400, &json!({"error": "invalid code"})),
                Err(accounts::SubmitError::UnknownFlow) => json_response(404, &json!({"error": "unknown flow"})),
                Err(accounts::SubmitError::TerminalPhase) | Err(accounts::SubmitError::NoStdin) => json_response(409, &json!({"error": "flow-ended"})),
            };
        }
        if method == Method::Delete && parts.len() == 4 {
            return if accounts::cancel(parts[3]) {
                json_response(200, &json!({"ok": true}))
            } else {
                json_response(404, &json!({"error": "unknown flow"}))
            };
        }
    }
    // /api/providers/claudeAgent/accounts/<id>/signout
    if method == Method::Post && parts.len() == 6 && parts[0] == "api" && parts[1] == "providers" && parts[2] == "claudeAgent" && parts[3] == "accounts" && parts[5] == "signout" {
        return if accounts::claude_signout(parts[4]) {
            json_response(200, &json!({"ok": true}))
        } else {
            json_response(400, &json!({"error": "invalid account"}))
        };
    }
    // PUT /api/providers/<id>/nicknames/<account>  {"name": "..."}: name a discovered account (empty clears it).
    if method == Method::Put && parts.len() == 5 && parts[0] == "api" && parts[1] == "providers" && parts[3] == "nicknames" {
        let Some(provider) = state.providers.iter().find(|p| p.id() == parts[2]) else {
            return json_response(404, &json!({"error": "unknown provider"}));
        };
        if !accounts::valid_name(parts[4]) && parts[4] != "chatgpt-login" {
            return json_response(400, &json!({"error": "invalid-name"}));
        }
        let Some(body) = read_body(request) else { return json_response(400, &json!({"error": "invalid-name"})) };
        let name = body.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
        if !name.is_empty() && !nicknames::valid(name) {
            return json_response(400, &json!({"error": "invalid-name"}));
        }
        return if nicknames::set(provider.id(), parts[4], name) {
            json_response(200, &json!({"ok": true}))
        } else {
            json_response(500, &json!({"error": "sign-in-failed"}))
        };
    }
    // /api/providers/<id>/keys[/<name>]
    if parts.len() >= 4 && parts[0] == "api" && parts[1] == "providers" && parts[3] == "keys" {
        let Some(provider) = state.providers.iter().find(|p| p.id() == parts[2] && p.auth() == providers::Auth::ApiKey) else {
            return json_response(404, &json!({"error": "unknown provider"}));
        };
        // POST /keys/test is a route, not an account name; match it before name-based branches.
        if method == Method::Post && parts.len() == 5 && parts[4] == "test" {
            let Some(body) = read_body(request) else { return json_response(400, &json!({"error": "invalid apiKey"})) };
            let key = body.get("apiKey").and_then(Value::as_str).map(str::trim).unwrap_or("");
            if key.len() < 8 || key.len() > 4096 {
                return json_response(400, &json!({"error": "invalid apiKey"}));
            }
            return match provider.test_key(key) {
                Ok(()) => json_response(200, &json!({"ok": true})),
                Err(error) => json_response(200, &json!({"ok": false, "error": error})),
            };
        }
        if method == Method::Patch && parts.len() == 5 && valid_name(parts[4]) {
            let Some(body) = read_body(request) else { return json_response(400, &json!({"error": "invalid-name"})) };
            let new = body.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
            if !valid_name(new) {
                return json_response(400, &json!({"error": "invalid-name"}));
            }
            return if state.keys.rename(provider.id(), parts[4], new) {
                json_response(200, &json!({"ok": true}))
            } else if state.keys.name_exists(provider.id(), new) {
                json_response(409, &json!({"error": "invalid-name"}))
            } else if !state.keys.name_exists(provider.id(), parts[4]) {
                json_response(404, &json!({"error": "account not found"}))
            } else {
                json_response(500, &json!({"error": "sign-in-failed"}))
            };
        }
        if method == Method::Post && parts.len() == 4 {
            let Some(body) = read_body(request) else { return json_response(400, &json!({"error": "invalid-name"})) };
            let name = body.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
            let key = body.get("apiKey").and_then(Value::as_str).map(str::trim).unwrap_or("");
            if !valid_name(name) {
                return json_response(400, &json!({"error": "invalid-name"}));
            }
            if key.len() < 8 || key.len() > 4096 {
                return json_response(400, &json!({"error": "invalid apiKey"}));
            }
            state.keys.set(provider.id(), name, key);
            return json_response(200, &json!({"ok": true}));
        }
        if method == Method::Delete && parts.len() == 5 && valid_name(parts[4]) {
            state.keys.remove(provider.id(), parts[4]);
            return json_response(200, &json!({"ok": true}));
        }
    }
    // Feature routes: one module per feature under routes/, see docs/CONTRACTS.md.
    for handler in routes::all() {
        if let Some(response) = handler(state, request, &method, path) {
            return response;
        }
    }
    json_response(404, &json!({"error": "not found"}))
}

/// Every component of a request path must be a plain relative name. Checking the joined path is not
/// enough on Windows: a `Prefix`/`RootDir` component (e.g. `C:/Windows/win.ini`) makes `join`
/// discard `web_dir`, and `CurDir` is never a legitimate static request either.
fn safe_static_path(path: &str) -> bool {
    let rel = path.trim_start_matches('/');
    Path::new(rel).components().all(|c| matches!(c, std::path::Component::Normal(_)))
}

/// CSP for the loopback-served HTML. `unsafe-inline` is required by the inline first-paint theme
/// bootstrap in index.html and React's inline style props. Removing it means externalising those
/// first (a separate frontend task); the header still disables framing, plugins, embeds and
/// off-origin loads.
const HTML_CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

fn serve_static(state: &State, path: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let rel = percent_decode(path);
    if !safe_static_path(&rel) {
        return Response::from_data(Vec::new()).with_status_code(StatusCode(403));
    }
    let mut file = state.web_dir.join(rel.trim_start_matches('/'));
    if !file.is_file() {
        file = state.web_dir.join("index.html");
    }
    match std::fs::read(&file) {
        Ok(bytes) => {
            // The HTML entry is revalidated on each load: it names the hashed bundles, so a cached
            // copy keeps an old build alive after an update. The hashed assets can cache.
            let cache = if mime(&file).starts_with("text/html") { "no-store" } else { "public, max-age=3600" };
            let mut response = Response::from_data(bytes)
                .with_header(Header::from_bytes("Content-Type", mime(&file)).unwrap())
                .with_header(Header::from_bytes("Cache-Control", cache).unwrap());
            if mime(&file).starts_with("text/html") {
                response = response.with_header(Header::from_bytes("Content-Security-Policy", HTML_CSP).unwrap());
            }
            response
        }
        Err(_) => Response::from_data(b"Build the web app first: pnpm build".to_vec()).with_status_code(StatusCode(404)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_paths_are_plain_relative_components() {
        assert!(safe_static_path("/"));
        assert!(safe_static_path("/assets/app.js"));
        assert!(safe_static_path("/a/b/c"));
        assert!(!safe_static_path("/a/../secret"));
        assert!(!safe_static_path("/../secret"));
        assert!(!safe_static_path("./secret"));
        #[cfg(windows)]
        {
            assert!(!safe_static_path("/C:/Windows/win.ini"));
            assert!(!safe_static_path("/C:\\Windows\\win.ini"));
        }
    }

    #[test]
    fn html_csp_blocks_off_origin_loads_and_embedding() {
        assert!(HTML_CSP.contains("default-src 'self'"));
        assert!(HTML_CSP.contains("object-src 'none'"));
        assert!(HTML_CSP.contains("frame-ancestors 'none'"));
        // Inline boot scripts and React style props need these today.
        assert!(HTML_CSP.contains("script-src 'self' 'unsafe-inline'"));
        assert!(HTML_CSP.contains("style-src 'self' 'unsafe-inline'"));
        assert!(!HTML_CSP.contains("unsafe-eval"));
        assert!(Header::from_bytes("Content-Security-Policy", HTML_CSP).is_ok());
    }

    #[test]
    fn connection_slots_are_capped_and_released() {
        let mut held = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            assert!(acquire_connection_slot());
            held.push(ConnectionGuard);
        }
        assert!(!acquire_connection_slot());
        drop(held);
        assert!(acquire_connection_slot());
        drop(ConnectionGuard);
    }
}

fn find_web_dir() -> PathBuf {
    if let Some(dir) = readers::env_path("BURNRATE_WEB") {
        return dir;
    }
    let mut candidates: Vec<PathBuf> = vec![PathBuf::from("dist/web")];
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().skip(1).take(6) {
            candidates.push(ancestor.join("dist").join("web"));
        }
    }
    candidates.into_iter().find(|c| c.join("index.html").is_file()).unwrap_or_else(|| PathBuf::from("dist/web"))
}

/// Per-user data directory for installed builds: `%APPDATA%\burnrate` on Windows,
/// `~/Library/Application Support/burnrate` on macOS, and `$XDG_DATA_HOME/burnrate`
/// (or `~/.local/share/burnrate`) elsewhere. The CLI and the desktop shell derive their
/// well-known `port.txt` from the same location, so keep the three in step.
pub fn default_user_data_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library").join("Application Support"));
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share")));
    base.filter(|b| !b.as_os_str().is_empty()).map(|b| b.join("burnrate"))
}

/// Decide the data directory before any thread starts (it publishes `BURNRATE_DATA`, which every store
/// reads). The historical default, `<web dir>/../../data`, only makes sense in a source checkout
/// (`<root>/dist/web`); in an installed layout (`<install>/web`, `/usr/share/burnrate/web`,
/// `/app/share/burnrate/web`) it would land beside the install dir, often somewhere read-only. So: honour an
/// explicit `BURNRATE_DATA`, keep the legacy directory when it is a dev layout or already exists, and
/// otherwise use the per-user data directory. Call from `main` / the shell's setup, not from a thread.
pub fn init_env() {
    if readers::env_path("BURNRATE_DATA").is_some() {
        return;
    }
    let web = find_web_dir();
    let legacy = web.parent().and_then(Path::parent).map(|root| root.join("data"));
    let dev_layout = web.ends_with("dist/web") || legacy.as_ref().is_some_and(|dir| dir.is_dir());
    if dev_layout {
        return;
    }
    if let Some(dir) = default_user_data_dir() {
        std::env::set_var("BURNRATE_DATA", dir);
    }
}

/// Cap concurrent connections so a local client cannot exhaust threads/memory by opening many
/// sockets. Long-lived SSE streams hold a slot too, which also bounds their aggregate cost.
const MAX_CONNECTIONS: usize = 256;
static ACTIVE_CONNECTIONS: AtomicUsize = AtomicUsize::new(0);

struct ConnectionGuard;

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        ACTIVE_CONNECTIONS.fetch_sub(1, Ordering::AcqRel);
    }
}

fn acquire_connection_slot() -> bool {
    let previous = ACTIVE_CONNECTIONS.fetch_add(1, Ordering::AcqRel);
    if previous >= MAX_CONNECTIONS {
        ACTIVE_CONNECTIONS.fetch_sub(1, Ordering::AcqRel);
        false
    } else {
        true
    }
}

/// Runs the server until the process exits. `main.rs` calls this; the desktop shell embeds it.
pub fn run() {
    let port: u16 = std::env::var("BURNRATE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(13790);
    let web_dir = find_web_dir();
    // The data directory sits next to the web build unless told otherwise.
    let data_dir = readers::env_path("BURNRATE_DATA").unwrap_or_else(|| web_dir.parent().and_then(Path::parent).map_or_else(|| PathBuf::from("data"), |root| root.join("data")));
    let state = Arc::new(State {
        port,
        web_dir,
        keys: KeyStore::open(&data_dir),
        settings: SettingsStore::open(&data_dir),
        engine: Engine::new(data_dir.clone()),
        providers: providers::all(),
    });
    let server = match Server::http(format!("127.0.0.1:{port}")) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Cannot listen on 127.0.0.1:{port}: {e}");
            std::process::exit(1);
        }
    };
    println!("Burnrate listening on http://127.0.0.1:{port}");
    scheduler::start(state.clone());
    // Read the transcripts in the background so the first Cost view finds data (or honest progress) waiting.
    // Nothing waits for it, and no limits probe is made here: that stays on demand.
    state.engine.start_scan();
    for mut request in server.incoming_requests() {
        if !acquire_connection_slot() {
            let _ = request.respond(Response::from_data(Vec::new()).with_status_code(StatusCode(503)));
            continue;
        }
        let state = state.clone();
        std::thread::spawn(move || {
            let _slot = ConnectionGuard;
            // Reject DNS rebinding: only our own loopback host names are served.
            let host = request.headers().iter().find(|h| h.field.equiv("Host")).map(|h| h.value.as_str().to_string()).unwrap_or_default();
            let allowed = host == format!("127.0.0.1:{}", state.port) || host == format!("localhost:{}", state.port);
            let path = request.url().split('?').next().unwrap_or("/").to_string();
            // The event stream keeps the connection open and flushes per event, so it takes over the request.
            if allowed && routes::is_stream_request(request.method(), &path) {
                routes::serve_stream(request);
                return;
            }
            let response = if !allowed {
                Response::from_data(Vec::new()).with_status_code(StatusCode(403))
            } else if path.starts_with("/api/") {
                handle_api(&state, &mut request, &path)
            } else {
                serve_static(&state, &path)
            };
            let _ = request.respond(response);
        });
    }
}
