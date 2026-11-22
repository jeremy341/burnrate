use std::sync::atomic::Ordering;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::{stream, AppState, TRAY_ID};

/// Kept in managed state so the tray icon lives as long as the app.
#[allow(dead_code)] // the `tray` field is held only to keep the native tray alive
pub(crate) struct TrayHandle {
    #[allow(dead_code)]
    pub(crate) tray: TrayIcon,
}

pub(crate) fn setup(app: &AppHandle) -> tauri::Result<()> {
    let refresh = MenuItem::with_id(app, "tray.refresh", "Refresh now", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "tray.open", "Open Burnrate", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "tray.settings", "Settings", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray.quit", "Quit Burnrate", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&refresh, &open, &settings, &separator, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| crate::icon::percent_icon(Some(100)));
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .tooltip("Burnrate")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray.open" => crate::windows::open_main(app, None),
            "tray.settings" => crate::windows::open_main(app, Some("settings")),
            "tray.refresh" => {
                if let Some(state) = app.try_state::<std::sync::Arc<AppState>>() {
                    // `GET /api/limits` is the refresh path the UI's own refresh button uses
                    // (`api.limits()`); it refreshes the shared report cache in the server
                    // and counts as an active consumer for the background scheduler.
                    let _ = stream::get_json(&state.base, "/api/limits");
                    // Keep the last known percent instead of flashing the `?` icon.
                    update(app, Some(state.last_percent.load(Ordering::Relaxed)));
                }
            }
            "tray.quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle().clone();
                crate::windows::open_main(&app, None);
            }
        })
        .build(app)?;
    app.manage(TrayHandle { tray });
    Ok(())
}

/// `shell.tray`: show or hide the tray icon without rebuilding it.
pub(crate) fn set_visible(app: &AppHandle, visible: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(visible);
    }
}

/// `percent == None` means no data yet (shows `?`).
pub(crate) fn update(app: &AppHandle, percent: Option<u32>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let _ = tray.set_icon(Some(crate::icon::percent_icon(percent)));
    let label = match percent {
        Some(p) => format!("Burnrate {p}% left"),
        None => "Burnrate".to_string(),
    };
    let _ = tray.set_tooltip(Some(label));
}

/// Pulls the worst remaining percent from a compact `/api/status` payload.
pub(crate) fn percent_from_status(status: &serde_json::Value) -> Option<u32> {
    if let Some(worst) = status.get("worst") {
        if let Some(remaining) = worst.get("remainingPercent").and_then(serde_json::Value::as_f64) {
            return Some(remaining.round().clamp(0.0, 100.0) as u32);
        }
    }
    let mut lowest: Option<f64> = None;
    if let Some(accounts) = status.get("accounts").and_then(serde_json::Value::as_array) {
        for account in accounts {
            if account.get("unavailable").is_some() { continue }
            if let Some(windows) = account.get("windows").and_then(serde_json::Value::as_array) {
                for window in windows {
                    if let Some(remaining) = window.get("remainingPercent").and_then(serde_json::Value::as_f64) {
                        lowest = Some(lowest.map_or(remaining, |v: f64| v.min(remaining)));
                    }
                }
            }
        }
    }
    lowest.map(|v| v.round().clamp(0.0, 100.0) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_worst_then_accounts() {
        assert_eq!(percent_from_status(&json!({"worst": {"remainingPercent": 7.6}})), Some(8));
        assert_eq!(
            percent_from_status(&json!({"accounts": [
                {"windows": [{"remainingPercent": 42.0}]},
                {"windows": [{"remainingPercent": 19.4}]}
            ]})),
            Some(19)
        );
        assert_eq!(percent_from_status(&json!({"accounts": []})), None);
    }
}
