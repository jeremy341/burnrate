//! Last-good cache and probe throttle for Claude's usage endpoint.
//!
//! `api/oauth/usage` answers HTTP 429 readily. Without this layer a 429 blanked the whole Claude
//! section. Rules (docs/CONTRACTS.md section 15):
//!  - one probe per account at most every 5 minutes, shared by every caller (the UI, the
//!    scheduler, repeated `/api/limits` calls): a call inside the interval is answered from memory;
//!  - on 429, 5xx, network and parse errors the last good windows are returned flagged stale
//!    (`limits.stale`, `limits.staleSince`) instead of an empty section;
//!  - failures back off exponentially (5, 10, 20, 30 minutes) and honour `Retry-After`;
//!  - the last good values survive a restart (`<data>/claude-usage-cache.json`, percentages and
//!    reset times only, never a token).
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

/// Never probe the same account more often than this.
pub const MIN_PROBE_INTERVAL_MS: i64 = 5 * 60 * 1000;
const MAX_BACKOFF_MS: i64 = 30 * 60 * 1000;
/// A `Retry-After` longer than this is ignored in favour of the capped backoff.
const MAX_RETRY_AFTER_MS: i64 = 24 * 60 * 60 * 1000;
const FILE_VERSION: u64 = 1;
const MAX_ENTRIES: usize = 32;

/// One successful probe.
#[derive(Clone, Debug, PartialEq)]
pub struct Good {
    pub windows: Vec<Value>,
    pub credits: Option<Value>,
    pub at_ms: i64,
}

/// Why a probe did not produce numbers.
#[derive(Debug, Clone, PartialEq)]
pub enum ProbeError {
    /// 429, 5xx, network or parse failure: show the last good values and retry later.
    Transient { message: String, retry_after_secs: Option<u64> },
    /// 401/403: the login is gone; old numbers would mislead, so nothing is served as stale.
    Auth { message: String },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Resolved {
    Fresh(Good),
    Stale { good: Good, message: String },
    Failed(String),
}

#[derive(Clone, Debug, PartialEq)]
enum Last {
    Ok,
    Transient(String),
    Auth(String),
}

struct Entry {
    good: Option<Good>,
    next_probe_ms: i64,
    failures: u32,
    last: Last,
    /// Modification time (ms) of the credentials file when a 401/403 was recorded: a different
    /// time later means the user signed in again, so the rejection no longer holds.
    auth_cred_mtime: Option<i64>,
}

pub struct Store {
    path: Option<PathBuf>,
    entries: Mutex<HashMap<String, Arc<Mutex<Entry>>>>,
}

fn parse_good(v: &Value) -> Option<Good> {
    let windows = v.get("windows")?.as_array()?.clone();
    let at_ms = v.get("at")?.as_i64()?;
    Some(Good { windows, credits: v.get("credits").filter(|c| c.is_object()).cloned(), at_ms })
}

fn parse_last(v: &Value) -> Last {
    let message = v.get("message").and_then(Value::as_str).unwrap_or("").chars().take(200).collect::<String>();
    match v.get("kind").and_then(Value::as_str) {
        Some("transient") => Last::Transient(message),
        Some("auth") => Last::Auth(message),
        _ => Last::Ok,
    }
}

impl Store {
    pub fn new(path: Option<PathBuf>) -> Store {
        let store = Store { path, entries: Mutex::new(HashMap::new()) };
        store.load();
        store
    }

    fn load(&self) {
        let Some(path) = &self.path else { return };
        let Ok(bytes) = std::fs::read(path) else { return };
        let Ok(file) = serde_json::from_slice::<Value>(&bytes) else { return };
        if file.get("version").and_then(Value::as_u64) != Some(FILE_VERSION) {
            return;
        }
        let Some(accounts) = file.get("accounts").and_then(Value::as_object) else { return };
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        for (key, v) in accounts.iter().take(MAX_ENTRIES) {
            entries.insert(
                key.clone(),
                Arc::new(Mutex::new(Entry {
                    good: v.get("good").and_then(parse_good),
                    next_probe_ms: v.get("nextProbeAt").and_then(Value::as_i64).unwrap_or(0),
                    failures: v.get("failures").and_then(Value::as_u64).unwrap_or(0).min(10) as u32,
                    last: v.get("last").map(parse_last).unwrap_or(Last::Ok),
                    auth_cred_mtime: v.get("authCredMtime").and_then(Value::as_i64),
                })),
            );
        }
    }

