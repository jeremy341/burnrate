//! Background refresh loop: reads limits at the configured interval while a consumer is connected
//! (SSE client, a recent `/api/limits` request, or notifications enabled in settings) and feeds
//! `history::on_snapshot`, `alerts::on_snapshot` and the hub. Idle = parked on a condition variable.
//! The raw `LimitsReport` and the compact status share one 30 s cache, so `/api/limits`, `/api/status`
//! and the loop never run a second concurrent probe. Owned by the scheduler-hub-status package.
//! Contract: docs/CONTRACTS.md, "Scheduler".

use crate::{hub, State};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_INTERVAL_SEC: u64 = 120;
const MIN_INTERVAL_SEC: u64 = 30;
/// Concurrent `/api/status` / `/api/stream` callers share one probe within this window.
const CACHE_TTL: Duration = Duration::from_secs(30);
/// A `/api/limits` request counts as a consumer for three refresh intervals.
const LIMITS_REQUEST_MULTIPLIER: u64 = 3;
/// Wait this long when idle; any publish/subscribe/activity wakes us first (a park, not a poll).
const IDLE_WAIT: Duration = Duration::from_secs(3600);
/// No unprompted limits probe (a network call per provider) this soon after launch: the app may start
/// minimised and the first window asks for limits itself. `/api/status` and `/api/limits` still read on demand.
const STARTUP_GRACE: Duration = Duration::from_secs(45);

#[derive(Default)]
struct Cache {
    /// The raw `LimitsReport` JSON, kept for the history/alerts hooks and diagnostics.
    report: Option<Value>,
    /// The compact status served by `/api/status` and published on the hub.
    compact: Option<Value>,
    built_at: Option<Instant>,
}

struct Scheduler {
    state: Arc<State>,
    /// Held across the whole probe so concurrent callers never start a second network refresh.
    refresh_guard: Mutex<()>,
    cache: Mutex<Cache>,
    last_limits_ms: AtomicU64,
}

/// Set once by `start` from `lib.rs::run`. All public accessors read through this.
static ACTIVE: OnceLock<Arc<Scheduler>> = OnceLock::new();

/// Interactive SSE streams currently attached. The hub counts every subscriber, but the shell's
/// stream is passive (registered by `status_api`) and must not keep the scheduler awake on its own.
static ACTIVE_STREAMS: AtomicUsize = AtomicUsize::new(0);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn raw_settings(state: &State) -> Value {
    // `SettingsStore::raw()` is the full merged AppSettings once the settings package lands;
    // until then its legacy mirrors are present and the fields below simply read as "unset".
    state.settings.raw()
}

fn get_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |current, key| current.get(key))
}

fn setting_bool(raw: &Value, path: &[&str], default: bool) -> bool {
    get_path(raw, path).and_then(Value::as_bool).unwrap_or(default)
}

fn refresh_interval(state: &State) -> Duration {
    let secs = get_path(&raw_settings(state), &["usage", "refreshIntervalSec"])
        .and_then(Value::as_f64)
        .unwrap_or(DEFAULT_INTERVAL_SEC as f64) as u64;
    Duration::from_secs(secs.max(MIN_INTERVAL_SEC))
}

impl Scheduler {
    /// A consumer is active if an interactive SSE client is attached, notifications are enabled,
    /// or `/api/limits` was requested recently (within three intervals). The shell's stream and
    /// status reads are passive so a minimised shell cannot keep the scheduler awake forever.
    fn consumer_active(&self, interval: Duration) -> bool {
        let raw = raw_settings(&self.state);
        if ACTIVE_STREAMS.load(Ordering::Relaxed) > 0 {
            return true;
        }
        if setting_bool(&raw, &["notifications", "enabled"], false) {
            return true;
        }
        let last = self.last_limits_ms.load(Ordering::Relaxed);
        if last != 0 {
            let active_for = interval.as_millis() as u64 * LIMITS_REQUEST_MULTIPLIER;
            if now_ms().saturating_sub(last) < active_for {
                return true;
            }
        }
        false
    }

