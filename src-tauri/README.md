# Burnrate desktop shell (package 12)

A single Tauri 2 process. `burnrate_server::run()` runs in a background thread,
and the main window loads `http://127.0.0.1:<port>/` from that in-process server.

## Run

```powershell
# from the repository root
corepack pnpm install --frozen-lockfile
corepack pnpm build                     # produces dist/web
$env:CARGO_TARGET_DIR = Join-Path $env:TEMP "burnrate-target"
cargo tauri dev --manifest-path src-tauri/Cargo.toml
```

For a plain `cargo check` (no web bundle needed):

```powershell
$env:CARGO_TARGET_DIR = Join-Path $env:TEMP "burnrate-target"
cargo check --manifest-path src-tauri/Cargo.toml
```

`cargo tauri dev` is supplied by the Tauri CLI; it is not a crate dependency
here. The web app is served by the Rust server from `dist/web`; for a relocated
bundle set `BURNRATE_WEB` to the directory containing `index.html`.

## Behaviour

- **Port**: `BURNRATE_PORT` (default `13790`). If occupied, the shell asks the OS
  for a free loopback port and exports the chosen value back to the server
  thread. The actual port is passed to windows as a URL.
- **Main window**: created on demand, `closeToTray` hides instead of closing.
- **Tray** (`tray.rs`): dynamic percent icon drawn with a 3x5 bitmap font
  (`icon.rs`, no image crate), menu: Open / Refresh / Snooze 1h / Quit.
  Left-click opens the main window. On GNOME (no status-icon extension)
  tray setup failure is non-fatal: the main window stays available.
- **Events** (`stream.rs`): follows `GET /api/stream`; `snapshot` updates the
  tray, `alert` raises a native toast only when `notifications.enabled` and
  `notifications.desktop`, `settings` re-applies auto-start/minimised prefs.
  Reconnects with capped backoff; the shutdown flag stops the loop cleanly.
- **Autostart** (`autostart.rs`): Windows `HKCU\...\Run` value `Burnrate`;
  Linux `~/.config/autostart/burnrate.desktop`. No admin rights requested.
- **Deep link** (`deeplink.rs`): `burnrate://open[/view]` and
  `burnrate://snooze/<minutes>`; second launches arrive through the
  single-instance plugin and focus the existing window.
- **Global shortcut** (`shortcut.rs`): Ctrl+Shift+B on Windows.
- **Notifications** (`notify.rs`): Windows WinRT toast using the installer's
  AUMID `Burnrate`; Linux `notify-send` (libnotify/D-Bus).

Security: no remote content in `tauri.conf.json`, strict CSP allowing only
`http://127.0.0.1:*`, and a minimal inline capability in `tauri.conf.json`. No secrets are
read or stored by the shell; all settings come from the local server.

## Verified / unverified

- Verified: `cargo check` on Windows; unit tests for the bitmap font, tray
  percent parsing, deep links, toast escaping, and autostart paths.
- **UNVERIFIED on Linux**: autostart acceptance by the desktop environment,
  libnotify/D-Bus toasts, and the absence of a GTK tray on GNOME. These paths
  are `cfg`-gated and marked in code. Global shortcuts are deliberately disabled
  on Linux rather than guessed.
- **UNVERIFIED**: AUMID shortcut creation is the installer's job (package 48);
  `notify.rs` only exposes the path builder/AUMID used by toast delivery.
- Installers, autostart, AUMID and deep-link code are only exercised in tests
  with throwaway names (`BurnrateP12Throwaway`), removed in the same test run.

## Size / idle RAM notes

- Release profile: `opt-level = "s"`, LTO, one codegen unit, panic abort, strip.
  The tray renderer adds no image dependency (raw 16x16 RGBA buffer).
- Idle RAM: one Rust server process, a WebView for the main window while open,
  and two small background threads (server + event stream).
- The bundled icon set is rendered from the Burnrate logo (`public/icon-512x512.png`) by
  `powershell -File src-tauri/generate-icons.ps1 -src public/icon-512x512.png -out src-tauri/icons`.
