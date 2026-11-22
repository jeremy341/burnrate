//! Native window chrome for the main window: the title bar follows the app theme, the window remembers its
//! size and position, and the colours are known before the webview paints (so there is no white flash).
//!
//! The web UI is the source of truth for the palette: `src/appearance.ts` calls
//! `window.burnrateShell.setChrome(dark, bg, fg)` whenever the resolved theme changes. The last values and the
//! window bounds are kept in `<data dir>/window-state.json`, which the next start reads before the window exists.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::window::Color;
use tauri::{
    AppHandle, Manager, Theme, WebviewWindow, Window, WindowEvent,
};

use crate::{AppState, MAIN_LABEL};

/// Default (first-run) inner size in logical pixels. The Usage screen is a two-column layout with a
/// chart, a provider list and a breakdown table, and T3's own Usage window opens at this scale.
/// `prevent_overflow()` on the builder shrinks it on a small display; the minimum is unchanged.
pub(crate) const DEFAULT_WIDTH: f64 = 1280.0;
pub(crate) const DEFAULT_HEIGHT: f64 = 860.0;
/// Bounds saved by an older build were produced by a smaller default. A saved width below this
/// (physical px) is replaced by the new default once, so an upgrade does not keep the cramped window.
const MIGRATED_MIN_WIDTH: u32 = 1280;
const LAYOUT_VERSION: u32 = 1;
pub(crate) const MIN_WIDTH: f64 = 520.0;
pub(crate) const MIN_HEIGHT: f64 = 520.0;

/// The product is dark by default (`appearance.themeMode = "dark"`, T3's true-black canvas).
const DARK_BG: &str = "#181818";
const DARK_FG: &str = "#f2f2f2";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct WindowState {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub maximized: bool,
    pub dark: bool,
    pub bg: String,
    pub fg: String,
    /// Window-layout generation; bumped when the default size changes (see `migrate_layout`).
    pub layout_version: u32,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            width: None,
            height: None,
            maximized: false,
            dark: true,
            bg: DARK_BG.into(),
            fg: DARK_FG.into(),
            layout_version: LAYOUT_VERSION,
        }
    }
}

/// A monitor's rectangle in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// `#rgb` / `#rrggbb` -> (r, g, b). Anything else (including CSS functions) is rejected.
pub(crate) fn parse_hex(value: &str) -> Option<(u8, u8, u8)> {
    let hex = value.trim().strip_prefix('#')?;
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        3 => {
            let n = |i: usize| u8::from_str_radix(&hex[i..i + 1], 16).ok().map(|v| v * 17);
            Some((n(0)?, n(1)?, n(2)?))
        }
        6 => {
            let n = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
            Some((n(0)?, n(2)?, n(4)?))
        }
        _ => None,
    }
}

/// Windows `COLORREF` (0x00BBGGRR) for the DWM caption attributes.
pub(crate) fn colorref((r, g, b): (u8, u8, u8)) -> u32 {
    (b as u32) << 16 | (g as u32) << 8 | r as u32
}

/// Where the saved bounds can be restored: the window must overlap a monitor enough to be grabbed, and is
/// shrunk to fit it. `None` means "use the default size, centred" (first run, unplugged monitor, bad data).
pub(crate) fn fit_to_monitors(state: &WindowState, monitors: &[Area]) -> Option<(i32, i32, u32, u32)> {
    let (x, y, width, height) = (state.x?, state.y?, state.width?, state.height?);
    if width < 200 || height < 200 {
        return None;
    }
    // Pick the monitor that holds the window's title-bar centre.
    let cx = x + (width / 2) as i32;
    let cy = y + 16;
    let monitor = monitors.iter().find(|m| {
        cx >= m.x && cx < m.x + m.width as i32 && cy >= m.y && cy < m.y + m.height as i32
    })?;
    let width = width.min(monitor.width);
    let height = height.min(monitor.height);
    let x = x.clamp(monitor.x, monitor.x + monitor.width as i32 - width as i32);
    let y = y.clamp(monitor.y, monitor.y + monitor.height as i32 - height as i32);
    Some((x, y, width, height))
}

/// One-time upgrade: forget saved bounds narrower than the new default so the window opens at the
/// new size. Bounds the user made larger are kept.
pub(crate) fn migrate_layout(state: &mut WindowState) {
    if state.layout_version >= LAYOUT_VERSION {
        return;
    }
    if state.width.map_or(false, |w| w < MIGRATED_MIN_WIDTH) {
        state.x = None;
        state.y = None;
        state.width = None;
        state.height = None;
    }
    state.layout_version = LAYOUT_VERSION;
}

fn state_path() -> PathBuf {
    crate::port_file_path().with_file_name("window-state.json")
}

pub(crate) fn load_state() -> WindowState {
    let mut state = std::fs::read_to_string(state_path())
        .ok()
        .and_then(|text| serde_json::from_str::<WindowState>(&text).ok())
        .unwrap_or_default();
    if parse_hex(&state.bg).is_none() {
        state.bg = DARK_BG.into();
        state.dark = true;
    }
    if parse_hex(&state.fg).is_none() {
        state.fg = DARK_FG.into();
    }
    migrate_layout(&mut state);
    state
}

