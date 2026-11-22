//! Notification delivery (docs/CONTRACTS.md section 10).
//!
//! Posts an `AlertEvent` to ntfy / Discord / a generic webhook using secrets from the encrypted
//! store (`secret:alerts`). All outbound traffic goes through `net_guard` and an injectable
//! `HttpSender`, so tests never touch the network. At most one attempt per channel per event: no
//! retries, no storms.

use super::{AlertEvent, NotificationConfig};
use std::collections::HashMap;
use std::time::Duration;

/// The `KeyStore` provider id that holds channel secrets (contracts section 6).
pub const SECRET_SCOPE: &str = "secret:alerts";

/// A single outbound request. Real senders must validate `url` with `net_guard::check_url`.
pub struct HttpRequest<'a> {
    pub url: &'a str,
    pub headers: Vec<(&'a str, String)>,
    pub body: String,
}

/// Injectable HTTP boundary. Production uses `UreqSender`; tests use a capturing fake.
pub trait HttpSender: Send + Sync {
    fn send(&self, request: &HttpRequest<'_>) -> Result<(), String>;
}

/// Classify an upstream status. A 3xx is refused: redirects must never move a notification (or its
/// headers/body) to a host that was not validated by `net_guard`.
fn status_error(status: u16) -> Option<String> {
    if (300..400).contains(&status) {
        Some("redirect refused".into())
    } else if status >= 400 {
        Some(format!("notification channel responded {status}"))
    } else {
        None
    }
}

/// The only production sender: HTTPS-only, 5-second timeout, no redirects, redacted errors.
pub struct UreqSender;

impl HttpSender for UreqSender {
    fn send(&self, request: &HttpRequest<'_>) -> Result<(), String> {
        let safe = crate::net_guard::check_url(request.url, None, false)?;
        // Never follow a redirect to an unvalidated host, and make the connect-time address check
        // authoritative. Environment proxies are disabled so net_guard checks the real target.
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(5))
            .redirects(0)
            .try_proxy_from_env(false)
            .resolver(crate::net_guard::GuardedResolver { allow_local: false })
            .build();
        let mut call = agent.post(&safe);
        for (name, value) in &request.headers {
            call = call.set(name, value);
        }
        let response = call
            .send_string(&request.body)
            .map_err(|error| crate::net_guard::redact(&error.to_string()))?;
        if let Some(message) = status_error(response.status()) {
            return Err(crate::net_guard::redact(&message));
        }
        Ok(())
    }
}

/// Reads `ntfy`, `discord` and `webhook` secrets from the encrypted key store.
pub fn secrets(keys: &crate::keys::KeyStore) -> HashMap<String, String> {
    keys.list(SECRET_SCOPE).into_iter().collect()
}

/// Delivers `event` using the real HTTPS sender. Returns the names of channels attempted.
pub fn deliver(
    cfg: &NotificationConfig,
    event: &AlertEvent,
    keys: &crate::keys::KeyStore,
) -> Vec<String> {
    deliver_with(cfg, event, &secrets(keys), &UreqSender)
}

/// Core delivery with an injected secret map and sender (unit-testable, no I/O).
pub fn deliver_with(
    cfg: &NotificationConfig,
    event: &AlertEvent,
    secrets: &HashMap<String, String>,
    sender: &dyn HttpSender,
) -> Vec<String> {
    let mut attempted = Vec::new();
    if !cfg.enabled {
        return attempted;
    }

    if cfg.channels.ntfy.enabled {
        if let Some(url) = secret(secrets, "ntfy") {
            let priority = match event.severity.as_str() {
                "critical" => "5",
                "warn" => "3",
                _ => "1",
            };
            let headers = vec![
                ("Title", event.title.clone()),
                ("Tags", "warning".to_string()),
                ("X-Priority", priority.to_string()),
                ("Content-Type", "text/plain; charset=utf-8".to_string()),
            ];
            attempt("ntfy", url, headers, event.body.clone(), sender, &mut attempted);
        }
    }

    if cfg.channels.discord.enabled {
        if let Some(url) = secret(secrets, "discord") {
            let content = format!("**{}**\n{}", event.title, event.body);
            let body = serde_json::json!({ "content": content }).to_string();
            let headers = vec![("Content-Type", "application/json".to_string())];
            attempt("discord", url, headers, body, sender, &mut attempted);
        }
    }

    if cfg.channels.webhook.enabled {
        if let Some(url) = secret(secrets, "webhook") {
            let body = serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string());
            let headers = vec![("Content-Type", "application/json".to_string())];
            attempt("webhook", url, headers, body, sender, &mut attempted);
        }
    }

    attempted
}

