fn main() {
    // `cargo check` on a fresh checkout has no dist/web yet, and tauri-build refuses a missing
    // resource path. Release/installer builds run Vite first, so only fill the dev case.
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        let _ = std::fs::create_dir_all("../dist/web");
    }
    // App commands are only reachable from the http://127.0.0.1 pages through explicit permissions
    // (`allow-<command>` in tauri.conf.json); without this manifest the window chrome bridge fails
    // with "Plugin not found".
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "shell_open_main",
            "shell_set_chrome",
            "shell_minimize_main",
            "shell_main_is_maximized",
            "shell_toggle_main_maximize",
            "shell_close_main",
        ])),
    )
    .expect("failed to run tauri-build");
}
