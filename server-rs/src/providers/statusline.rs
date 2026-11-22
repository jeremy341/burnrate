//! Claude Code statusline ingest (contracts section 8).
//!
//! Claude Code passes a JSON object to a `statusLine` command on every assistant turn. It contains
//! official `rate_limits` that we can use without credentials. We keep only the two documented
//! windows in memory for 15 minutes; nothing is written to disk and no token is read or refreshed
//! here. This is a push source, not a poller: entries expire and are pruned on access.

use super::{iso_ms, Window};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Freshness of an ingested snapshot. Statusline data is a supplement, not a history source.
pub const TTL_MS: i64 = 15 * 60 * 1000;
/// Used when the payload has no transcript path to map back to a Claude config directory.
pub const DEFAULT_KEY: &str = "default";

#[derive(Clone)]
struct Entry {
    windows: Vec<Window>,
    received_ms: i64,
}

static STORE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();

fn store() -> &'static Mutex<HashMap<String, Entry>> {
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Entry>> {
    store().lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn prune(map: &mut HashMap<String, Entry>, now: i64) {
    // The absolute form also handles a system clock that jumped backwards.
    map.retain(|_, e| now.saturating_sub(e.received_ms) < TTL_MS && e.received_ms.saturating_sub(now) < TTL_MS);
}

/// Stable key for a config dir. Windows and POSIX separators are both accepted by `Path` on the
/// host platform; normalising case and separators keeps lookups consistent across WSL/Windows.
pub fn normalise_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_ascii_lowercase()
}

/// Claude config dirs hold a `projects/` folder. The statusline payload gives us a transcript path
/// inside it, so the folder's parent identifies the account (one config dir per Claude login).
pub fn config_dir_from_body(body: &Value) -> Option<PathBuf> {
    let raw = body.get("transcript_path").and_then(Value::as_str)?;
    // Accept either separator so a transcript written on one OS resolves its `.claude` folder even
    // when it is read on another (synced folders, CI, copied projects).
    let parts: Vec<&str> = raw.split(['/', '\\']).filter(|part| !part.is_empty()).collect();
    let projects = parts.iter().position(|part| *part == "projects")?;
    if projects == 0 {
        return None;
    }
    let head = &parts[..projects];
    let dir = if raw.starts_with('/') {
        format!("/{}", head.join("/"))
    } else if head.first().is_some_and(|part| part.ends_with(':')) {
        // Windows drive ("C:"): keep the colon and use a separator after it.
        format!("{}/{}", head[0], head[1..].join("/"))
    } else {
        head.join("/")
    };
    Some(PathBuf::from(dir))
}

fn reset_ms(value: f64) -> Option<f64> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    // Claude Code reports epoch seconds; tolerate an epoch-milliseconds payload too.
    Some(if value > 1e11 { value } else { value * 1000.0 })
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).or_else(|| value.and_then(Value::as_str).and_then(|s| s.parse().ok()))
}

/// Map the statusline `rate_limits` object to the UI's window shape. Both windows may be absent
/// (free accounts, or before the first API response) and are simply skipped.
pub fn statusline_windows(body: &Value) -> Vec<Window> {
    let Some(limits) = body.get("rate_limits").filter(|v| v.is_object()) else {
        return Vec::new();
    };
    let mut windows = Vec::new();
    for (field, kind, label, mins) in [
        ("five_hour", "session", "Session", 300.0),
        ("seven_day", "weekly", "Weekly", 10080.0),
    ] {
        let Some(bucket) = limits.get(field).filter(|v| v.is_object()) else { continue };
        let Some(used) = number(bucket.get("used_percentage")).filter(|u| u.is_finite()) else { continue };
        let resets = number(bucket.get("resets_at")).and_then(reset_ms).and_then(iso_ms);
        // The label is a constant, so leaking a transcript/model name through a window id is not possible.
        windows.push(Window::new(field, kind, label, used).provenance("statusline").mins(Some(mins)).resets(resets));
    }
    windows
}

/// Store a payload. Returns the number of windows cached (0 for a payload without rate limits).
pub fn ingest(body: &Value) -> usize {
    let windows = statusline_windows(body);
    let now = now_ms();
    let key = config_dir_from_body(body).map(|p| normalise_key(&p)).unwrap_or_else(|| DEFAULT_KEY.into());
    let count = windows.len();
    let mut map = lock();
    prune(&mut map, now);
    // Only use the fallback when the payload has no transcript path, so two accounts sharing one
    // server never see each other's numbers through a mismatched config dir.
    map.insert(key, Entry { windows, received_ms: now });
    count
}

