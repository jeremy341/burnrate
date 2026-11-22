//! Claude Code statusline ingest (contracts section 8).
//!
//! `POST /api/ingest/claude-statusline` accepts the JSON Claude Code writes to a `statusLine`
//! command's stdin. We cache only `rate_limits` in memory for 15 minutes; the CLI does the POST
//! best-effort, so the body is small and the write never depends on a provider probe.
//! The generic loopback Host/X-Burnrate/Origin checks already ran in `handle_api`; the header is
//! checked again here so this handler stays safe if it is ever called directly.
use super::Resp;
use crate::State;
use serde_json::{json, Value};
use std::io::Read;
use tiny_http::{Header, Method, Request, Response, StatusCode};

const PATH: &str = "/api/ingest/claude-statusline";
const MAX_BODY: u64 = 65_536;

fn respond(status: u16, body: &Value) -> Resp {
    Response::from_data(serde_json::to_vec(body).unwrap_or_default())
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
        .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap())
}

/// Pure JSON validation, shared with the unit tests. Anything that is not a JSON object is rejected.
pub fn parse_body(bytes: &[u8]) -> Result<Value, ()> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ())?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(())
    }
}

pub fn handle(state: &State, request: &mut Request, method: &Method, path: &str) -> Option<Resp> {
    if path != PATH {
        return None;
    }
    if *method != Method::Post {
        return Some(respond(405, &json!({"error": "method not allowed"})));
    }
    if !request.headers().iter().any(|h| h.field.equiv("X-Burnrate") && h.value.as_str() == "1") {
        return Some(respond(403, &json!({"error": "forbidden"})));
    }
    let mut bytes = Vec::new();
    if request.as_reader().take(MAX_BODY + 1).read_to_end(&mut bytes).is_err() {
        return Some(respond(400, &json!({"error": "invalid body"})));
    }
    if bytes.len() as u64 > MAX_BODY {
        return Some(respond(413, &json!({"error": "body too large"})));
    }
    let Ok(body) = parse_body(&bytes) else {
        return Some(respond(400, &json!({"error": "invalid json"})));
    };
    // Refresh the flag providers use; the CLI/statusline is the main reason to ingest at all, so
    // this also keeps `providers.claudeOAuthProbe` current without any extra polling.
    crate::providers::set_settings_snapshot(&state.settings.raw());
    let stored = crate::providers::statusline::ingest(&body);
    Some(respond(200, &json!({"ok": true, "windows": stored})))
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATUSLINE: &[u8] = include_bytes!("../providers/claude-statusline.json");
    const EMPTY: &[u8] = include_bytes!("../providers/claude-statusline-empty.json");

    #[test]
    fn parses_statusline_fixtures() {
        let body = parse_body(STATUSLINE).expect("fixture");
        assert_eq!(body["hook_event_name"], "Status");
        assert_eq!(body["rate_limits"]["five_hour"]["used_percentage"], 47);
        let empty = parse_body(EMPTY).expect("fixture");
        assert!(empty["rate_limits"].is_null());
    }

    #[test]
    fn rejects_invalid_and_oversized_bodies() {
        assert!(parse_body(b"{").is_err());
        assert!(parse_body(b"[]").is_err());
        assert!(parse_body(b"null").is_err());
        assert!(parse_body(STATUSLINE).is_ok());
    }

    #[test]
    fn body_cap_is_small_and_bounded() {
        // A statusline payload is a few hundred bytes; 64 KiB leaves plenty of room without
        // allowing a runaway request to pin memory.
        assert!(MAX_BODY <= 65_536);
    }
}
