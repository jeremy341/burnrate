use super::*;
use crate::readers::{env_path, home};
use std::path::PathBuf;

const GROK_USAGE_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

fn grok_home() -> PathBuf {
    env_path("GROK_HOME").unwrap_or_else(|| home().join(".grok"))
}

fn read_credential() -> Option<Value> {
    // An API key or a custom deployment is not a Grok subscription login.
    if std::env::var("XAI_API_KEY").is_ok_and(|v| !v.trim().is_empty()) {
        return None;
    }
    let all = read_json(&grok_home().join("auth.json"))?;
    // Never pick an arbitrary account from other deployments stored in the same file.
    let credential = all.get("https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828").or_else(|| all.get("https://accounts.x.ai/sign-in"))?.clone();
    (credential.get("auth_mode").and_then(Value::as_str) != Some("api_key")).then_some(credential)
}

pub fn usage_to_windows(body: &Value) -> Vec<Window> {
    let period = body.pointer("/config/currentPeriod");
    let kind_name = period.and_then(|p| p.get("type")).and_then(Value::as_str).map(|t| t.trim_start_matches("USAGE_PERIOD_TYPE_")).unwrap_or("");
    let kind = match kind_name {
        "WEEKLY" => "weekly",
        "MONTHLY" => "monthly",
        _ => "other",
    };
    let parse = |v: Option<&Value>| v.and_then(Value::as_str).and_then(crate::types::parse_rfc3339_ms);
    let start = parse(period.and_then(|p| p.get("start")));
    let end = parse(period.and_then(|p| p.get("end")));
    let mins = match (start, end) {
        (Some(s), Some(e)) => ((e - s) / 60_000.0).round(),
        _ => 0.0,
    };
    let mut used = body.pointer("/config/creditUsagePercent").and_then(Value::as_f64);
    // Grok omits a zero percentage while keeping the subscription period.
    if used.is_none() && (kind == "weekly" || kind == "monthly") && start.zip(end).is_some_and(|(s, e)| s < e) {
        used = Some(0.0);
    }
    let Some(used) = used.filter(|u| u.is_finite()) else { return Vec::new() };
    let label = match kind {
        "weekly" => "Weekly",
        "monthly" => "Monthly",
        _ => "Subscription",
    };
    // The CLI billing endpoint is undocumented: `unofficial`.
    vec![Window::new("subscription", kind, label, used).provenance("unofficial").resets(end.and_then(iso_ms)).mins((mins > 0.0).then_some(mins))]
}

/// `auth.json` holds at least one stored credential with a token (the file can exist but be empty
/// after `grok logout`).
pub fn login_present(path: &std::path::Path) -> bool {
    read_json(path)
        .and_then(|all| all.as_object().map(|o| o.values().any(|c| c.get("key").and_then(Value::as_str).is_some_and(|k| !k.trim().is_empty()))))
        .unwrap_or(false)
}

/// Where the Grok CLI keeps its login (`GROK_HOME` or `~/.grok`).
pub fn auth_file() -> PathBuf {
    grok_home().join("auth.json")
}

pub struct Grok;

impl Provider for Grok {
    fn id(&self) -> &'static str {
        "grok"
    }
    fn label(&self) -> &'static str {
        "Grok"
    }
    fn color(&self) -> &'static str {
        "#8b8b8b"
    }
    fn auth(&self) -> Auth {
        Auth::LocalLogin
    }
    fn hint(&self) -> &'static str {
        "Sign in with the Grok CLI"
    }
    fn has_login(&self) -> bool {
        login_present(&grok_home().join("auth.json"))
    }
    fn read(&self, _keys: &KeyStore) -> Vec<Value> {
        let Some(credential) = read_credential() else { return Vec::new() };
        let Some(token) = credential.get("key").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) else { return Vec::new() };
        let email = credential.get("email").and_then(Value::as_str).map(str::trim).filter(|e| !e.is_empty());
        let mut head = json!({"id": "grok-login", "driver": "grok", "label": email.unwrap_or("Grok login")});
        if let Some(e) = email {
            head["email"] = json!(e);
        }
        match agent().get(GROK_USAGE_URL).set("Authorization", &format!("Bearer {token}")).call() {
            Ok(res) => match res.into_json::<Value>() {
                Ok(body) => vec![account_with(head, usage_to_windows(&body))],
                Err(e) => vec![unavailable_account(head, format!("Grok usage unavailable ({e})."))],
            },
            Err(ureq::Error::Status(403, res)) => {
                let text = res.into_string().unwrap_or_default();
                let message = if text.contains("WKE=privacy-mode:") { "Grok usage unavailable (Switch your xAI account to Privacy Mode to show Grok usage limits)." } else { "Grok usage unavailable (HTTP 403)." };
                vec![unavailable_account(head, message.into())]
            }
            Err(ureq::Error::Status(401, _)) => vec![unavailable_account(head, login_expired_message("Grok"))],
            Err(ureq::Error::Status(code, _)) => vec![unavailable_account(head, format!("Grok usage unavailable (HTTP {code})."))],
            Err(_) => vec![unavailable_account(head, "Grok usage unavailable (error).".into())],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn grok_windows_are_labelled_unofficial() {
        let body = json!({"config": {"creditUsagePercent": 15.0, "currentPeriod": {"type": "USAGE_PERIOD_TYPE_WEEKLY", "start": "2026-11-16T00:00:00Z", "end": "2026-11-23T00:00:00Z"}}});
        let windows = usage_to_windows(&body);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].provenance, Some("unofficial"));
        assert_eq!(windows[0].kind, "weekly");
    }
}
