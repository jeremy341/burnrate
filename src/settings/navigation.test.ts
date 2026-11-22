import { describe, expect, it } from "vitest";

import {
  formatSettingsHash,
  parseSettingsHash,
  pickInitialSection,
  readRememberedSection,
  rememberSection,
  resolveSettingsTarget,
  SETTINGS_SECTION_STORAGE_KEY,
} from "./navigation";

const SECTIONS = ["general", "appearance", "usage", "providers", "notifications", "shortcuts", "shell"].map(
  (id) => ({ id }),
);

describe("settings hash", () => {
  it("parses and formats #settings/<target>", () => {
    expect(parseSettingsHash("#settings/providers")).toBe("providers");
    expect(parseSettingsHash("#settings/appearance-theme-library")).toBe("appearance-theme-library");
    expect(parseSettingsHash(formatSettingsHash("usage/refresh interval"))).toBe("usage/refresh interval");
  });

  it("ignores other hashes and survives malformed escapes", () => {
    expect(parseSettingsHash("")).toBeNull();
    expect(parseSettingsHash("#settings")).toBeNull();
    expect(parseSettingsHash("#settings/")).toBeNull();
    expect(parseSettingsHash("#other/providers")).toBeNull();
    expect(parseSettingsHash("#settings/%E0%A4%A")).toBe("%E0%A4%A");
  });
});

describe("resolveSettingsTarget", () => {
  it("maps a section id to that section with no row", () => {
    expect(resolveSettingsTarget("providers", SECTIONS)).toEqual({ sectionId: "providers", rowId: null });
  });

  it("maps section-prefixed row ids to the owning section", () => {
    expect(resolveSettingsTarget("appearance-theme-library", SECTIONS)).toEqual({
      sectionId: "appearance",
      rowId: "appearance-theme-library",
    });
    expect(resolveSettingsTarget("general-close-to-tray", SECTIONS)).toEqual({
      sectionId: "general",
      rowId: "general-close-to-tray",
    });
    expect(resolveSettingsTarget("setting-theme-mode", SECTIONS)).toEqual({
      sectionId: "appearance",
      rowId: "setting-theme-mode",
    });
    expect(resolveSettingsTarget("usage.usage-currency", SECTIONS)).toEqual({
      sectionId: "usage",
      rowId: "usage-currency",
    });
    expect(resolveSettingsTarget("notifications/channels", SECTIONS, ["notifications-channels"])).toEqual({
      sectionId: "notifications",
      rowId: "notifications-channels",
    });
    expect(resolveSettingsTarget("usage/refresh-interval", SECTIONS, ["usage-refresh-interval"])?.rowId)
      .toBe("usage-refresh-interval");
    expect(resolveSettingsTarget("usage/refresh-interval", SECTIONS, ["refresh-interval", "usage-refresh-interval"])?.rowId)
      .toBe("refresh-interval");
  });

  it("knows the unprefixed typography row ids", () => {
    expect(resolveSettingsTarget("typography", SECTIONS)?.sectionId).toBe("appearance");
    expect(resolveSettingsTarget("mono-font", SECTIONS)?.sectionId).toBe("appearance");
  });

  it("returns null for unknown or empty targets instead of jumping to the first section", () => {
    expect(resolveSettingsTarget("does-not-exist", SECTIONS)).toBeNull();
    expect(resolveSettingsTarget("", SECTIONS)).toBeNull();
    expect(resolveSettingsTarget(null, SECTIONS)).toBeNull();
    // An alias whose section is not registered must not resolve either.
    expect(resolveSettingsTarget("typography", [{ id: "general" }])).toBeNull();
  });
});

describe("pickInitialSection / remembered section", () => {
  it("prefers a deep link, then the remembered section, then the first", () => {
    expect(pickInitialSection({ sectionId: "usage", rowId: null }, "shell", SECTIONS)).toBe("usage");
    expect(pickInitialSection(null, "shell", SECTIONS)).toBe("shell");
    expect(pickInitialSection(null, "gone", SECTIONS)).toBe("general");
    expect(pickInitialSection(null, null, SECTIONS)).toBe("general");
    expect(pickInitialSection(null, null, [])).toBe("");
  });

  it("round-trips through storage and never throws when storage is blocked", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    rememberSection(storage, "providers");
    expect(store.get(SETTINGS_SECTION_STORAGE_KEY)).toBe("providers");
    expect(readRememberedSection(storage)).toBe("providers");

    const blocked = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readRememberedSection(blocked)).toBeNull();
    expect(() => rememberSection(blocked, "usage")).not.toThrow();
    expect(readRememberedSection(null)).toBeNull();
  });
});
