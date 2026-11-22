#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Burnrate desktop shell. One process: the HTTP server runs in a background
//! thread and every window points at `http://127.0.0.1:<port>/`.
//! See docs/CONTRACTS.md section 12 and PACKAGES.md package 12.

mod autostart;
mod chrome;
mod deeplink;
mod icon;
mod notify;
mod shortcut;
mod stream;
mod tray;
mod windows;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub(crate) const MAIN_LABEL: &str = "main";
pub(crate) const DEFAULT_PORT: u16 = 13790;
pub(crate) const TRAY_ID: &str = "burnrate-tray";

/// The small subset of settings the native shell actually acts on.
#[derive(Clone, Debug)]
pub(crate) struct Prefs {
    pub notifications_enabled: bool,
    pub notifications_desktop: bool,
    pub launch_at_login: bool,
    pub start_minimized: bool,
    pub close_to_tray: bool,
    /// `shell.tray`: show the tray icon. Without it the window close button must quit.
    pub tray: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            notifications_enabled: false,
            notifications_desktop: false,
            launch_at_login: false,
            start_minimized: false,
            close_to_tray: false,
            tray: false,
        }
    }
}

pub(crate) struct AppState {
    pub port: u16,
    pub base: String,
    pub shutdown: Arc<AtomicBool>,
    pub prefs: Arc<Mutex<Prefs>>,
    /// Lowest remaining percent across all windows, for the tray icon.
    pub last_percent: AtomicU32,
    pub main_opened: AtomicBool,
    /// Last theme colours and window bounds (window-state.json).
    pub chrome: Arc<chrome::ChromeState>,
}

impl AppState {
    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    pub(crate) fn set_percent(&self, percent: f64) {
        let clamped = if percent.is_finite() {
            percent.round().clamp(0.0, 100.0) as u32
        } else {
            100
        };
        self.last_percent.store(clamped, Ordering::Relaxed);
    }
}

/// Prefer the configured port (or 13790); if it is taken, ask the OS for a
/// free one. We bind briefly to test availability, then let the server bind.
fn pick_port() -> u16 {
    let wanted = std::env::var("BURNRATE_PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_PORT);
    if std::net::TcpListener::bind(("127.0.0.1", wanted)).is_ok() {
        return wanted;
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("ask the OS for a free loopback port");
    listener.local_addr().map(|a| a.port()).unwrap_or(wanted)
}

/// Well-known port file. The CLI, statusline hooks and deep-link helpers read the
/// same path when BURNRATE_PORT is not set, so a random fallback is not lost.
pub(crate) fn port_file_path() -> PathBuf {
    if let Some(dir) = std::env::var_os("BURNRATE_DATA") {
        return PathBuf::from(dir).join("port.txt");
    }
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library").join("Application Support"));
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share"))
    });
    base.unwrap_or_else(|| PathBuf::from(".")).join("burnrate").join("port.txt")
}

/// Publish the chosen port for out-of-process consumers (CLI, statusline hooks). Only a non-default
/// port needs publishing; on the default port any leftover file from a crashed earlier run is removed so
/// it cannot point the CLI at a dead port. A clean exit removes it too (see `forget_port`).
fn persist_port(port: u16) {
    let path = port_file_path();
    if port == DEFAULT_PORT {
        let _ = std::fs::remove_file(&path);
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, port.to_string());
}

