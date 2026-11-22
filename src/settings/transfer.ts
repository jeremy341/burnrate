/**
 * Helpers for the Settings → Data section (contracts §2 and §9).
 *
 * The pure functions at the top are deliberately free of DOM/React state so they can be unit
 * tested; the async ones at the bottom are thin wrappers around the documented HTTP API.
 * Secrets are never part of a settings export (see the schema notes in `schema.ts`).
 */
import { ApiError, request } from "~/api/http";
import { m } from "~/i18n";
import { cloneDefaults, deepMerge } from "./migrate";
import type { AppSettings } from "./schema";

export type ImportMode = "merge" | "replace";

export const EXPORT_APP = "burnrate";
export const EXPORT_SCHEMA_VERSION = 2;

/** Shape returned by `POST /api/settings/export`. */
export interface SettingsExport {
  app: string;
  schemaVersion: number;
  exportedAt: string;
  settings: AppSettings;
}

/** A validated import file: we only hand `settings` to the server, never the wrapper fields. */
export interface ParsedImport {
  settings: Record<string, unknown>;
  schemaVersion: number | null;
  exportedAt: string | null;
}

/** One changed leaf in a settings comparison, used for the import confirmation summary. */
export interface DiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `burnrate-settings-YYYY-MM-DD.json` (UTC, stable for a given export). */
export function buildExportFileName(exportedAt: string | number | Date = new Date()): string {
  const date = exportedAt instanceof Date ? exportedAt : new Date(exportedAt);
  if (Number.isNaN(date.getTime())) return "burnrate-settings-unknown.json";
  return `burnrate-settings-${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}.json`;
}

/** Pretty, deterministic file contents. Secrets are excluded by the server's export. */
export function serializeSettingsExport(payload: SettingsExport): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Parse and validate a settings export file. Throws human-readable errors suitable for a toast
 * or inline status message. Accepts schemaVersion 1 and 2; the server migrates v1 on import.
 */
export function parseSettingsImport(text: string): ParsedImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(m("The selected file is not valid JSON."));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(m("This does not look like a Burnrate settings export."));
  }
  const wrapper = parsed as Record<string, unknown>;
  if (wrapper.app !== EXPORT_APP) {
    throw new Error(m("This file is not a Burnrate settings export."));
  }
  const version = typeof wrapper.schemaVersion === "number" ? wrapper.schemaVersion : null;
  if (version !== null && version !== 1 && version !== EXPORT_SCHEMA_VERSION) {
    throw new Error(m("This settings export uses an unsupported version."));
  }
  const settings = wrapper.settings;
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(m("The settings export is missing its settings."));
  }
  return {
    settings: settings as Record<string, unknown>,
    schemaVersion: version,
    exportedAt: typeof wrapper.exportedAt === "string" ? wrapper.exportedAt : null,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Flatten two settings objects into the list of leaves that differ. Objects are walked by key;
 * arrays and scalars replace atomically. Result is sorted by path for a stable confirmation list.
 */
export function diffSettings(before: unknown, after: unknown, basePath = ""): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    const aObj = isPlainObject(a);
    const bObj = isPlainObject(b);
    if (aObj || bObj) {
      const keys = new Set([...Object.keys(aObj ? a : {}), ...Object.keys(bObj ? b : {})]);
      for (const key of [...keys].sort()) {
        walk(
          aObj ? a[key] : undefined,
          bObj ? b[key] : undefined,
          path ? `${path}.${key}` : key,
        );
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      entries.push({ path, before: a, after: b });
    }
  };
  walk(before, after, basePath);
  return entries;
}

/**
 * The legacy top-level price/alias maps in an old export belong under `usage.*` (the server folds them in
 * the same way before merging).
 */
function foldLegacyMaps(imported: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...imported };
  const usage = isPlainObject(out.usage) ? { ...out.usage } : {};
  for (const key of ["usagePriceOverrides", "usageModelAliases"]) {
    if (key in out) {
      if (!(key in usage)) usage[key] = out[key];
      delete out[key];
    }
  }
  if (Object.keys(usage).length > 0) out.usage = usage;
  return out;
}

