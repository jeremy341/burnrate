use super::usage_cache::{self, ProbeError, Resolved};
use super::*;
use crate::readers::{env_path, home};
use std::path::{Path, PathBuf};

const SESSION_MINS: f64 = 5.0 * 60.0;
const WEEK_MINS: f64 = 7.0 * 24.0 * 60.0;

fn config_dir() -> PathBuf {
    env_path("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home().join(".claude"))
}
fn credentials_path() -> PathBuf {
    config_dir().join(".credentials.json")
}

fn iso(v: Option<&Value>) -> Option<String> {
    let ms = crate::types::parse_rfc3339_ms(v?.as_str()?)?;
    iso_ms(ms)
}

fn percent_from(used: Option<f64>, limit: Option<f64>) -> Option<f64> {
    let (u, l) = (used?, limit?);
    (u.is_finite() && l.is_finite() && u >= 0.0 && l > 0.0).then(|| clamp(u / l * 100.0))
}

fn spend_percent(usage: &Value) -> Option<f64> {
    if let Some(s) = usage.get("spend").filter(|s| s.get("enabled").and_then(Value::as_bool) == Some(true)) {
        let (used, limit) = (s.get("used")?, s.get("limit")?);
        let same = used.get("currency").and_then(Value::as_str).map(str::trim) == limit.get("currency").and_then(Value::as_str).map(str::trim)
            && used.get("exponent") == limit.get("exponent");
        if same {
            if let Some(p) = percent_from(used.get("amount_minor").and_then(Value::as_f64), limit.get("amount_minor").and_then(Value::as_f64)) {
                return Some(p);
            }
        }
    }
    let e = usage.get("extra_usage")?;
    if e.get("is_enabled").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let p = percent_from(e.get("used_credits").and_then(Value::as_f64), e.get("monthly_limit").and_then(Value::as_f64)).or_else(|| e.get("utilization").and_then(Value::as_f64));
    p.filter(|p| p.is_finite() && *p >= 0.0).map(clamp)
}

pub fn usage_to_windows(usage: &Value) -> Vec<Window> {
    let mut windows = Vec::new();
    for (id, kind, label, mins) in [("five_hour", "session", "Session", SESSION_MINS), ("seven_day", "weekly", "Weekly", WEEK_MINS)] {
        let Some(bucket) = usage.get(id).filter(|b| b.is_object()) else { continue };
        let Some(used) = bucket.get("utilization").and_then(Value::as_f64) else { continue };
        // The `api/oauth/usage` endpoint is an undocumented Claude Code endpoint: `unofficial`.
        windows.push(Window::new(id, kind, label, used).provenance("unofficial").mins(Some(mins)).resets(iso(bucket.get("resets_at"))));
    }
    for limit in usage.get("limits").and_then(Value::as_array).into_iter().flatten() {
        let name = limit.pointer("/scope/model/display_name").and_then(Value::as_str);
        let (Some(name), Some(percent)) = (name, limit.get("percent").and_then(Value::as_f64)) else { continue };
        if limit.get("kind").and_then(Value::as_str) != Some("weekly_scoped") {
            continue;
        }
        let token: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect::<String>();
        // Collapse runs of separators like the TypeScript server's regex does.
        let mut collapsed = String::new();
        for c in token.chars() {
            if c == '_' && collapsed.ends_with('_') {
                continue;
            }
            collapsed.push(c);
        }
        windows.push(Window::new(&format!("seven_day_{collapsed}"), "weekly", &format!("Weekly · {name}"), percent).provenance("unofficial").mins(Some(WEEK_MINS)).resets(iso(limit.get("resets_at"))));
    }
    if let Some(spend) = spend_percent(usage) {
        windows.push(Window::new("monthly_spend", "monthly", "Monthly spend", spend).provenance("unofficial"));
    }
    windows
}

/// Where an account's limits come from. We only ever READ a token that the user's own Claude Code
/// already stored locally; we never call Anthropic's token-refresh endpoint, never write to
/// Claude's config directory, and never trigger a browser sign-in. Another app's credentials are
/// not ours to refresh (asserted by the tests in `statusline.rs` and at the end of this file).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeSource {
    /// Read the local OAuth token and call Claude Code's usage endpoint (opt-in, `unofficial`).
    OAuth,
    /// Use the rate limits pushed by Claude Code's statusline hook (`statusline`).
    Statusline,
    /// No probe at all: only local transcripts provide cost/token data.
    Transcripts,
}

