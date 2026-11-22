// Usage-limit providers. Each module reads one source of subscription limits; to add a provider,
// implement `Provider` and list it in `all()`. Endpoints and rules derive from T3 Code (MIT, see NOTICE).
mod claude;
pub mod codex;
mod cursor;
pub mod grok;
mod logs;
mod mistral;
mod opencode;
pub mod statusline;
pub mod usage_cache;

use crate::keys::KeyStore;
use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Copy, PartialEq)]
pub enum Auth {
    ApiKey,
    LocalLogin,
    LocalLogs,
}

impl Auth {
    pub fn as_str(self) -> &'static str {
        match self {
            Auth::ApiKey => "apiKey",
            Auth::LocalLogin => "localLogin",
            Auth::LocalLogs => "localLogs",
        }
    }
}

/// Which group of the Providers screen an entry belongs to. The order of the variants is the order
/// `GET /api/providers` returns them in: agents, API keys, local logs, then organisation/admin keys.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Category {
    Agent,
    ApiKey,
    LocalLogs,
    Admin,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Agent => "agent",
            Category::ApiKey => "apiKey",
            Category::LocalLogs => "localLogs",
            Category::Admin => "admin",
        }
    }
}

/// Measured from a local-log provider's own files (Pi, Muse). No quotas are invented here: these
/// are only counts and timestamps taken from the session logs on this computer.
#[derive(Clone)]
pub struct LocalLogStats {
    /// Session log files found (one file = one session for the agents counted so far).
    pub sessions: u32,
    /// Newest file modification time, in milliseconds since the epoch.
    pub last_used_ms: Option<f64>,
    /// The folder the logs were found in (the candidate holding the newest log, else the first
    /// existing one).
    pub folder: PathBuf,
}

impl LocalLogStats {
    pub fn json(&self) -> Value {
        let mut v = json!({"sessions": self.sessions, "folder": self.folder.to_string_lossy()});
        if let Some(at) = self.last_used_ms.and_then(iso_ms) {
            v["lastUsedAt"] = json!(at);
        }
        v
    }
}

pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    fn color(&self) -> &'static str;
    fn auth(&self) -> Auth;
    /// Providers screen group. Defaults follow the auth kind: login -> agent, key -> apiKey, logs -> localLogs.
    fn category(&self) -> Category {
        match self.auth() {
            Auth::LocalLogin => Category::Agent,
            Auth::ApiKey => Category::ApiKey,
            Auth::LocalLogs => Category::LocalLogs,
        }
    }
    /// Where the user creates a key (or signs up) for this provider, when there is such a page.
    fn key_url(&self) -> Option<String> {
        None
    }
    /// One line shown when the provider is not connected yet (a connected local login says
    /// "Detected on this computer" instead; see `provider_info`).
    fn hint(&self) -> &'static str {
        ""
    }
    /// True for a definition the user wrote themselves (`<data>/providers.d`): "Advanced" in the UI.
    fn custom(&self) -> bool {
        false
    }
    /// Whether a local login (or transcript folder) exists on this computer.
    fn has_login(&self) -> bool {
        false
    }
    /// What the provider's local log files say (local-log providers only): how many sessions were
    /// found, when one was last used, and the folder they were read from. `None` when unseen or
    /// when the provider keeps no local files.
    fn local_stats(&self) -> Option<LocalLogStats> {
        None
    }
    /// Accounts with their limits, in the `LimitsAccount` shape the UI reads.
    fn read(&self, keys: &KeyStore) -> Vec<Value>;
    /// Validate an unsaved key against the provider's limits/billing endpoint. API-key providers
    /// override this with a real request; other auth kinds have no key to test.
    fn test_key(&self, key: &str) -> Result<(), String> {
        let _ = key;
        Err("This provider does not use API keys".into())
    }
}

/// Whether OpenCode already holds an API key for the Go plan (see `opencode::go_key_present`).
pub fn opencode_go_key_present() -> bool {
    opencode::go_key_present()
}

/// Whether OpenCode's data is on this computer (existence only; see `opencode::local_install_present`).
pub fn opencode_local_install_present() -> bool {
    opencode::local_install_present()
}

pub use mistral::{vibe_present, ImportError as VibeImportError};

/// Explicit one-click import of the key Mistral Vibe already holds on this computer.
pub fn import_mistral_from_vibe(keys: &KeyStore) -> Result<&'static str, VibeImportError> {
    mistral::import_local(keys)
}

pub fn all() -> Vec<Box<dyn Provider>> {
    let mut list: Vec<Box<dyn Provider>> = vec![
        Box::new(claude::Claude),
        Box::new(codex::Codex),
        Box::new(grok::Grok),
        Box::new(cursor::Cursor),
        Box::new(opencode::OpenCode),
        Box::new(logs::LogsOnly::new("antigravity", "Antigravity", "#8c7bd1")),
        Box::new(logs::LogsOnly::new("pi", "Pi", "#4d9f8a")),
        Box::new(logs::LogsOnly::new("muse", "Muse Code", "#0866ff")),
        Box::new(mistral::Mistral),
    ];
    list.extend(crate::defs::providers());
    list
}

/// The statusline store, the settings snapshot and the process environment are globals: every test
/// that sets any of them (claude.rs, statusline.rs) takes this one lock so they cannot interleave.
#[cfg(test)]
pub(crate) static TEST_GLOBALS: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------- settings-backed flags
// `State.settings` is not passed to `Provider::read`, so providers read feature flags through
// this small accessor. The ingest route (and the integrator at startup) refresh the snapshot with
// `set_settings_snapshot`; the on-disk settings file is the fallback for a cold start.

static SETTINGS_SNAPSHOT: OnceLock<Mutex<Option<Value>>> = OnceLock::new();

