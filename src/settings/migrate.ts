/**
 * Local settings migration (v1 mirror -> v2 schema) and the write-through mirror helpers.
 *
 * The server (`data/settings.json`) is the source of truth; `localStorage["burnrate.settings.mirror"]`
 * is only a synchronous first-paint cache. A pre-v2 build kept three UI preferences under
 * `localStorage["burnrate.settings"]` (plus the usage page prefs under
 * `t3code:usage-page-preferences:v1`). Those are folded into the v2 sections here, once, so the
 * values are visible before `GET /api/settings` resolves. The old keys are deliberately left in
 * place for one release (see docs/research/02-t3-themes-settings.md, section 4.6).
 */
import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  type AppSettings,
  type SettingsPatch,
} from "./schema";

export const MIRROR_KEY = "burnrate.settings.mirror";
/** The three-key localStorage object used before settings moved to the server. */
export const LEGACY_SETTINGS_KEY = "burnrate.settings";
export const LEGACY_USAGE_PREFS_KEY = "t3code:usage-page-preferences:v1";

/** Only the two methods the store needs; easy to fake in tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fresh copy so callers can never mutate `DEFAULT_SETTINGS` through a patch. */
export function cloneDefaults(): AppSettings {
  if (typeof structuredClone === "function") return structuredClone(DEFAULT_SETTINGS);
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings;
}

/**
 * RFC 7396-ish merge used by both the local mirror and the PATCH payload: objects merge,
 * arrays and scalars replace, `null` deletes a map entry, `undefined` is ignored.
 * Does not mutate its arguments.
 */
/**
 * Settings whose `null` is a real value ("use the stock theme", "no shortcut"). Keep in sync with
 * `NULLABLE_FIELDS` in server-rs/src/settings.rs; for every other key `null` deletes the entry.
 */
export const NULLABLE_FIELDS: ReadonlySet<string> = new Set([
  "appearance.lightThemeId",
  "appearance.darkThemeId",
  "appearance.fontFamily",
  "appearance.monoFontFamily",
  "notifications.snoozeUntil",
  "shell.globalShortcut",
]);

export function deepMerge<T>(base: T, patch: unknown, path = ""): T {
  if (patch === undefined) return base;
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = isPlainObject(base)
    ? { ...(base as Record<string, unknown>) }
    : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    const here = path === "" ? key : `${path}.${key}`;
    if (value === null) {
      if (NULLABLE_FIELDS.has(here)) out[key] = null;
      else delete out[key];
      continue;
    }
    out[key] = isPlainObject(value)
      ? deepMerge(isPlainObject(out[key]) ? out[key] : {}, value, here)
      : value;
  }
  return out as T;
}