/// Fresh windows for a Claude config dir, or the last fallback snapshot. Expired entries are
/// dropped here rather than by a timer: there is no background work while nobody is looking.
pub fn fresh_for(dir: &Path) -> Option<Vec<Window>> {
    let now = now_ms();
    let mut map = lock();
    prune(&mut map, now);
    map.get(&normalise_key(dir))
        .or_else(|| map.get(DEFAULT_KEY))
        .map(|e| e.windows.clone())
        .filter(|windows| !windows.is_empty())
}

#[cfg(test)]
pub fn clear_for_test() {
    lock().clear();
}

#[cfg(test)]
pub fn age_for_test(key: &str, by_ms: i64) {
    if let Some(entry) = lock().get_mut(key) {
        entry.received_ms -= by_ms;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::claude::choose_source;
    use serde_json::json;
    use std::sync::Mutex;

    // The store and the settings snapshot are process globals: keep the tests that touch them in
    // one serialised group so parallel test threads cannot see each other's fixtures.
    use crate::providers::TEST_GLOBALS as GLOBAL;

    const STATUSLINE: &str = include_str!("claude-statusline.json");
    const EMPTY: &str = include_str!("claude-statusline-empty.json");

    #[test]
    fn maps_rate_limits_to_statusline_windows() {
        let body: Value = serde_json::from_str(STATUSLINE).expect("fixture");
        let windows = statusline_windows(&body);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].id, "five_hour");
        assert_eq!(windows[0].kind, "session");
        assert!((windows[0].used - 47.0).abs() < f64::EPSILON);
        assert_eq!(windows[0].mins, Some(300.0));
        assert_eq!(windows[0].provenance, Some("statusline"));
        assert!(windows[0].resets_at.is_some(), "epoch seconds must become an ISO timestamp");
        assert_eq!(windows[1].id, "seven_day");
        assert_eq!(windows[1].kind, "weekly");
        assert!((windows[1].used - 36.0).abs() < f64::EPSILON);
        assert_eq!(windows[1].provenance, Some("statusline"));
        let json = windows[0].json();
        assert_eq!(json["provenance"], "statusline");
    }

    #[test]
    fn missing_or_null_rate_limits_produce_no_windows() {
        assert!(statusline_windows(&json!({})).is_empty());
        let empty: Value = serde_json::from_str(EMPTY).expect("fixture");
        assert!(statusline_windows(&empty).is_empty());
        assert!(statusline_windows(&json!({"rate_limits": {"five_hour": {"resets_at": 1}}})).is_empty());
    }

    #[test]
    fn config_dir_comes_from_the_transcript_path_on_both_platforms() {
        let windows = json!({"transcript_path": "C:\\Users\\tester\\.claude\\projects\\-C--proj\\s.jsonl"});
        assert_eq!(config_dir_from_body(&windows).unwrap().to_string_lossy().replace('\\', "/"), "C:/Users/tester/.claude");
        let unix = json!({"transcript_path": "/home/tester/.claude/projects/-home-tester/s.jsonl"});
        assert_eq!(config_dir_from_body(&unix).unwrap(), Path::new("/home/tester/.claude"));
        assert!(config_dir_from_body(&json!({"transcript_path": "/tmp/notes.jsonl"})).is_none());
    }

    #[test]
    fn ingest_maps_by_account_and_expires_after_fifteen_minutes() {
        let _guard = GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        clear_for_test();
        let body: Value = serde_json::from_str(STATUSLINE).expect("fixture");
        let dir = config_dir_from_body(&body).expect("config dir");
        assert_eq!(ingest(&body), 2);
        assert_eq!(fresh_for(&dir).map(|w| w.len()), Some(2));
        assert!(fresh_for(Path::new("/somewhere/else")).is_none(), "no cross-account fallback");

        // A payload without a transcript path is stored under the fallback key only.
        let mut anonymous: Value = serde_json::from_str(STATUSLINE).expect("fixture");
        anonymous.as_object_mut().expect("object").remove("transcript_path");
        assert_eq!(ingest(&anonymous), 2);
        assert_eq!(fresh_for(Path::new("/somewhere/else")).map(|w| w.len()), Some(2));

        age_for_test(&normalise_key(&dir), TTL_MS + 1);
        age_for_test(DEFAULT_KEY, TTL_MS + 1);
        assert!(fresh_for(&dir).is_none());
        clear_for_test();
    }

    #[test]
    fn source_selection_never_refreshes_another_apps_tokens() {
        // With the probe disabled we either read the user's own statusline push, or nothing at all.
        // There is deliberately no code path here that writes to Claude's config dir or asks
        // Anthropic for a new token: another application's credentials are not ours to refresh.
        assert_eq!(choose_source(true, false), crate::providers::claude::ProbeSource::Statusline);
        assert_eq!(choose_source(false, false), crate::providers::claude::ProbeSource::Transcripts);
        assert_eq!(choose_source(true, true), crate::providers::claude::ProbeSource::OAuth);
        assert_eq!(choose_source(false, true), crate::providers::claude::ProbeSource::OAuth);
    }
}