/// Refresh the settings snapshot from `&State.settings` (call on startup and after a settings write).
pub fn set_settings_snapshot(settings: &Value) {
    let slot = SETTINGS_SNAPSHOT.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(settings.clone());
    }
}

fn snapshot_settings() -> Option<Value> {
    SETTINGS_SNAPSHOT.get()?.lock().ok().and_then(|guard| guard.clone())
}

fn settings_path() -> Option<PathBuf> {
    if let Some(dir) = crate::readers::env_path("BURNRATE_DATA") {
        return Some(dir.join("settings.json"));
    }
    if let Some(web) = crate::readers::env_path("BURNRATE_WEB") {
        return web.parent().and_then(std::path::Path::parent).map(|root| root.join("data").join("settings.json"));
    }
    let exe = std::env::current_exe().ok()?;
    for ancestor in exe.ancestors().skip(1).take(6) {
        if ancestor.join("dist").join("web").join("index.html").is_file() {
            return Some(ancestor.join("data").join("settings.json"));
        }
    }
    None
}

fn flag_from(settings: &Value) -> Option<bool> {
    settings.pointer("/providers/claudeOAuthProbe").and_then(Value::as_bool)
}

/// `providers.claudeOAuthProbe` (DEFAULT_SETTINGS says `true`). When false we must not read a
/// Claude OAuth token at all: the account runs on local transcripts and statusline pushes only.
pub fn claude_oauth_probe_enabled() -> bool {
    snapshot_settings()
        .as_ref()
        .and_then(flag_from)
        .or_else(|| {
            let path = settings_path()?;
            flag_from(&serde_json::from_slice::<Value>(&std::fs::read(path).ok()?).ok()?)
        })
        .unwrap_or(true)
}

/// The alerts engine (contracts section 10) detects expired logins by this stable prefix.
pub const LOGIN_EXPIRED_PREFIX: &str = "login-expired:";

pub fn login_expired_message(provider: &str) -> String {
    format!("{LOGIN_EXPIRED_PREFIX} {provider} login expired, sign in again")
}

pub fn is_login_expired(message: &str) -> bool {
    message.trim_start().starts_with(LOGIN_EXPIRED_PREFIX)
}

/// Shared mapping for auth-looking HTTP statuses across the login providers.
pub fn auth_failure_message(provider: &str, code: u16, detail: &str, fallback: String) -> String {
    let lower = detail.to_ascii_lowercase();
    let auth = matches!(code, 401 | 403)
        || ["token expired", "invalid token", "unauthorized", "authentication required", "session expired"].iter().any(|p| lower.contains(p));
    if auth {
        login_expired_message(provider)
    } else {
        fallback
    }
}

pub fn iso_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn iso_ms(ms: f64) -> Option<String> {
    Utc.timestamp_millis_opt(ms as i64).single().map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
}

pub fn clamp(n: f64) -> f64 {
    n.clamp(0.0, 100.0)
}

#[derive(Clone)]
pub struct Window {
    pub id: String,
    pub kind: &'static str,
    pub label: String,
    pub used: f64,
    pub resets_at: Option<String>,
    pub mins: Option<f64>,
    /// Where the number came from: `official`, `unofficial`, `statusline`, `local`, `estimated`.
    pub provenance: Option<&'static str>,
}

impl Window {
    pub fn new(id: &str, kind: &'static str, label: &str, used: f64) -> Window {
        Window { id: id.into(), kind, label: label.into(), used: clamp(used), resets_at: None, mins: None, provenance: None }
    }
    pub fn resets(mut self, at: Option<String>) -> Window {
        self.resets_at = at;
        self
    }
    pub fn mins(mut self, mins: Option<f64>) -> Window {
        self.mins = mins;
        self
    }
    /// Label a window with its source so the UI can show an honesty badge (contracts section 1).
    pub fn provenance(mut self, source: &'static str) -> Window {
        self.provenance = Some(source);
        self
    }
    pub fn json(&self) -> Value {
        let mut v = json!({"id": self.id, "kind": self.kind, "label": self.label, "usedPercent": self.used});
        let m = v.as_object_mut().unwrap();
        if let Some(r) = &self.resets_at {
            m.insert("resetsAt".into(), json!(r));
        }
        if let Some(d) = self.mins {
            m.insert("windowDurationMins".into(), json!(d));
        }
        if let Some(p) = self.provenance {
            m.insert("provenance".into(), json!(p));
        }
        v
    }
}

/// An account whose limits could not be read: shown with a notice rather than hidden.
pub fn unavailable_account(mut head: Value, message: String) -> Value {
    head["limits"] = json!({"checkedAt": iso_now(), "windows": [], "unavailable": {"reason": "probeFailed", "message": message}});
    head
}

pub fn account_with(mut head: Value, windows: Vec<Window>) -> Value {
    head["limits"] = json!({"checkedAt": iso_now(), "windows": windows.iter().map(Window::json).collect::<Vec<_>>()});
    head
}

pub fn agent() -> ureq::Agent {
    // A provider cannot redirect a keyed request to a host we never validated, and the address set
    // is re-checked at connect time (no DNS-rebinding gap). Environment proxies are disabled so the
    // GuardedResolver sees the real target host, not a proxy.
    ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .redirects(0)
        .try_proxy_from_env(false)
        .resolver(crate::net_guard::GuardedResolver { allow_local: false })
        .build()
}

/// Map an HTTP status from a key test to a fixed message. Rate limits and server errors are
/// reported as "busy" so the user retries instead of discarding a valid key.
pub fn test_status_error(code: u16) -> String {
    match code {
        401 | 403 => "The key was rejected".into(),
        429 | 500..=599 => "The provider is busy, try again".into(),
        _ => "Could not reach the provider".into(),
    }
}

pub fn read_json(path: &std::path::Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}
