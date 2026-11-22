//! Alerts engine (docs/CONTRACTS.md section 10).
//!
//! `evaluate` is a pure, unit-testable rule engine: it takes the previous state, a limits snapshot,
//! a notification config and the current time, and returns the new state plus the events to emit.
//! `on_snapshot` is the I/O wrapper: it loads config from settings, persists state atomically,
//! publishes events on the hub and hands them to the notification channels.

pub mod channels;
pub mod predict;

use chrono::{Local, TimeZone, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub use predict::DEFAULT_ALPHA;

/// Cap on retained events (also used by `/api/alerts/recent`).
pub const MAX_RECENT_EVENTS: usize = 50;
/// Default thresholds when none are configured.
pub const DEFAULT_THRESHOLDS: [u32; 3] = [80, 90, 100];
/// Default per-window cooldown, in minutes.
pub const DEFAULT_COOLDOWN_MINUTES: i64 = 30;
/// Drop window/account bookkeeping that has not been seen for a day (no unbounded caches).
const STALE_MS: i64 = 24 * 60 * 60 * 1000;
/// A window must have been at or above this level for a reset to be reportable.
const RESET_ARM_PERCENT: f64 = 80.0;
/// A drop of at least this many points counts as a reset.
const RESET_DROP_POINTS: f64 = 50.0;
/// How many consecutive auth-looking unavailable polls are needed for a login alert.
const LOGIN_POLLS: u32 = 2;

// ---------------------------------------------------------------------------
// Config (mirrors `notifications` in src/settings/schema.ts)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuietHoursConfig {
    pub enabled: bool,
    /// "HH:MM" local time.
    pub start: String,
    /// "HH:MM" local time.
    pub end: String,
}

