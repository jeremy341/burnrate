import { describe, expect, it } from "vitest";

import {
  LEGACY_SETTINGS_KEY,
  LEGACY_USAGE_PREFS_KEY,
  MIRROR_KEY,
  deepMerge,
  legacySettingsPatch,
  migrateMirrorObject,
  readInitialSettings,
  type StorageLike,
} from "./migrate";
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION } from "./schema";

function memoryStorage(entries: Record<string, unknown> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  for (const [key, value] of Object.entries(entries)) data.set(key, JSON.stringify(value));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
}

describe("settings migration", () => {
  it("deep merges objects, replaces arrays and deletes with null", () => {
    const base = structuredClone(DEFAULT_SETTINGS);
    const merged = deepMerge(base, {
      general: { hideSensitive: true },
      notifications: { thresholds: [70, 85] },
      usage: { usageModelAliases: { stale: null, fresh: "new" } },
    });
    expect(merged.general.hideSensitive).toBe(true);
    expect(merged.notifications.thresholds).toEqual([70, 85]);
    expect(merged.usage.usageModelAliases).toEqual({ fresh: "new" });
    // base is untouched
    expect(base.general.hideSensitive).toBe(false);
    expect(base.notifications.thresholds).toEqual([80, 90, 100]);
  });

  it("maps the v1 local keys into their v2 sections", () => {
    expect(
      legacySettingsPatch(
        { theme: "dark", timestampFormat: "24-hour", hideSensitive: true, junk: 1 },
        { defaultMetric: "limits", defaultWindowDays: 7, limitsBarMode: "used" },
      ),
    ).toEqual({
      general: { timestampFormat: "24-hour", hideSensitive: true },
      appearance: { themeMode: "dark" },
      usage: { defaultView: "limits", defaultPeriod: "7d", barMode: "used" },
    });
    expect(legacySettingsPatch({ theme: "neon", timestampFormat: "nope" })).toBeNull();
  });

  it("migrates a v1 mirror to a complete v2 object and writes the mirror", () => {
    const storage = memoryStorage({
      [MIRROR_KEY]: { theme: "dark", timestampFormat: "12-hour", hideSensitive: true },
    });
    const settings = readInitialSettings(storage);
    expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(settings.appearance.themeMode).toBe("dark");
    expect(settings.general.timestampFormat).toBe("12-hour");
    expect(settings.general.hideSensitive).toBe(true);
    expect(settings.advanced.logLevel).toBe(DEFAULT_SETTINGS.advanced.logLevel); // filled default
    expect(JSON.parse(storage.data.get(MIRROR_KEY)!).schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it("migrates the old burnrate.settings key when there is no usable mirror", () => {
    const storage = memoryStorage({
      [LEGACY_SETTINGS_KEY]: { theme: "light", timestampFormat: "locale", hideSensitive: true },
      [LEGACY_USAGE_PREFS_KEY]: { showPaceTick: false, defaultWindowDays: 30 },
    });
    const settings = readInitialSettings(storage);
    expect(settings.appearance.themeMode).toBe("light");
    expect(settings.general.hideSensitive).toBe(true);
    expect(settings.usage.showPaceTick).toBe(false);
    expect(settings.usage.defaultPeriod).toBe("30d");
    expect(storage.data.has(MIRROR_KEY)).toBe(true);
    // old keys are left in place for one release
    expect(storage.data.has(LEGACY_SETTINGS_KEY)).toBe(true);
  });

  it("keeps a v2 mirror, folds top-level legacy mirrors and fills missing fields", () => {
    const settings = migrateMirrorObject({
      schemaVersion: 2,
      appearance: { radius: 0.9 },
      usagePriceOverrides: { "gpt-x": { price: 1 } },
      usageModelAliases: { alias: "real" },
      usage: {},
    });
    expect(settings).not.toBeNull();
    expect(settings!.appearance.radius).toBe(0.9);
    expect(settings!.appearance.density).toBe(DEFAULT_SETTINGS.appearance.density);
    expect(settings!.usage.usageModelAliases).toEqual({ alias: "real" });
    expect(settings!.usage.usagePriceOverrides).toEqual({ "gpt-x": { price: 1 } });
    expect("usagePriceOverrides" in settings!).toBe(false);
  });

  it("falls back to defaults for corrupt or unknown-version mirrors", () => {
    expect(migrateMirrorObject("not json")).toBeNull();
    expect(migrateMirrorObject({ schemaVersion: 999 })).toBeNull();
    const storage = memoryStorage({ [MIRROR_KEY]: "not json" });
    expect(readInitialSettings(storage)).toEqual(DEFAULT_SETTINGS);
    expect(JSON.parse(storage.data.get(MIRROR_KEY)!).schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it("loads old and new saved files that contain deprecated keys without rejecting them", () => {
    const saved = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      appearance: { radius: "wide", density: 9, uiScale: -2 },
      advanced: { experimental: { openVsx: "yes", random: [1, 2] } },
    };
    const migrated = migrateMirrorObject(saved);
    expect(migrated).not.toBeNull();
    const value = migrated as unknown as Record<string, Record<string, unknown>>;
    expect(value.appearance.radius).toBe("wide");
    expect(value.appearance.density).toBe(9);
    expect(value.advanced.experimental).toEqual({ openVsx: "yes", random: [1, 2] });
    // Live settings are still filled, so an old file remains fully usable.
    expect(migrated!.general.hideSensitive).toBe(DEFAULT_SETTINGS.general.hideSensitive);

    // A v1-shaped file with the same ignored keys loads too (unknown keys are preserved verbatim).
    const legacy = migrateMirrorObject({ theme: "dark", radius: 0.7 });
    const oldValue = legacy as unknown as Record<string, unknown>;
    expect(oldValue.radius).toBe(0.7);
    expect(legacy!.appearance.themeMode).toBe("dark");
  });

  it("does not seed a radius default", () => {
    expect(DEFAULT_SETTINGS.appearance).not.toHaveProperty("radius");
  });
});