    fn entry(&self, key: &str) -> Arc<Mutex<Entry>> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries.len() >= MAX_ENTRIES && !entries.contains_key(key) {
            // A bounded map: account ids come from directory names on disk.
            entries.clear();
        }
        entries.entry(key.to_string()).or_insert_with(|| Arc::new(Mutex::new(Entry { good: None, next_probe_ms: 0, failures: 0, last: Last::Ok, auth_cred_mtime: None }))).clone()
    }

    /// Save every entry, taking the values of `key` (currently locked by the caller) from `entry`.
    fn persist_entry(&self, key: &str, entry: &Entry) {
        let Some(path) = &self.path else { return };
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let mut accounts = serde_json::Map::new();
        for (k, other) in entries.iter() {
            if k == key {
                accounts.insert(k.clone(), entry_json(entry));
            } else if let Ok(other) = other.try_lock() {
                accounts.insert(k.clone(), entry_json(&other));
            }
        }
        write_file(path, accounts);
    }

    /// Answer from the cache when inside the shared interval, otherwise run `probe` once.
    /// `now_ms` is injected so tests do not sleep. `cred_mtime_ms` is the credentials file's
    /// modification time: when a login was rejected and the file has changed since, the user
    /// signed in again and the next call probes at once instead of waiting out the throttle.
    pub fn resolve(&self, key: &str, now_ms: i64, cred_mtime_ms: Option<i64>, probe: impl FnOnce() -> Result<(Vec<Value>, Option<Value>), ProbeError>) -> Resolved {
        let slot = self.entry(key);
        // Held across the probe: a second caller waits and is then answered from the fresh state,
        // so there is never more than one request in flight per account.
        let mut entry = slot.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(entry.last, Last::Auth(_)) && cred_mtime_ms.is_some() && cred_mtime_ms != entry.auth_cred_mtime {
            entry.next_probe_ms = 0;
        }
        if now_ms < entry.next_probe_ms {
            return from_state(&entry);
        }
        match probe() {
            Ok((windows, credits)) => {
                entry.good = Some(Good { windows, credits, at_ms: now_ms });
                entry.failures = 0;
                entry.last = Last::Ok;
                entry.auth_cred_mtime = None;
                entry.next_probe_ms = now_ms + MIN_PROBE_INTERVAL_MS;
            }
            Err(ProbeError::Transient { message, retry_after_secs }) => {
                entry.failures = (entry.failures + 1).min(10);
                entry.last = Last::Transient(message);
                entry.auth_cred_mtime = None;
                entry.next_probe_ms = now_ms + retry_delay_ms(entry.failures, retry_after_secs);
            }
            Err(ProbeError::Auth { message }) => {
                entry.failures = 0;
                entry.last = Last::Auth(message);
                entry.auth_cred_mtime = cred_mtime_ms;
                entry.next_probe_ms = now_ms + MIN_PROBE_INTERVAL_MS;
            }
        }
        self.persist_entry(key, &entry);
        from_state(&entry)
    }

    #[cfg(test)]
    fn next_probe_ms(&self, key: &str) -> i64 {
        self.entry(key).lock().unwrap().next_probe_ms
    }
}

fn entry_json(entry: &Entry) -> Value {
    let mut v = json!({"nextProbeAt": entry.next_probe_ms, "failures": entry.failures});
    if let Some(m) = entry.auth_cred_mtime {
        v["authCredMtime"] = json!(m);
    }
    v["last"] = match &entry.last {
        Last::Ok => json!({"kind": "ok"}),
        Last::Transient(m) => json!({"kind": "transient", "message": m}),
        Last::Auth(m) => json!({"kind": "auth", "message": m}),
    };
    if let Some(good) = &entry.good {
        let mut g = json!({"at": good.at_ms, "windows": good.windows});
        if let Some(c) = &good.credits {
            g["credits"] = c.clone();
        }
        v["good"] = g;
    }
    v
}