fn save_state(state: &WindowState) {
    let path = state_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(state) {
        // Write beside the target and rename so a crash never leaves a truncated file.
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// Shared between the window events, the chrome command and the debounce thread.
pub(crate) struct ChromeState {
    state: Mutex<WindowState>,
    save_pending: AtomicBool,
}

impl ChromeState {
    pub(crate) fn new(state: WindowState) -> Self {
        Self { state: Mutex::new(state), save_pending: AtomicBool::new(false) }
    }

    pub(crate) fn snapshot(&self) -> WindowState {
        self.state.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn update(&self, change: impl FnOnce(&mut WindowState)) -> bool {
        let Ok(mut guard) = self.state.lock() else { return false };
        let before = guard.clone();
        change(&mut guard);
        *guard != before
    }

    /// Write the file at most once per burst of move/resize events.
    fn save_soon(self: &Arc<Self>) {
        if self.save_pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let this = self.clone();
        let spawned = std::thread::Builder::new().name("burnrate-window-state".into()).spawn(move || {
            std::thread::sleep(Duration::from_millis(700));
            this.save_pending.store(false, Ordering::Release);
            save_state(&this.snapshot());
        });
        if spawned.is_err() {
            self.save_pending.store(false, Ordering::Release);
        }
    }

    fn save_now(&self) {
        save_state(&self.snapshot());
    }
}

/// Theme, background and (on Windows 11) the caption colours. Everything here is best effort: older Windows
/// builds ignore the DWM attributes and keep the plain dark/light title bar from `set_theme`.
pub(crate) fn apply_chrome(window: &WebviewWindow, dark: bool, bg: &str, fg: &str) {
    let theme = if dark { Theme::Dark } else { Theme::Light };
    let _ = window.set_theme(Some(theme));
    let Some(bg_rgb) = parse_hex(bg) else { return };
    let _ = window.set_background_color(Some(Color(bg_rgb.0, bg_rgb.1, bg_rgb.2, 255)));
    #[cfg(windows)]
    caption_colors(window, bg_rgb, parse_hex(fg));
    #[cfg(not(windows))]
    let _ = fg;
}

#[cfg(windows)]
fn caption_colors(window: &WebviewWindow, bg: (u8, u8, u8), fg: Option<(u8, u8, u8)>) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    };
    let Ok(hwnd) = window.hwnd() else { return };
    let set = |attribute, value: u32| unsafe {
        // Windows 11 (build 22000+) only; elsewhere the call fails and is ignored on purpose.
        let _ = DwmSetWindowAttribute(
            hwnd,
            attribute,
            &value as *const u32 as *const core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    };
    set(DWMWA_CAPTION_COLOR, colorref(bg));
    set(DWMWA_BORDER_COLOR, colorref(bg));
    if let Some(fg) = fg {
        set(DWMWA_TEXT_COLOR, colorref(fg));
    }
}

/// Everything the builder needs before the window exists: bounds restored against the connected monitors.
pub(crate) struct Initial {
    pub bounds: Option<(i32, i32, u32, u32)>,
    pub maximized: bool,
}

pub(crate) fn initial(app: &AppHandle, state: &WindowState) -> Initial {
    let monitors: Vec<Area> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Area { x: m.position().x, y: m.position().y, width: m.size().width, height: m.size().height })
        .collect();
    Initial { bounds: fit_to_monitors(state, &monitors), maximized: state.maximized }
}

/// Persist bounds and maximised state as the user moves and resizes the window.
pub(crate) fn track(window: &WebviewWindow, chrome: Arc<ChromeState>) {
    let target = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if target.is_minimized().unwrap_or(false) {
                return;
            }
            let maximized = target.is_maximized().unwrap_or(false);
            let changed = chrome.update(|state| {
                state.maximized = maximized;
                // Keep the restored (normal) bounds while maximised.
                if !maximized {
                    if let (Ok(p), Ok(s)) = (target.outer_position(), target.inner_size()) {
                        state.x = Some(p.x);
                        state.y = Some(p.y);
                        state.width = Some(s.width);
                        state.height = Some(s.height);
                    }
                }
            });
            if changed {
                chrome.save_soon();
            }
        }
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => chrome.save_now(),
        _ => {}
    });
}

/// `window.burnrateShell.setChrome(dark, bg, fg)`: the page tells the shell its resolved palette.
#[tauri::command]
pub(crate) fn shell_set_chrome(
    window: Window,
    app: AppHandle,
    dark: bool,
    bg: String,
    fg: Option<String>,
) -> Result<(), String> {
    if window.label() != MAIN_LABEL {
        return Err("only the main window has native chrome".into());
    }
    let fg = fg.unwrap_or_default();
    if parse_hex(&bg).is_none() {
        return Err("invalid colour".into());
    }
    let webview = app.get_webview_window(MAIN_LABEL).ok_or("main window missing")?;
    let fg = if parse_hex(&fg).is_some() { fg } else if dark { DARK_FG.into() } else { "#27272a".into() };
    apply_chrome(&webview, dark, &bg, &fg);
    if let Some(app_state) = app.try_state::<Arc<AppState>>() {
        let chrome = app_state.chrome.clone();
        let changed = chrome.update(|state| {
            state.dark = dark;
            state.bg = bg.clone();
            state.fg = fg.clone();
        });
        if changed {
            chrome.save_soon();
        }
    }
    Ok(())
}