fn secret<'a>(secrets: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    secrets
        .get(name)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
}

fn attempt(
    name: &str,
    url: &str,
    headers: Vec<(&'static str, String)>,
    body: String,
    sender: &dyn HttpSender,
    attempted: &mut Vec<String>,
) {
    let request = HttpRequest { url, headers, body };
    // Best effort: one attempt, no retries. The sender redacts any error it surfaces.
    let _ = sender.send(&request);
    attempted.push(name.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct CapturingSender {
        seen: Mutex<Vec<(String, Vec<(String, String)>, String)>>,
    }

    impl HttpSender for CapturingSender {
        fn send(&self, request: &HttpRequest<'_>) -> Result<(), String> {
            self.seen.lock().unwrap().push((
                request.url.to_string(),
                request.headers.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
                request.body.clone(),
            ));
            Ok(())
        }
    }

    fn event() -> AlertEvent {
        AlertEvent {
            id: "threshold|a|w|80|0".into(),
            ts: 1_700_000_000_000,
            kind: "threshold".into(),
            account_id: "a".into(),
            provider: "claude".into(),
            window_id: Some("w".into()),
            title: "Claude at 80%".into(),
            body: "Your 5-hour window is 80% used.".into(),
            severity: "warn".into(),
            used_percent: Some(80.0),
        }
    }

    #[test]
    fn delivers_only_enabled_configured_channels() {
        let mut cfg = NotificationConfig::default();
        cfg.enabled = true;
        cfg.channels.ntfy.enabled = true;
        cfg.channels.webhook.enabled = true;
        let secrets = HashMap::from([
            ("ntfy".to_string(), " https://ntfy.sh/topic ".to_string()),
            ("webhook".to_string(), "https://example.com/hook".to_string()),
        ]);
        let sender = CapturingSender::default();
        let attempted = deliver_with(&cfg, &event(), &secrets, &sender);
        assert_eq!(attempted, vec!["ntfy", "webhook"]);
        let seen = sender.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].0, "https://ntfy.sh/topic");
        assert_eq!(seen[0].2, "Your 5-hour window is 80% used.");
        assert!(seen[0].1.iter().any(|(k, v)| k == "X-Priority" && v == "3"));
        assert!(seen[1].2.contains("\"accountId\":\"a\""));
    }

    #[test]
    fn redirects_are_refused_but_successes_are_accepted() {
        assert!(status_error(200).is_none());
        assert!(status_error(204).is_none());
        for code in [301, 302, 303, 307, 308] {
            assert_eq!(status_error(code).as_deref(), Some("redirect refused"), "{code}");
        }
        assert!(status_error(500).is_some_and(|m| m.contains("responded 500")));
    }

    #[test]
    fn nothing_is_sent_when_master_switch_is_off() {
        let cfg = NotificationConfig::default(); // enabled = false
        let secrets = HashMap::from([("discord".to_string(), "https://example.com/hook".to_string())]);
        let sender = CapturingSender::default();
        assert!(deliver_with(&cfg, &event(), &secrets, &sender).is_empty());
        assert!(sender.seen.lock().unwrap().is_empty());
    }

    #[test]
    fn discord_payload_and_missing_or_blank_secrets_are_skipped() {
        let mut cfg = NotificationConfig::default();
        cfg.enabled = true;
        cfg.channels.discord.enabled = true;
        cfg.channels.ntfy.enabled = true;
        let secrets = HashMap::from([
            ("discord".to_string(), "https://discord.com/hook".to_string()),
            ("ntfy".to_string(), "   ".to_string()),
        ]);
        let sender = CapturingSender::default();
        let attempted = deliver_with(&cfg, &event(), &secrets, &sender);
        assert_eq!(attempted, vec!["discord"]);
        let seen = sender.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].2.contains("**Claude at 80%**"));
    }
}
