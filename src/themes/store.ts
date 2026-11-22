/**
 * Low-level bridge between the theme modules and the Burnrate settings store.
 *
 * T3 keeps its custom theme library in `localStorage`; Burnrate keeps it in
 * `settings.appearance.customThemes` (server source of truth, localStorage mirror for
 * first paint). This module is the only place that knows the storage location, so the
 * pure palette code in `themePalette.ts` can stay storage-agnostic.
 */
import { useEffect } from "react";

import { getSettings, updateSettings, useSettings } from "~/settings/store";
import type { ThemeDefinition } from "~/shared/themePalettes";

export type ThemeRecord = Readonly<Record<string, ThemeDefinition>>;

/** Written by `appearance.ts` on every theme change; read by the inline boot script. */
export const BOOT_STORAGE_KEY = "burnrate.boot";
export const SETTINGS_MIRROR_KEY = "burnrate.settings.mirror";

export function readCustomThemes(): ThemeRecord {
  return getSettings().appearance?.customThemes ?? {};
}

/**
 * Optimistic write-through. `updateSettings` commits before its PATCH promise settles. Settings patches merge
 * maps key by key, so an id that left the record must travel as `null` or it is never removed.
 */
export function writeCustomThemes(themes: ThemeRecord): void {
  const removed = Object.fromEntries(
    Object.keys(readCustomThemes())
      .filter((id) => !Object.hasOwn(themes, id))
      .map((id) => [id, null]),
  );
  void updateSettings({ appearance: { customThemes: { ...themes, ...removed } } as never }).catch((error: unknown) => {
    console.error("Failed to persist custom themes", error);
  });
}

const settingsListeners = new Set<() => void>();

/** Notified by `useAppearanceSync()` (same window) and the `storage` event (other windows). */
export function subscribeToSettings(listener: () => void): () => void {
  settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
}

export function notifySettingsChanged(): void {
  for (const listener of settingsListeners) listener();
}

/** Subscribe a React component to the appearance slice and notify plain-JS theme listeners. */
export function useAppearanceSettingsBridge(): void {
  const appearance = useSettings((settings) => settings.appearance);
  useEffect(() => {
    notifySettingsChanged();
  }, [appearance]);
}