/// Restore the saved bounds on an existing builder result (position/size are set on the builder; this applies
/// the maximised flag after the window exists).
pub(crate) fn restore_maximized(window: &WebviewWindow, maximized: bool) {
    if maximized {
        let _ = window.maximize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor() -> Area {
        Area { x: 0, y: 0, width: 1920, height: 1080 }
    }

    #[test]
    fn parses_hex_colours_only() {
        assert_eq!(parse_hex("#181818"), Some((0x18, 0x18, 0x18)));
        assert_eq!(parse_hex(" #FcFcFc "), Some((0xfc, 0xfc, 0xfc)));
        assert_eq!(parse_hex("#fff"), Some((255, 255, 255)));
        assert_eq!(parse_hex("rgb(1,2,3)"), None);
        assert_eq!(parse_hex("#12345"), None);
        assert_eq!(parse_hex("#gg0000"), None);
        assert_eq!(parse_hex(""), None);
    }

    #[test]
    fn colorref_is_bgr() {
        assert_eq!(colorref((0x11, 0x22, 0x33)), 0x0033_2211);
    }

    #[test]
    fn default_state_is_dark() {
        let state = WindowState::default();
        assert!(state.dark);
        assert_eq!(state.bg, "#181818");
        assert!(fit_to_monitors(&state, &[monitor()]).is_none());
    }

    #[test]
    fn default_window_is_larger_than_the_old_1100_by_800() {
        assert!(DEFAULT_WIDTH >= 1280.0 && DEFAULT_HEIGHT >= 860.0);
        assert!(MIN_WIDTH < DEFAULT_WIDTH && MIN_HEIGHT < DEFAULT_HEIGHT);
    }

    #[test]
    fn upgrade_drops_small_saved_bounds_once_and_keeps_big_ones() {
        let mut small = WindowState {
            x: Some(100), y: Some(80), width: Some(1100), height: Some(800),
            bg: "#181818".into(), layout_version: 0, ..Default::default()
        };
        migrate_layout(&mut small);
        assert_eq!((small.x, small.y, small.width, small.height), (None, None, None, None));
        assert_eq!(small.bg, "#181818");
        assert_eq!(small.layout_version, LAYOUT_VERSION);
        // A later, user-chosen small size is not touched again.
        small.width = Some(900);
        small.height = Some(700);
        migrate_layout(&mut small);
        assert_eq!(small.width, Some(900));
        let mut big = WindowState { x: Some(5), y: Some(5), width: Some(1700), height: Some(1000), layout_version: 0, ..Default::default() };
        migrate_layout(&mut big);
        assert_eq!(big.width, Some(1700));
    }

    #[test]
    fn restores_bounds_on_a_connected_monitor() {
        let state = WindowState { x: Some(100), y: Some(80), width: Some(1100), height: Some(800), ..Default::default() };
        assert_eq!(fit_to_monitors(&state, &[monitor()]), Some((100, 80, 1100, 800)));
    }

    #[test]
    fn drops_bounds_of_an_unplugged_monitor() {
        let state = WindowState { x: Some(2500), y: Some(80), width: Some(1100), height: Some(800), ..Default::default() };
        assert_eq!(fit_to_monitors(&state, &[monitor()]), None);
    }

    #[test]
    fn shrinks_and_nudges_a_window_that_overflows() {
        let state = WindowState { x: Some(300), y: Some(900), width: Some(2400), height: Some(1500), ..Default::default() };
        let monitors = [Area { x: 0, y: 0, width: 2560, height: 1440 }];
        let fitted = fit_to_monitors(&state, &monitors).unwrap();
        assert_eq!(fitted, (160, 0, 2400, 1440));
        // A second monitor with a negative origin works the same way.
        let left = Area { x: -1920, y: 0, width: 1920, height: 1080 };
        let state = WindowState { x: Some(-1800), y: Some(40), width: Some(900), height: Some(700), ..Default::default() };
        assert_eq!(fit_to_monitors(&state, &[monitor(), left]), Some((-1800, 40, 900, 700)));
    }

    #[test]
    fn rejects_degenerate_sizes() {
        let state = WindowState { x: Some(0), y: Some(0), width: Some(10), height: Some(10), ..Default::default() };
        assert_eq!(fit_to_monitors(&state, &[monitor()]), None);
    }

    #[test]
    fn state_file_round_trips_and_tolerates_missing_fields() {
        let parsed: WindowState = serde_json::from_str(r##"{"dark":false,"bg":"#fcfcfc"}"##).unwrap();
        assert!(!parsed.dark);
        assert_eq!(parsed.bg, "#fcfcfc");
        assert_eq!(parsed.fg, "#f2f2f2");
        assert_eq!(parsed.width, None);
    }
}
