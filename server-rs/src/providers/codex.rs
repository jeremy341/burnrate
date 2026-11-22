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

/// `wham/usage` is an undocumented endpoint (UNVERIFIED): `reset_at` is assumed to be epoch
/// seconds, but tolerate an epoch-milliseconds payload as statusline.rs does so a unit change
/// cannot place the reset in year ~58,000.
fn reset_ms(value: f64) -> Option<f64> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    Some(if value > 1e11 { value } else { value * 1000.0 })
}

fn to_window(id: &str, w: Option<&Value>) -> Option<Window> {
    let w = w?;
    let used = w.get("used_percent")?.as_f64()?;
    let mins = w.get("limit_window_seconds").and_then(Value::as_f64).filter(|s| *s > 0.0).map(|s| s / 60.0);
    let kind = if mins.is_some_and(|m| m >= 60.0 * 24.0 * 5.0) { "weekly" } else { "session" };
    let reset_ms = match (w.get("reset_at").and_then(Value::as_f64).and_then(reset_ms), w.get("reset_after_seconds").and_then(Value::as_f64)) {
        (Some(at), _) => Some(at),
        (None, Some(after)) => Some(crate::types::parse_rfc3339_ms(&iso_now()).unwrap_or(0.0) + after * 1000.0),
        _ => None,
    };
    // The `wham/usage` endpoint is an undocumented Codex endpoint: `unofficial`.
    Some(Window::new(id, kind, if kind == "weekly" { "Weekly" } else { "Session" }, used).provenance("unofficial").resets(reset_ms.and_then(iso_ms)).mins(mins.map(f64::round)))
}

/// `auth.json` holds a ChatGPT login (an access token), not just an API key or an empty shell.
/// The Codex CLI itself refuses to run without one, and `wham/usage` needs the token.
pub fn login_present(path: &std::path::Path) -> bool {
    read_json(path)
        .and_then(|a| a.pointer("/tokens/access_token").and_then(Value::as_str).map(|t| !t.trim().is_empty()))
        .unwrap_or(false)
}

/// The signed-in ChatGPT address, read from the unverified payload of the `id_token` the Codex CLI stores
/// locally. Display only: nothing is trusted or sent anywhere, and a missing/odd token just yields `None`.
fn id_token_email(id_token: &str) -> Option<String> {
    use base64::Engine;
    let payload = id_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    claims.get("email").and_then(Value::as_str).map(str::trim).filter(|e| e.contains('@')).map(str::to_string)
}

/// Where the Codex CLI keeps its login (`CODEX_HOME` or `~/.codex`).
pub fn auth_file() -> PathBuf {
    auth_path()
}

/// The discovered label of the ChatGPT login for the provider list: the signed-in e-mail when the
/// locally stored `id_token` carries one, otherwise "ChatGPT login". The user's nickname for
/// `codex/chatgpt-login` (if set) is applied on top of this in the accounts API.
pub fn chatgpt_label() -> String {
    read_json(&auth_path())
        .and_then(|a| a.pointer("/tokens/id_token").and_then(Value::as_str).and_then(id_token_email))
        .unwrap_or_else(|| "ChatGPT login".into())
}

pub struct Codex;

impl Provider for Codex {
    fn id(&self) -> &'static str {
        "codex"
    }
    fn label(&self) -> &'static str {
        // This driver serves ChatGPT plan limits (Plus/Pro) through the Codex login.
        "Codex (ChatGPT)"
    }
    fn color(&self) -> &'static str {
        "var(--contrast-foreground)"
    }
    fn auth(&self) -> Auth {
        Auth::LocalLogin
    }
    fn hint(&self) -> &'static str {
        "Sign in with your ChatGPT account"
    }
    fn has_login(&self) -> bool {
        login_present(&auth_path())
    }
    fn read(&self, _keys: &KeyStore) -> Vec<Value> {
        let Some(tokens) = read_json(&auth_path()).and_then(|a| a.get("tokens").cloned()) else { return Vec::new() };
        let Some(token) = tokens.get("access_token").and_then(Value::as_str).filter(|t| !t.is_empty()) else { return Vec::new() };
        let mut head = json!({"id": "chatgpt-login", "driver": "codex", "label": "ChatGPT login", "displayName": "ChatGPT login"});
        if let Some(email) = tokens.get("id_token").and_then(Value::as_str).and_then(id_token_email) {
            head["email"] = json!(email);
        }
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
                    if let Some(plan) = body.get("plan_type").and_then(Value::as_str).and_then(plan_label) {
                        head["plan"] = json!(plan);
                    }
                    // Native windows are the answer here; no "open ChatGPT usage" external card.
                    vec![account_with(head, windows)]
                }
                Err(e) => vec![unavailable_account(head, format!("Codex usage unavailable ({e})."))],
            },
            Err(ureq::Error::Status(401 | 403, _)) => vec![unavailable_account(head, login_expired_message("ChatGPT"))],
            Err(ureq::Error::Status(code, _)) => vec![unavailable_account(head, format!("Codex usage unavailable (HTTP {code})."))],
            Err(_) => vec![unavailable_account(head, "Codex usage unavailable (error).".into())],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_windows_are_labelled_unofficial() {
        let w = to_window("primary", Some(&json!({"used_percent": 42.0, "limit_window_seconds": 300.0, "reset_at": 1784589600.0}))).expect("window");
        assert_eq!(w.provenance, Some("unofficial"));
        assert_eq!(w.kind, "session");
        assert!(w.resets_at.is_some());
        assert!(is_login_expired(&login_expired_message("ChatGPT")));
    }

    #[test]
    fn a_login_needs_an_access_token() {
        let dir = std::env::temp_dir().join(format!("burnrate-codex-login-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("auth.json");
        assert!(!login_present(&file), "missing file");
        std::fs::write(&file, br#"{"OPENAI_API_KEY":"x"}"#).unwrap();
        assert!(!login_present(&file), "an API key alone is not a ChatGPT login");
        std::fs::write(&file, br#"{"tokens":{"access_token":"  "}}"#).unwrap();
        assert!(!login_present(&file));
        std::fs::write(&file, br#"{"tokens":{"access_token":"throwaway"}}"#).unwrap();
        assert!(login_present(&file));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_login_email_comes_from_the_local_id_token() {
        use base64::Engine;
        let enc = |v: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
        let token = format!("{}.{}.sig", enc(&json!({"alg": "none"})), enc(&json!({"email": "me@example.com"})));
        assert_eq!(id_token_email(&token).as_deref(), Some("me@example.com"));
        assert_eq!(id_token_email("not-a-jwt"), None);
        let no_email = format!("h.{}.s", enc(&json!({"sub": "x"})));
        assert_eq!(id_token_email(&no_email), None);
    }

    #[test]
    fn reset_at_tolerates_seconds_or_milliseconds() {
        assert_eq!(reset_ms(1_784_589_600.0), Some(1_784_589_600_000.0));
        assert_eq!(reset_ms(1_784_589_600_000.0), Some(1_784_589_600_000.0));
        assert_eq!(reset_ms(0.0), None);
        assert_eq!(reset_ms(f64::NAN), None);
    }
}
