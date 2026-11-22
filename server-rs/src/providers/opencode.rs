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

/// API keys OpenCode's `auth.json` holds for the Go plan or the shared Zen gateway (either can read Go usage).
fn auth_file_keys(path: &std::path::Path) -> Vec<String> {
    let Some(auth) = read_json(path) else { return Vec::new() };
    ["opencode-go", "opencode"]
        .iter()
        .filter_map(|id| auth.get(*id))
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("api"))
        .filter_map(|entry| entry.get("key").and_then(Value::as_str))
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
        .collect()
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
    stored.get("key").and_then(Value::as_str).map(str::trim).filter(|k| !k.is_empty()).map(str::to_string)
}

/// A Zen key can exist without a Go subscription: omitted windows must be skipped, not shown as
/// a fabricated 0% window (contrast grok.rs, which only synthesises 0 when a period exists).
fn window(id: &str, kind: &'static str, label: &str, w: &Value, mins: Option<f64>) -> Option<Window> {
    let used = w.get("percent").and_then(Value::as_f64).filter(|p| p.is_finite())?;
    let resets = w.get("resetsAt").and_then(Value::as_str).and_then(crate::types::parse_rfc3339_ms).and_then(iso_ms);
    // The Zen usage endpoint is not a documented public API: `unofficial`.
    Some(Window::new(id, kind, label, used).provenance("unofficial").resets(resets).mins(mins))
}

/// OpenCode itself holds a Go/Zen key (opencode.db, auth.json or `OPENCODE_API_KEY`).
pub fn go_key_present() -> bool {
    stored_key("opencode-go").is_some()
        || stored_key("opencode").is_some()
        || !auth_file_keys(&auth_path()).is_empty()
        || std::env::var("OPENCODE_API_KEY").is_ok_and(|k| !k.trim().is_empty())
}

/// OpenCode has left its data on this computer (file existence only: no credential is opened).
/// This is what lets the UI offer "Use my local OpenCode login" before the user has opted in.
pub fn local_install_present() -> bool {
    auth_path().exists() || db_path().exists() || std::env::var("OPENCODE_API_KEY").is_ok_and(|k| !k.trim().is_empty())
}

/// Keys OpenCode holds, de-duplicated and without any that is also saved in Burnrate's own store.
fn candidate_keys(found: impl IntoIterator<Item = Option<String>>, saved_here: &HashSet<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    found.into_iter().flatten().filter(|k| !k.is_empty() && !saved_here.contains(k) && seen.insert(k.clone())).collect()
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
    fn key_url(&self) -> Option<String> {
        Some("https://opencode.ai/auth".into())
    }
    // A Go key pasted into Burnrate is saved under the `opencode-go` definition
    // (server-rs/defs/opencode-go.toml), which reads it and shows its own account
    // (`opencode-go-<name>`). This native reader covers keys OpenCode itself holds (opencode.db,
    // auth.json, env) and steps aside whenever a Go key is saved there, so one quota never shows twice.
    fn read(&self, keys: &KeyStore) -> Vec<Value> {
        Self::read_local_go(
            keys,
            || {
                [stored_key("opencode-go"), stored_key("opencode")]
                    .into_iter()
                    .chain(auth_file_keys(&auth_path()).into_iter().map(Some))
                    .chain([std::env::var("OPENCODE_API_KEY").ok().map(|k| k.trim().to_string())])
            },
            &agent(),
            "https://opencode.ai/zen/go/v1/usage",
        )
    }
}