/**
 * What an import would really change, per mode. The file's own keys are not the whole story: "merge" keeps
 * everything the file does not mention, "replace" resets everything it does not mention to the defaults.
 * Diffing the raw file against the current settings listed every setting missing from the file as
 * "changes to not set", which no mode ever does.
 */
export function previewImport(
  current: AppSettings,
  imported: Record<string, unknown>,
  mode: ImportMode,
): DiffEntry[] {
  const file = foldLegacyMaps(imported);
  delete file.schemaVersion;
  const base: unknown = mode === "replace" ? cloneDefaults() : current;
  return diffSettings(current, deepMerge(base, file));
}

/** Things a reset would delete for good: they cannot be recovered from the defaults. */
export interface ResetLosses {
  customThemes: number;
  priceOverrides: number;
  modelAliases: number;
  providerOverrides: number;
}

function sizeOf(value: unknown): number {
  return isPlainObject(value) ? Object.keys(value).length : 0;
}

/**
 * Count the user-made content a reset would discard, so "Reset all" can say "this deletes 2 custom themes
 * and 3 price overrides" instead of promising only that settings return to their defaults.
 */
export function resetLosses(settings: AppSettings): ResetLosses {
  return {
    customThemes: sizeOf(settings.appearance?.customThemes),
    priceOverrides: sizeOf(settings.usage?.usagePriceOverrides),
    modelAliases: sizeOf(settings.usage?.usageModelAliases),
    providerOverrides: sizeOf(settings.providers?.overrides),
  };
}

export function hasResetLosses(losses: ResetLosses): boolean {
  return Object.values(losses).some((count) => count > 0);
}

/** Compact byte size for diagnostics rows. `null` renders as "Unknown". */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return m("Unknown");
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Trigger a Blob download. No-op outside a browser (keeps the pure helpers node-testable). */
export function downloadTextFile(filename: string, text: string, mime = "application/json"): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** POST /api/settings/export, then save it as a file. Returns the exported payload. */
export async function exportSettingsFile(): Promise<SettingsExport> {
  const payload = await request<SettingsExport>("/api/settings/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  downloadTextFile(buildExportFileName(payload.exportedAt), serializeSettingsExport(payload));
  return payload;
}

/** POST /api/settings/import. Returns the new (merged or replaced) settings. */
export async function importSettings(settings: AppSettings, mode: ImportMode): Promise<AppSettings> {
  return request<AppSettings>("/api/settings/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings, mode }),
  });
}

/** POST /api/settings/reset — restore every setting to its default. */
export async function resetSettings(): Promise<AppSettings> {
  return request<AppSettings>("/api/settings/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "all" }),
  });
}

/** POST /api/diagnostics/open-data-dir (loopback only; opens the folder in the OS file manager). */
export async function openDataFolder(): Promise<void> {
  await request("/api/diagnostics/open-data-dir", { method: "POST" });
}

/** DELETE /api/history — clears the recorded limit samples. */
export async function clearHistory(): Promise<void> {
  await request("/api/history", { method: "DELETE" });
}

/** Turn any thrown value into a short message suitable for `aria-live` status text. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.field) {
    return m("Check the value for {field} and try again.", { field: error.field });
  }
  return error instanceof Error ? error.message : m("Something went wrong. Please try again.");
}

function missingKeys(current: unknown, incoming: unknown): number {
  if (!isPlainObject(current)) return 0;
  const kept = isPlainObject(incoming) ? incoming : {};
  return Object.keys(current).filter((key) => !(key in kept)).length;
}

/**
 * What a "replace" import deletes: user-made entries that the file does not bring back. (The defaults are
 * empty maps, so anything in the current settings that is absent from the file is lost.)
 */
export function replaceImportLosses(current: AppSettings, imported: Record<string, unknown>): ResetLosses {
  const file = foldLegacyMaps(imported);
  const section = (name: string): Record<string, unknown> => {
    const value = file[name];
    return isPlainObject(value) ? value : {};
  };
  return {
    customThemes: missingKeys(current.appearance?.customThemes, section("appearance").customThemes),
    priceOverrides: missingKeys(current.usage?.usagePriceOverrides, section("usage").usagePriceOverrides),
    modelAliases: missingKeys(current.usage?.usageModelAliases, section("usage").usageModelAliases),
    providerOverrides: missingKeys(current.providers?.overrides, section("providers").overrides),
  };
}