impl Default for QuietHoursConfig {
    fn default() -> Self {
        Self { enabled: false, start: "22:00".into(), end: "08:00".into() }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderAlertOverride {
    pub enabled: Option<bool>,
    pub thresholds: Option<Vec<u32>>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelFlag {
    pub enabled: bool,
    pub configured: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelFlags {
    pub ntfy: ChannelFlag,
    pub discord: ChannelFlag,
    pub webhook: ChannelFlag,
}

/// The notification settings the engine needs. Every field has a default matching
/// `DEFAULT_SETTINGS.notifications`, so a partial settings JSON is always safe to parse.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationConfig {
    pub enabled: bool,
    pub desktop: bool,
    pub sound: bool,
    pub thresholds: Vec<u32>,
    pub predict_runout: bool,
    pub notify_on_reset: bool,
    pub notify_on_expired_login: bool,
    pub quiet_hours: QuietHoursConfig,
    /// ISO-8601 timestamp or null, matching `notifications.snoozeUntil`.
    pub snooze_until: Option<String>,
    pub cooldown_minutes: i64,
    pub per_provider: HashMap<String, ProviderAlertOverride>,
    pub channels: ChannelFlags,
    /// Internal test hook: timezone offset east of UTC in seconds. Not part of the settings
    /// schema; when absent the machine's local zone is used for quiet hours.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tz_offset_secs: Option<i32>,
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            desktop: false,
            sound: false,
            thresholds: DEFAULT_THRESHOLDS.to_vec(),
            predict_runout: false,
            notify_on_reset: false,
            notify_on_expired_login: false,
            quiet_hours: QuietHoursConfig::default(),
            snooze_until: None,
            cooldown_minutes: DEFAULT_COOLDOWN_MINUTES,
            per_provider: HashMap::new(),
            channels: ChannelFlags::default(),
            tz_offset_secs: None,
        }
    }
}

impl NotificationConfig {
    /// Reads the `notifications` section of a settings JSON value. Also accepts the section
    /// itself directly (handy for tests); unknown fields are ignored.
    pub fn from_settings(settings: &Value) -> Self {
        let candidate = settings.get("notifications").unwrap_or(settings);
        serde_json::from_value(candidate.clone()).unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// Events and persisted state
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertEvent {
    pub id: String,
    /// Epoch milliseconds.
    pub ts: i64,
    /// "threshold" | "runout" | "reset" | "login".
    pub kind: String,
    pub account_id: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    pub title: String,
    pub body: String,
    /// "info" | "warn" | "critical".
    pub severity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowState {
    /// Increments on every detected reset; part of event ids and clears per-cycle flags.
    pub cycle: u64,
    /// The `resetsAt` value seen in the current cycle.
    pub reset_key: Option<String>,
    pub fired_thresholds: Vec<u32>,
    pub runout_fired: bool,
    pub last_alert_ms: Option<i64>,
    pub peak_used: f64,
    /// The previous snapshot's used percent (needed for threshold crossings and resets).
    pub prev_used: f64,
    /// Recent `(ts_ms, used_percent)` samples for the EWMA predictor.
    pub samples: Vec<(i64, f64)>,
    pub last_seen_ms: i64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AccountState {
    /// Consecutive polls whose `unavailable.message` looked like an expired login.
    pub login_polls: u32,
    pub login_fired: bool,
    /// Increments for each distinct login episode so event ids stay unique.
    pub login_episode: u32,
    pub last_alert_ms: Option<i64>,
    pub last_seen_ms: i64,
}

/// Everything needed to avoid duplicate alerts, persisted to `<data>/alerts-state.json`.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AlertState {
    pub version: u32,
    /// Epoch milliseconds; snooze set through `/api/alerts/snooze`.
    pub snooze_until: Option<i64>,
    pub last_events: Vec<AlertEvent>,
    pub windows: HashMap<String, WindowState>,
    pub accounts: HashMap<String, AccountState>,
}

// ---------------------------------------------------------------------------
// Snapshot normalisation (accepts both compact status and raw limits report)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct WindowView {
    id: String,
    label: String,
    used: f64,
    resets_at: Option<String>,
}

#[derive(Clone, Debug)]
struct AccountView {
    id: String,
    provider: String,
    label: String,
    windows: Vec<WindowView>,
    unavailable_message: Option<String>,
}

fn str_or<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn extract_accounts(snapshot: &Value) -> Vec<AccountView> {
    let Some(list) = snapshot.get("accounts").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|account| {
            let id = str_or(account, "id")
                .or_else(|| str_or(account, "accountId"))
                .or_else(|| str_or(account, "label"))
                .unwrap_or("");
            if id.is_empty() {
                return None;
            }
            let provider = str_or(account, "provider")
                .or_else(|| str_or(account, "driver"))
                .unwrap_or("")
                .to_string();
            let label = str_or(account, "label")
                .or_else(|| str_or(account, "displayName"))
                .unwrap_or(id)
                .to_string();
            // Raw limits report nests windows under `limits`; compact status puts them on the account.
            let limits = account.get("limits").unwrap_or(account);
            let unavailable_message = limits
                .pointer("/unavailable/message")
                .and_then(Value::as_str)
                .or_else(|| account.pointer("/unavailable/message").and_then(Value::as_str))
                .map(str::to_string);
            let raw_windows: &[Value] = limits
                .get("windows")
                .and_then(Value::as_array)
                .map(|windows| windows.as_slice())
                .unwrap_or(&[]);
            let windows = raw_windows
                .iter()
                .filter_map(|window| {
                    let id = str_or(window, "id")?.to_string();
                    if id.is_empty() {
                        return None;
                    }
                    let used = window.get("usedPercent").and_then(Value::as_f64).unwrap_or(0.0);
                    let resets_at = str_or(window, "resetsAt").map(str::to_string);
                    Some(WindowView {
                        label: str_or(window, "label").unwrap_or(&id).to_string(),
                        id,
                        used,
                        resets_at,
                    })
                })
                .collect();
            Some(AccountView { id: id.to_string(), provider, label, windows, unavailable_message })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/// Parses an ISO-8601 timestamp, or a bare epoch-milliseconds number, into epoch milliseconds.
pub fn parse_ms(value: &str) -> Option<i64> {
    if let Ok(ms) = value.trim().parse::<i64>() {
        return Some(ms);
    }
    chrono::DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|date| date.timestamp_millis())
}

/// Parses a "HH:MM" string into minutes since midnight.
pub fn parse_hhmm(value: &str) -> Option<i32> {
    let (hours, minutes) = value.trim().split_once(':')?;
    let hours: i32 = hours.trim().parse().ok()?;
    let minutes: i32 = minutes.trim().parse().ok()?;
    if (0..24).contains(&hours) && (0..60).contains(&minutes) {
        Some(hours * 60 + minutes)
    } else {
        None
    }
}

fn local_minutes(now_ms: i64, tz_offset_secs: Option<i32>) -> i32 {
    if let Some(offset) = tz_offset_secs {
        if let Some(date) = Utc.timestamp_millis_opt(now_ms.saturating_add(offset as i64 * 1000)).single() {
            return date.hour() as i32 * 60 + date.minute() as i32;
        }
    }
    if let Some(date) = Local.timestamp_millis_opt(now_ms).single() {
        return date.hour() as i32 * 60 + date.minute() as i32;
    }
    Utc.timestamp_millis_opt(now_ms)
        .single()
        .map(|date| date.hour() as i32 * 60 + date.minute() as i32)
        .unwrap_or(0)
}

/// Quiet hours in local time; a start greater than the end wraps over midnight.
pub fn in_quiet_hours(quiet: &QuietHoursConfig, now_ms: i64, tz_offset_secs: Option<i32>) -> bool {
    if !quiet.enabled {
        return false;
    }
    let (Some(start), Some(end)) = (parse_hhmm(&quiet.start), parse_hhmm(&quiet.end)) else {
        return false;
    };
    if start == end {
        return false; // A zero-length window never suppresses anything.
    }
    let now = local_minutes(now_ms, tz_offset_secs);
    if start < end {
        now >= start && now < end
    } else {
        now >= start || now < end
    }
}

fn effective_snooze(previous: &AlertState, cfg: &NotificationConfig) -> Option<i64> {
    let configured = cfg.snooze_until.as_deref().and_then(parse_ms);
    match (previous.snooze_until, configured) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn provider_enabled(cfg: &NotificationConfig, provider: &str) -> bool {
    cfg.per_provider.get(provider).and_then(|entry| entry.enabled).unwrap_or(true)
}

fn provider_thresholds(cfg: &NotificationConfig, provider: &str) -> Vec<u32> {
    let mut thresholds = cfg
        .per_provider
        .get(provider)
        .and_then(|entry| entry.thresholds.clone())
        .unwrap_or_else(|| cfg.thresholds.clone());
    thresholds.retain(|value| (1..=100).contains(value));
    thresholds.sort_unstable();
    thresholds.dedup();
    thresholds
}

fn reset_moved_forward(old: &str, new: &str) -> bool {
    match (parse_ms(old), parse_ms(new)) {
        (Some(old_ms), Some(new_ms)) => new_ms > old_ms,
        _ => new > old,
    }
}

fn auth_looking(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.starts_with("login-expired:")
        || ["login", "auth", "token", "expired", "unauthor", "401", "403", "sign in", "reconnect"]
            .iter()
            .any(|needle| lower.contains(needle))
}

fn cooldown_allows(last_alert_ms: Option<i64>, now_ms: i64, cooldown_minutes: i64) -> bool {
    let Some(last) = last_alert_ms else { return true };
    let cooldown = cooldown_minutes.max(0).saturating_mul(60_000);
    now_ms.saturating_sub(last) >= cooldown
}

// ---------------------------------------------------------------------------
// Pure rule engine
// ---------------------------------------------------------------------------

fn event(
    kind: &str,
    account: &AccountView,
    window: Option<&WindowView>,
    discriminator: &str,
    cycle: u64,
    now_ms: i64,
    title: String,
    body: String,
    severity: &str,
    used: Option<f64>,
) -> AlertEvent {
    AlertEvent {
        id: format!(
            "{kind}|{}|{}|{discriminator}|{cycle}",
            account.id,
            window.map(|window| window.id.as_str()).unwrap_or("-")
        ),
        ts: now_ms,
        kind: kind.to_string(),
        account_id: account.id.clone(),
        provider: account.provider.clone(),
        window_id: window.map(|window| window.id.clone()),
        title,
        body,
        severity: severity.to_string(),
        used_percent: used,
    }
}

fn evaluate_window(
    next: &mut AlertState,
    events: &mut Vec<AlertEvent>,
    account: &AccountView,
    window: &WindowView,
    thresholds: &[u32],
    cfg: &NotificationConfig,
    now_ms: i64,
    blocked: bool,
) {
    let key = format!("{}\u{1f}{}", account.id, window.id);
    let state = next.windows.entry(key).or_default();
    state.last_seen_ms = now_ms;
    let reset_key = window.resets_at.clone();

    // Detect a reset using the *previous* cycle's data.
    let dropped = state.prev_used >= RESET_ARM_PERCENT
        && state.prev_used - window.used >= RESET_DROP_POINTS;
    let moved = state
        .reset_key
        .as_deref()
        .zip(reset_key.as_deref())
        .is_some_and(|(old, new)| reset_moved_forward(old, new));
    let reset_detected = state.prev_used >= RESET_ARM_PERCENT && (dropped || moved);

    predict::record(&mut state.samples, now_ms, window.used);

    if reset_detected {
        if cfg.notify_on_reset && !blocked && cooldown_allows(state.last_alert_ms, now_ms, cfg.cooldown_minutes) {
            let body = format!(
                "{} reset its {} window to {:.0}% used.",
                account.label, window.label, window.used
            );
            events.push(event(
                "reset", account, Some(window), "reset", state.cycle + 1, now_ms,
                format!("{} window reset", account.label), body, "info", Some(window.used),
            ));
            state.last_alert_ms = Some(now_ms);
        }
        state.cycle = state.cycle.saturating_add(1);
        state.fired_thresholds.clear();
        state.runout_fired = false;
        state.samples.clear();
        predict::record(&mut state.samples, now_ms, window.used);
    }

    // Threshold crossings, ascending, at most one event per threshold per reset cycle.
    let previous_used = state.prev_used;
    let mut crossed = Vec::new();
    for &threshold in thresholds {
        let level = threshold as f64;
        if previous_used < level && window.used >= level && !state.fired_thresholds.contains(&threshold) {
            crossed.push(threshold);
        }
    }

    let resets_ms = reset_key.as_deref().and_then(parse_ms);
    let runout = cfg.predict_runout
        && !state.runout_fired
        && predict::should_warn(&state.samples, now_ms, window.used, resets_ms, DEFAULT_ALPHA);

    // Suppressed events (snooze/quiet hours/disabled provider) still advance the dedupe flags so
    // they do not replay in a burst once suppression ends.
    if blocked {
        state.fired_thresholds.extend(crossed);
        state.runout_fired |= runout;
    } else if cooldown_allows(state.last_alert_ms, now_ms, cfg.cooldown_minutes) {
        let mut emitted = false;
        for threshold in &crossed {
            let severity = if *threshold >= 100 { "critical" } else { "warn" };
            let body = format!(
                "{} is {}% through its {} window.",
                account.label, threshold, window.label
            );
            events.push(event(
                "threshold",
                account,
                Some(window),
                &threshold.to_string(),
                state.cycle,
                now_ms,
                format!("{} at {}%", account.label, threshold),
                body,
                severity,
                Some(window.used),
            ));
            emitted = true;
        }
        if runout {
            let body = format!(
                "At the current burn rate, {} will run out before its {} window resets.",
                account.label, window.label
            );
            events.push(event(
                "runout", account, Some(window), "runout", state.cycle, now_ms,
                format!("{} may run out", account.label), body, "critical", Some(window.used),
            ));
            state.runout_fired = true;
            emitted = true;
        }
        if emitted {
            state.last_alert_ms = Some(now_ms);
        }
    } else {
        state.fired_thresholds.extend(crossed);
        state.runout_fired |= runout;
    }

    state.fired_thresholds.sort_unstable();
    state.fired_thresholds.dedup();
    state.prev_used = window.used;
    state.reset_key = reset_key;
    state.peak_used = state.peak_used.max(window.used);
}

fn evaluate_login(
    next: &mut AlertState,
    events: &mut Vec<AlertEvent>,
    account: &AccountView,
    cfg: &NotificationConfig,
    now_ms: i64,
    blocked: bool,
) {
    let state = next.accounts.entry(account.id.clone()).or_default();
    state.last_seen_ms = now_ms;
    let auth = account.unavailable_message.as_deref().is_some_and(auth_looking);
    if !auth {
        state.login_polls = 0;
        state.login_fired = false;
        return;
    }
    state.login_polls = state.login_polls.saturating_add(1);
    if state.login_polls < LOGIN_POLLS || state.login_fired {
        return;
    }
    state.login_fired = true;
    state.login_episode = state.login_episode.saturating_add(1);
    if blocked || !cooldown_allows(state.last_alert_ms, now_ms, cfg.cooldown_minutes) {
        return;
    }
    let reason = account
        .unavailable_message
        .as_deref()
        .map(crate::net_guard::redact)
        .unwrap_or_else(|| "Login needs attention".to_string());
    events.push(event(
        "login",
        account,
        None,
        &state.login_episode.to_string(),
        0,
        now_ms,
        format!("{} needs sign-in", account.label),
        reason,
        "warn",
        None,
    ));
    state.last_alert_ms = Some(now_ms);
}

/// The pure alert rule engine. No I/O and no wall-clock access: all time comes from `now_ms`.
pub fn evaluate(
    previous: &AlertState,
    snapshot: &Value,
    cfg: &NotificationConfig,
    now_ms: i64,
) -> (AlertState, Vec<AlertEvent>) {
    let mut next = previous.clone();
    let mut events = Vec::new();
    if !cfg.enabled {
        return (next, events);
    }

    let snoozed = effective_snooze(previous, cfg).is_some_and(|until| now_ms < until);
    let quiet = cfg.quiet_hours.enabled && in_quiet_hours(&cfg.quiet_hours, now_ms, cfg.tz_offset_secs);

    for account in extract_accounts(snapshot) {
        let provider_ok = provider_enabled(cfg, &account.provider);
        let blocked = snoozed || quiet || !provider_ok;
        if cfg.notify_on_expired_login {
            evaluate_login(&mut next, &mut events, &account, cfg, now_ms, blocked);
        }
        let thresholds = provider_thresholds(cfg, &account.provider);
        for window in &account.windows {
            evaluate_window(&mut next, &mut events, &account, window, &thresholds, cfg, now_ms, blocked);
        }
    }

    next.windows.retain(|_, state| now_ms - state.last_seen_ms <= STALE_MS);
    next.accounts.retain(|_, state| now_ms - state.last_seen_ms <= STALE_MS);
    if next.version == 0 {
        next.version = 1;
    }
    // Events stay in emission order: thresholds are generated ascending per window, and windows
    // follow the snapshot order, so ordering is deterministic without a lexicographic sort.

    // Keep the recent-event ring bounded.
    if next.last_events.len() > MAX_RECENT_EVENTS {
        let excess = next.last_events.len() - MAX_RECENT_EVENTS;
        next.last_events.drain(0..excess);
    }
    (next, events)
}

// ---------------------------------------------------------------------------
// Persistence and the I/O wrapper
// ---------------------------------------------------------------------------

fn default_state_path() -> PathBuf {
    if let Some(dir) = std::env::var_os("BURNRATE_DATA") {
        return PathBuf::from(dir).join("alerts-state.json");
    }
    // Mirror lib.rs: the data directory sits two levels above the web build by default.
    let web = std::env::var_os("BURNRATE_WEB")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("dist/web"));
    web.parent()
        .and_then(Path::parent)
        .map(|root| root.join("data").join("alerts-state.json"))
        .unwrap_or_else(|| PathBuf::from("data/alerts-state.json"))
}

fn load_state(path: &Path) -> AlertState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| serde_json::from_value::<AlertState>(value).ok())
        .unwrap_or_default()
}

/// Appends emitted events to the persisted recent-event ring (newest last) and keeps it bounded.
fn record_events(state: &mut AlertState, events: &[AlertEvent]) {
    state.last_events.extend(events.iter().cloned());
    if state.last_events.len() > MAX_RECENT_EVENTS {
        let excess = state.last_events.len() - MAX_RECENT_EVENTS;
        state.last_events.drain(0..excess);
    }
}

/// Atomic write: `<file>.tmp` then rename, so a crash cannot leave a partial state file.
pub fn save_state(path: &Path, state: &AlertState) -> bool {
    let Some(parent) = path.parent() else { return false };
    if std::fs::create_dir_all(parent).is_err() {
        return false;
    }
    let Ok(bytes) = serde_json::to_vec_pretty(state) else { return false };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, bytes).is_err() {
        return false;
    }
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    true
}

struct AlertRuntime {
    path: PathBuf,
    state: AlertState,
}

static RUNTIME: OnceLock<Mutex<AlertRuntime>> = OnceLock::new();

fn runtime() -> &'static Mutex<AlertRuntime> {
    RUNTIME.get_or_init(|| {
        let path = default_state_path();
        let state = load_state(&path);
        Mutex::new(AlertRuntime { path, state })
    })
}

