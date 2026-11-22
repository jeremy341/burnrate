/**
 * Runtime environment checks for the settings UI. Burnrate is a desktop app (Tauri) that can also be
 * opened in a browser during development; a handful of settings only mean something in the app.
 */

/** True inside the packaged Tauri webview (`__TAURI_INTERNALS__` is always injected; `__TAURI__` only when enabled). */
export function isDesktopShell(target: object | undefined = typeof window === "undefined" ? undefined : window): boolean {
  if (!target) return false;
  return "__TAURI_INTERNALS__" in target || "__TAURI__" in target;
}