    /// Return the raw `LimitsReport` and its compact status from one shared probe. A fresh cache
    /// (or `force`) decides whether to probe; `refresh_guard` serialises concurrent callers so
    /// `/api/limits`, `/api/status` and the scheduler never start a second network refresh.
    fn refresh_data(&self, force: bool) -> (Value, Value) {
        let _guard = self.refresh_guard.lock().unwrap_or_else(|e| e.into_inner());
        {
            let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            if !force {
                if let (Some(report), Some(compact), Some(at)) =
                    (cache.report.as_ref(), cache.compact.as_ref(), cache.built_at)
                {
                    if at.elapsed() < CACHE_TTL {
                        return (report.clone(), compact.clone());
                    }
                }
            }
        }

        // `limits_report` is crate-private in lib.rs; a child module may call it directly.
        let report = crate::limits_report(&self.state);
        let compact = build_compact_status(&report, Utc::now());

        // Hooks take the raw report. Both are stubs until their packages land.
        crate::history::on_snapshot(&self.state, &report);
        crate::alerts::on_snapshot(&self.state, &report);

        {
            let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            cache.report = Some(report.clone());
            cache.compact = Some(compact.clone());
            cache.built_at = Some(Instant::now());
        }
        hub::publish("snapshot", compact.clone());
        (report, compact)
    }

    /// Refresh the compact status if the cache is stale, otherwise return the cached one.
    fn refresh(&self) -> Value {
        self.refresh_data(false).1
    }
}

/// Start the single background scheduler thread. Called once from `lib.rs::run`.
pub fn start(state: Arc<State>) {
    let scheduler = Arc::new(Scheduler {
        state,
        refresh_guard: Mutex::new(()),
        cache: Mutex::new(Cache::default()),
        last_limits_ms: AtomicU64::new(0),
    });
    let _ = ACTIVE.set(scheduler.clone());

    let thread = std::thread::Builder::new()
        .name("burnrate-scheduler".to_string())
        .spawn(move || {
            let first_probe_at = Instant::now() + STARTUP_GRACE;
            let mut next_refresh = first_probe_at;
            loop {
                let interval = refresh_interval(&scheduler.state);
                if scheduler.consumer_active(interval) {
                    if Instant::now() >= next_refresh {
                        let _ = scheduler.refresh();
                        next_refresh = Instant::now() + interval;
                    }
                    let wait = next_refresh.saturating_duration_since(Instant::now());
                    hub::wait_for_activity(wait);
                } else {
                    // Idle: no timer, no polling. Wake only when a consumer/event appears.
                    next_refresh = Instant::now().max(first_probe_at);
                    hub::wait_for_activity(IDLE_WAIT);
                }
            }
        });

    if thread.is_err() {
        eprintln!("burnrate: could not start scheduler thread");
    }
}

/// Record that a consumer requested limits. Integrator: call from the `/api/limits` branch in
/// `lib.rs::handle_api` (that route is owned by the integrator, so it cannot be hooked here).
pub fn note_limits_request() {
    if let Some(scheduler) = ACTIVE.get() {
        scheduler.last_limits_ms.store(now_ms(), Ordering::Relaxed);
    }
    hub::wake();
}

/// Register an interactive SSE stream (as opposed to the shell's passive status stream). Paired
/// open/close calls from `status_api::serve_stream` keep `consumer_active` honest; a passive stream
/// never calls this, so it cannot pin the scheduler while the app is in the tray.
pub fn note_stream(open: bool) {
    if open {
        ACTIVE_STREAMS.fetch_add(1, Ordering::AcqRel);
        hub::wake();
    } else {
        let _ = ACTIVE_STREAMS.try_update(Ordering::AcqRel, Ordering::Relaxed, |n| n.checked_sub(1));
        hub::wake();
    }
}

/// Generic activity signal from an interactive client. Passive shell status reads must not call this.
pub fn note_activity() {
    note_limits_request();
}