fn lock_runtime() -> std::sync::MutexGuard<'static, AlertRuntime> {
    runtime().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Snapshot of the current persisted state (for the `/api/alerts/state` route).
pub fn current_state() -> AlertState {
    lock_runtime().state.clone()
}

/// Most recent events, newest first.
pub fn recent_events(limit: usize) -> Vec<AlertEvent> {
    lock_runtime()
        .state
        .last_events
        .iter()
        .rev()
        .take(limit)
        .cloned()
        .collect()
}

pub fn set_snooze(until_ms: i64) -> AlertState {
    let mut runtime = lock_runtime();
    runtime.state.snooze_until = Some(until_ms);
    save_state(&runtime.path, &runtime.state);
    runtime.state.clone()
}

pub fn clear_snooze() -> AlertState {
    let mut runtime = lock_runtime();
    runtime.state.snooze_until = None;
    save_state(&runtime.path, &runtime.state);
    runtime.state.clone()
}

/// Records a manually triggered test event in the recent ring.
pub fn record_test_event(event: AlertEvent) {
    let mut runtime = lock_runtime();
    record_events(&mut runtime.state, std::slice::from_ref(&event));
    save_state(&runtime.path, &runtime.state);
}

/// Evaluate a snapshot and fold the emitted events into the state that gets persisted, so alert
/// history survives restarts and feeds `/api/alerts/recent` and `lastEvents` in `/api/alerts/state`.
fn evaluate_and_record(
    previous: &AlertState,
    snapshot: &Value,
    cfg: &NotificationConfig,
    now_ms: i64,
) -> (AlertState, Vec<AlertEvent>) {
    let (mut next, events) = evaluate(previous, snapshot, cfg, now_ms);
    record_events(&mut next, &events);
    (next, events)
}

