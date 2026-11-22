import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "~/settings/schema";
import type { AppSettings } from "~/settings/schema";

import { computeBootPalette, resolveBootAppearance } from "./boot";
import { resolveAppearance, resolveThemeId, themeHalvesFromSettings } from "./resolve";

function settings(patch: Partial<AppSettings["appearance"]>): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    appearance: { ...DEFAULT_SETTINGS.appearance, ...patch },
  };
}

describe("boot palette", () => {
  it("uses the dark default palette with no flash colors", () => {
    expect(resolveBootAppearance("system", true)).toBe("dark");
    const palette = computeBootPalette(settings({}), true);
    expect(palette.dark).toBe(true);
    expect(palette.bg).toBe("#181818");
    expect(palette.fg).toBe("#eeeeee");
  });

  it("uses the stock light fallback when no light half is selected", () => {
    const palette = computeBootPalette(settings({ themeMode: "system", lightThemeId: null }), false);
    expect(palette.dark).toBe(false);
    expect(palette.bg).toBe("#fcfcfc");
  });

  it("respects a forced mode and per-appearance halves", () => {
    const value = settings({
      themeMode: "dark",
      darkThemeId: "burnrate-dark",
      lightThemeId: "grove",
    });
    expect(resolveAppearance(value, false)).toBe("dark");
    expect(resolveThemeId(value, "light")).toBe("grove");
    expect(themeHalvesFromSettings(value)).toEqual({ light: "grove", dark: "burnrate-dark" });
  });

  it("forces a single-appearance theme's mode", () => {
    const value = settings({ themeMode: "light", lightThemeId: "burnrate-dark" });
    expect(resolveAppearance(value, false)).toBe("dark");
  });
});
