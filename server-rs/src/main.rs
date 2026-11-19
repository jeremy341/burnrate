mod engine;
mod keys;
mod pricing;
mod providers;
mod readers;
mod settings;
mod store;
mod types;

use engine::{Engine, SummaryInput};
use keys::KeyStore;
use providers::Provider;
use serde_json::{json, Value};
use settings::SettingsStore;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

struct State {
    port: u16,
    web_dir: PathBuf,
    keys: KeyStore,
    settings: SettingsStore,
    engine: Engine,
    providers: Vec<Box<dyn Provider>>,
}

fn json_response(status: u16, body: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(serde_json::to_vec(body).unwrap_or_default())
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
        .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap())
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("json") => "application/json",
        Some("woff2") => "font/woff2",
        Some("webmanifest") => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query(url: &str) -> std::collections::HashMap<String, String> {
    url.split_once('?')
        .map(|(_, q)| q.split('&').filter_map(|p| p.split_once('=')).map(|(k, v)| (percent_decode(k), percent_decode(v))).collect())
        .unwrap_or_default()
}

fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

fn valid_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}

fn provider_info(state: &State) -> Value {
    Value::Array(
        state
            .providers
            .iter()
            .map(|p| {
                let names = if p.auth() == providers::Auth::ApiKey { state.keys.names(p.id()) } else { Vec::new() };
                let connected = if p.auth() == providers::Auth::ApiKey { !names.is_empty() } else { p.has_login() };
                json!({
                    "id": p.id(), "label": p.label(), "color": p.color(), "auth": p.auth().as_str(), "connected": connected,
                    "accounts": names.iter().map(|n| json!({"id": n, "label": n})).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

/// Reads every provider's limits at once: each is a network call.
fn limits_report(state: &State) -> Value {
    let results: Vec<Vec<Value>> = std::thread::scope(|scope| {
        let handles: Vec<_> = state.providers.iter().map(|p| scope.spawn(|| p.read(&state.keys))).collect();
        handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    });
    let mut accounts: Vec<Value> = Vec::new();
    let mut notices: Vec<String> = Vec::new();
    for batch in results {
        accounts.extend(batch);
    }
    for a in &accounts {
        if let Some(message) = a.pointer("/limits/unavailable/message").and_then(Value::as_str) {
            let name = a.get("displayName").or_else(|| a.get("label")).and_then(Value::as_str).unwrap_or("");
            notices.push(format!("{name}: {message}"));
        }
    }
    let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "this computer".into());
    json!({"createdAt": providers::iso_now(), "hostLabel": host, "accounts": accounts, "notices": notices})
}

fn read_body(request: &mut Request) -> Option<Value> {
    let mut body = Vec::new();
    request.as_reader().take(16_385).read_to_end(&mut body).ok()?;
    if body.len() > 16_384 {
        return None;
    }
    if body.is_empty() {
        return Some(json!({}));
    }
    serde_json::from_slice(&body).ok()
}

fn handle_api(state: &State, request: &mut Request, path: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let method = request.method().clone();
    if method != Method::Get {
        // Cross-site pages cannot send this header without a CORS preflight, which is never granted.
        let has_header = request.headers().iter().any(|h| h.field.equiv("X-Burnrate") && h.value.as_str() == "1");
        if !has_header {
            return json_response(403, &json!({"error": "forbidden"}));
        }
        if let Some(origin) = request.headers().iter().find(|h| h.field.equiv("Origin")).map(|h| h.value.as_str().to_string()) {
            let host = origin.split("://").nth(1).unwrap_or("");
            if host != format!("127.0.0.1:{}", state.port) && host != format!("localhost:{}", state.port) {
                return json_response(403, &json!({"error": "forbidden"}));
            }
        }
    }
    let url = request.url().to_string();
    match (&method, path) {
        (Method::Get, "/api/providers") => return json_response(200, &provider_info(state)),
        (Method::Get, "/api/limits") => return json_response(200, &limits_report(state)),
        (Method::Get, "/api/settings") => return json_response(200, &state.settings.raw()),
        (Method::Patch, "/api/settings") => {
            let Some(body) = read_body(request) else { return json_response(400, &json!({"error": "invalid settings"})) };
            return match state.settings.patch(body.get("patch").unwrap_or(&json!({}))) {
                Some(next) => json_response(200, &next),
                None => json_response(400, &json!({"error": "invalid settings"})),
            };
        }
        (Method::Get, "/api/usage") => {
            let q = query(&url);
            let since = q.get("since").cloned().unwrap_or_default();
            let until = q.get("until").cloned().unwrap_or_default();
            if !is_day(&since) || !is_day(&until) {
                return json_response(400, &json!({"error": "invalid window"}));
            }
            let input = SummaryInput {
                since_day: since,
                until_day: until,
                time_zone: q.get("tz").filter(|t| !t.is_empty()).cloned().unwrap_or_else(|| "UTC".into()),
                hourly: q.get("resolution").is_some_and(|r| r == "hour"),
            };
            return json_response(200, &state.engine.summary(&input, &state.settings.get()));
        }
        _ => {}
    }
    // /api/providers/<id>/keys[/<name>]
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if parts.len() >= 4 && parts[0] == "api" && parts[1] == "providers" && parts[3] == "keys" {
        let Some(provider) = state.providers.iter().find(|p| p.id() == parts[2] && p.auth() == providers::Auth::ApiKey) else {
            return json_response(404, &json!({"error": "unknown provider"}));
        };
        if method == Method::Post && parts.len() == 4 {
            let Some(body) = read_body(request) else { return json_response(400, &json!({"error": "invalid name or key"})) };
            let name = body.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
            let key = body.get("apiKey").and_then(Value::as_str).map(str::trim).unwrap_or("");
            if !valid_name(name) || key.len() < 8 || key.len() > 4096 {
                return json_response(400, &json!({"error": "invalid name or key"}));
            }
            state.keys.set(provider.id(), name, key);
            return json_response(200, &json!({"ok": true}));
        }
        if method == Method::Delete && parts.len() == 5 && valid_name(parts[4]) {
            state.keys.remove(provider.id(), parts[4]);
            return json_response(200, &json!({"ok": true}));
        }
    }
    json_response(404, &json!({"error": "not found"}))
}

fn serve_static(state: &State, path: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let rel = percent_decode(path);
    let mut file = state.web_dir.join(rel.trim_start_matches('/'));
    // Stay inside the web directory.
    let inside = file.components().all(|c| !matches!(c, std::path::Component::ParentDir));
    if !inside {
        return Response::from_data(Vec::new()).with_status_code(StatusCode(403));
    }
    if !file.is_file() {
        file = state.web_dir.join("index.html");
    }
    match std::fs::read(&file) {
        Ok(bytes) => {
            let cache = if file.file_name().is_some_and(|n| n == "index.html") { "no-store" } else { "public, max-age=3600" };
            Response::from_data(bytes)
                .with_header(Header::from_bytes("Content-Type", mime(&file)).unwrap())
                .with_header(Header::from_bytes("Cache-Control", cache).unwrap())
        }
        Err(_) => Response::from_data(b"Build the web app first: pnpm build".to_vec()).with_status_code(StatusCode(404)),
    }
}

fn find_web_dir() -> PathBuf {
    if let Some(dir) = readers::env_path("BURNRATE_WEB") {
        return dir;
    }
    let mut candidates: Vec<PathBuf> = vec![PathBuf::from("dist/web")];
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().skip(1).take(6) {
            candidates.push(ancestor.join("dist").join("web"));
        }
    }
    candidates.into_iter().find(|c| c.join("index.html").is_file()).unwrap_or_else(|| PathBuf::from("dist/web"))
}

fn main() {
    let port: u16 = std::env::var("BURNRATE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(13790);
    let web_dir = find_web_dir();
    // The data directory sits next to the web build unless told otherwise.
    let data_dir = readers::env_path("BURNRATE_DATA").unwrap_or_else(|| web_dir.parent().and_then(Path::parent).map_or_else(|| PathBuf::from("data"), |root| root.join("data")));
    let state = Arc::new(State {
        port,
        web_dir,
        keys: KeyStore::open(&data_dir),
        settings: SettingsStore::open(&data_dir),
        engine: Engine::new(data_dir.clone()),
        providers: providers::all(),
    });
    let server = match Server::http(format!("127.0.0.1:{port}")) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Cannot listen on 127.0.0.1:{port}: {e}");
            std::process::exit(1);
        }
    };
    println!("Burnrate listening on http://127.0.0.1:{port}");
    // Read the transcripts once in the background so the first Cost view does not wait for a cold scan.
    {
        let state = state.clone();
        std::thread::spawn(move || {
            let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
            state.engine.summary(&SummaryInput { since_day: today.clone(), until_day: today, time_zone: "UTC".into(), hourly: false }, &state.settings.get());
        });
    }
    for mut request in server.incoming_requests() {
        let state = state.clone();
        std::thread::spawn(move || {
            // Reject DNS rebinding: only our own loopback host names are served.
            let host = request.headers().iter().find(|h| h.field.equiv("Host")).map(|h| h.value.as_str().to_string()).unwrap_or_default();
            let allowed = host == format!("127.0.0.1:{}", state.port) || host == format!("localhost:{}", state.port);
            let path = request.url().split('?').next().unwrap_or("/").to_string();
            let response = if !allowed {
                Response::from_data(Vec::new()).with_status_code(StatusCode(403))
            } else if path.starts_with("/api/") {
                handle_api(&state, &mut request, &path)
            } else {
                serve_static(&state, &path)
            };
            let _ = request.respond(response);
        });
    }
}
