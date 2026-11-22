/**
 * Settings endpoints from docs/CONTRACTS.md section 2. The client store uses GET/PATCH here;
 * export/import/reset are called directly by the settings data sections.
 */
import { request } from "~/api/http";
import type { AppSettings, SettingsPatch } from "~/settings/schema";

/** A settings export never contains secrets (they live in the encrypted key store). */
export interface SettingsExport {
  app: "burnrate";
  schemaVersion: number;
  exportedAt: string;
  settings: AppSettings;
}

export type SettingsImportMode = "merge" | "replace";
export type SettingsSection =
  | "general"
  | "appearance"
  | "usage"
  | "providers"
  | "notifications"
  | "shell"
  | "advanced";
export type SettingsResetScope = "all" | "section";

/** GET /api/settings — full merged settings plus the legacy top-level mirrors. */
export function fetchSettings(): Promise<AppSettings> {
  return request<AppSettings>("/api/settings");
}

/** PATCH /api/settings — `{ patch }`, deep merge, `null` deletes a map entry. */
export function sendSettingsPatch(patch: SettingsPatch): Promise<AppSettings> {
  return request<AppSettings>("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patch }),
  });
}

/** POST /api/settings/import */
export function importSettings(settings: unknown, mode: SettingsImportMode): Promise<AppSettings> {
  return request<AppSettings>("/api/settings/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings, mode }),
  });
}

/** POST /api/settings/reset */
export function resetSettings(scope: SettingsResetScope, section?: SettingsSection): Promise<AppSettings> {
  return request<AppSettings>("/api/settings/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scope === "section" ? { scope, section } : { scope }),
  });
}
