/**
 * Burnrate appearance pipeline — the adapted `startClientAppearance` (T3 appInit.tsx).
 * Applies the theme palette and the remaining appearance settings onto <html>, keeps
 * the theme-color meta in sync and writes the first-paint boot mirror. `index.css`
 * and `a11y.css` own the selectors; this file only writes attributes/CSS variables,
 * never stylesheet text.
 *
 * Corner radius, density and UI scale are no longer applied: the app uses T3's fixed
 * radius token and fixed spacing/scale. The saved `appearance.radius`,
 * `appearance.density` and `appearance.uiScale` keys are tolerated and ignored.
 */
import { useEffect, useSyncExternalStore } from "react";

import { applyAppearanceContrast } from "~/appearanceContrast";
import { getSettings, updateSettings, useSettings } from "~/settings/store";
import type { AppSettings } from "~/settings/schema";
import { applyThemePalette } from "~/themePalette";
import { resolveAppearance, resolveThemeId } from "~/themes/engine/resolve";
import { getSystemDark, subscribeToSystemDark } from "~/themes/engine/systemDark";
import { computeBootPalette, writeBootPalette, type BootPalette } from "~/themes/engine/boot";
import { useAppearanceSettingsBridge } from "~/themes/store";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const MOTION_QUERY = "(prefers-reduced-motion: reduce)";
export const REDUCED_MOTION_CHANGE = "burnrate:reduced-motion-change";

export function resolveReducedMotion(setting: AppSettings["appearance"]["reduceMotion"], system: boolean): boolean {
  return setting === "on" || (setting === "system" && system);
}

export function isReducedMotion(): boolean {
  const system = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(MOTION_QUERY).matches
    : false;
  return resolveReducedMotion(getSettings().appearance.reduceMotion, system);
}

function applyMotionPreference(): void {
  const root = document.documentElement;
  const next = isReducedMotion() ? "on" : "off";
  if (root.dataset.reduceMotion === next) return;
  root.dataset.reduceMotion = next;
  window.dispatchEvent(new Event(REDUCED_MOTION_CHANGE));
}

/** T3's contrast scale is 50-200 (100 = stock). 150 pushes text half way to black/white. */
export const HIGH_CONTRAST_LEVEL = 150;

function systemDarkNow(): boolean {
  return getSystemDark();
}

/** The window chrome follows the computed `--app-theme-canvas` / `--background`. */
function syncTitleBarColor(): void {
  requestAnimationFrame(() => {
    const probe = document.createElement("canvas").getContext("2d");
    const styles = getComputedStyle(document.documentElement);
    const background = (
      styles.getPropertyValue("--app-theme-canvas") || styles.getPropertyValue("--background")
    ).trim();
    if (!probe || !background) return;
    probe.fillStyle = "#000";
    probe.fillStyle = background;
    const color = probe.fillStyle;
    document.documentElement.style.background = color;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  });
}

interface DesktopChromeBridge {
  setChrome?: (dark: boolean, bg: string, fg: string) => void;
}

let lastChrome = "";

/**
 * Desktop shell only: tell Tauri the resolved palette so the native title bar, window border and
 * window background follow the app theme (src-tauri/src/chrome.rs). A no-op in a browser, and only
 * sent when the palette actually changed.
 */
export function syncDesktopChrome(
  palette: BootPalette,
  bridge: DesktopChromeBridge | undefined = (globalThis as { burnrateShell?: DesktopChromeBridge }).burnrateShell,
): boolean {
  if (!bridge || typeof bridge.setChrome !== "function") return false;
  const key = `${palette.dark ? 1 : 0}|${palette.bg}|${palette.fg}`;
  if (key === lastChrome) return false;
  lastChrome = key;
  bridge.setChrome(palette.dark, palette.bg, palette.fg);
  return true;
}

/** Test hook: forget the last palette sent to the shell. */
export function resetDesktopChromeCache(): void {
  lastChrome = "";
}

