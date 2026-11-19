use super::*;
use crate::readers::{env_path, home};
use std::path::PathBuf;

const SESSION_MINS: f64 = 5.0 * 60.0;
const WEEK_MINS: f64 = 7.0 * 24.0 * 60.0;

fn config_dir() -> PathBuf {
    env_path("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home().join(".claude"))
}
fn credentials_path() -> PathBuf {
    config_dir().join(".credentials.json")
}
fn account_path() -> PathBuf {
    match env_path("CLAUDE_CONFIG_DIR") {
        Some(d) => d.join(".claude.json"),
        None => home().join(".claude.json"),
    }
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
        windows.push(Window::new(id, kind, label, used).mins(Some(mins)).resets(iso(bucket.get("resets_at"))));
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
        windows.push(Window::new(&format!("seven_day_{collapsed}"), "weekly", &format!("Weekly · {name}"), percent).mins(Some(WEEK_MINS)).resets(iso(limit.get("resets_at"))));
    }
    if let Some(spend) = spend_percent(usage) {
        windows.push(Window::new("monthly_spend", "monthly", "Monthly spend", spend));
    }
    windows
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
    fn has_login(&self) -> bool {
        credentials_path().exists()
    }
    fn read(&self, _keys: &KeyStore) -> Vec<Value> {
        let Some(token) = read_json(&credentials_path()).and_then(|c| c.pointer("/claudeAiOauth/accessToken").and_then(Value::as_str).map(|t| t.trim().to_string())).filter(|t| !t.is_empty()) else {
            return Vec::new();
        };
        let identity = read_json(&account_path()).and_then(|c| c.get("oauthAccount").cloned());
        let name = identity.as_ref().and_then(|i| i.get("displayName")).and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);
        let mut head = json!({"id": "claude-login", "driver": "claudeAgent", "label": name.clone().unwrap_or_else(|| "Claude login".into()), "plan": "Claude Subscription"});
        if let Some(n) = &name {
            head["displayName"] = json!(n);
        }
        if let Some(email) = identity.as_ref().and_then(|i| i.get("emailAddress")).and_then(Value::as_str) {
            head["email"] = json!(email);
        }
        let result = agent()
            .get("https://api.anthropic.com/api/oauth/usage?skip_spend=1")
            .set("Authorization", &format!("Bearer {token}"))
            .set("anthropic-beta", "oauth-2025-04-20")
            // The endpoint can answer 429 without a Claude Code user agent.
            .set("User-Agent", "claude-code/2.1.273")
            .call();
        match result {
            Ok(res) => match res.into_json::<Value>() {
                Ok(usage) => vec![account_with(head, usage_to_windows(&usage))],
                Err(e) => vec![unavailable_account(head, format!("Claude usage unavailable ({e})."))],
            },
            Err(ureq::Error::Status(code, _)) => vec![unavailable_account(head, format!("Claude usage unavailable (HTTP {code})."))],
            Err(_) => vec![unavailable_account(head, "Claude usage unavailable (error).".into())],
        }
    }
}