/// Choose the primary source. When the OAuth probe fails we still fall back to a fresh statusline
/// snapshot (see `read_account`), so the flag only needs to decide whether to probe at all.
pub fn choose_source(statusline_fresh: bool, oauth_probe_enabled: bool) -> ProbeSource {
    match (oauth_probe_enabled, statusline_fresh) {
        (false, true) => ProbeSource::Statusline,
        (false, false) => ProbeSource::Transcripts,
        (true, _) => ProbeSource::OAuth,
    }
}

pub struct Claude;

impl Provider for Claude {
    fn id(&self) -> &'static str {
        "claudeAgent"
    }
    fn label(&self) -> &'static str {
        "Claude Code"
    }
    fn color(&self) -> &'static str {
        "#d97757"
    }
    fn auth(&self) -> Auth {
        Auth::LocalLogin
    }
    fn hint(&self) -> &'static str {
        "Sign in with the Claude Code CLI"
    }
    fn has_login(&self) -> bool {
        credentials_path().exists()
    }
    fn read(&self, _keys: &KeyStore) -> Vec<Value> {
        let oauth_probe_enabled = crate::providers::claude_oauth_probe_enabled();
        // One account per Claude Code config directory that holds a login (`~/.claude`, `~/.claude-work`, ...)
        // or has pushed a fresh statusline snapshot.
        let mut dirs = crate::readers::claude_config_dirs();
        if dirs.is_empty() {
            dirs.push(config_dir());
        }
        let default_dir = home().join(".claude");
        std::thread::scope(|scope| {
            let handles: Vec<_> = dirs
                .iter()
                .filter(|dir| dir.join(".credentials.json").exists() || statusline::fresh_for(dir).is_some())
                .map(|dir| {
                    let account_file = if **dir == default_dir { home().join(".claude.json") } else { dir.join(".claude.json") };
                    let id = dir.file_name().map(|n| n.to_string_lossy().trim_start_matches('.').to_string()).unwrap_or_else(|| "claude".into());
                    scope.spawn(move || read_account(dir, &account_file, &id, oauth_probe_enabled))
                })
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
        })
    }
}

fn account_head(account_file: &Path, id: &str) -> Value {
    let identity = read_json(account_file).and_then(|c| c.get("oauthAccount").cloned());
    let name = identity.as_ref().and_then(|i| i.get("displayName")).and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);
    let mut head = json!({"id": format!("claude-{id}"), "driver": "claudeAgent", "label": name.clone().unwrap_or_else(|| id.to_string()), "plan": "Claude Subscription"});
    if let Some(n) = &name {
        head["displayName"] = json!(n);
    }
    if let Some(email) = identity.as_ref().and_then(|i| i.get("emailAddress")).and_then(Value::as_str) {
        head["email"] = json!(email);
    }
    head
}

/// Prefer the user's own statusline data when the probe is off or it failed; never invent numbers.
fn fallback_or_unavailable(head: Value, statusline: Option<Vec<Window>>, message: String) -> Value {
    match statusline {
        Some(windows) => account_with(head, windows),
        None => unavailable_account(head, message),
    }
}

fn read_account(dir: &Path, account_file: &Path, id: &str, oauth_probe_enabled: bool) -> Option<Value> {
    let statusline = statusline::fresh_for(dir);
    match choose_source(statusline.is_some(), oauth_probe_enabled) {
        ProbeSource::Statusline => {
            let head = account_head(account_file, id);
            Some(account_with(head, statusline.unwrap_or_default()))
        }
        ProbeSource::Transcripts => {
            // `providers.claudeOAuthProbe = false` means no token is read, no request is sent and
            // another app's files are never touched. Cost/tokens still come from local transcripts.
            None
        }
        ProbeSource::OAuth => {
            // Read the existing token only. No refresh endpoint, no file writes, no interactive sign-in.
            let token = read_json(&dir.join(".credentials.json"))
                .and_then(|c| c.pointer("/claudeAiOauth/accessToken").and_then(Value::as_str).map(|t| t.trim().to_string()))
                .filter(|t| !t.is_empty())?;
            let head = account_head(account_file, id);
            // Every caller (the UI, the scheduler, repeated /api/limits calls) goes through the shared
            // cache: at most one probe per account every five minutes, last good values on failure.
            let now = usage_cache::now_ms();
            let cred_mtime_ms = std::fs::metadata(dir.join(".credentials.json"))
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);
            let resolved = usage_cache::global().resolve(&format!("claude-{id}"), now, cred_mtime_ms, || probe_usage(&token));
            Some(match resolved {
                Resolved::Fresh(good) => account_from_good(head, &good),
                Resolved::Stale { good, message } => match statusline {
                    // The statusline hook is live data from the user's own Claude Code: better than old numbers.
                    Some(windows) => account_with(head, windows),
                    None => stale_account(head, &good, &message, now),
                },
                Resolved::Failed(message) => fallback_or_unavailable(head, statusline, message),
            })
        }
    }
}

