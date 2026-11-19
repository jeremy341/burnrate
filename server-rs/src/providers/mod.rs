// Usage-limit providers. Each module reads one source of subscription limits; to add a provider,
// implement `Provider` and list it in `all()`. Endpoints and rules derive from T3 Code (MIT, see NOTICE).
mod claude;
mod codex;
mod cursor;
mod grok;
mod logs;
mod mistral;
mod opencode;

use crate::keys::KeyStore;
use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};

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

pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    fn color(&self) -> &'static str;
    fn auth(&self) -> Auth;
    /// Whether a local login (or transcript folder) exists on this computer.
    fn has_login(&self) -> bool {
        false
    }
    /// Accounts with their limits, in the `LimitsAccount` shape the UI reads.
    fn read(&self, keys: &KeyStore) -> Vec<Value>;
}

pub fn all() -> Vec<Box<dyn Provider>> {
    vec![
        Box::new(claude::Claude),
        Box::new(codex::Codex),
        Box::new(grok::Grok),
        Box::new(cursor::Cursor),
        Box::new(opencode::OpenCode),
        Box::new(logs::LogsOnly::new("antigravity", "Antigravity", "#8c7bd1")),
        Box::new(logs::LogsOnly::new("pi", "Pi", "#4d9f8a")),
        Box::new(logs::LogsOnly::new("muse", "Muse Code", "#0866ff")),
        Box::new(mistral::Mistral),
    ]
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

pub struct Window {
    pub id: String,
    pub kind: &'static str,
    pub label: String,
    pub used: f64,
    pub resets_at: Option<String>,
    pub mins: Option<f64>,
}

impl Window {
    pub fn new(id: &str, kind: &'static str, label: &str, used: f64) -> Window {
        Window { id: id.into(), kind, label: label.into(), used: clamp(used), resets_at: None, mins: None }
    }
    pub fn resets(mut self, at: Option<String>) -> Window {
        self.resets_at = at;
        self
    }
    pub fn mins(mut self, mins: Option<f64>) -> Window {
        self.mins = mins;
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
    ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(10)).build()
}

pub fn read_json(path: &std::path::Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}