const THEME_MODES = new Set(["system", "light", "dark"]);
const TIMESTAMP_FORMATS = new Set(["locale", "12-hour", "24-hour"]);
const VIEWS = new Set(["cost", "tokens", "limits"]);
const BAR_MODES = new Set(["remaining", "used"]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Convert the old flat keys into a v2 `SettingsPatch`. Invalid values are dropped rather than
 * copied, so a corrupt/partial legacy object can never push a bad value at the server.
 */
export function legacySettingsPatch(rawLegacy: unknown, rawUsagePrefs?: unknown): SettingsPatch | null {
  const legacy = isPlainObject(rawLegacy) ? rawLegacy : {};
  const prefs = isPlainObject(rawUsagePrefs) ? rawUsagePrefs : {};
  const patch: SettingsPatch = {};

  const timestampFormat = asString(legacy.timestampFormat);
  if (timestampFormat && TIMESTAMP_FORMATS.has(timestampFormat)) {
    patch.general = {
      ...patch.general,
      timestampFormat: timestampFormat as AppSettings["general"]["timestampFormat"],
    };
  }
  if (typeof legacy.hideSensitive === "boolean") {
    patch.general = { ...patch.general, hideSensitive: legacy.hideSensitive };
  }

  const theme = asString(legacy.theme) ?? asString(legacy.appearanceMode);
  if (theme && THEME_MODES.has(theme)) {
    patch.appearance = { ...patch.appearance, themeMode: theme as AppSettings["appearance"]["themeMode"] };
  }

  // `t3code:usage-page-preferences:v1` used different names; map the ones that still exist.
  const defaultView = asString(prefs.defaultMetric);
  if (defaultView && VIEWS.has(defaultView)) {
    patch.usage = { ...patch.usage, defaultView: defaultView as AppSettings["usage"]["defaultView"] };
  }
  const periodDays = prefs.defaultWindowDays;
  if (periodDays === 1 || periodDays === 7 || periodDays === 30 || periodDays === 90) {
    const defaultPeriod = ({ 1: "today", 7: "7d", 30: "30d", 90: "90d" } as const)[periodDays];
    patch.usage = { ...patch.usage, defaultPeriod };
  }
  const barMode = asString(prefs.limitsBarMode);
  if (barMode && BAR_MODES.has(barMode)) {
    patch.usage = { ...patch.usage, barMode: barMode as AppSettings["usage"]["barMode"] };
  }
  if (typeof prefs.showPaceTick === "boolean") {
    patch.usage = { ...patch.usage, showPaceTick: prefs.showPaceTick };
  }
  if (prefs.autoRefreshSeconds === 0 || (typeof prefs.autoRefreshSeconds === "number" && prefs.autoRefreshSeconds >= 30)) {
    patch.usage = { ...patch.usage, refreshIntervalSec: prefs.autoRefreshSeconds as number };
  }
  if (Array.isArray(prefs.hiddenProviders) && prefs.hiddenProviders.every((v) => typeof v === "string")) {
    patch.providers = { ...patch.providers, hidden: prefs.hiddenProviders as string[] };
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function readJson(store: StorageLike, key: string): unknown {
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Normalise any supported mirror shape into a complete v2 `AppSettings`. */
export function migrateMirrorObject(raw: unknown, rawUsagePrefs?: unknown): AppSettings | null {
  if (!isPlainObject(raw)) return null;
  const isV1 = raw.schemaVersion === undefined || raw.schemaVersion === 1;
  if (!isV1 && raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) return null; // unknown future version

  const obj: Record<string, unknown> = { ...raw };
  if (isV1) {
    const patch = legacySettingsPatch(obj, rawUsagePrefs);
    // v1 mirrors kept the flat keys at the top level; fold them in and drop them.
    delete obj.theme;
    delete obj.appearanceMode;
    delete obj.timestampFormat;
    delete obj.hideSensitive;
    delete obj.version;
    if (patch) Object.assign(obj, deepMerge(obj, patch));
  }

  // Legacy server mirrors are duplicated at the top level; keep only the nested copies.
  const usage = isPlainObject(obj.usage) ? { ...obj.usage } : {};
  if (!("usagePriceOverrides" in usage) && "usagePriceOverrides" in obj) {
    usage.usagePriceOverrides = obj.usagePriceOverrides;
  }
  if (!("usageModelAliases" in usage) && "usageModelAliases" in obj) {
    usage.usageModelAliases = obj.usageModelAliases;
  }
  delete obj.usagePriceOverrides;
  delete obj.usageModelAliases;
  obj.usage = usage;
  obj.schemaVersion = SETTINGS_SCHEMA_VERSION;

  return deepMerge(cloneDefaults(), obj) as AppSettings;
}

export function writeMirror(settings: AppSettings, store: StorageLike | null = getStorage()): void {
  if (!store) return;
  try {
    store.setItem(MIRROR_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable / quota — the server is still the source of truth */
  }
}

/**
 * The synchronous snapshot used to initialise the store: prefer a v2 mirror, otherwise migrate
 * the old local keys. Always writes a v2 mirror back so the next first paint is flash-free.
 */
export function readInitialSettings(store: StorageLike | null = getStorage()): AppSettings {
  if (!store) return cloneDefaults();

  const fromMirror = migrateMirrorObject(readJson(store, MIRROR_KEY), readJson(store, LEGACY_USAGE_PREFS_KEY));
  if (fromMirror) {
    writeMirror(fromMirror, store);
    return fromMirror;
  }

  const prefs = readJson(store, LEGACY_USAGE_PREFS_KEY);
  const patch = legacySettingsPatch(readJson(store, LEGACY_SETTINGS_KEY), prefs);
  const settings = patch ? (deepMerge(cloneDefaults(), patch) as AppSettings) : cloneDefaults();
  writeMirror(settings, store);
  return settings;
}
