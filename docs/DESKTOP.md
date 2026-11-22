# Desktop shell: how it runs, what is verified, residual risks

Burnrate is a Tauri 2 desktop app. One process: the Rust server runs in a thread and the main window
loads `http://127.0.0.1:<port>/` from it. This file records the desktop-specific
decisions and the risks that are still open. (Review sources: `docs/reviews/`, which is not edited.)

## Run / build

```powershell
npm run dev:desktop          # vite build + cargo run (debug shell, windows on demand)
npm run build:desktop        # vite build + Tauri NSIS/AppImage/deb/rpm bundle (CLI pinned via npx)
npm run build:desktop:bin    # release binary only: src-tauri/target/release/burnrate(.exe)
```

## App-not-webpage behaviour (src-tauri/src/windows.rs)

- Main window is created hidden and shown after the first page load (4 s fallback). It opens at 1100x800 (minimum
  520x520), centred and clamped to the monitor (`prevent_overflow`), or exactly where the user left it (see Window
  chrome). No blank white frame, no flash of an unstyled document.
- Browser leftovers removed: page zoom hotkeys off, browser context menu suppressed outside editable text and
  selections, Alt+Arrow / mouse back-forward history navigation blocked, reload/print shortcuts blocked in release
  builds, `window.open` / `target=_blank` never spawn a second webview.
- Navigation guard: a window may only show the app's own origin. Any other `http(s)` link is handed to the system
  browser; everything else is refused. Dropped files cannot turn the window into a file viewer.
- `<html>` gets `data-shell="desktop"` and `data-platform="windows|macos|linux"` from an init script, so the web UI can
  scope native-feel CSS (e.g. `user-select`, scrollbars, cursor) without sniffing.

## Window chrome (src-tauri/src/chrome.rs)

- The product is dark by default (`appearance.themeMode = "dark"`). The page reports its resolved palette through
  `window.burnrateShell.setChrome(dark, bg, fg)` (`src/appearance.ts`, `syncDesktopChrome`); the shell applies the
  native window theme, the webview/window background colour and, on Windows 11, the DWM caption, border and text
  colours (`DWMWA_CAPTION_COLOR` etc., ignored by Windows 10), so the title bar is the same `#181818` as the
  in-app header. `system` and `light` modes switch the title bar live.
- `<data dir>/window-state.json` keeps `{x, y, width, height, maximized, dark, bg, fg}`. It is read before the window
  is built, so the first frame already has the right title bar and background. Bounds are written (debounced, atomic
  rename) after move/resize, and restored only when the window still lands on a connected monitor (otherwise default
  size, centred). Size is the inner size, position the outer corner.
- The window icon, taskbar icon and tray icon come from `src-tauri/icons` (rendered from the Burnrate logo with
  `generate-icons.ps1`).
- **Taskbar / Alt-Tab icon (Windows).** `tauri-build` embeds `icons/icon.ico` (first `.ico` in `bundle.icon`) as the exe
  icon resource, and Tauri uses it as the default window icon. The main window no longer relies on that implicitly: it
  is built with `.icon(icon::app_icon(app))`, which takes the exe resource at the system icon size and falls
  back to the 128x128 logo compiled into the binary (`include_bytes!`) if the resource is missing or decodes fully
  transparent. The window caption has no icon (`decorations(false)`), so the taskbar button is the only place it shows.
- **Taskbar grouping / AUMID.** The shell deliberately does *not* call `SetCurrentProcessExplicitAppUserModelID`. The
  installers' shortcuts carry no AppUserModelID property, and a process with an explicit AUMID no longer matches a
  pinned shortcut that has none, which shows two buttons. Without an explicit one Windows groups by `burnrate.exe`, so a
  pinned shortcut and the running window are one button. The `Burnrate` AUMID (`notify.rs`, registered under
  `HKCU\Software\Classes\AppUserModelId\Burnrate`) is only the toast identity. `identifier` (`app.burnrate.desktop`) is
  the single-instance key and the bundle id, not a taskbar identity. A taskbar button keeps its old icon until the shortcut
  or Explorer icon cache refreshes; a pinned button created by an older build may need unpin and pin again.
- The bridge commands are listed in `build.rs` and granted in `tauri.conf.json` (`allow-shell-*`). Without that
  manifest a remote (`http://127.0.0.1`) page gets "Plugin not found" for every app command, so `setChrome` did
  not work. The init script also runs before `<html>` exists, so it tags `data-shell` /
  `data-platform` through a MutationObserver.
- `shell.tray = false` hides the tray icon; close-to-tray and start-minimised are then ignored (the window button
  quits, the window opens at start) so the app can never become invisible. Tray labels: Open Burnrate, Refresh now,
  Snooze alerts for 1 hour, Quit Burnrate.

## Data and port locations

