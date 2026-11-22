//! Alert routes (docs/CONTRACTS.md section 10).
//! `GET /api/alerts/state`, `GET /api/alerts/recent`, `POST /api/alerts/test`,
//! `POST /api/alerts/snooze`, `DELETE /api/alerts/snooze`.
//!
//! `POST /api/alerts/test` accepts an optional `{ "channel": "ntfy" | "discord" | "webhook" }`.
//! With a channel it sends only to that channel and reports the real outcome per channel; without
//! one it keeps the original behaviour (in-app alert plus every enabled channel).
use super::Resp;
use crate::alerts::channels::{self, HttpRequest, HttpSender, UreqSender};
use crate::alerts::{self, AlertEvent, NotificationConfig};
use crate::{json_response, read_body, State};
use chrono::{TimeZone, Utc};
use serde_json::{json, Value};
use tiny_http::{Method, Request};

pub fn handle(state: &State, request: &mut Request, method: &Method, path: &str) -> Option<Resp> {
    match (method, path) {
        (Method::Get, "/api/alerts/state") => Some(json_response(200, &state_response(state))),
        (Method::Get, "/api/alerts/recent") => {
            Some(json_response(200, &json!({ "events": alerts::recent_events(alerts::MAX_RECENT_EVENTS) })))
        }
        (Method::Post, "/api/alerts/test") => {
            let Some(body) = read_body(request) else {
                return Some(json_response(400, &json!({ "error": "invalid body" })));
            };
            let channel = body.get("channel").and_then(Value::as_str);
            if channel.is_some_and(|name| !CHANNEL_NAMES.contains(&name)) {
                return Some(json_response(400, &json!({ "error": "unknown channel" })));
            }
            Some(test(state, channel))
        }
        (Method::Post, "/api/alerts/snooze") => {
            let Some(body) = read_body(request) else {
                return Some(json_response(400, &json!({ "error": "invalid body" })));
            };
            let minutes = body
                .get("minutes")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .clamp(0.0, 24.0 * 60.0);
            let until_ms = Utc::now().timestamp_millis().saturating_add((minutes * 60_000.0) as i64);
            let next = alerts::set_snooze(until_ms);
            mirror_snooze(state, Some(until_ms));
            Some(json_response(200, &json!({
                "ok": true,
                "snoozeUntil": iso(until_ms),
                "state": public_state(&next),
            })))
        }
        (Method::Delete, "/api/alerts/snooze") => {
            let next = alerts::clear_snooze();
            mirror_snooze(state, None);
            Some(json_response(200, &json!({ "ok": true, "state": public_state(&next) })))
        }
        _ => None,
    }
}

fn iso(milliseconds: i64) -> Value {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .map(|date| json!(date.to_rfc3339()))
        .unwrap_or(Value::Null)
}

/// Keep the settings schema's `notifications.snoozeUntil` in sync (best effort).
fn mirror_snooze(state: &State, until_ms: Option<i64>) {
    let value = until_ms.map(iso).unwrap_or(Value::Null);
    let _ = state.settings.patch(&json!({ "notifications": { "snoozeUntil": value } }));
}

fn public_state(state: &alerts::AlertState) -> Value {
    json!({
        "version": state.version,
        "snoozeUntil": state.snooze_until.map(iso).unwrap_or(Value::Null),
        "lastEvents": state.last_events,
    })
}

fn state_response(state: &State) -> Value {
    let cfg = NotificationConfig::from_settings(&state.settings.raw());
    let current = alerts::current_state();
    let now = Utc::now().timestamp_millis();
    let effective = current
        .snooze_until
        .or_else(|| cfg.snooze_until.as_deref().and_then(alerts::parse_ms));
    json!({
        "enabled": cfg.enabled,
        "snoozed": effective.is_some_and(|until| now < until),
        "snoozeMsRemaining": effective.map(|until| (until - now).max(0)).unwrap_or(0),
        "snoozeUntil": effective.map(iso).unwrap_or(Value::Null),
        "lastEvents": current.last_events,
    })
}

const CHANNEL_NAMES: [&str; 3] = ["ntfy", "discord", "webhook"];

fn channel_label(name: &str) -> &str {
    match name {
        "ntfy" => "ntfy",
        "discord" => "Discord",
        _ => "Webhook",
    }
}

/// Records the outcome of every `send` so a test can report real delivery results.
struct RecordingSender<'a> {
    inner: &'a dyn HttpSender,
    outcomes: std::sync::Mutex<Vec<Result<(), String>>>,
}

impl HttpSender for RecordingSender<'_> {
    fn send(&self, request: &HttpRequest<'_>) -> Result<(), String> {
        let outcome = self.inner.send(request);
        if let Ok(mut outcomes) = self.outcomes.lock() {
            outcomes.push(outcome.clone());
        }
        outcome
    }
}

