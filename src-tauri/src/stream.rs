//! Local HTTP helpers plus the `/api/stream` SSE client. The shell follows
//! `snapshot`, `alert` and `settings` events; it never polls on a timer while
//! the stream is alive (the server owns the scheduler).

use std::io::Read;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

use crate::{autostart, notify, tray, AppState};

pub(crate) fn get_json(base: &str, path: &str) -> Option<Value> {
    ureq::get(&format!("{base}{path}"))
        .timeout(Duration::from_secs(5))
        .call()
        .ok()?
        .into_json()
        .ok()
}

pub(crate) fn post_json(base: &str, path: &str, body: &Value) -> Option<()> {
    ureq::post(&format!("{base}{path}"))
        .set("X-Burnrate", "1")
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(5))
        .send_string(&body.to_string())
        .ok()
        .map(|_| ())
}

pub(crate) fn bool_at(settings: &Value, path: &str, default: bool) -> bool {
    settings.pointer(path).and_then(Value::as_bool).unwrap_or(default)
}

fn apply_settings(app: &AppHandle, state: &Arc<AppState>, settings: &Value) {
    let prefs = crate::Prefs {
        notifications_enabled: bool_at(settings, "/notifications/enabled", false),
        notifications_desktop: bool_at(settings, "/notifications/desktop", false),
        launch_at_login: bool_at(settings, "/general/launchAtLogin", false),
        start_minimized: bool_at(settings, "/general/startMinimized", false),
        close_to_tray: bool_at(settings, "/general/closeToTray", true),
        tray: bool_at(settings, "/shell/tray", true),
    };
    if let Ok(mut guard) = state.prefs.lock() {
        *guard = prefs.clone();
    }
    // The global hotkey is rebound from `shell.globalShortcut` on the initial load and on
    // every SSE settings event (shortcut.rs compares against the current combo itself).
    crate::shortcut::apply_from_settings(settings);
    autostart::set_enabled(prefs.launch_at_login);
    crate::tray::set_visible(app, prefs.tray);
    // Starting minimised only makes sense while the tray icon can bring the window back.
    let may_stay_hidden = prefs.start_minimized && prefs.tray;
    if !may_stay_hidden && !state.main_opened.load(Ordering::Relaxed) {
        crate::windows::open_main(app, None);
    }
}

fn refresh(app: &AppHandle, state: &Arc<AppState>) {
    if let Some(settings) = get_json(&state.base, "/api/settings") {
        apply_settings(app, state, &settings);
    }
    if let Some(status) = get_json(&state.base, "/api/status") {
        let percent = tray::percent_from_status(&status);
        state.set_percent(percent.unwrap_or(100) as f64);
        tray::update(app, percent);
    }
}

pub(crate) fn start(app: AppHandle, state: Arc<AppState>) {
    std::thread::Builder::new()
        .name("burnrate-stream".into())
        .spawn(move || {
            let mut backoff = Duration::from_secs(1);
            loop {
                if state.shutdown.load(Ordering::Relaxed) {
                    break;
                }
                refresh(&app, &state);
                match follow_stream(&app, &state) {
                    Ok(()) => backoff = Duration::from_secs(1),
                    Err(error) => eprintln!("stream disconnected: {error}"),
                }
                if state.shutdown.load(Ordering::Relaxed) {
                    break;
                }
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        })
        .ok();
}

/// SSE streams are long-lived. `Request::timeout()` is an overall deadline and would
/// disconnect every ~90 s despite the server's 25 s heartbeats, forcing a needless
/// reconnect (and settings/status refetch). Agent read timeouts are per-read/idle.
fn stream_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(60))
        .timeout_write(Duration::from_secs(10))
        .try_proxy_from_env(false)
        .build()
}

fn follow_stream(app: &AppHandle, state: &Arc<AppState>) -> Result<(), String> {
    let response = stream_agent()
        .get(&state.url("/api/stream"))
        .call()
        .map_err(|e| e.to_string())?;
    let mut reader = response.into_reader();
    let mut pending = Vec::<u8>::new();
    let mut chunk = [0u8; 2048];
    loop {
        let read = reader.read(&mut chunk).map_err(|e| e.to_string())?;
        if read == 0 {
            return Ok(());
        }
        for byte in &chunk[..read] {
            if *byte != b'\r' {
                pending.push(*byte);
            }
        }
        while let Some(end) = pending.windows(2).position(|pair| pair == b"\n\n") {
            let event: Vec<u8> = pending.drain(..end + 2).collect();
            handle_event(app, state, &String::from_utf8_lossy(&event));
        }
        if pending.len() > 1_048_576 {
            pending.clear(); // never grow without bound on a malformed stream
        }
    }
}

fn handle_event(app: &AppHandle, state: &Arc<AppState>, raw: &str) {
    let (mut name, mut data) = (String::new(), String::new());
    for line in raw.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            name = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push_str(value.trim_start());
        }
    }
    if data.is_empty() {
        return;
    }
    let Ok(payload) = serde_json::from_str::<Value>(&data) else { return };
    match name.as_str() {
        "alert" => {
            let (enabled, desktop) = state
                .prefs
                .lock()
                .map(|p| (p.notifications_enabled, p.notifications_desktop))
                .unwrap_or((false, false));
            if enabled && desktop {
                let title = payload.get("title").and_then(Value::as_str).unwrap_or("Burnrate alert");
                let body = payload.get("body").and_then(Value::as_str).unwrap_or("");
                let severity = payload.get("severity").and_then(Value::as_str).unwrap_or("info");
                notify::native_toast(title, body, severity);
            }
        }
        "snapshot" => {
            let percent = tray::percent_from_status(&payload);
            state.set_percent(percent.unwrap_or(100) as f64);
            tray::update(app, percent);
        }
        "settings" => apply_settings(app, state, &payload),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_settings_flags_with_defaults() {
        let settings = json!({
            "notifications": {"enabled": true, "desktop": false},
            "general": {"launchAtLogin": true}
        });
        assert!(bool_at(&settings, "/notifications/enabled", false));
        assert!(!bool_at(&settings, "/notifications/desktop", true));
        assert!(bool_at(&settings, "/general/launchAtLogin", false));
        assert!(bool_at(&settings, "/general/closeToTray", true)); // default
        assert!(bool_at(&settings, "/shell/tray", true)); // tray defaults on
    }

    #[test]
    fn http_helpers_reject_bad_urls_without_panicking() {
        assert!(get_json("http://127.0.0.1:1", "/api/status").is_none());
    }
}
