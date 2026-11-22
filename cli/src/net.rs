//! Loopback HTTP client. No TLS feature (http only), no proxy discovery.

use serde_json::Value;
use std::fmt;
use std::io::{BufRead, BufReader};
use std::time::Duration;

#[derive(Debug)]
pub struct NetError(pub String);

impl fmt::Display for NetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}", self.0) }
}

const INGEST_TIMEOUT: Duration = Duration::from_millis(280); // < 300 ms statusline budget
const REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);
const STREAM_TIMEOUT: Duration = Duration::from_secs(365 * 24 * 3600); // effectively none

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(timeout)
        .try_proxy_from_env(false)
        .build()
}

pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

pub fn status_url(port: u16) -> String {
    format!("{}/api/status", base_url(port))
}

pub fn stream_url(port: u16) -> String {
    format!("{}/api/stream", base_url(port))
}

pub fn ingest_url(port: u16) -> String {
    format!("{}/api/ingest/claude-statusline", base_url(port))
}

/// GET /api/status -> raw JSON body.
pub fn fetch_status(port: u16) -> Result<String, NetError> {
    let resp = agent(REQUEST_TIMEOUT)
        .get(&status_url(port))
        .call()
        .map_err(|e| NetError(e.to_string()))?;
    if resp.status() >= 400 {
        return Err(NetError(format!("status endpoint returned {}", resp.status())));
    }
    resp.into_string().map_err(|e| NetError(e.to_string()))
}

/// POST the Claude Code statusline payload to the ingest endpoint. Best effort:
/// the 280 ms agent timeout keeps the whole call under the 300 ms budget.
pub fn post_statusline(port: u16, body: &str) -> Result<(), NetError> {
    agent(INGEST_TIMEOUT)
        .post(&ingest_url(port))
        .set("Content-Type", "application/json")
        .set("X-Burnrate", "1")
        .send_bytes(body.as_bytes())
        .map(|_| ())
        .map_err(|e| NetError(e.to_string()))
}

/// Follow /api/stream (SSE), invoking `on_line` for every line received.
pub fn stream_events<F: FnMut(&str)>(port: u16, mut on_line: F) -> Result<(), NetError> {
    let resp = agent(STREAM_TIMEOUT)
        .get(&stream_url(port))
        .set("Accept", "text/event-stream")
        .call()
        .map_err(|e| NetError(e.to_string()))?;
    if resp.status() >= 400 {
        return Err(NetError(format!("stream endpoint returned {}", resp.status())));
    }
    let reader = BufReader::new(resp.into_reader());
    for line in reader.lines() {
        let line = line.map_err(|e| NetError(e.to_string()))?;
        on_line(&line);
    }
    Ok(())
}

/// Extract a compact-status JSON object from one SSE `data:` line.
/// Accepts both a bare status object and an envelope `{ snapshot: {...} }`.
pub fn status_from_sse_line(line: &str) -> Option<String> {
    let data = line.strip_prefix("data:")?.trim();
    if data.is_empty() || data == "[DONE]" { return None; }
    let value: Value = serde_json::from_str(data).ok()?;
    if value.get("accounts").is_some() {
        return Some(data.to_string());
    }
    for key in ["snapshot", "compactStatus", "status"] {
        if let Some(inner) = value.get(key) {
            if inner.get("accounts").is_some() {
                return Some(inner.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(status_url(13811), "http://127.0.0.1:13811/api/status");
        assert_eq!(stream_url(13790), "http://127.0.0.1:13790/api/stream");
        assert_eq!(ingest_url(1), "http://127.0.0.1:1/api/ingest/claude-statusline");
    }

    #[test]
    fn sse_extraction() {
        assert_eq!(status_from_sse_line("data: {\"accounts\":[]}").as_deref(), Some("{\"accounts\":[]}"));
        assert_eq!(status_from_sse_line("data: {\"snapshot\":{\"accounts\":[]}}").as_deref(), Some("{\"accounts\":[]}"));
        assert!(status_from_sse_line("event: snapshot").is_none());
        assert!(status_from_sse_line("data: [DONE]").is_none());
        assert!(status_from_sse_line("data: {").is_none());
    }
}
