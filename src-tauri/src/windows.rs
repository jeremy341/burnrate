use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::{chrome, AppState, MAIN_LABEL};

/// Runs in the main window before any page script. It removes the leftovers that make an embedded page
/// feel like a browser tab, and tags the document so the web UI can style native-shell specifics:
/// `<html data-shell="desktop" data-platform="windows|macos|linux">`.
///  - the browser context menu (Back / Reload / Inspect) outside editable text and selections,
///  - history navigation by Alt+Arrow / mouse back-forward buttons,
///  - reload and print shortcuts in release builds (F5, Ctrl/Cmd+R, Ctrl/Cmd+P).
/// Native text editing menus keep working: inputs, textareas and a live selection are left alone.
pub(crate) const APP_JS: &str = r#"(() => {
  const ua = navigator.userAgent || '';
  // Init scripts run before the document element exists, so tag it as soon as it does.
  const tag = () => {
    const root = document.documentElement;
    if (!root) return false;
    root.dataset.shell = 'desktop';
    root.dataset.platform = /Windows/i.test(ua) ? 'windows' : /Mac/i.test(ua) ? 'macos' : 'linux';
    return true;
  };
  if (!tag()) {
    const observer = new MutationObserver(() => { if (tag()) observer.disconnect(); });
    observer.observe(document, { childList: true });
  }
  // The page reports its resolved palette so the native title bar follows the app theme.
  window.burnrateShell = {
    setChrome: (dark, bg, fg) => {
      const internals = window.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === 'function') {
        internals.invoke('shell_set_chrome', { dark: !!dark, bg: String(bg), fg: fg ? String(fg) : null }).catch(() => {});
      }
    },
  };
  const editable = (el) => !!el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName));
  window.addEventListener('contextmenu', (e) => {
    const selection = window.getSelection && String(window.getSelection());
    if (!editable(e.target) && !selection) e.preventDefault();
  }, true);
  window.addEventListener('auxclick', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); }, true);
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = (e.key || '').toLowerCase();
    if (e.altKey && (key === 'arrowleft' || key === 'arrowright')) e.preventDefault();
    if (__DEV__) return;
    if (key === 'f5' || (mod && (key === 'r' || key === 'p'))) e.preventDefault();
  }, true);
})();"#;

/// True for the loopback origin the shell itself serves (and only that origin).
fn is_local_origin(url: &Url, port: u16) -> bool {
    matches!(url.scheme(), "http")
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(port)
}

/// Hand an http(s) link to the system browser. The URL was parsed and re-serialised by `Url`, and the
/// scheme is restricted, so it cannot carry options or another protocol into the launcher.
pub(crate) fn open_external(url: &Url) {
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }
    let target = url.as_str();
    #[cfg(windows)]
    let result = std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", target])
        .spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(target).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(target).spawn();
    if let Err(error) = result {
        eprintln!("cannot open {target} in the system browser: {error}");
    }
}

/// Navigation guard: only the app's own origin may load inside a window. Anything else (a stray link,
/// a dropped file) goes to the system browser or is refused, so the shell can never turn into a browser.
fn navigation_allowed(url: &Url, port: u16) -> bool {
    if is_local_origin(url, port) || matches!(url.scheme(), "about" | "blob" | "data") {
        return true;
    }
    open_external(url);
    false
}

fn new_window_response(url: Url) -> NewWindowResponse<tauri::Wry> {
    // `window.open` / target=_blank: never spawn a second webview; external links use the system browser.
    if !matches!(url.scheme(), "about" | "blob" | "data") {
        open_external(&url);
    }
    NewWindowResponse::Deny
}

fn state(app: &AppHandle) -> Option<Arc<AppState>> {
    app.try_state::<Arc<AppState>>().map(|s| s.inner().clone())
}

fn clean_view(view: Option<&str>) -> Option<String> {
    view.map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| {
            let cleaned: String = v
                .chars()
                .take(64)
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/'))
                .collect();
            cleaned.trim_matches('/').to_string()
        })
        .filter(|v: &String| !v.is_empty())
}

