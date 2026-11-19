use super::*;
use crate::readers::{env_path, home};
use std::path::PathBuf;

fn auth_path() -> PathBuf {
    env_path("CODEX_HOME").unwrap_or_else(|| home().join(".codex")).join("auth.json")
}

fn plan_label(plan: &str) -> Option<&'static str> {
    match plan {
        "plus" => Some("ChatGPT Plus Subscription"),
        "pro" => Some("ChatGPT Pro 200 Subscription"),
        "prolite" => Some("ChatGPT Pro 100 Subscription"),
        _ => None,
    }
}

fn to_window(id: &str, w: Option<&Value>) -> Option<Window> {
    let w = w?;
    let used = w.get("used_percent")?.as_f64()?;
    let mins = w.get("limit_window_seconds").and_then(Value::as_f64).filter(|s| *s > 0.0).map(|s| s / 60.0);
    let kind = if mins.is_some_and(|m| m >= 60.0 * 24.0 * 5.0) { "weekly" } else { "session" };
    let reset_ms = match (w.get("reset_at").and_then(Value::as_f64).filter(|r| *r > 0.0), w.get("reset_after_seconds").and_then(Value::as_f64)) {
        (Some(at), _) => Some(at * 1000.0),
        (None, Some(after)) => Some(crate::types::parse_rfc3339_ms(&iso_now()).unwrap_or(0.0) + after * 1000.0),
        _ => None,
    };
    Some(Window::new(id, kind, if kind == "weekly" { "Weekly" } else { "Session" }, used).resets(reset_ms.and_then(iso_ms)).mins(mins.map(f64::round)))
}

pub struct Codex;

impl Provider for Codex {
    fn id(&self) -> &'static str {
        "codex"
    }
    fn label(&self) -> &'static str {
        "Codex"
    }
    fn color(&self) -> &'static str {
        "var(--contrast-foreground)"
    }
    fn auth(&self) -> Auth {
        Auth::LocalLogin
    }
    fn has_login(&self) -> bool {
        auth_path().exists()
    }
    fn read(&self, _keys: &KeyStore) -> Vec<Value> {
        let Some(tokens) = read_json(&auth_path()).and_then(|a| a.get("tokens").cloned()) else { return Vec::new() };
        let Some(token) = tokens.get("access_token").and_then(Value::as_str).filter(|t| !t.is_empty()) else { return Vec::new() };
        let head = json!({"id": "chatgpt-login", "driver": "codex", "label": "ChatGPT login", "displayName": "ChatGPT login"});
        let mut request = agent()
            .get("https://chatgpt.com/backend-api/wham/usage")
            .set("Authorization", &format!("Bearer {token}"))
            .set("OpenAI-Beta", "codex-1")
            .set("Originator", "Codex Desktop");
        if let Some(account) = tokens.get("account_id").and_then(Value::as_str) {
            request = request.set("Chatgpt-Account-Id", account);
        }
        match request.call() {
            Ok(res) => match res.into_json::<Value>() {
                Ok(body) => {
                    let windows: Vec<Window> = [to_window("primary", body.pointer("/rate_limit/primary_window")), to_window("secondary", body.pointer("/rate_limit/secondary_window"))].into_iter().flatten().collect();
                    let mut head = head;
                    if let Some(plan) = body.get("plan_type").and_then(Value::as_str).and_then(plan_label) {
                        head["plan"] = json!(plan);
                    }
                    let mut account = account_with(head, windows);
                    account["limits"]["externalUsage"] = json!({"label": "ChatGPT usage", "url": "https://chatgpt.com/#settings/Usage"});
                    vec![account]
                }
                Err(e) => vec![unavailable_account(head, format!("Codex usage unavailable ({e})."))],
            },
            Err(ureq::Error::Status(code, _)) => vec![unavailable_account(head, format!("Codex usage unavailable (HTTP {code})."))],
            Err(_) => vec![unavailable_account(head, "Codex usage unavailable (error).".into())],
        }
    }
}