/** Apply one settings snapshot. Safe to call repeatedly; every write is idempotent. */
export function applyAppearance(settings: AppSettings, systemDark = systemDarkNow()): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const appearance = settings.appearance;
  // `safeMode` ignores custom themes and CSS: stock palette and plain mode resolution.
  const mode = settings.advanced.safeMode
    ? appearance.themeMode === "system"
      ? systemDark ? "dark" : "light"
      : appearance.themeMode
    : resolveAppearance(settings, systemDark);
  const dark = mode === "dark";

  const themeId = settings.advanced.safeMode ? "" : resolveThemeId(settings, mode);
  applyThemePalette(themeId, mode);

  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  // T3's fixed radius, spacing and scale: saved radius/density/uiScale keys are ignored.
  const systemReducedMotion = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(MOTION_QUERY).matches
    : false;
  const nextMotion = resolveReducedMotion(appearance.reduceMotion, systemReducedMotion) ? "on" : "off";
  if (root.dataset.reduceMotion !== nextMotion) {
    root.dataset.reduceMotion = nextMotion;
    if (typeof window !== "undefined") window.dispatchEvent(new Event(REDUCED_MOTION_CHANGE));
  }
  if (appearance.highContrast) root.dataset.highContrast = "true";
  else delete root.dataset.highContrast;
  // High contrast must reach the `--appearance-contrast-*` chain too: the CSS block in appearance.css only
  // retunes border and muted tokens, so text on custom themes stayed at stock contrast without this.
  applyAppearanceContrast(root, appearance.highContrast ? HIGH_CONTRAST_LEVEL : 100);
  syncTitleBarColor();
  const palette = computeBootPalette(settings, systemDark);
  writeBootPalette(palette);
  syncDesktopChrome(palette);
}

export function applyAppearanceFromSettings(): void {
  applyAppearance(getSettings(), systemDarkNow());
}

/**
 * One-time, React-independent setup: initial paint, OS scheme changes, cross-window
 * mirror changes, and a small bridge from the legacy `burnrate.settings.theme` key
 * (App.tsx still writes it until the app-shell package migrates the toggle).
 */
export function startClientAppearance(): () => void {
  if (typeof window === "undefined") return () => {};
  applyAppearanceFromSettings();

  const onSystemChange = () => applyAppearanceFromSettings();
  const unsubscribeSystem = subscribeToSystemDark(onSystemChange);
  const motionQuery = typeof window.matchMedia === "function" ? window.matchMedia(MOTION_QUERY) : null;
  const onMotionChange = () => applyMotionPreference();
  motionQuery?.addEventListener("change", onMotionChange);

  const onStorage = (event: StorageEvent) => {
    if (event.key === "burnrate.settings.mirror" || event.key === null) {
      applyAppearanceFromSettings();
    }
    if (event.key === "burnrate.settings") {
      try {
        const legacy = JSON.parse(event.newValue ?? "{}") as { theme?: unknown };
        if (
          legacy.theme === "system" ||
          legacy.theme === "light" ||
          legacy.theme === "dark"
        ) {
          if (getSettings().appearance.themeMode !== legacy.theme) {
            void updateSettings({ appearance: { themeMode: legacy.theme } }).catch(() => {});
          }
        }
      } catch {
        /* ignore malformed legacy mirror */
      }
    }
  };
  window.addEventListener("storage", onStorage);

  return () => {
    unsubscribeSystem();
    motionQuery?.removeEventListener("change", onMotionChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** React-facing counterpart of `startClientAppearance`, mounted once in main.tsx. */
export function useAppearanceSync(): void {
  useAppearanceSettingsBridge();
  const appearance = useSettings((settings) => settings.appearance);
  const safeMode = useSettings((settings) => settings.advanced.safeMode);
  const systemDark = useSyncExternalStore(subscribeToSystemDark, systemDarkNow, () => false);
  useEffect(() => {
    applyAppearance(getSettings(), systemDark);
  }, [appearance, safeMode, systemDark]);
}

export { DARK_QUERY };
