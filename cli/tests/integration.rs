//! Integration tests against a tiny in-test loopback HTTP stub. No real server,
//! no real keys, no external network. Each stub serves exactly one connection.

use burnrate_cli::{model, net, render};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

fn stub(response: String) -> (u16, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        // Wait for the complete request (headers AND body) before replying; otherwise a POST can be
        // aborted mid-send on Windows (WSAECONNABORTED) when the server closes first.
        let mut request = Vec::new();
        let mut buf = [0u8; 4096];
        let mut header_end = None;
        while header_end.is_none() {
            let n = stream.read(&mut buf).unwrap_or(0);
            if n == 0 { break; }
            request.extend_from_slice(&buf[..n]);
            header_end = request.windows(4).position(|w| w == b"\r\n\r\n").map(|at| at + 4);
        }
        if let Some(end) = header_end {
            let headers = String::from_utf8_lossy(&request[..end]);
            let length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok())?
                })
                .unwrap_or(0);
            while request.len() < end + length {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 { break; }
                request.extend_from_slice(&buf[..n]);
            }
        }
        stream.write_all(response.as_bytes()).unwrap();
        let _ = stream.flush();
    });
    (port, handle)
}

fn http_json(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[test]
fn fetch_parse_and_render_status() {
    let reset = now() + 3 * 3600 + 57 * 60;
    let body = format!(
        r#"{{"checkedAt":"now","accounts":[{{"id":"a","provider":"claudeAgent","label":"Claude Kernel",
            "windows":[{{"id":"five_hour","kind":"session","label":"5h","usedPercent":27,
            "remainingPercent":73,"resetsAt":"{reset}","state":"ok"}}]}}],
            "worst":{{"accountId":"a","provider":"claudeAgent","windowId":"five_hour","remainingPercent":73}},
            "notices":[]}}"#
    );
    let (port, handle) = stub(http_json(&body));
    let fetched = net::fetch_status(port).unwrap();
    assert_eq!(fetched, body);

    let status = model::Status::parse(&fetched).unwrap();
    let line = render::status_line(&status, Some("claudeagent"), Some("session"), false, now());
    assert!(line.starts_with("Claude Kernel 27% used"), "unexpected line: {line}");
    assert!(line.contains("resets"), "unexpected line: {line}");

    let waybar = render::waybar_json(&status, now());
    assert_eq!(waybar["text"], "5h 27%");
    assert_eq!(waybar["class"], "ok");
    handle.join().unwrap();
}

#[test]
fn post_statusline_reaches_ingest_endpoint() {
    let (port, handle) = stub(http_json(r#"{"ok":true}"#));
    net::post_statusline(port, r#"{"rate_limits":{"five_hour":{"used_percentage":47}}}"#).unwrap();
    handle.join().unwrap();
}

#[test]
fn stream_events_reads_sse_snapshot() {
    let sse = "event: snapshot\ndata: {\"accounts\":[{\"id\":\"a\",\"provider\":\"p\",\"label\":\"L\",\"windows\":[]}]}\n\n";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{sse}",
        sse.len()
    );
    let (port, handle) = stub(response);
    let mut lines = Vec::new();
    net::stream_events(port, |line| lines.push(line.to_string())).unwrap();
    assert!(lines.iter().any(|l| net::status_from_sse_line(l).is_some()));
    handle.join().unwrap();
}

#[test]
fn unreachable_daemon_is_an_error() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    assert!(net::fetch_status(port).is_err());
}
