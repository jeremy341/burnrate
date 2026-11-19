use super::*;
use crate::readers::opencode::data_root;
use rusqlite::{Connection, OpenFlags};
use std::collections::HashSet;

// Logic derived from T3 Code's OpenCode Go usage-limit reader (MIT, see NOTICE).
fn auth_path() -> std::path::PathBuf {
    data_root().join("auth.json")
}

fn db_path() -> std::path::PathBuf {
    data_root().join(std::env::var("OPENCODE_DB").unwrap_or_else(|_| "opencode.db".into()))
}

fn auth_file_key() -> Option<String> {
    let auth = read_json(&auth_path())?;
    let entry = auth.get("opencode-go")?;
    (entry.get("type").and_then(Value::as_str) == Some("api")).then(|| entry.get("key").and_then(Value::as_str).map(|k| k.trim().to_string())).flatten()
}

fn stored_key(integration: &str) -> Option<String> {
    let path = db_path();
    if !path.exists() {
        return None;
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let _ = db.busy_timeout(std::time::Duration::from_millis(100));
    let value: String = db
        .query_row(
            "SELECT value FROM credential WHERE integration_id = ?1 AND active IS NOT 0 ORDER BY active DESC, time_created DESC, id DESC LIMIT 1",
            [integration],
            |r| r.get(0),
        )
        .ok()?;
    let stored: Value = serde_json::from_str(&value).ok()?;
    if stored.get("type").and_then(Value::as_str) != Some("key") {
        return None;
    }
    if let Some(server) = stored.pointer("/metadata/server").and_then(Value::as_str) {
        if server.trim_end_matches('/') != "https://opencode.ai/console" {
            return None;
        }
    }
    stored.get("key").and_then(Value::as_str).map(|k| k.trim().to_string())
}

fn window(id: &str, kind: &'static str, label: &str, w: &Value, mins: Option<f64>) -> Window {
    let resets = w.get("resetsAt").and_then(Value::as_str).and_then(crate::types::parse_rfc3339_ms).and_then(iso_ms);
    Window::new(id, kind, label, w.get("percent").and_then(Value::as_f64).unwrap_or(0.0)).resets(resets).mins(mins)
}

pub struct OpenCode;

impl Provider for OpenCode {
    fn id(&self) -> &'static str {
        "opencode"
    }
    fn label(&self) -> &'static str {
        "OpenCode"
    }
    fn color(&self) -> &'static str {
        "#5b9bbd"
    }
    fn auth(&self) -> Auth {
        Auth::LocalLogin
    }
    fn has_login(&self) -> bool {
        auth_path().exists() || db_path().exists()
    }
    fn read(&self, _keys: &KeyStore) -> Vec<Value> {
        let mut seen = HashSet::new();
        let keys: Vec<String> = [stored_key("opencode"), stored_key("opencode-go"), auth_file_key(), std::env::var("OPENCODE_API_KEY").ok().map(|k| k.trim().to_string())]
            .into_iter()
            .flatten()
            .filter(|k| !k.is_empty() && seen.insert(k.clone()))
            .collect();
        if keys.is_empty() {
            return Vec::new();
        }
        let head = json!({"id": "opencode-go", "driver": "opencode", "label": "OpenCode", "displayName": "OpenCode"});
        let mut last: Option<Result<ureq::Response, ureq::Error>> = None;
        for key in &keys {
            let res = agent().get("https://opencode.ai/zen/go/v1/usage").set("Authorization", &format!("Bearer {key}")).call();
            let retry = matches!(&res, Err(ureq::Error::Status(401 | 403, _)));
            last = Some(res);
            if !retry {
                break;
            }
        }
        match last {
            // A valid Zen key can exist without a Go subscription: nothing to show.
            Some(Err(ureq::Error::Status(401 | 403, _))) | None => Vec::new(),
            Some(Err(ureq::Error::Status(code, _))) => vec![unavailable_account(head, format!("OpenCode Go could not read usage (HTTP {code})."))],
            Some(Err(_)) => vec![unavailable_account(head, "OpenCode Go could not read usage (error).".into())],
            Some(Ok(res)) => match res.into_json::<Value>() {
                Ok(body) => {
                    let u = body.get("usage").cloned().unwrap_or(Value::Null);
                    vec![account_with(
                        head,
                        vec![
                            window("go_rolling", "session", "Go · Session", u.get("rolling").unwrap_or(&Value::Null), Some(300.0)),
                            window("go_weekly", "weekly", "Go · Weekly", u.get("weekly").unwrap_or(&Value::Null), Some(10080.0)),
                            window("go_monthly", "monthly", "Go · Monthly", u.get("monthly").unwrap_or(&Value::Null), None),
                        ],
                    )]
                }
                Err(e) => vec![unavailable_account(head, format!("OpenCode Go could not read usage ({e})."))],
            },
        }
    }
}