/// Raw `LimitsReport` for `GET /api/limits`, served from the same 30 s cache as compact status so
/// repeated reads share one probe. `force` bypasses it for an explicit Refresh. Without a running
/// scheduler (tests/embedding) this falls back to a direct probe with `state`.
pub fn limits_report_cached(force: bool, state: &crate::State) -> Value {
    match ACTIVE.get() {
        Some(scheduler) => scheduler.refresh_data(force).0,
        None => crate::limits_report(state),
    }
}

/// Compact status for `GET /api/status`. Uses the shared cache (one probe per TTL).
pub fn compact_status() -> Value {
    match ACTIVE.get() {
        Some(scheduler) => scheduler.refresh(),
        None => empty_status(),
    }
}

/// Last cached compact status, if any (used to send an immediate snapshot on SSE connect).
pub(crate) fn cached_compact() -> Option<Value> {
    ACTIVE.get()?.cache.lock().ok()?.compact.clone()
}

fn empty_status() -> Value {
    json!({"checkedAt": null, "hostLabel": "", "accounts": [], "notices": []})
}

// ---- compact status building (pure, unit-testable) ----

fn num(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

fn parse_ts(s: &str) -> Option<DateTime<Utc>> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

/// Minutes already elapsed in a window, derived from its duration and its reset time.
fn elapsed_minutes(duration_mins: f64, resets: DateTime<Utc>, now: DateTime<Utc>) -> f64 {
    let minutes_left = resets.signed_duration_since(now).num_seconds() as f64 / 60.0;
    (duration_mins - minutes_left).clamp(0.0, duration_mins)
}

/// `paceDelta` = percent used minus percent of the window elapsed (positive = ahead of pace).
fn pace_delta(used: f64, duration_mins: Option<f64>, elapsed: Option<f64>) -> Option<f64> {
    let duration = duration_mins?;
    let elapsed = elapsed?;
    if duration <= 0.0 || elapsed < 0.0 {
        return None;
    }
    Some(used - (elapsed / duration * 100.0))
}

/// When this window would hit 100% at its current burn rate. Requires >= 10 min of history.
fn projected_exhaustion(
    used: f64,
    remaining: f64,
    elapsed: Option<f64>,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let elapsed = elapsed?;
    if elapsed < 10.0 || used <= 0.0 {
        return None;
    }
    let rate = used / elapsed; // percent per minute
    if rate <= 0.0 {
        return None;
    }
    Some(now + ChronoDuration::seconds((remaining / rate * 60.0) as i64))
}

/// critical when remaining <= 10 or projected to run out before reset;
/// warn when remaining <= 25 or paceDelta >= 15; ok otherwise.
fn pace_state(
    remaining: f64,
    delta: Option<f64>,
    projected: Option<DateTime<Utc>>,
    resets: Option<DateTime<Utc>>,
) -> &'static str {
    if remaining <= 10.0 {
        return "critical";
    }
    if let (Some(projected), Some(resets)) = (projected, resets) {
        if projected < resets {
            return "critical";
        }
    }
    if remaining <= 25.0 || delta.is_some_and(|d| d >= 15.0) {
        return "warn";
    }
    "ok"
}