- Installed layouts (`<install>/web`, `/usr/share/burnrate/web`, `/app/share/burnrate/web`) used to derive the data
  directory as `<web>/../../data`, i.e. next to or above the install dir, often read-only. `burnrate_server::init_env()`
  (called by the shell setup and by `burnrate-server`'s `main`) now picks `%APPDATA%\burnrate` / `$XDG_DATA_HOME/burnrate`
  unless `BURNRATE_DATA` is set, the web dir is a source checkout (`.../dist/web`), or the legacy `data/` already exists.
- `port.txt` (random-port fallback) is written under the same directory only for a non-default port, is removed on a clean
  exit, and is removed at start when the default port is free again. The CLI only trusts it after a loopback connect probe,
  so a stale file from a crash cannot point it at a dead port.

## Mistral Vibe on Windows (second profile)

- Usage: `readers/vibe.rs` reads `~/.vibe*/logs/session/unified/.session-index.json` for every Vibe config directory
  and files the sessions under Mistral (see `docs/PROVIDER-DEFINITIONS.md` 6.4).
- Second key: Windows Vibe has one Credential Manager slot, so a second profile uses a per-instance keyring backend
  (`PYTHON_KEYRING_BACKEND=vibe2_keyring.DpapiFileKeyring`, `VIBE2_KEYRING_FILE`) that keeps the secrets in
  `<config dir>/keyring.bin`, a DPAPI-encrypted JSON object. **DPAPI is current-user-only:** Burnrate can open that file
  only when it runs as the same Windows user that wrote it (a copy from another account or machine is skipped). The
  import calls `CryptUnprotectData` through a minimal FFI declaration, never shows UI, and never logs key material
  (6.3 has the contract).

## Verified here (Windows 11, debug build)

- `cargo check`/`cargo test` for `src-tauri`, `server-rs`, `cli`; `node packaging/scripts/validate-packaging.mjs`.
- Debug shell launched with a temp `BURNRATE_DATA` and port (and `TAURI_CONFIG` overriding `identifier`, because the
  single-instance lock is keyed by it and a running real Burnrate would swallow the test launch): main window titled
  "Burnrate" exists, `/`,
  `/api/status`, `/api/providers` answer 200, HTML responses carry the CSP header, `port.txt` was written.
- A second launch reached the first instance (single-instance) and focused the existing window. Closing the main
  window keeps the process alive (default `closeToTray: true`).

- Real bundle: `tauri build --config packaging/tauri/bundle.conf.json --bundles nsis` (CLI 2.12.6 through npx) produced
  `Burnrate_0.1.0_x64-setup.exe`. The generated `installer.nsi` installs `burnrate.exe` plus `web\...` (the resource map)
  and inserts `installer-hooks.nsh` (post-install and post-uninstall macros), so the hook's `$INSTDIR\burnrate.exe` is right.
  The installer was not executed. The release `burnrate.exe` + `web\` copied to an unrelated folder (no `dist/web`
  ancestor, `APPDATA` redirected) served the UI from `<exe>\web`, and wrote its data under `%APPDATA%\burnrate`, not beside
  the install dir.
- The dist/web inside that installer is whatever `dist/web` held at build time; `npm run build:desktop` rebuilds it first.

## Not verifiable without a GUI session / other machines

- Tray icon rendering and menu clicks (Quit, Refresh, Snooze) were not clicked; the Quit path (`RunEvent::Exit`) that removes
  `port.txt` is covered by a unit test only.
- Toast appearance: the AUMID is now registered under `HKCU\Software\Classes\AppUserModelId\Burnrate` by the shell at
  every start and by both installers. The previous installer step (WScript.Shell `System.AppUserModelID`) did not work
  (that COM object has no such property; checked). Whether Windows renders the toast with this registration alone needs
  a real notification on a clean machine.
- Linux: tray on GNOME, AppImage/deb/rpm contents, `x-scheme-handler/burnrate` registration (desktop file + postinst now
  shared by deb and rpm via `desktopTemplate`/`postInstallScript`; AppImage uses Tauri's own desktop file).
- macOS: nothing here was built or run; `icon.icns` is referenced by `bundle.conf.json` but not generated.

## Residual risks (server)

- **SSE write timeout.** `tiny_http` does not expose the socket, so a write cannot be given a timeout. Mitigation: each
  subscriber has a 64-event queue; a stalled client is evicted from the hub (its stream slot is freed immediately and the
  queue cannot grow). The pinned thread ends when the OS finally fails the write; threads are bounded by the 256-connection
  cap. A real fix needs a custom listener or a different HTTP server.
- **Master key.** `master.key` is still stored beside `keys.enc` (format shared with the TS server, so it cannot change
  without a migration). It is now created atomically (no truncated key can orphan `keys.enc`) and with 0600 on Unix. On
  Windows the per-user profile ACL is the protection. Any process running as the same user can read both; DPAPI or a
  keychain would defend against disk theft / backups but not against same-user malware. `%APPDATA%` is the roaming profile:
  on domain machines with profile roaming the key may sync, which is a reason to move to `%LOCALAPPDATA%` in a future
  migration.
- **DNS pinning.** `defs/fetch.rs` now uses `GuardedResolver` (validated addresses are the ones dialled) with redirects and
  environment proxies off, like every other outbound agent. Residual: `check_url`'s own lookup is still check-time only;
  the connect-time resolver is the enforcement point.
- **Tauri CSP.** `tauri.conf.json` `security.csp` only applies to Tauri-served pages; the real CSP is the header set by
  `serve_static` (still allows inline scripts/styles for the boot script and React style props).

## Bundle layout

`tauri.conf.json` and `packaging/tauri/bundle.conf.json` ship `../dist/web` as the `web` resource. The shell points the
server at `<resource_dir>/web` when `BURNRATE_WEB` is unset and that directory has an `index.html`.