fn write_file(path: &PathBuf, accounts: serde_json::Map<String, Value>) {
    let body = json!({"version": FILE_VERSION, "accounts": accounts});
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec(&body).unwrap_or_default()).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn from_state(entry: &Entry) -> Resolved {
    match (&entry.last, &entry.good) {
        (Last::Ok, Some(good)) => Resolved::Fresh(good.clone()),
        (Last::Transient(message), Some(good)) => Resolved::Stale { good: Good { credits: None, ..good.clone() }, message: message.clone() },
        (Last::Transient(message), None) => Resolved::Failed(message.clone()),
        (Last::Auth(message), _) => Resolved::Failed(message.clone()),
        // A cache file without a good value and a successful last attempt cannot be answered.
        (Last::Ok, None) => Resolved::Failed("Claude usage unavailable (no data yet).".into()),
    }
}

/// 5, 10, 20, 30 (capped) minutes, or the server's `Retry-After` when that is longer.
fn retry_delay_ms(failures: u32, retry_after_secs: Option<u64>) -> i64 {
    let backoff = (MIN_PROBE_INTERVAL_MS << failures.saturating_sub(1).min(8)).min(MAX_BACKOFF_MS);
    let asked = retry_after_secs.map(|s| (s.min(MAX_RETRY_AFTER_MS as u64 / 1000) as i64) * 1000).unwrap_or(0);
    backoff.max(asked).max(MIN_PROBE_INTERVAL_MS)
}

/// "Showing values from 12 minutes ago".
pub fn stale_message(at_ms: i64, now_ms: i64) -> String {
    let mins = ((now_ms - at_ms).max(0)) / 60_000;
    let age = match mins {
        0 => "less than a minute ago".to_string(),
        1 => "1 minute ago".to_string(),
        2..=119 => format!("{mins} minutes ago"),
        120..=2879 => format!("{} hours ago", mins / 60),
        _ => format!("{} days ago", mins / 1440),
    };
    format!("Showing values from {age}")
}

/// Seconds from a `Retry-After` header: a plain number (the HTTP-date form is not used by this API).
pub fn parse_retry_after(value: Option<&str>) -> Option<u64> {
    value?.trim().parse::<u64>().ok()
}

fn global_path() -> Option<PathBuf> {
    Some(crate::defs::data_dir().join("claude-usage-cache.json"))
}

