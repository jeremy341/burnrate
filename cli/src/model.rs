//! Tolerant parser for the compact status payload (contracts section 8).
//! We are a separate crate from the server, so we read `serde_json::Value`
//! directly and never declare a shared type that could drift.

use crate::format;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub used: f64,
    pub remaining: f64,
    pub resets_at: Option<String>,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Account {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub windows: Vec<Window>,
    pub unavailable: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Worst {
    pub account_id: String,
    pub provider: String,
    pub window_id: String,
    pub label: String,
    pub remaining: f64,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    pub checked_at: Option<String>,
    pub accounts: Vec<Account>,
    pub worst: Option<Worst>,
    pub notices: Vec<String>,
}

fn obj(v: &Value) -> Option<&serde_json::Map<String, Value>> {
    v.as_object()
}

/// First key present with a string value.
fn str_field<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    let o = obj(v)?;
    keys.iter().find_map(|k| o.get(*k).and_then(Value::as_str))
}

fn f64_field(v: &Value, keys: &[&str]) -> Option<f64> {
    let o = obj(v)?;
    keys.iter().find_map(|k| o.get(*k).and_then(Value::as_f64))
}

fn arr_field<'a>(v: &'a Value, keys: &[&str]) -> &'a [Value] {
    obj(v)
        .and_then(|o| keys.iter().find_map(|k| o.get(*k).and_then(Value::as_array)))
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn parse_window(v: &Value) -> Window {
    let used = f64_field(v, &["usedPercent", "used_percent"]).unwrap_or(0.0);
    let remaining = f64_field(v, &["remainingPercent", "remaining_percent"]).unwrap_or_else(|| 100.0 - used);
    let state = str_field(v, &["state"])
        .map(str::to_string)
        .unwrap_or_else(|| format::state_from_remaining(remaining).to_string());
    Window {
        id: str_field(v, &["id"]).unwrap_or("").to_string(),
        kind: str_field(v, &["kind"]).unwrap_or("other").to_string(),
        label: str_field(v, &["label"]).unwrap_or("").to_string(),
        used,
        remaining,
        resets_at: str_field(v, &["resetsAt", "resets_at"]).map(str::to_string),
        state,
    }
}

fn parse_account(v: &Value) -> Account {
    // Also accept the older /api/limits shape (nested `limits.windows`) so the
    // CLI keeps working while the compact /api/status endpoint is rolled out.
    let windows: Vec<Window> = obj(v)
        .and_then(|o| o.get("windows").or_else(|| o.get("limits").and_then(|l| l.get("windows"))))
        .and_then(Value::as_array)
        .map(|arr| arr.iter().map(parse_window).collect())
        .unwrap_or_default();

    let unavailable = obj(v)
        .and_then(|o| o.get("unavailable").or_else(|| o.get("limits").and_then(|l| l.get("unavailable"))))
        .and_then(|u| match u {
            Value::String(s) => Some(s.clone()),
            Value::Object(_) => str_field(u, &["message", "reason"])
                .map(str::to_string),
            _ => None,
        });

    Account {
        id: str_field(v, &["id"]).unwrap_or("").to_string(),
        provider: str_field(v, &["provider", "driver"]).unwrap_or("").to_string(),
        label: str_field(v, &["label", "displayName", "name"])
            .map(str::to_string)
            .or_else(|| str_field(v, &["id"]).map(str::to_string))
            .unwrap_or_default(),
        windows,
        unavailable,
    }
}

impl Status {
    pub fn parse(body: &str) -> Result<Status, String> {
        let value: Value = serde_json::from_str(body).map_err(|e| format!("invalid status JSON: {e}"))?;
        if obj(&value).is_none() {
            return Err("status JSON is not an object".into());
        }
        let accounts = arr_field(&value, &["accounts"]).iter().map(parse_account).collect();
        let worst = obj(&value).and_then(|o| o.get("worst")).and_then(|w| {
            if obj(w).is_none() { return None; }
            let used = f64_field(w, &["usedPercent"]).unwrap_or(0.0);
            let remaining = f64_field(w, &["remainingPercent"]).unwrap_or_else(|| 100.0 - used);
            Some(Worst {
                account_id: str_field(w, &["accountId"]).unwrap_or("").to_string(),
                provider: str_field(w, &["provider"]).unwrap_or("").to_string(),
                window_id: str_field(w, &["windowId"]).unwrap_or("").to_string(),
                label: str_field(w, &["label"]).unwrap_or("").to_string(),
                remaining,
                resets_at: str_field(w, &["resetsAt", "resets_at"]).map(str::to_string),
            })
        });
        let notices = arr_field(&value, &["notices"])
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        Ok(Status {
            checked_at: str_field(&value, &["checkedAt", "createdAt"]).map(str::to_string),
            accounts,
            worst,
            notices,
        })
    }

