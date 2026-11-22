import { describe, expect, it } from "vitest";

import { THEME_COLOR_ROLES, type ThemeDefinition } from "~/shared/themePalettes";
import { burnrateDark } from "~/themes/engine/burnrateDark";

import { theme as burnrateDarkPreset } from "../burnrate-dark";
import { theme as burnrateLightPreset } from "../burnrate-light";

const ROLES = [...THEME_COLOR_ROLES];

function expectCompleteTheme(theme: ThemeDefinition): void {
  expect(ROLES).toHaveLength(61);
  expect(Object.keys(theme.colors)).toHaveLength(ROLES.length);
  expect(Object.keys(theme.colors).sort()).toEqual([...ROLES].sort());
  for (const role of ROLES) {
    const value = theme.colors[role];
    expect(typeof value, `${theme.id}.${role} is a color string`).toBe("string");
    expect(value.trim(), `${theme.id}.${role} is not empty`).not.toBe("");
    expect(value).not.toMatch(/undefined|null/);
  }
}

describe("Burnrate theme presets", () => {
  it("Burnrate Dark re-exports the engine definition unchanged", () => {
    expect(burnrateDarkPreset).toBe(burnrateDark);
    expect(burnrateDarkPreset.id).toBe("burnrate-dark");
    expect(burnrateDarkPreset.label).toBe("edge of night");
    expect(burnrateDarkPreset.appearance).toBe("dark");
    expect(burnrateDarkPreset.managed).toBe(true);
  });

  it("Burnrate Dark defines all 61 theme roles", () => {
    expectCompleteTheme(burnrateDarkPreset);
  });

  it("Burnrate Light is the stock light palette with all 61 roles", () => {
    expect(burnrateLightPreset.id).toBe("burnrate-light");
    expect(burnrateLightPreset.label).toBe("Burnrate Light");
    expect(burnrateLightPreset.appearance).toBe("light");
    expect(burnrateLightPreset.managed).toBe(true);
    expectCompleteTheme(burnrateLightPreset);
  });
});