impl OpenCode {
    fn read_local_go<I: IntoIterator<Item = Option<String>>>(
        keys: &KeyStore,
        local_credentials: impl FnOnce() -> I,
        http: &ureq::Agent,
        usage_url: &str,
    ) -> Vec<Value> {
        // Provider::read only receives the key store. Read the settings file from the same data
        // directory so a settings patch or reset takes effect on the next read without a restart.
        let settings = read_json(&keys.data_dir().join("settings.json")).unwrap_or(Value::Null);
        if !crate::defs::experimental_enabled("opencodeGoLocalCredentials", &settings) {
            return Vec::new();
        }
        // A Go key saved in Burnrate is managed by the `opencode-go` definition. Reading OpenCode's
        // own login as well would show the same subscription twice when the two tokens differ, so
        // the definition wins and the native reader stays out of the way.
        if !keys.list("opencode-go").is_empty() {
            return Vec::new();
        }
        let keys = candidate_keys(local_credentials(), &HashSet::new());
        if keys.is_empty() {
            return Vec::new();
        }
        let head = json!({"id": "opencode-go", "driver": "opencode", "label": "OpenCode Go", "displayName": "OpenCode Go"});
        let mut last: Option<Result<ureq::Response, ureq::Error>> = None;
        for key in &keys {
            let res = http.get(usage_url).set("Authorization", &format!("Bearer {key}")).call();
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
                    let windows: Vec<Window> = [
                        window("go_rolling", "session", "Go · Session", u.get("rolling").unwrap_or(&Value::Null), Some(300.0)),
                        window("go_weekly", "weekly", "Go · Weekly", u.get("weekly").unwrap_or(&Value::Null), Some(10080.0)),
                        window("go_monthly", "monthly", "Go · Monthly", u.get("monthly").unwrap_or(&Value::Null), None),
                    ]
                    .into_iter()
                    .flatten()
                    .collect();
                    // A Zen-only key answers 200 without any Go window: there is no Go plan to show.
                    if windows.is_empty() {
                        return Vec::new();
                    }
                    vec![account_with(head, windows)]
                }
                Err(e) => vec![unavailable_account(head, format!("OpenCode Go could not read usage ({e})."))],
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn go_test_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("burnrate-go-{tag}-{}-{}", std::process::id(), rand::random::<u64>()))
    }

    #[test]
    fn local_go_credentials_are_never_read_or_fetched_by_default() {
        let dir = go_test_dir("default");
        let keys = KeyStore::open(&dir);
        let auth = dir.join("auth.json");
        std::fs::write(&auth, r#"{"opencode-go":{"type":"api","key":"test-go-key"}}"#).unwrap();
        let read_credentials = std::cell::Cell::new(false);
        let accounts = OpenCode::read_local_go(
            &keys,
            || {
                read_credentials.set(true);
                auth_file_keys(&auth).into_iter().map(Some)
            },
            &agent(),
            "http://127.0.0.1:1/usage",
        );
        assert!(!read_credentials.get());
        assert!(accounts.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn opting_in_fetches_go_windows_and_removing_credentials_stops_fetching() {
        use std::time::Duration;
        let dir = go_test_dir("opt-in");
        let keys = KeyStore::open(&dir);
        let settings = crate::settings::SettingsStore::open(&dir);
        settings.patch(&json!({"advanced": {"experimental": {"opencodeGoLocalCredentials": true}}})).unwrap();
        let auth = dir.join("auth.json");
        std::fs::write(&auth, r#"{"opencode-go":{"type":"api","key":" test-go-key "}}"#).unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/usage", server.server_addr().to_ip().unwrap());
        let client = ureq::AgentBuilder::new().timeout(Duration::from_secs(5)).try_proxy_from_env(false).build();
        let read = || OpenCode::read_local_go(&keys, || auth_file_keys(&auth).into_iter().map(Some), &client, &url);
        let accounts = std::thread::scope(|scope| {
            scope.spawn(|| {
                let request = server.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
                assert_eq!(request.url(), "/usage");
                assert!(request.headers().iter().any(|h| h.field.equiv("Authorization") && h.value.as_str() == "Bearer test-go-key"));
                request.respond(tiny_http::Response::from_string(r#"{"usage":{"rolling":{"percent":17}}}"#)).unwrap();
            });
            read()
        });
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0]["id"], "opencode-go");
        assert_eq!(accounts[0]["limits"]["windows"][0]["id"], "go_rolling");

        std::fs::write(&auth, r#"{"opencode-go":{"type":"api","key":" "}}"#).unwrap();
        assert!(read().is_empty());
        assert!(server.try_recv().unwrap().is_none());

        settings.patch(&json!({"advanced": {"experimental": {"opencodeGoLocalCredentials": false}}})).unwrap();
        let accounts = OpenCode::read_local_go(
            &keys,
            || -> Vec<Option<String>> { panic!("local credential discovery ran after opting out") },
            &client,
            &url,
        );
        assert!(accounts.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_saved_go_key_stops_the_native_reader_from_double_reporting() {
        let dir = go_test_dir("saved");
        let keys = KeyStore::open(&dir);
        let settings = crate::settings::SettingsStore::open(&dir);
        settings.patch(&json!({"advanced": {"experimental": {"opencodeGoLocalCredentials": true}}})).unwrap();
        keys.set("opencode-go", "work", "saved-go-key");
        let read_credentials = std::cell::Cell::new(false);
        let accounts = OpenCode::read_local_go(
            &keys,
            || {
                read_credentials.set(true);
                vec![Some("other-go-key".to_string())]
            },
            &agent(),
            "http://127.0.0.1:1/usage",
        );
        assert!(!read_credentials.get(), "the definition already covers this subscription");
        assert!(accounts.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn opencode_windows_are_labelled_unofficial() {
        let w = window("go_rolling", "session", "Go · Session", &json!({"percent": 7.0}), Some(300.0)).expect("window");
        assert_eq!(w.provenance, Some("unofficial"));
        assert!((w.used - 7.0).abs() < f64::EPSILON);
    }

    #[test]
    fn a_key_saved_in_burnrate_is_not_read_a_second_time() {
        let saved: HashSet<String> = ["go-key".to_string()].into_iter().collect();
        let found = vec![Some("go-key".to_string()), Some("zen-key".to_string()), None, Some("zen-key".to_string()), Some(String::new())];
        assert_eq!(candidate_keys(found, &saved), vec!["zen-key".to_string()]);
        assert!(candidate_keys(vec![Some("go-key".to_string())], &saved).is_empty(), "same quota, one card");
        assert_eq!(candidate_keys(vec![Some("a".to_string())], &HashSet::new()), vec!["a".to_string()]);
    }

    #[test]
    fn missing_windows_are_skipped_not_fabricated() {
        // A Zen key without a Go subscription omits rolling/weekly/monthly entirely.
        assert!(window("go_rolling", "session", "Go · Session", &Value::Null, Some(300.0)).is_none());
        assert!(window("go_weekly", "weekly", "Go · Weekly", &json!({"resetsAt": "2026-11-20T00:00:00Z"}), Some(10080.0)).is_none());
        // A genuine 0% is still a real window.
        let w = window("go_weekly", "weekly", "Go · Weekly", &json!({"percent": 0.0}), Some(10080.0)).expect("window");
        assert_eq!(w.used, 0.0);
    }
}