/// Delivers `alert` and returns `(channel, error)` for every attempted channel (`None` = delivered).
/// With `only`, just that channel is tried, even when the master switch or its own switch is off,
/// and a missing secret is reported instead of silently skipped.
fn run_test(
    cfg: &NotificationConfig,
    alert: &AlertEvent,
    secrets: &std::collections::HashMap<String, String>,
    only: Option<&str>,
    sender: &dyn HttpSender,
) -> Vec<(String, Option<String>)> {
    let mut cfg = cfg.clone();
    if let Some(name) = only {
        let has_secret = secrets.get(name).is_some_and(|value| !value.trim().is_empty());
        if !has_secret {
            return vec![(name.to_string(), Some("No URL saved yet".to_string()))];
        }
        cfg.enabled = true;
        cfg.channels.ntfy.enabled = name == "ntfy";
        cfg.channels.discord.enabled = name == "discord";
        cfg.channels.webhook.enabled = name == "webhook";
    }
    let recorder = RecordingSender { inner: sender, outcomes: std::sync::Mutex::new(Vec::new()) };
    let attempted = channels::deliver_with(&cfg, alert, secrets, &recorder);
    let outcomes = recorder.outcomes.into_inner().unwrap_or_default();
    attempted
        .into_iter()
        .zip(outcomes)
        .map(|(name, outcome)| (name, outcome.err()))
        .collect()
}

fn test(state: &State, only: Option<&str>) -> Resp {
    let cfg = NotificationConfig::from_settings(&state.settings.raw());
    let now = Utc::now().timestamp_millis();
    let alert = AlertEvent {
        id: format!("test|{now}"),
        ts: now,
        // Kept within the documented AlertEvent kind set; the title makes its purpose explicit.
        kind: "threshold".into(),
        account_id: String::new(),
        provider: String::new(),
        window_id: None,
        title: "Burnrate test alert".into(),
        body: "This is a test notification from Burnrate.".into(),
        severity: "info".into(),
        used_percent: None,
    };
    if only.is_none() {
        if let Ok(value) = serde_json::to_value(&alert) {
            crate::hub::publish("alert", value);
        }
    }
    let secrets = channels::secrets(&state.keys);
    let results = run_test(&cfg, &alert, &secrets, only, &UreqSender);
    if only.is_none() {
        alerts::record_test_event(alert.clone());
    }
    let delivered: Vec<&str> = results.iter().filter(|(_, e)| e.is_none()).map(|(n, _)| n.as_str()).collect();
    let failed: Vec<String> = results
        .iter()
        .filter_map(|(name, error)| error.as_ref().map(|e| format!("{}: {e}", channel_label(name))))
        .collect();
    let message = if failed.is_empty() { Value::Null } else { json!(failed.join("; ")) };
    json_response(200, &json!({
        "ok": failed.is_empty(),
        "message": message,
        "event": alert,
        "delivered": delivered,
        "results": results
            .iter()
            .map(|(name, error)| json!({ "channel": name, "ok": error.is_none(), "error": error }))
            .collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct FakeSender {
        fail: bool,
        urls: std::sync::Mutex<Vec<String>>,
    }

    impl HttpSender for FakeSender {
        fn send(&self, request: &HttpRequest<'_>) -> Result<(), String> {
            self.urls.lock().unwrap().push(request.url.to_string());
            if self.fail {
                Err("notification channel responded 404".into())
            } else {
                Ok(())
            }
        }
    }

    fn fake(fail: bool) -> FakeSender {
        FakeSender { fail, urls: Default::default() }
    }

    fn alert() -> AlertEvent {
        AlertEvent {
            id: "test|1".into(),
            ts: 1,
            kind: "threshold".into(),
            account_id: String::new(),
            provider: String::new(),
            window_id: None,
            title: "Burnrate test alert".into(),
            body: "body".into(),
            severity: "info".into(),
            used_percent: None,
        }
    }

    fn secrets() -> HashMap<String, String> {
        HashMap::from([
            ("ntfy".to_string(), "https://ntfy.sh/t".to_string()),
            ("discord".to_string(), "https://discord.com/h".to_string()),
        ])
    }

    #[test]
    fn single_channel_test_only_hits_that_channel_even_when_switches_are_off() {
        let sender = fake(false);
        let cfg = NotificationConfig::default(); // master switch and channels off
        let results = run_test(&cfg, &alert(), &secrets(), Some("discord"), &sender);
        assert_eq!(results, vec![("discord".to_string(), None)]);
        assert_eq!(*sender.urls.lock().unwrap(), vec!["https://discord.com/h".to_string()]);
    }

    #[test]
    fn single_channel_test_reports_the_real_failure() {
        let sender = fake(true);
        let results = run_test(&NotificationConfig::default(), &alert(), &secrets(), Some("ntfy"), &sender);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "ntfy");
        assert!(results[0].1.as_deref().is_some_and(|e| e.contains("404")));
    }

    #[test]
    fn single_channel_test_without_a_saved_secret_does_not_send() {
        let sender = fake(false);
        let results = run_test(&NotificationConfig::default(), &alert(), &secrets(), Some("webhook"), &sender);
        assert_eq!(results, vec![("webhook".to_string(), Some("No URL saved yet".to_string()))]);
        assert!(sender.urls.lock().unwrap().is_empty());
    }

    #[test]
    fn untargeted_test_still_follows_the_enabled_channels() {
        let sender = fake(false);
        let mut cfg = NotificationConfig::default();
        cfg.enabled = true;
        cfg.channels.ntfy.enabled = true;
        let results = run_test(&cfg, &alert(), &secrets(), None, &sender);
        assert_eq!(results, vec![("ntfy".to_string(), None)]);
    }
}