/// One real request to Claude's usage endpoint (`unofficial`). Errors keep the status and
/// `Retry-After` so the cache can back off; no response body or token is ever put in a message.
fn probe_usage(token: &str) -> Result<(Vec<Value>, Option<Value>), ProbeError> {
    let result = agent()
        .get("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1")
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", "oauth-2025-04-20")
        // The endpoint can answer 429 without a Claude Code user agent.
        .set("User-Agent", &format!("claude-cli/{} (external, cli)", cli_version()))
        .call();
    match result {
        Ok(res) => match res.into_json::<Value>() {
            Ok(usage) => {
                let windows: Vec<Value> = usage_to_windows(&usage).iter().map(Window::json).collect();
                if windows.is_empty() {
                    return Err(ProbeError::Transient { message: retry_soon_message(None), retry_after_secs: None });
                }
                Ok((windows, reset_credits(usage.get("cedar_ember"))))
            }
            Err(_) => Err(ProbeError::Transient { message: retry_soon_message(None), retry_after_secs: None }),
        },
        Err(ureq::Error::Status(code, res)) => {
            let retry_after = usage_cache::parse_retry_after(res.header("retry-after"));
            let detail = res.into_string().unwrap_or_default();
            let message = auth_failure_message("Claude Code", code, &detail, retry_soon_message(Some(code)));
            if is_login_expired(&message) {
                Err(ProbeError::Auth { message })
            } else {
                Err(ProbeError::Transient { message, retry_after_secs: retry_after })
            }
        }
        Err(_) => Err(ProbeError::Transient { message: "Burnrate could not reach Claude. It will try again soon.".into(), retry_after_secs: None }),
    }
}

/// What the user reads when a usage check fails for a reason that is not their login: what
/// happened and that it retries, never a status code.
fn retry_soon_message(status: Option<u16>) -> String {
    match status {
        Some(429) => "Claude is limiting usage checks right now. Burnrate will try again soon.".into(),
        Some(500..=599) => "Claude's usage service is having problems. Burnrate will try again soon.".into(),
        _ => "Claude usage could not be read. Burnrate will try again soon.".into(),
    }
}

fn limits_from_good(good: &usage_cache::Good) -> Value {
    json!({"checkedAt": iso_ms(good.at_ms as f64).unwrap_or_else(iso_now), "windows": good.windows})
}

fn account_from_good(mut head: Value, good: &usage_cache::Good) -> Value {
    head["limits"] = limits_from_good(good);
    if let Some(credits) = &good.credits {
        head["limits"]["resetCredits"] = credits.clone();
    }
    head
}

/// The last good values, marked stale so the UI can say how old they are instead of showing nothing.
fn stale_account(mut head: Value, good: &usage_cache::Good, reason: &str, now_ms: i64) -> Value {
    head["limits"] = limits_from_good(good);
    head["limits"]["stale"] = json!(true);
    head["limits"]["staleSince"] = json!(iso_ms(good.at_ms as f64).unwrap_or_else(iso_now));
    head["limits"]["staleMessage"] = json!(usage_cache::stale_message(good.at_ms, now_ms));
    head["limits"]["staleReason"] = json!(reason);
    head
}

const RESET_KINDS: [(&str, &str, &str); 4] = [
    ("session", "5-hour reset", "Refills your 5-hour limit."),
    ("weekly", "Weekly reset", "Refills your weekly limit."),
    ("fable", "Fable reset", "Refills your Fable allowance and gives back what Fable used on your weekly limit. It doesn't reset your whole week."),
    ("full", "Full reset", "Refills your 5-hour and weekly limits."),
];