/// Turn a raw `LimitsReport` into the compact status consumed by `/api/status`, the tray and the CLI.
pub(crate) fn build_compact_status(report: &Value, now: DateTime<Utc>) -> Value {
    let accounts_in = report.get("accounts").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut accounts = Vec::with_capacity(accounts_in.len());
    let mut worst: Option<Value> = None;

    for account in &accounts_in {
        let limits = account.get("limits");
        let windows_in = limits
            .and_then(|l| l.get("windows"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let unavailable = limits.and_then(|l| l.get("unavailable")).cloned();
        let account_id = text(account.get("id")).unwrap_or("");
        let provider = text(account.get("driver")).unwrap_or("");
        let mut windows = Vec::with_capacity(windows_in.len());

        for window in &windows_in {
            let used_value = num(window.get("usedPercent"));
            let used = used_value.unwrap_or(0.0).clamp(0.0, 100.0);
            let remaining = (100.0 - used).max(0.0);
            let resets_at = text(window.get("resetsAt")).map(str::to_string);
            let resets = resets_at.as_deref().and_then(parse_ts);
            let duration_mins = num(window.get("windowDurationMins")).filter(|d| *d > 0.0);
            let elapsed = duration_mins.and_then(|d| resets.map(|r| elapsed_minutes(d, r, now)));
            let delta = pace_delta(used, duration_mins, elapsed);
            let projected = projected_exhaustion(used, remaining, elapsed, now);

            let state = if used_value.is_none() {
                "unavailable"
            } else {
                pace_state(remaining, delta, projected, resets)
            };

            let mut compact_window = json!({
                "id": text(window.get("id")).unwrap_or(""),
                "kind": text(window.get("kind")).unwrap_or("other"),
                "label": text(window.get("label")).unwrap_or(""),
                "usedPercent": round2(used),
                "remainingPercent": round2(remaining),
                "state": state,
            });
            if let Some(resets_at) = &resets_at {
                compact_window["resetsAt"] = json!(resets_at);
            }
            if let Some(duration) = duration_mins {
                compact_window["windowMinutes"] = json!(duration);
            }
            if let Some(delta) = delta {
                compact_window["paceDelta"] = json!(round2(delta));
            }
            if let Some(provenance) = text(window.get("provenance")) {
                compact_window["provenance"] = json!(provenance);
            }

            if state != "unavailable" {
                let mut candidate = json!({
                    "accountId": account_id,
                    "provider": provider,
                    "windowId": text(window.get("id")).unwrap_or(""),
                    "label": text(window.get("label")).unwrap_or(""),
                    "remainingPercent": round2(remaining),
                });
                if let Some(resets_at) = &resets_at {
                    candidate["resetsAt"] = json!(resets_at);
                }
                let is_worse = worst
                    .as_ref()
                    .and_then(|w| num(w.get("remainingPercent")))
                    .map_or(true, |current| remaining < current);
                if is_worse {
                    worst = Some(candidate);
                }
            }
            windows.push(compact_window);
        }

        // An account that failed to probe should still be visible, never silently hidden.
        if windows.is_empty() && unavailable.is_some() {
            windows.push(json!({
                "id": "unavailable",
                "kind": "other",
                "label": "Unavailable",
                "usedPercent": 0.0,
                "remainingPercent": 0.0,
                "state": "unavailable",
            }));
        }

        let mut compact_account = json!({
            "id": account_id,
            "provider": provider,
            "label": text(account.get("displayName"))
                .or_else(|| text(account.get("label")))
                .unwrap_or(""),
            "windows": windows,
        });
        if let Some(plan) = text(account.get("plan")) {
            compact_account["plan"] = json!(plan);
        }
        if let Some(balances) = limits.and_then(|l| l.get("balances")).cloned() {
            compact_account["balances"] = balances;
        }
        if let Some(unavailable) = unavailable {
            compact_account["unavailable"] = unavailable;
        }
        accounts.push(compact_account);
    }

    let mut status = json!({
        "checkedAt": text(report.get("createdAt")).unwrap_or("").to_string(),
        "hostLabel": text(report.get("hostLabel")).unwrap_or("").to_string(),
        "accounts": accounts,
        "notices": report.get("notices").cloned().unwrap_or_else(|| json!([])),
    });
    if status["checkedAt"].as_str().unwrap_or("").is_empty() {
        status["checkedAt"] = json!(now.to_rfc3339());
    }
    if let Some(worst) = worst {
        status["worst"] = worst;
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> DateTime<Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-01-01T12:00:00Z").unwrap().with_timezone(&Utc)
    }

    #[test]
    fn pace_rules_thresholds() {
        // remaining > 25, delta < 15 -> ok
        assert_eq!(pace_state(60.0, Some(5.0), None, None), "ok");
        // remaining <= 10 -> critical (takes priority over warn)
        assert_eq!(pace_state(10.0, Some(99.0), None, None), "critical");
        // remaining <= 25 -> warn
        assert_eq!(pace_state(25.0, None, None, None), "warn");
        // ahead of pace by >= 15 -> warn
        assert_eq!(pace_state(60.0, Some(15.0), None, None), "warn");
    }

    #[test]
    fn projected_runout_before_reset_is_critical() {
        let resets = now() + ChronoDuration::hours(1);
        // 90% used over 90 min => 1%/min; 10% remaining => 10 min to empty, well before reset.
        let projected = projected_exhaustion(90.0, 10.0, Some(90.0), now()).unwrap();
        assert_eq!(pace_state(10.0, None, Some(projected), Some(resets)), "critical");
        // Needs at least 10 minutes of data: with 9 min we do not predict.
        assert!(projected_exhaustion(90.0, 10.0, Some(9.0), now()).is_none());
        // A future projection without a known reset cannot be judged critical.
        assert_eq!(pace_state(40.0, None, Some(projected), None), "ok");
    }

    #[test]
    fn pace_delta_uses_elapsed_window_fraction() {
        // 40% used with 30% of the window elapsed => +10 ahead of pace.
        assert_eq!(pace_delta(40.0, Some(100.0), Some(30.0)), Some(10.0));
        // No duration -> unknown.
        assert_eq!(pace_delta(40.0, None, Some(30.0)), None);
    }

    #[test]
    fn compact_status_maps_windows_state_and_worst() {
        let report = json!({
            "createdAt": "2026-01-01T12:00:00Z",
            "hostLabel": "workstation",
            "notices": ["claude: login expired"],
            "accounts": [
                {
                    "id": "claude-main", "driver": "claudeAgent", "label": "Claude", "plan": "Max",
                    "limits": {
                        "windows": [
                            {
                                "id": "five_hour", "kind": "session", "label": "5h",
                                "usedPercent": 27.0, "resetsAt": "2026-01-01T15:00:00Z",
                                "windowDurationMins": 300.0, "provenance": "official"
                            },
                            {
                                "id": "seven_day", "kind": "weekly", "label": "7d",
                                "usedPercent": 92.0, "resetsAt": "2026-01-07T12:00:00Z"
                            }
                        ],
                        "balances": [{"id": "credits", "label": "Credits", "kind": "credit", "amount": 12.5, "currency": "USD"}]
                    }
                },
                {
                    "id": "openrouter-x", "driver": "openrouter", "label": "OpenRouter",
                    "limits": {"unavailable": {"reason": "probeFailed", "message": "unauthorized"}}
                }
            ]
        });

        let status = build_compact_status(&report, now());
        assert_eq!(status["checkedAt"], "2026-01-01T12:00:00Z");
        assert_eq!(status["hostLabel"], "workstation");
        assert_eq!(status["accounts"].as_array().unwrap().len(), 2);

        let claude = &status["accounts"][0];
        assert_eq!(claude["provider"], "claudeAgent");
        assert_eq!(claude["plan"], "Max");
        assert_eq!(claude["windows"][0]["remainingPercent"], 73.0);
        assert_eq!(claude["windows"][0]["state"], "ok");
        assert_eq!(claude["windows"][0]["windowMinutes"], 300.0);
        assert_eq!(claude["windows"][0]["provenance"], "official");
        // 27% used, 120 min of 300 elapsed (40%) => 27 - 40 = -13, still ok.
        assert_eq!(claude["windows"][0]["paceDelta"], -13.0);
        assert_eq!(claude["windows"][1]["state"], "critical");
        assert_eq!(claude["balances"][0]["amount"], 12.5);

        let failed = &status["accounts"][1];
        assert_eq!(failed["unavailable"]["reason"], "probeFailed");
        assert_eq!(failed["windows"][0]["state"], "unavailable");

        // The 7d window (8% remaining) is the worst.
        assert_eq!(status["worst"]["accountId"], "claude-main");
        assert_eq!(status["worst"]["windowId"], "seven_day");
        assert_eq!(status["worst"]["remainingPercent"], 8.0);
    }
}