/// Remove the port file on exit, but only when it still names *our* port (a newer instance may have
/// replaced it).
fn forget_port(port: u16) {
    let path = port_file_path();
    let ours = std::fs::read_to_string(&path).ok().and_then(|t| t.trim().parse::<u16>().ok()) == Some(port);
    if ours {
        let _ = std::fs::remove_file(path);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch carries burnrate:// deep links in its args and
            // should focus the existing main window instead of opening a new one.
            deeplink::handle_args(app, &args);
            windows::open_main(app, None);
        }))
        .invoke_handler(tauri::generate_handler![
            windows::shell_open_main,
            windows::shell_minimize_main,
            windows::shell_main_is_maximized,
            windows::shell_toggle_main_maximize,
            windows::shell_close_main,
            chrome::shell_set_chrome,
        ])
        .setup(|app| {
            let port = pick_port();
            // The server reads this in burnrate_server::run(); publish it for out-of-process
            // consumers as well so a random fallback does not strand the CLI/statusline.
            std::env::set_var("BURNRATE_PORT", port.to_string());
            persist_port(port);

            // The web bundle is shipped as a Tauri resource ($RESOURCES/web) in every
            // installer. Point the embedded server at it; find_web_dir() only knows about
            // BURNRATE_WEB and <exe>/dist/web, neither of which matches bundled layouts.
            if std::env::var_os("BURNRATE_WEB").is_none() {
                if let Ok(dir) = app.path().resource_dir() {
                    let web = dir.join("web");
                    if web.join("index.html").is_file() {
                        std::env::set_var("BURNRATE_WEB", &web);
                    }
                }
            }

            // Installed layouts must not derive the data dir from the install path; pick the per-user
            // dir (or keep the dev checkout's ./data). Still single-threaded w.r.t. our own threads.
            burnrate_server::init_env();
            // Windows toasts need a registered AUMID even for portable / non-installer launches.
            notify::register_aumid();

            let base = format!("http://127.0.0.1:{port}");
            let state = Arc::new(AppState {
                port,
                base,
                shutdown: Arc::new(AtomicBool::new(false)),
                prefs: Arc::new(Mutex::new(Prefs::default())),
                last_percent: AtomicU32::new(100),
                main_opened: AtomicBool::new(false),
                chrome: Arc::new(chrome::ChromeState::new(chrome::load_state())),
            });
            app.manage(state.clone());

            std::thread::Builder::new()
                .name("burnrate-server".into())
                .spawn(burnrate_server::run)?;

            let handle = app.handle().clone();
            // GNOME has no status icon extension by default: keep the main
            // window available instead of relying on the tray there.
            if let Err(error) = tray::setup(&handle) {
                eprintln!("tray unavailable ({error}); main window stays available");
                windows::open_main(&handle, None);
            }

            let args: Vec<String> = std::env::args().skip(1).collect();
            deeplink::handle_args(&handle, &args);

            // Fetches settings/status, follows /api/stream, drives the tray.
            stream::start(handle.clone(), state.clone());
            // Global hotkeys for the main window (Windows); no-op / UNVERIFIED elsewhere.
            shortcut::start(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Burnrate")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    state.shutdown.store(true, Ordering::Relaxed);
                    forget_port(state.port);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_clamps_percent() {
        let state = AppState {
            port: 13790,
            base: String::new(),
            shutdown: Arc::new(AtomicBool::new(false)),
            prefs: Arc::new(Mutex::new(Prefs::default())),
            last_percent: AtomicU32::new(100),
            main_opened: AtomicBool::new(false),
            chrome: Arc::new(chrome::ChromeState::new(chrome::WindowState::default())),
        };
        state.set_percent(-5.0);
        assert_eq!(state.last_percent.load(Ordering::Relaxed), 0);
        state.set_percent(140.0);
        assert_eq!(state.last_percent.load(Ordering::Relaxed), 100);
        state.set_percent(f64::NAN);
        assert_eq!(state.last_percent.load(Ordering::Relaxed), 100);
        assert_eq!(state.url("/api/status"), "/api/status");
    }

    #[test]
    fn port_file_is_published_for_random_ports_and_removed_on_exit() {
        let dir = std::env::temp_dir().join(format!("burnrate-port-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("BURNRATE_DATA", &dir);
        let file = dir.join("port.txt");
        persist_port(54321);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "54321");
        // Another instance's port must not be removed by us.
        forget_port(40000);
        assert!(file.exists());
        forget_port(54321);
        assert!(!file.exists());
        // On the default port a stale file from a crashed run is cleared, never kept.
        std::fs::write(&file, "54321").unwrap();
        persist_port(DEFAULT_PORT);
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