// Claude Code's own grouping: a grant that gives back weekly usage is a Fable reset, else its declared
// type, else what it clears.
fn grant_kind(grant: &Value) -> &'static str {
    if grant.get("gives_back_weekly").and_then(Value::as_bool) == Some(true) {
        return "fable";
    }
    if let Some(t) = grant.get("type").and_then(Value::as_str) {
        if let Some((k, _, _)) = RESET_KINDS.iter().find(|(k, _, _)| *k == t && *k != "fable") {
            return k;
        }
    }
    let clears: Vec<&str> = grant.get("clears").and_then(Value::as_array).map(|c| c.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let session = clears.contains(&"five_hour");
    let other = clears.iter().any(|c| *c != "five_hour");
    if session && !other {
        "session"
    } else if other && !session {
        "weekly"
    } else {
        "full"
    }
}

/// Banked reset credits from Claude's `cedar_ember` block, shaped as the UI reads them.
fn reset_credits(block: Option<&Value>) -> Option<Value> {
    let block = block?;
    if block.get("eligible").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let now = crate::types::parse_rfc3339_ms(&iso_now()).unwrap_or(0.0);
    let live: Vec<&Value> = block
        .get("grants")
        .and_then(Value::as_array)?
        .iter()
        .filter(|g| g.get("resets_left").and_then(Value::as_u64).is_some() && g.get("id").and_then(Value::as_str).is_some())
        .filter(|g| g.get("paused").and_then(Value::as_bool) != Some(true) && g.get("usable_now").and_then(Value::as_bool) == Some(true))
        .filter(|g| match g.get("ends_at").and_then(Value::as_str) {
            None => true,
            Some(t) => crate::types::parse_rfc3339_ms(t).is_some_and(|ms| ms > now),
        })
        .collect();
    let next_id = block.get("next_grant_id").and_then(Value::as_str);
    let next = live.iter().find(|g| g.get("id").and_then(Value::as_str) == next_id).copied();
    let expires = |g: Option<&Value>| g.and_then(|g| g.get("ends_at")).and_then(Value::as_str).and_then(crate::types::parse_rfc3339_ms).and_then(iso_ms);
    let options: Vec<Value> = RESET_KINDS
        .iter()
        .filter_map(|(kind, label, description)| {
            let grants: Vec<&&Value> = live.iter().filter(|g| g.get("resets_left").and_then(Value::as_u64) != Some(0) && grant_kind(g) == *kind).collect();
            let target = grants.first()?;
            let count: u64 = grants.iter().filter_map(|g| g.get("resets_left").and_then(Value::as_u64)).sum();
            let mut o = json!({"creditId": target.get("id"), "label": label, "description": description, "availableCount": count});
            if let Some(e) = expires(Some(target)) {
                o["expiresAt"] = json!(e);
            }
            Some(o)
        })
        .collect();
    let total: u64 = if next.is_some() { live.iter().filter_map(|g| g.get("resets_left").and_then(Value::as_u64)).sum() } else { 0 };
    let mut out = json!({"availableCount": total});
    if let Some(e) = expires(next) {
        out["nextExpiresAt"] = json!(e);
    }
    if let Some(n) = next {
        out["nextCreditId"] = n.get("id").cloned().unwrap_or(Value::Null);
        out["options"] = json!(options);
    }
    Some(out)
}