pub(crate) fn open_main(app: &AppHandle, view: Option<&str>) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        if let Some(view) = clean_view(view) {
            let _ = window.eval(&format!("window.location.hash='#{view}'"));
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let Some(state) = state(app) else { return };
    let mut url = format!("{}/", state.base);
    if let Some(view) = clean_view(view) {
        url.push('#');
        url.push_str(&view);
    }
    let Ok(parsed) = tauri::Url::parse(&url) else { return };
    let port = state.port;
    // Created hidden and shown once the first page has loaded (or after a short grace period), so the
    // user never sees an empty white native frame while the local server answers.
    let shown = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let shown_on_load = shown.clone();
    let init_js = APP_JS.replace("__DEV__", if cfg!(debug_assertions) { "true" } else { "false" });
    // Palette and bounds of the last run, known before the window exists: dark title bar and a dark window
    // background from the very first frame, and the window comes back where the user left it.
    let saved = state.chrome.snapshot();
    let restored = chrome::initial(app, &saved);
    let (bg_r, bg_g, bg_b) = chrome::parse_hex(&saved.bg).unwrap_or((0x18, 0x18, 0x18));
    let mut builder = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::External(parsed))
        .title("Burnrate")
        .decorations(false)
        .theme(Some(if saved.dark { tauri::Theme::Dark } else { tauri::Theme::Light }))
        .background_color(tauri::window::Color(bg_r, bg_g, bg_b, 255))
        .inner_size(chrome::DEFAULT_WIDTH, chrome::DEFAULT_HEIGHT)
        .min_inner_size(chrome::MIN_WIDTH, chrome::MIN_HEIGHT)
        .visible(false)
        .zoom_hotkeys_enabled(false)
        .initialization_script(init_js)
        .on_navigation(move |url| navigation_allowed(url, port))
        .on_new_window(|url, _features| new_window_response(url));
    // Explicit taskbar / Alt-Tab icon (WM_SETICON). Without it the undecorated window can end up with the
    // generic Windows icon when the exe icon resource does not decode (see icon::app_icon).
    builder = match builder.icon(crate::icon::app_icon(app)) {
        Ok(with_icon) => with_icon,
        Err(error) => {
            eprintln!("cannot set the main window icon: {error}");
            return;
        }
    };
    if restored.bounds.is_none() {
        builder = builder.center().prevent_overflow();
    }
    match builder
        .on_page_load(move |window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished)
                && !shown_on_load.swap(true, Ordering::Relaxed)
            {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .build()
    {
        Ok(window) => {
            state.main_opened.store(true, std::sync::atomic::Ordering::Relaxed);
            // The tracker records physical pixels. Builder positions and sizes are logical pixels.
            if let Some((x, y, width, height)) = restored.bounds {
                let _ = window.set_position(PhysicalPosition::new(x, y));
                let _ = window.set_size(PhysicalSize::new(width, height));
            }
            chrome::apply_chrome(&window, saved.dark, &saved.bg, &saved.fg);
            chrome::restore_maximized(&window, restored.maximized);
            chrome::track(&window, state.chrome.clone());
            // `closeToTray`: hide instead of closing the app (setting 27).
            let on_close = window.clone();
            let close_prefs = state.prefs.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Hiding only works while something (the tray icon) can bring the window back.
                    let keep = close_prefs.lock().map(|p| p.close_to_tray && p.tray).unwrap_or(false);
                    if keep {
                        api.prevent_close();
                        let _ = on_close.hide();
                    }
                }
            });
            // If the page never finishes loading (server down), still show the window so the
            // user is not left with a process that has no visible UI.
            let fallback = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(4));
                if !shown.swap(true, Ordering::Relaxed) {
                    let _ = fallback.show();
                    let _ = fallback.set_focus();
                }
            });
        }
        Err(error) => eprintln!("cannot open main window: {error}"),
    }
}
fn label_guard(required: &str, window: &str) -> Result<(), String> {
    if window == required {
        Ok(())
    } else {
        Err(format!("only the {required} window may call this command"))
    }
}

/// Main-window-only commands (`shell_*_main`): window controls that must never act on another
/// webview.
fn main_window(window: &WebviewWindow) -> Result<(), String> {
    label_guard(MAIN_LABEL, window.label())
}

#[tauri::command]
pub(crate) fn shell_minimize_main(window: WebviewWindow) -> Result<(), String> {
    main_window(&window)?;
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn shell_main_is_maximized(window: WebviewWindow) -> Result<bool, String> {
    main_window(&window)?;
    window.is_maximized().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn shell_toggle_main_maximize(window: WebviewWindow) -> Result<bool, String> {
    let maximized = shell_main_is_maximized(window.clone())?;
    // The move/resize events update ChromeState, retaining normal bounds while maximized.
    if maximized {
        window.unmaximize()
    } else {
        window.maximize()
    }
    .map_err(|error| error.to_string())?;
    Ok(!maximized)
}

#[tauri::command]
pub(crate) fn shell_close_main(window: WebviewWindow) -> Result<(), String> {
    main_window(&window)?;
    // CloseRequested flushes ChromeState and applies the existing close-to-tray preference.
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn shell_open_main(app: tauri::AppHandle, view: Option<String>) {
    open_main(&app, view.as_deref());
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_is_sanitised() {
        assert_eq!(clean_view(Some(" settings/providers ")), Some("settings/providers".into()));
        assert_eq!(clean_view(Some("../evil")), Some("evil".into()));
        assert_eq!(clean_view(Some("")), None);
        assert_eq!(clean_view(Some("bad:view")), Some("badview".into()));
    }
}
