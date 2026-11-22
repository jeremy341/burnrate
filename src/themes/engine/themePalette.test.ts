import { describe, expect, it } from "vitest";

import {
  APP_THEME_VARIABLES,
  THEME_COLOR_ROLES,
  createVividThemeColors,
  parseThemeFile,
  serializeThemeFile,
  themeColorToHex,
  toCanonicalThemeColor,
} from "~/themePalette";
import type { ThemeColorRole } from "~/shared/themePalettes";

import { burnrateDark } from "./burnrateDark";

describe("createVividThemeColors parity with docs/THEME.md", () => {
  const generated = createVividThemeColors("dark", "#181818", "#ffffff");

  it("matches all 61 roles of the Burnrate Dark palette (parity requirement)", () => {
    const mismatches: string[] = [];
    for (const role of THEME_COLOR_ROLES) {
      const expected = toCanonicalThemeColor(burnrateDark.colors[role]);
      const actual = toCanonicalThemeColor(generated[role]);
      if (expected !== actual) mismatches.push(`${role}: expected ${expected}, got ${actual}`);
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("resolves the key pixel samples from docs/THEME.md", () => {
    expect(themeColorToHex(generated.canvas)).toBe("#181818");
    expect(themeColorToHex(generated.text)).toBe("#eeeeee");
    expect(themeColorToHex(generated.mutedForeground)).toBe("#8e8e8e");
    expect(themeColorToHex(generated.border)).toBe("#3f3f3f");
  });
});

describe("theme file v1", () => {
  it("round-trips a seeded theme through serialize/parse", () => {
    const theme = parseThemeFile({
      version: 1,
      name: "Test Palette",
      appearance: "dark",
      canvas: "#181818",
      accent: "#ffffff",
      colors: { canvas: "#181818" },
    });
    const restored = parseThemeFile(JSON.parse(serializeThemeFile(theme)));
    expect(restored).toEqual(theme);
  });

  it("rejects unsupported versions and reserved ids", () => {
    expect(() => parseThemeFile({ version: 2, name: "x", appearance: "dark", colors: {} })).toThrow();
    expect(() =>
      parseThemeFile({ version: 1, id: "dark", name: "x", appearance: "dark", colors: { canvas: "#000" } }),
    ).toThrow();
  });
});

describe("CSS variable mapping", () => {
  it("publishes every theme role as --app-theme-* (index.css contract)", () => {
    expect(Object.keys(APP_THEME_VARIABLES).sort()).toEqual([...THEME_COLOR_ROLES].sort());
    const roles = Object.keys(APP_THEME_VARIABLES) as ThemeColorRole[];
    for (const role of roles) {
      const expected =
        role === "terminalSelection"
          ? "--app-theme-terminal-selection-background"
          : `--app-theme-${role.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`;
      expect(APP_THEME_VARIABLES[role]).toBe(expected);
    }
  });
});
