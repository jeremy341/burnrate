/**
 * Thin adapter over the v2 settings store, kept so the copied T3 usage components (and App.tsx)
 * do not have to change. The three legacy fields map onto their v2 homes:
 *   theme -> appearance.themeMode, timestampFormat/hideSensitive -> general.*
 */
import type { SettingsPatch } from "~/settings/schema";
import {
  clearSettingsError,
  getSettingsError,
  updateSettings as storeUpdate,
  useSettings,
  useSettingsError,
  type SettingsError,
} from "~/settings/store";
import type { TimestampFormat } from "~/timestampFormat";

export interface AppSettings {
  readonly timestampFormat: TimestampFormat;
  readonly theme: "system" | "light" | "dark";
  readonly hideSensitive: boolean;
}

export type { SettingsError };
export { clearSettingsError, getSettingsError, useSettingsError };

interface LegacyPatch {
  theme?: AppSettings["theme"];
  timestampFormat?: TimestampFormat;
  hideSensitive?: boolean;
}

export type PrimarySettingsPatch = LegacyPatch | SettingsPatch;

/** Accepts both the legacy three keys and any v2 patch; legacy keys never reach the server. */
export function updateSettings(patch: PrimarySettingsPatch): Promise<void> {
  const { theme, timestampFormat, hideSensitive, ...rest } = patch as LegacyPatch & SettingsPatch;
  const mapped: SettingsPatch = { ...(rest as SettingsPatch) };
  if (theme !== undefined) mapped.appearance = { ...mapped.appearance, themeMode: theme };
  if (timestampFormat !== undefined) {
    mapped.general = { ...mapped.general, timestampFormat };
  }
  if (hideSensitive !== undefined) {
    mapped.general = { ...mapped.general, hideSensitive };
  }
  return storeUpdate(mapped);
}

/** The legacy `usePrimarySettings` shape, backed by the v2 store. */
export function usePrimarySettings<T = AppSettings>(select?: (settings: AppSettings) => T): T {
  return useSettings((settings) => {
    const legacy: AppSettings = {
      theme: settings.appearance.themeMode,
      timestampFormat: settings.general.timestampFormat,
      hideSensitive: settings.general.hideSensitive,
    };
    return (select ? select(legacy) : legacy) as T;
  });
}