    /// Select (account, window) pairs matching an optional provider and kind.
    pub fn selected<'a>(&'a self, provider: Option<&str>, kind: Option<&str>) -> Vec<(&'a Account, &'a Window)> {
        let mut out = Vec::new();
        for account in &self.accounts {
            if let Some(p) = provider {
                if !account.provider.eq_ignore_ascii_case(p) && !account.id.eq_ignore_ascii_case(p) {
                    continue;
                }
            }
            for window in &account.windows {
                if let Some(k) = kind {
                    if !window.kind.eq_ignore_ascii_case(k) { continue; }
                }
                out.push((account, window));
            }
        }
        out
    }

    /// The window to use for Waybar / the worst-line fallback.
    pub fn worst_window(&self) -> Option<&Window> {
        if let Some(ref w) = self.worst {
            let by_id = self.accounts.iter().flat_map(|a| a.windows.iter())
                .find(|win| win.id == w.window_id);
            if let Some(win) = by_id { return Some(win); }
        }
        self.accounts.iter()
            .flat_map(|a| a.windows.iter())
            .max_by(|a, b| {
                format::state_rank(&a.state).cmp(&format::state_rank(&b.state))
                    .then_with(|| a.used.partial_cmp(&b.used).unwrap_or(std::cmp::Ordering::Equal))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "checkedAt":"2026-11-20T12:00:00Z","hostLabel":"box","notices":[],
      "accounts":[
        {"id":"claude-Kernel","provider":"claudeAgent","label":"Claude Kernel",
         "windows":[
           {"id":"five_hour","kind":"session","label":"5h","usedPercent":27,"remainingPercent":73,"resetsAt":"1970-01-01T03:57:00Z","state":"ok"},
           {"id":"seven_day","kind":"weekly","label":"7d","usedPercent":47,"remainingPercent":53,"state":"ok"}
         ]}
      ],
      "worst":{"accountId":"claude-Kernel","provider":"claudeAgent","windowId":"five_hour","label":"5h","remainingPercent":73,"resetsAt":"1970-01-01T03:57:00Z"}
    }"#;

    #[test]
    fn parses_compact_status() {
        let s = Status::parse(SAMPLE).unwrap();
        assert_eq!(s.accounts.len(), 1);
        assert_eq!(s.accounts[0].label, "Claude Kernel");
        assert_eq!(s.accounts[0].windows.len(), 2);
        assert_eq!(s.accounts[0].windows[0].used, 27.0);
        assert_eq!(s.accounts[0].windows[1].remaining, 53.0);
        assert_eq!(s.worst.as_ref().unwrap().window_id, "five_hour");
        assert_eq!(s.worst_window().unwrap().id, "five_hour");
    }

    #[test]
    fn selection_filters() {
        let s = Status::parse(SAMPLE).unwrap();
        assert_eq!(s.selected(Some("claudeagent"), Some("weekly")).len(), 1);
        assert!(s.selected(Some("codex"), None).is_empty());
        assert_eq!(s.selected(None, Some("session")).len(), 1);
    }

    #[test]
    fn parses_legacy_limits_shape() {
        let body = r#"{"createdAt":"x","accounts":[{"id":"a","provider":"p","label":"L",
            "limits":{"windows":[{"id":"w","kind":"session","label":"s","usedPercent":10}],
            "unavailable":{"reason":"probeFailed","message":"boom"}}}]}"#;
        let s = Status::parse(body).unwrap();
        assert_eq!(s.accounts[0].windows[0].remaining, 90.0);
        assert_eq!(s.accounts[0].unavailable.as_deref(), Some("boom"));
        assert_eq!(s.checked_at.as_deref(), Some("x"));
    }

    #[test]
    fn rejects_non_json() {
        assert!(Status::parse("nope").is_err());
        assert!(Status::parse("[]").is_err());
    }
}