/// The process-wide store every Claude read goes through.
pub fn global() -> &'static Store {
    static STORE: OnceLock<Store> = OnceLock::new();
    STORE.get_or_init(|| Store::new(global_path()))
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const T0: i64 = 1_800_000_000_000;
    const MIN: i64 = 60_000;

    fn win(percent: f64) -> Vec<Value> {
        vec![json!({"id": "five_hour", "kind": "session", "label": "Session", "usedPercent": percent})]
    }

    fn ok(percent: f64) -> Result<(Vec<Value>, Option<Value>), ProbeError> {
        Ok((win(percent), None))
    }

    fn rate_limited(after: Option<u64>) -> Result<(Vec<Value>, Option<Value>), ProbeError> {
        Err(ProbeError::Transient { message: "Claude is limiting usage checks right now. Burnrate will try again soon.".into(), retry_after_secs: after })
    }

    fn temp_file(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("burnrate-usage-cache-{tag}-{}-{}", std::process::id(), now_ms())).join("claude-usage-cache.json")
    }

    #[test]
    fn a_second_call_inside_five_minutes_never_probes() {
        let store = Store::new(None);
        let calls = Cell::new(0);
        let probe = || {
            calls.set(calls.get() + 1);
            ok(40.0)
        };
        assert!(matches!(store.resolve("a", T0, None, probe), Resolved::Fresh(_)));
        for offset in [1, 30_000, 4 * MIN, 5 * MIN - 1] {
            let again = store.resolve("a", T0 + offset, None, || {
                calls.set(calls.get() + 100);
                ok(99.0)
            });
            let Resolved::Fresh(good) = again else { panic!("expected the cached value") };
            assert_eq!(good.windows, win(40.0));
            assert_eq!(good.at_ms, T0, "the cached value keeps its own timestamp");
        }
        assert_eq!(calls.get(), 1, "one probe, however many callers");
        // After the interval the next caller probes again and gets the new number.
        let Resolved::Fresh(good) = store.resolve("a", T0 + 5 * MIN, None, || ok(55.0)) else { panic!() };
        assert_eq!(good.windows, win(55.0));
    }

    #[test]
    fn http_429_keeps_the_last_good_values_flagged_stale() {
        let store = Store::new(None);
        assert!(matches!(store.resolve("a", T0, None, || ok(40.0)), Resolved::Fresh(_)));
        let result = store.resolve("a", T0 + 6 * MIN, None, || rate_limited(None));
        let Resolved::Stale { good, message } = result else { panic!("expected stale values, got {result:?}") };
        assert_eq!(good.windows, win(40.0));
        assert_eq!(good.at_ms, T0);
        assert!(message.contains("limiting usage checks"));
        // And it stays stale (without probing) until the backoff is over.
        let calls = Cell::new(0);
        let again = store.resolve("a", T0 + 7 * MIN, None, || {
            calls.set(1);
            ok(1.0)
        });
        assert!(matches!(again, Resolved::Stale { .. }));
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn no_good_value_yet_is_a_plain_failure_not_an_empty_success() {
        let store = Store::new(None);
        let result = store.resolve("a", T0, None, || rate_limited(None));
        assert!(matches!(result, Resolved::Failed(ref m) if m.contains("limiting usage checks")));
    }

    #[test]
    fn errors_back_off_and_honour_retry_after() {
        let store = Store::new(None);
        store.resolve("a", T0, None, || ok(10.0));
        let mut now = T0 + 5 * MIN;
        for (failure, expected_delay) in [(1, 5), (2, 10), (3, 20), (4, 30), (5, 30)] {
            store.resolve("a", now, None, || rate_limited(None));
            assert_eq!(store.next_probe_ms("a"), now + expected_delay * MIN, "failure {failure}");
            now += expected_delay * MIN;
        }
        // A Retry-After longer than the backoff wins; a short one never goes below five minutes.
        store.resolve("a", now, None, || rate_limited(Some(3 * 3600)));
        assert_eq!(store.next_probe_ms("a"), now + 180 * MIN);
        let other = Store::new(None);
        other.resolve("b", T0, None, || rate_limited(Some(10)));
        assert_eq!(other.next_probe_ms("b"), T0 + 5 * MIN);
        // A success resets the backoff.
        other.resolve("b", T0 + 5 * MIN, None, || ok(5.0));
        assert_eq!(other.next_probe_ms("b"), T0 + 10 * MIN);
        other.resolve("b", T0 + 10 * MIN, None, || rate_limited(None));
        assert_eq!(other.next_probe_ms("b"), T0 + 15 * MIN);
    }

    #[test]
    fn a_rejected_login_is_never_served_as_stale_numbers() {
        let store = Store::new(None);
        store.resolve("a", T0, None, || ok(40.0));
        let result = store.resolve("a", T0 + 6 * MIN, None, || Err(ProbeError::Auth { message: crate::providers::login_expired_message("Claude Code") }));
        let Resolved::Failed(message) = result else { panic!("expected a failure") };
        assert!(crate::providers::is_login_expired(&message));
    }

    #[test]
    fn signing_in_again_lifts_the_login_expired_throttle() {
        let store = Store::new(None);
        let expired = || Err(ProbeError::Auth { message: crate::providers::login_expired_message("Claude Code") });
        // The login is rejected while the credentials file has mtime 100.
        let first = store.resolve("a", T0, Some(100), expired);
        assert!(matches!(first, Resolved::Failed(ref m) if crate::providers::is_login_expired(m)));
        // Same file, inside the interval: still the cached rejection, no probe.
        let calls = Cell::new(0);
        let again = store.resolve("a", T0 + MIN, Some(100), || {
            calls.set(1);
            ok(1.0)
        });
        assert!(matches!(again, Resolved::Failed(_)));
        assert_eq!(calls.get(), 0);
        // The user signs in again (new mtime): the very next call probes and shows real numbers.
        let after = store.resolve("a", T0 + 2 * MIN, Some(200), || ok(12.0));
        let Resolved::Fresh(good) = after else { panic!("expected fresh values after a new sign-in, got {after:?}") };
        assert_eq!(good.windows, win(12.0));
        // A missing mtime (unreadable file) never lifts the throttle by itself.
        let store = Store::new(None);
        store.resolve("b", T0, Some(100), expired);
        let still = store.resolve("b", T0 + MIN, None, || ok(1.0));
        assert!(matches!(still, Resolved::Failed(_)));
    }

    #[test]
    fn the_rejected_credentials_time_survives_a_restart() {
        let path = temp_file("authmtime");
        {
            let store = Store::new(Some(path.clone()));
            store.resolve("a", T0, Some(100), || Err(ProbeError::Auth { message: crate::providers::login_expired_message("Claude Code") }));
        }
        let reloaded = Store::new(Some(path.clone()));
        let same = reloaded.resolve("a", T0 + MIN, Some(100), || ok(1.0));
        assert!(matches!(same, Resolved::Failed(_)), "same credentials file: still rejected");
        let changed = reloaded.resolve("a", T0 + MIN, Some(300), || ok(2.0));
        assert!(matches!(changed, Resolved::Fresh(_)));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn accounts_are_independent() {
        let store = Store::new(None);
        store.resolve("a", T0, None, || ok(10.0));
        let Resolved::Fresh(b) = store.resolve("b", T0 + 1, None, || ok(20.0)) else { panic!() };
        assert_eq!(b.windows, win(20.0));
    }

    #[test]
    fn stale_credits_are_not_offered() {
        let store = Store::new(None);
        store.resolve("a", T0, None, || Ok((win(10.0), Some(json!({"availableCount": 1})))));
        let Resolved::Fresh(fresh) = store.resolve("a", T0 + 1, None, || ok(0.0)) else { panic!() };
        assert!(fresh.credits.is_some(), "still valid within the interval");
        let Resolved::Stale { good, .. } = store.resolve("a", T0 + 6 * MIN, None, || rate_limited(None)) else { panic!() };
        assert!(good.credits.is_none(), "an old reset-credit offer must not be shown as current");
    }

    #[test]
    fn last_good_values_survive_a_restart() {
        let path = temp_file("restart");
        {
            let store = Store::new(Some(path.clone()));
            store.resolve("a", T0, None, || ok(33.0));
            store.resolve("a", T0 + 6 * MIN, None, || rate_limited(Some(2 * 3600)));
        }
        let text = std::fs::read_to_string(&path).expect("cache file written");
        assert!(!text.to_lowercase().contains("token"), "no credentials in the cache file");
        let reloaded = Store::new(Some(path.clone()));
        let calls = Cell::new(0);
        // Still inside the Retry-After window: no probe, stale values.
        let result = reloaded.resolve("a", T0 + 7 * MIN, None, || {
            calls.set(1);
            ok(1.0)
        });
        assert_eq!(calls.get(), 0, "the backoff is persisted too, so a restart does not hammer the endpoint");
        let Resolved::Stale { good, .. } = result else { panic!("expected stale values, got {result:?}") };
        assert_eq!(good.windows, win(33.0));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_corrupt_cache_file_is_ignored() {
        let path = temp_file("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{not json").unwrap();
        let store = Store::new(Some(path.clone()));
        assert!(matches!(store.resolve("a", T0, None, || ok(1.0)), Resolved::Fresh(_)));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn stale_message_reads_like_a_sentence() {
        assert_eq!(stale_message(T0, T0 + 12 * MIN), "Showing values from 12 minutes ago");
        assert_eq!(stale_message(T0, T0 + 30_000), "Showing values from less than a minute ago");
        assert_eq!(stale_message(T0, T0 + MIN), "Showing values from 1 minute ago");
        assert_eq!(stale_message(T0, T0 + 3 * 60 * MIN), "Showing values from 3 hours ago");
        assert_eq!(stale_message(T0, T0 + 3 * 24 * 60 * MIN), "Showing values from 3 days ago");
        assert_eq!(stale_message(T0 + 5, T0), "Showing values from less than a minute ago");
    }

    #[test]
    fn retry_after_header_is_parsed_as_seconds() {
        assert_eq!(parse_retry_after(Some("120")), Some(120));
        assert_eq!(parse_retry_after(Some(" 7 ")), Some(7));
        assert_eq!(parse_retry_after(Some("Wed, 21 Oct 2026 07:28:00 GMT")), None);
        assert_eq!(parse_retry_after(None), None);
    }
}
