//! `GET /api/status` (compact status) and `GET /api/stream` (SSE: `snapshot`, `alert`, `settings`).
//! Owned by the scheduler-hub-status package. Contract: docs/CONTRACTS.md, "Scheduler, hub, events, status".

use super::Resp;
use crate::{hub, json_response, scheduler};
use serde_json::{json, Value};
use std::io::Write;
use std::time::Duration;
use tiny_http::{Method, Request};

/// Emit a heartbeat comment if no event arrives within this time.
const HEARTBEAT: Duration = Duration::from_secs(25);
/// How long EventSource waits before reconnecting if the connection ever drops.
const RETRY_MS: u32 = 3000;

pub fn handle(_state: &crate::State, request: &mut Request, method: &Method, path: &str) -> Option<Resp> {
    match (method, path) {
        (Method::Get, "/api/status") => {
            // An interactive status read is a consumer signal; the shell's passive seed is not.
            if !is_passive(request) {
                scheduler::note_activity();
            }
            Some(json_response(200, &scheduler::compact_status()))
        }
        _ => None,
    }
}

/// The native shell marks its long-lived stream and its initial status seed as passive so they
/// cannot keep the background scheduler awake while the window is closed or minimised.
fn is_passive(request: &Request) -> bool {
    request
        .headers()
        .iter()
        .any(|h| h.field.equiv("X-Burnrate-Passive") && h.value.as_str().trim() == "1")
}

/// Unregisters an interactive stream from the scheduler on every exit path.
struct StreamGuard(bool);

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if self.0 {
            scheduler::note_stream(false);
        }
    }
}

/// Append one SSE event. `serde_json::to_string` produces compact JSON (no literal newlines),
/// so the whole payload is safe on a single `data:` line.
fn append_event(body: &mut Vec<u8>, kind: &str, data: &Value) {
    let payload = serde_json::to_string(data).unwrap_or_else(|_| "{}".to_string());
    body.extend_from_slice(format!("event: {kind}\ndata: {payload}\n\n").as_bytes());
}

/// True when this request is the SSE endpoint. The request loop calls `serve_stream` for it instead of the
/// buffered route registry, because a stream needs the raw connection.
pub fn is_stream_request(method: &Method, path: &str) -> bool {
    *method == Method::Get && path == "/api/stream"
}

/// Serve `GET /api/stream` as a real long-lived `text/event-stream` response.
///
/// The response is written by hand on the raw connection (`Request::into_writer`) so every event is flushed
/// immediately: headers and the cached snapshot go out at once, later events follow as the hub publishes them,
/// and a heartbeat comment keeps idle connections alive. The body ends when the client disconnects (a failed
/// write) or the hub drops this subscription. Capped at `hub::MAX_STREAM_SUBSCRIBERS` streams.
/// A `X-Burnrate-Passive: 1` request (the shell) is not registered as an active consumer, so it
/// cannot keep the scheduler's refresh loop awake while the app is in the tray.
pub fn serve_stream(request: Request) {
    let passive = is_passive(&request);
    let _stream_guard = StreamGuard(!passive);
    if !passive {
        scheduler::note_stream(true);
    }
    let Some(subscription) = hub::subscribe() else {
        let _ = request.respond(json_response(429, &json!({"error": "too many streams"})));
        return;
    };
    let mut out = request.into_writer();
    let head = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nX-Accel-Buffering: no\r\n\r\n";
    let mut first = Vec::new();
    first.extend_from_slice(format!("retry: {RETRY_MS}\n\n").as_bytes());
    if let Some(snapshot) = scheduler::cached_compact() {
        append_event(&mut first, "snapshot", &snapshot);
    } else {
        first.extend_from_slice(b": connected\n\n");
    }
    if out.write_all(head).is_err() || out.write_all(&first).is_err() || out.flush().is_err() {
        return;
    }
    loop {
        let mut frame = Vec::new();
        match subscription.recv_timeout(HEARTBEAT) {
            Ok(event) => {
                append_event(&mut frame, &event.kind, &event.data);
                // Coalesce a burst that is already queued into one write.
                while let Ok(next) = subscription.try_recv() {
                    append_event(&mut frame, &next.kind, &next.data);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => frame.extend_from_slice(b": heartbeat\n\n"),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
        }
        if out.write_all(&frame).is_err() || out.flush().is_err() {
            return; // client went away; dropping `subscription` frees the stream slot
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_event_formats_sse_frames() {
        let mut body = Vec::new();
        append_event(&mut body, "alert", &json!({"id": "a1", "title": "line\nbreak"}));
        let text = String::from_utf8(body).unwrap();
        assert!(text.starts_with("event: alert\ndata: "));
        assert!(text.ends_with("\n\n"));
        assert!(text.contains("\\n")); // newline is escaped inside the JSON string
        assert!(!text.lines().any(|line| line.starts_with("data: ") && line.contains('\n')));
    }
}
