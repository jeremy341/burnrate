/**
 * Adapted T3 `hooks/useTheme.ts` (MIT, T3 Tools Inc.) backed by the Burnrate
 * settings store instead of T3's localStorage keys. Effect/atoms, the desktop
 * bridge and error-log helpers are removed; the observable API is kept so the
 * theme editor and palette packages can use it unchanged.
 */
import { useMemo, useSyncExternalStore } from "react";

import { applyAppearanceFromSettings } from "~/appearance";
import { getSettings, updateSettings, useSettings } from "~/settings/store";
import type { AppSettings } from "~/settings/schema";
import {
  getThemeDefinition,
  getThemeModes,
  getThemePreviewAppearance,
  subscribeToThemePreview,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreferenceMode,
} from "~/themePalette";
import { resolveAppearance, resolveThemeId, themeHalvesFromSettings } from "~/themes/engine/resolve";
import { getSystemDark, subscribeToSystemDark } from "~/themes/engine/systemDark";
import { subscribeToSettings } from "~/themes/store";

export type Theme = string;

export interface ThemeSnapshot {
  theme: string;
  resolvedTheme: ThemeAppearance;
  systemDark: boolean;
  followSystem: boolean;
  appearanceMode: ThemePreferenceMode;
  themeHalves: ThemeHalves;
}

export class ThemeStorageError extends Error {
  constructor(
    message: string,
    readonly operation: "read" | "write",
    readonly storageKey: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ThemeStorageError";
  }
}

export function readAppearanceModePreference(): ThemePreferenceMode {
  return getSettings().appearance.themeMode;
}

export function readThemeHalves(): ThemeHalves {
  return themeHalvesFromSettings(getSettings());
}

export function readThemeHalvesRaw(): { light?: string; dark?: string } {
  return readThemeHalves();
}

function snapshotFromSettings(settings: AppSettings, systemDark: boolean): ThemeSnapshot {
  const appearance = settings.appearance;
  const resolvedTheme = resolveAppearance(settings, systemDark);
  return {
    theme: resolveThemeId(settings, resolvedTheme) || "system",
    resolvedTheme,
    systemDark,
    followSystem: appearance.themeMode === "system",
    appearanceMode: appearance.themeMode,
    themeHalves: themeHalvesFromSettings(settings),
  };
}

export function getThemeSnapshot(): ThemeSnapshot {
  return snapshotFromSettings(getSettings(), getSystemDark());
}

export function refreshTheme(): void {
  applyAppearanceFromSettings();
}

export function setAppearanceMode(next: ThemePreferenceMode): boolean {
  void updateSettings({ appearance: { themeMode: next } }).catch((error: unknown) => {
    console.error(new ThemeStorageError("Failed to set appearance mode", "write", "settings.appearance.themeMode", error));
  });
  refreshTheme();
  return true;
}

export function setFollowSystem(nextFollowSystem: boolean): boolean {
  return setAppearanceMode(nextFollowSystem ? "system" : getThemeSnapshot().resolvedTheme);
}

export function setTheme(next: string): boolean {
  if (next === "system" || next === "light" || next === "dark") {
    void updateSettings({
      appearance: {
        themeMode: next,
        lightThemeId: null,
        darkThemeId: null,
      },
    }).catch((error: unknown) => {
      console.error(new ThemeStorageError("Failed to set theme", "write", "settings.appearance", error));
    });
  } else {
    const definition = getThemeDefinition(next);
    if (!definition) return false;
    const modes = getThemeModes(definition);
    const both = modes.length === 2;
    void updateSettings({
      appearance: {
        lightThemeId: both || modes.includes("light") ? definition.id : null,
        darkThemeId: both || modes.includes("dark") ? definition.id : null,
      },
    }).catch((error: unknown) => {
      console.error(new ThemeStorageError("Failed to set theme", "write", "settings.appearance", error));
    });
  }
  refreshTheme();
  return true;
}

export function setThemeHalf(appearance: ThemeAppearance, themeId: string | null): boolean {
  const patch =
    appearance === "light"
      ? { appearance: { lightThemeId: themeId } }
      : { appearance: { darkThemeId: themeId } };
  void updateSettings(patch).catch((error: unknown) => {
    console.error(new ThemeStorageError("Failed to set theme half", "write", "settings.appearance", error));
  });
  refreshTheme();
  return true;
}

export function clearThemeHalves(): boolean {
  void updateSettings({ appearance: { lightThemeId: null, darkThemeId: null } }).catch((error: unknown) => {
    console.error(new ThemeStorageError("Failed to clear theme halves", "write", "settings.appearance", error));
  });
  refreshTheme();
  return true;
}

export function subscribeRenderedAppearance(listener: () => void): () => void {
  const offSettings = subscribeToSettings(listener);
  const offPreview = subscribeToThemePreview(listener);
  const offSystem = subscribeToSystemDark(listener);
  return () => {
    offSettings();
    offPreview();
    offSystem();
  };
}

export function getRenderedAppearance(): ThemeAppearance {
  return getThemePreviewAppearance() ?? getThemeSnapshot().resolvedTheme;
}

export function syncBrowserChromeTheme(): void {
  if (typeof document === "undefined") return;
  const background = getComputedStyle(document.documentElement)
    .getPropertyValue("--app-theme-canvas")
    .trim();
  if (!background) return;
  document.documentElement.style.background = background;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.setAttribute("content", background);
  }
}

export function useTheme() {
  const settings = useSettings((value) => value);
  const systemDark = useSyncExternalStore(subscribeToSystemDark, getSystemDark, () => false);
  const snapshot = useMemo(() => snapshotFromSettings(settings, systemDark), [settings, systemDark]);
  return {
    ...snapshot,
    setTheme,
    setAppearanceMode,
    setFollowSystem,
    setThemeHalf,
    clearThemeHalves,
    refreshTheme,
  } as const;
}

export function useRenderedAppearance(): ThemeAppearance {
  const preview = useSyncExternalStore(
    subscribeToThemePreview,
    getThemePreviewAppearance,
    () => null,
  );
  const { resolvedTheme } = useTheme();
  return preview ?? resolvedTheme;
}