/// The installed Claude Code version: the reset-credit block is only returned to a current client.
fn cli_version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(|| {
        let run = |program: &str| {
            let mut cmd = std::process::Command::new(program);
            cmd.arg("--version");
            #[cfg(windows)]
            std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x08000000);
            cmd.output().ok().and_then(|o| String::from_utf8(o.stdout).ok())
        };
        let text = run("claude").or_else(|| run("claude.cmd")).unwrap_or_default();
        text.split_whitespace().find(|w| w.split('.').count() == 3 && w.chars().all(|c| c.is_ascii_digit() || c == '.')).unwrap_or("2.1.273").to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::statusline;

    use crate::providers::TEST_GLOBALS as ENV_GLOBAL;

    const OAUTH_USAGE: &str = include_str!("claude-oauth-usage.json");
    const STATUSLINE: &str = include_str!("claude-statusline.json");

    struct EnvGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }
    impl EnvGuard {
        fn set(key: &'static str, value: &Path) -> EnvGuard {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            EnvGuard { key, previous }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn oauth_windows_are_labelled_unofficial() {
        let usage: Value = serde_json::from_str(OAUTH_USAGE).expect("fixture");
        let windows = usage_to_windows(&usage);
        assert_eq!(windows.len(), 2);
        assert!(windows.iter().all(|w| w.provenance == Some("unofficial")));
        assert_eq!(windows[0].id, "five_hour");
        assert!((windows[0].used - 27.5).abs() < f64::EPSILON);
        assert_eq!(windows[0].mins, Some(SESSION_MINS));
        assert_eq!(windows[1].id, "seven_day");
        assert!((windows[1].used - 63.25).abs() < f64::EPSILON);
        assert_eq!(windows[1].json()["provenance"], "unofficial");
    }

    #[test]
    fn auth_failures_produce_the_stable_login_expired_prefix() {
        let message = auth_failure_message("Claude Code", 401, "", "unused".into());
        assert_eq!(message, login_expired_message("Claude Code"));
        assert!(is_login_expired(&message));
        assert!(message.starts_with("login-expired:"));
        assert!(is_login_expired(&auth_failure_message("ChatGPT", 403, "", "unused".into())));
        assert!(!is_login_expired(&auth_failure_message("Claude Code", 500, "", "Claude usage unavailable (HTTP 500).".into())));
        assert!(is_login_expired(&auth_failure_message("Claude Code", 400, "{\"error\":\"token expired\"}", "unused".into())));
    }

    #[test]
    fn probe_disabled_never_touches_claude_credentials_or_tokens() {
        let _guard = ENV_GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "burnrate-claude-no-refresh-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()
        ));
        let config = dir.join(".claude");
        let _ = std::fs::create_dir_all(config.join("projects"));
        let credentials = config.join(".credentials.json");
        // A throwaway token in a temp dir: never a real Claude credential.
        let fake = br#"{"claudeAiOauth":{"accessToken":"throwaway-token-not-a-real-key"}}"#;
        std::fs::write(&credentials, fake).expect("temp credentials");
        let before = std::fs::read(&credentials).expect("temp credentials");

        let _home = EnvGuard::set("USERPROFILE", &dir);
        let _config = EnvGuard::set("CLAUDE_CONFIG_DIR", &config);
        crate::providers::set_settings_snapshot(&json!({"providers": {"claudeOAuthProbe": false}}));
        statusline::clear_for_test();

        let keys = KeyStore::open(&dir);
        assert!(Claude.read(&keys).is_empty(), "no probe and no statusline data means no account");
        assert_eq!(std::fs::read(&credentials).expect("temp credentials"), before, "credentials must not be modified");
        statusline::clear_for_test();
        crate::providers::set_settings_snapshot(&json!({}));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_disabled_uses_statusline_without_reading_credentials() {
        let _guard = ENV_GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "burnrate-claude-statusline-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()
        ));
        let config = dir.join(".claude");
        let _ = std::fs::create_dir_all(config.join("projects"));
        let credentials = config.join(".credentials.json");
        let fake = br#"{"claudeAiOauth":{"accessToken":"throwaway-token-not-a-real-key"}}"#;
        std::fs::write(&credentials, fake).expect("temp credentials");
        let before = std::fs::read(&credentials).expect("temp credentials");
        let transcript = config.join("projects").join("fixture.jsonl");

        let _home = EnvGuard::set("USERPROFILE", &dir);
        let _config = EnvGuard::set("CLAUDE_CONFIG_DIR", &config);
        crate::providers::set_settings_snapshot(&json!({"providers": {"claudeOAuthProbe": false}}));
        statusline::clear_for_test();
        let mut body: Value = serde_json::from_str(STATUSLINE).expect("fixture");
        body["transcript_path"] = json!(transcript.to_string_lossy());
        statusline::ingest(&body);

        let keys = KeyStore::open(&dir);
        let accounts = Claude.read(&keys);
        assert_eq!(accounts.len(), 1);
        let windows = accounts[0].pointer("/limits/windows").and_then(Value::as_array).expect("windows");
        assert_eq!(windows.len(), 2);
        assert!(windows.iter().all(|w| w["provenance"] == "statusline"));
        assert_eq!(std::fs::read(&credentials).expect("temp credentials"), before, "no token read or refresh");

        statusline::clear_for_test();
        crate::providers::set_settings_snapshot(&json!({}));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