/// Called by the scheduler with every limits report. Evaluates rules, persists state, publishes
/// `alert` events on the hub and delivers them to the configured channels.
pub fn on_snapshot(state: &crate::State, snapshot: &Value) {
    let cfg = NotificationConfig::from_settings(&state.settings.raw());
    if !cfg.enabled {
        return;
    }
    let now_ms = Utc::now().timestamp_millis();
    let events = {
        let mut runtime = lock_runtime();
        let (next, events) = evaluate_and_record(&runtime.state, snapshot, &cfg, now_ms);
        runtime.state = next;
        save_state(&runtime.path, &runtime.state);
        events
    };
    // The runtime lock is released before any network I/O.
    for alert in events {
        if let Ok(value) = serde_json::to_value(&alert) {
            crate::hub::publish("alert", value);
        }
        channels::deliver(&cfg, &alert, &state.keys);
    }
}

// ---------------------------------------------------------------------------
// Tests: exhaustive, table-driven coverage of every rule in section 10
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T0: i64 = 1_700_000_000_000; // 2023-11-14T22:13:20Z
    const RESET: &str = "2030-01-01T00:00:00Z";

    fn config() -> NotificationConfig {
        NotificationConfig {
            enabled: true,
            tz_offset_secs: Some(0), // deterministic quiet hours in all test environments
            ..Default::default()
        }
    }

    fn window(id: &str, used: f64, reset: Option<&str>) -> Value {
        let mut value = json!({"id": id, "usedPercent": used});
        if let Some(reset) = reset {
            value["resetsAt"] = json!(reset);
        }
        value
    }

    fn account(id: &str, provider: &str, windows: Vec<Value>) -> Value {
        json!({"id": id, "provider": provider, "label": id, "limits": {"windows": windows}})
    }

    fn compact_account(id: &str, provider: &str, windows: Vec<Value>) -> Value {
        json!({"id": id, "provider": provider, "label": id, "windows": windows})
    }

    fn snapshot(accounts: Vec<Value>) -> Value {
        json!({"accounts": accounts})
    }

    fn threshold_values(events: &[AlertEvent]) -> Vec<u32> {
        events
            .iter()
            .filter(|event| event.kind == "threshold")
            .filter_map(|event| event.id.split('|').nth(3).and_then(|value| value.parse().ok()))
            .collect()
    }

    fn seeded(prev_used: f64, reset_key: &str) -> AlertState {
        let mut state = AlertState::default();
        state.windows.insert(
            "a\u{1f}w".to_string(),
            WindowState { prev_used, reset_key: Some(reset_key.to_string()), ..Default::default() },
        );
        state
    }

    #[test]
    fn thresholds_fire_once_ascending_and_only_on_upward_crossing() {
        let cases: [(f64, f64, Vec<u32>); 6] = [
            (70.0, 85.0, vec![80]),
            (85.0, 95.0, vec![90]),
            (95.0, 100.0, vec![100]),
            (70.0, 100.0, vec![80, 90, 100]),
            (85.0, 88.0, vec![]),
            (95.0, 40.0, vec![]),
        ];
        for (previous_used, used, expected) in cases {
            let previous = seeded(previous_used, RESET);
            let snap = snapshot(vec![account("a", "claude", vec![window("w", used, Some(RESET))])]);
            let (_, events) = evaluate(&previous, &snap, &config(), T0);
            assert_eq!(threshold_values(&events), expected, "prev={previous_used} used={used}");
            for event in events.iter().filter(|event| event.kind == "threshold") {
                assert_eq!(event.severity, if event.id.contains("|100|") { "critical" } else { "warn" });
                assert_eq!(event.account_id, "a");
                assert_eq!(event.provider, "claude");
                assert_eq!(event.window_id.as_deref(), Some("w"));
            }
        }
    }

    #[test]
    fn thresholds_dedupe_across_snapshots_and_after_a_restart() {
        let cfg = NotificationConfig { cooldown_minutes: 0, ..config() };
        let snap = snapshot(vec![account("a", "claude", vec![window("w", 85.0, Some(RESET))])]);
        let (first, events) = evaluate(&AlertState::default(), &snap, &cfg, T0);
        assert_eq!(threshold_values(&events), vec![80]);

        // Same snapshot again: no duplicate event.
        let (second, events) = evaluate(&first, &snap, &cfg, T0 + 60_000);
        assert!(events.is_empty());

        // Simulate restart: round-trip the state through JSON, then cross the next threshold.
        let restored: AlertState = serde_json::from_value(serde_json::to_value(&second).unwrap()).unwrap();
        let higher = snapshot(vec![account("a", "claude", vec![window("w", 95.0, Some(RESET))])]);
        let (_, events) = evaluate(&restored, &higher, &cfg, T0 + 120_000);
        assert_eq!(threshold_values(&events), vec![90], "only the new threshold fires after restart");
    }

    #[test]
    fn cooldown_suppresses_repeated_events_until_it_expires() {
        let cfg = NotificationConfig {
            cooldown_minutes: 30,
            notify_on_reset: true,
            ..config()
        };
        let newer_reset = "2030-02-01T00:00:00Z";
        // First reset at T0: prev 90 -> 30 with a forward reset = reset event.
        let previous = seeded(90.0, RESET);
        let snap = snapshot(vec![account("a", "claude", vec![window("w", 30.0, Some(newer_reset))])]);
        let (after_first, events) = evaluate(&previous, &snap, &cfg, T0);
        assert_eq!(events.iter().filter(|e| e.kind == "reset").count(), 1);

        // Build another armed window from the state after the first reset.
        let mut armed = after_first.clone();
        let state = armed.windows.get_mut("a\u{1f}w").unwrap();
        state.prev_used = 90.0;
        state.reset_key = Some(newer_reset.to_string());
        let even_newer = "2030-03-01T00:00:00Z";
        let snap2 = snapshot(vec![account("a", "claude", vec![window("w", 30.0, Some(even_newer))])]);
        let (_, events) = evaluate(&armed, &snap2, &cfg, T0 + 10 * 60_000);
        assert!(events.is_empty(), "reset within cooldown is suppressed");
        let (_, events) = evaluate(&armed, &snap2, &cfg, T0 + 31 * 60_000);
        assert_eq!(events.iter().filter(|e| e.kind == "reset").count(), 1, "fires after cooldown");
    }

    #[test]
    fn cooldown_gate_boundary_is_inclusive() {
        assert!(cooldown_allows(None, T0, 30));
        assert!(!cooldown_allows(Some(T0), T0 + 29 * 60_000, 30));
        assert!(cooldown_allows(Some(T0), T0 + 30 * 60_000, 30));
        assert!(cooldown_allows(Some(T0), T0 + 1, 0));
    }

    #[test]
    fn quiet_hours_table_wraps_midnight() {
        let cases: [(&str, &str, i32, bool); 9] = [
            ("22:00", "08:00", 22 * 60, true),   // at start
            ("22:00", "08:00", 23 * 60 + 59, true),
            ("22:00", "08:00", 0, true),          // after midnight
            ("22:00", "08:00", 7 * 60 + 59, true),
            ("22:00", "08:00", 8 * 60, false),    // at end
            ("22:00", "08:00", 12 * 60, false),
            ("09:00", "17:00", 9 * 60, true),     // same-day window
            ("09:00", "17:00", 17 * 60, false),
            ("12:00", "12:00", 12 * 60, false),   // zero-length is disabled
        ];
        for (start, end, minute, expected) in cases {
            let quiet = QuietHoursConfig { enabled: true, start: start.into(), end: end.into() };
            let now_ms = T0 - (T0.rem_euclid(86_400_000)) + minute as i64 * 60_000;
            assert_eq!(in_quiet_hours(&quiet, now_ms, Some(0)), expected, "{start}-{end} at {minute}");
        }
        let disabled = QuietHoursConfig::default();
        assert!(!in_quiet_hours(&disabled, T0, Some(0)));
    }

    #[test]
    fn quiet_hours_suppress_events_but_not_state_updates() {
        let cfg = NotificationConfig {
            quiet_hours: QuietHoursConfig { enabled: true, start: "22:00".into(), end: "08:00".into() },
            ..config()
        };
        let night_ms = T0 - T0.rem_euclid(86_400_000) + 23 * 60 * 60_000;
        let snap = snapshot(vec![account("a", "claude", vec![window("w", 85.0, Some(RESET))])]);
        let (next, events) = evaluate(&AlertState::default(), &snap, &cfg, night_ms);
        assert!(events.is_empty(), "no alert during quiet hours");
        assert_eq!(next.windows["a\u{1f}w"].fired_thresholds, vec![80]);
        assert_eq!(next.windows["a\u{1f}w"].prev_used, 85.0);
    }

    #[test]
    fn snooze_from_settings_and_from_state_suppress_alerts() {
        let later = T0 + 60 * 60_000;
        let iso = chrono::Utc.timestamp_millis_opt(later).unwrap().to_rfc3339();
        let cfg = NotificationConfig { snooze_until: Some(iso), ..config() };
        let snap = snapshot(vec![account("a", "claude", vec![window("w", 85.0, Some(RESET))])]);
        assert!(evaluate(&AlertState::default(), &snap, &cfg, T0).1.is_empty());
        assert_eq!(threshold_values(&evaluate(&AlertState::default(), &snap, &cfg, later + 1).1), vec![80]);

        // Snooze only in persisted state (set by the route) is also honoured.
        let mut state = AlertState::default();
        state.snooze_until = Some(later);
        let plain = config();
        assert!(evaluate(&state, &snap, &plain, T0).1.is_empty());
        assert_eq!(threshold_values(&evaluate(&state, &snap, &plain, later + 1).1), vec![80]);
    }

    #[test]
    fn reset_detection_requires_arm_and_either_large_drop_or_forward_reset() {
        let cases: [(f64, f64, Option<&str>, bool); 6] = [
            (90.0, 30.0, Some(RESET), true),   // large drop
            (90.0, 88.0, Some("2030-06-01T00:00:00Z"), true), // forward reset
            (90.0, 88.0, Some(RESET), false),  // neither
            (70.0, 10.0, Some(RESET), false),  // never armed
            (90.0, 45.0, Some(RESET), false),  // drop < 50
            (90.0, 30.0, Some("2029-01-01T00:00:00Z"), true), // drop still fires
        ];
        let cfg = NotificationConfig { notify_on_reset: true, ..config() };
        for (previous_used, used, reset, expected) in cases {
            let previous = seeded(previous_used, RESET);
            let snap = snapshot(vec![account("a", "claude", vec![window("w", used, reset)])]);
            let (next, events) = evaluate(&previous, &snap, &cfg, T0);
            let reset_events = events.iter().filter(|event| event.kind == "reset").count();
            assert_eq!(reset_events == 1, expected, "prev={previous_used} used={used} reset={reset:?}");
            if expected {
                assert_eq!(next.windows["a\u{1f}w"].cycle, 1);
                assert!(next.windows["a\u{1f}w"].fired_thresholds.is_empty());
            }
        }
    }

    #[test]
    fn runout_prediction_uses_ewma_and_requires_ten_minutes() {
        let cfg = NotificationConfig { predict_runout: true, ..config() };
        let reset_ms = parse_ms(RESET).unwrap();
        let start = reset_ms - 60 * 60_000;
        let samples = vec![(start, 80.0), (start + 5 * 60_000, 85.0), (start + 11 * 60_000, 91.0)];
        let mut previous = seeded(91.0, RESET);
        previous.windows.get_mut("a\u{1f}w").unwrap().samples = samples.clone();

        let snap = snapshot(vec![account("a", "claude", vec![window("w", 91.0, Some(RESET))])]);
        let (next, events) = evaluate(&previous, &snap, &cfg, start + 11 * 60_000);
        assert_eq!(events.iter().filter(|e| e.kind == "runout").count(), 1);
        assert!(next.windows["a\u{1f}w"].runout_fired);

        // No replay in the same cycle.
        let (_, events) = evaluate(&next, &snap, &cfg, start + 12 * 60_000);
        assert!(events.is_empty());

        // Too little history: no prediction.
        let mut short = seeded(91.0, RESET);
        short.windows.get_mut("a\u{1f}w").unwrap().samples = vec![(start + 10 * 60_000, 89.0)];
        let (_, events) = evaluate(&short, &snap, &cfg, start + 11 * 60_000);
        assert!(events.is_empty());

        // Reset before projected exhaustion: the window survives to reset, so no warning.
        let now_ms = start + 11 * 60_000;
        let near_ms = now_ms + 5 * 60_000;
        let near = chrono::Utc.timestamp_millis_opt(near_ms).unwrap().to_rfc3339();
        let near_snap = snapshot(vec![account("a", "claude", vec![window("w", 91.0, Some(&near))])]);
        let mut previous_near = seeded(91.0, &near);
        previous_near.windows.get_mut("a\u{1f}w").unwrap().samples = samples;
        let (_, events) = evaluate(&previous_near, &near_snap, &cfg, now_ms);
        assert!(events.is_empty());
    }

    #[test]
    fn per_provider_overrides_change_thresholds_and_disable_alerts() {
        let snap = snapshot(vec![account("a", "claude", vec![window("w", 60.0, Some(RESET))])]);
        let mut cfg = config();
        cfg.per_provider.insert(
            "claude".into(),
            ProviderAlertOverride { enabled: Some(true), thresholds: Some(vec![50]) },
        );
        assert_eq!(threshold_values(&evaluate(&AlertState::default(), &snap, &cfg, T0).1), vec![50]);

        cfg.per_provider.insert("claude".into(), ProviderAlertOverride { enabled: Some(false), thresholds: None });
        let (_, events) = evaluate(&AlertState::default(), &snap, &cfg, T0);
        assert!(events.is_empty(), "provider disabled by override");
    }

    #[test]
    fn expired_login_needs_two_polls_and_recovers() {
        let cfg = NotificationConfig {
            notify_on_expired_login: true,
            cooldown_minutes: 0,
            ..config()
        };
        let bad = account("a", "claude", vec![]);
        let mut bad_with_message = bad;
        bad_with_message["limits"]["unavailable"] = json!({"reason": "probeFailed", "message": "login-expired: token revoked"});
        let snap = snapshot(vec![bad_with_message]);

        let (first, events) = evaluate(&AlertState::default(), &snap, &cfg, T0);
        assert!(events.is_empty(), "one poll is not enough");
        assert_eq!(first.accounts["a"].login_polls, 1);
        let (second, events) = evaluate(&first, &snap, &cfg, T0 + 60_000);
        assert_eq!(events.iter().filter(|e| e.kind == "login").count(), 1);
        assert_eq!(events[0].severity, "warn");
        let (third, events) = evaluate(&second, &snap, &cfg, T0 + 120_000);
        assert!(events.is_empty(), "one event per episode");

        let good = snapshot(vec![account("a", "claude", vec![window("w", 5.0, Some(RESET))])]);
        let (recovered, _) = evaluate(&third, &good, &cfg, T0 + 180_000);
        assert_eq!(recovered.accounts["a"].login_polls, 0);
        assert!(!recovered.accounts["a"].login_fired);
        // A fresh episode needs two auth-looking polls again.
        let (polling, events) = evaluate(&recovered, &snap, &cfg, T0 + 240_000);
        assert!(events.is_empty());
        let (_, events) = evaluate(&polling, &snap, &cfg, T0 + 300_000);
        assert_eq!(events.iter().filter(|e| e.kind == "login").count(), 1, "new episode alerts again");
    }

    #[test]
    fn compact_status_and_raw_limits_shapes_are_both_accepted() {
        let cfg = config();
        let snap = snapshot(vec![compact_account("a", "claude", vec![window("w", 85.0, Some(RESET))])]);
        let (_, events) = evaluate(&AlertState::default(), &snap, &cfg, T0);
        assert_eq!(threshold_values(&events), vec![80]);
    }

    #[test]
    fn disabled_engine_produces_nothing() {
        let cfg = NotificationConfig::default();
        let snap = snapshot(vec![account("a", "claude", vec![window("w", 100.0, Some(RESET))])]);
        let (state, events) = evaluate(&AlertState::default(), &snap, &cfg, T0);
        assert!(events.is_empty());
        assert!(state.windows.is_empty());
    }

    #[test]
    fn state_persists_atomically_and_survives_reload() {
        let mut state = AlertState::default();
        state.version = 1;
        state.snooze_until = Some(T0 + 10_000);
        state.last_events.push(AlertEvent {
            id: "x".into(), ts: T0, kind: "reset".into(), account_id: "a".into(),
            provider: "claude".into(), window_id: None, title: "t".into(), body: "b".into(),
            severity: "info".into(), used_percent: None,
        });
        let dir = std::env::temp_dir().join(format!("burnrate-alerts-test-{}-{}", std::process::id(), T0));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("alerts-state.json");
        assert!(save_state(&path, &state));
        assert!(!dir.join("alerts-state.json.tmp").exists());
        let loaded = load_state(&path);
        assert_eq!(loaded.snooze_until, Some(T0 + 10_000));
        assert_eq!(loaded.last_events.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn emitted_events_are_recorded_in_history_and_bounded() {
        let cfg = config();
        let snap = snapshot(vec![account("a", "claude", vec![window("w", 100.0, Some(RESET))])]);

        // What on_snapshot persists must contain the events it also publishes/delivers.
        let (state, events) = evaluate_and_record(&AlertState::default(), &snap, &cfg, T0);
        assert_eq!(threshold_values(&events), vec![80, 90, 100]);
        assert_eq!(state.last_events.len(), 3, "emitted events must be appended to history");
        assert_eq!(state.last_events[0].id, events[0].id);
        assert_eq!(state.last_events[2].id, events[2].id);

        // A repeat snapshot appends nothing (dedupe) and never clears existing history.
        let (again, more) = evaluate_and_record(&state, &snap, &cfg, T0 + 60_000);
        assert!(more.is_empty());
        assert_eq!(again.last_events.len(), 3);

        // The ring stays bounded and keeps the newest events.
        let mut seeded = AlertState::default();
        seeded.last_events = (0..MAX_RECENT_EVENTS + 5)
            .map(|i| AlertEvent {
                id: format!("old-{i}"), ts: T0, kind: "threshold".into(), account_id: "a".into(),
                provider: "claude".into(), window_id: None, title: "t".into(), body: "b".into(),
                severity: "warn".into(), used_percent: None,
            })
            .collect();
        let (trimmed, _) = evaluate_and_record(&seeded, &snap, &cfg, T0);
        assert_eq!(trimmed.last_events.len(), MAX_RECENT_EVENTS);
        assert_eq!(trimmed.last_events.last().map(|e| e.id.as_str()), Some(events[2].id.as_str()));

        // History survives a save/load cycle (restart).
        let dir = std::env::temp_dir().join(format!("burnrate-alerts-history-{}-{}", std::process::id(), T0));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("alerts-state.json");
        assert!(save_state(&path, &trimmed));
        assert_eq!(load_state(&path).last_events.len(), MAX_RECENT_EVENTS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_parses_notifications_section_with_defaults() {
        let settings = json!({
            "notifications": {"enabled": true, "thresholds": [70, 90], "perProvider": {"claude": {"enabled": false}}}
        });
        let cfg = NotificationConfig::from_settings(&settings);
        assert!(cfg.enabled);
        assert_eq!(cfg.thresholds, vec![70, 90]);
        assert_eq!(cfg.cooldown_minutes, DEFAULT_COOLDOWN_MINUTES);
        assert!(!cfg.per_provider["claude"].enabled.unwrap());
        let empty = NotificationConfig::from_settings(&json!({}));
        assert!(!empty.enabled);
        assert_eq!(empty.thresholds, vec![80, 90, 100]);
    }
}
