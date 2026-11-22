import { describe, expect, it } from "vitest";

import {
  humanizeThemeName,
  isVsCodeThemeFile,
  pairVsCodeThemes,
  parseThemeImport,
  resolveThemeLabelCollisions,
} from "~/vscodeThemeImport";
import {
  getThemeModes,
  serializeThemeFile,
  themeColorToHex,
  toCanonicalThemeColor,
  type ThemeDefinition,
} from "~/themePalette";

const midnightDark = {
  name: "midnight",
  displayName: "Midnight Dark",
  type: "dark",
  colors: {
    "editor.background": "#101014",
    "editor.foreground": "#d8d8e0",
    focusBorder: "#7aa2f7",
    "button.background": "#7aa2f7",
    "button.foreground": "#ffffff",
    "sideBar.background": "#0b0b0e",
    "sideBar.foreground": "#c0c0cc",
    "terminal.background": "#0d0d12",
    "list.activeSelectionBackground": "#20202a",
    "input.background": "#15151b",
    "editorWidget.background": "#15151b",
    "panel.border": "#2a2a36",
  },
};

const midnightLight = {
  name: "midnight-light",
  displayName: "Midnight Light",
  type: "light",
  colors: {
    "editor.background": "#f7f7fb",
    "editor.foreground": "#23232b",
    focusBorder: "#4b5bd6",
    "button.background": "#4b5bd6",
    "button.foreground": "#ffffff",
    "sideBar.background": "#ededf4",
    "terminal.background": "#ffffff",
  },
};

describe("theme file v1 import/export", () => {
  const file = {
    version: 1,
    name: "Aurora",
    appearance: "light",
    colors: { canvas: "#f7f7fb", accent: "#7157d9" },
  };

  it("parses a serialized theme file back to the same definition", () => {
    const parsed = parseThemeImport(JSON.stringify(file));
    const roundTripped = parseThemeImport(serializeThemeFile(parsed));
    expect(roundTripped.id).toBe(parsed.id);
    expect(roundTripped.label).toBe("Aurora");
    expect(roundTripped.appearance).toBe("light");
    expect(toCanonicalThemeColor(roundTripped.colors.canvas)).toBe(
      toCanonicalThemeColor(parsed.colors.canvas),
    );
    expect(themeColorToHex(roundTripped.colors.canvas)).toBe("#f7f7fb");
  });

  it("accepts comments and trailing commas in pasted JSON", () => {
    const source = `{
      // the theme name
      "version": 1,
      "name": "Commented",
      "appearance": "dark",
      "colors": { "canvas": "#101014", },
    }`;
    expect(parseThemeImport(source).label).toBe("Commented");
  });

  it("rejects malformed JSON with a readable message", () => {
    expect(() => parseThemeImport("{ nope")).toThrow(/not valid JSON/i);
  });
});

describe("VS Code theme import", () => {
  it("recognises workbench themes but not Burnrate theme files", () => {
    expect(isVsCodeThemeFile(midnightDark)).toBe(true);
    expect(isVsCodeThemeFile({ version: 1, name: "Aurora" })).toBe(false);
    expect(isVsCodeThemeFile({ name: "empty", colors: { foreground: "#fff" } })).toBe(false);
    expect(isVsCodeThemeFile({ tokenColors: [] })).toBe(true);
  });

  it("derives a full palette from the workbench colors", () => {
    const theme = parseThemeImport(JSON.stringify(midnightDark));
    expect(theme.label).toBe("Midnight Dark");
    expect(theme.appearance).toBe("dark");
    expect(themeColorToHex(theme.colors.canvas)).toBe("#101014");
    expect(themeColorToHex(theme.colors.sidebar)).toBe("#0b0b0e");
    expect(themeColorToHex(theme.colors.terminalBackground)).toBe("#0d0d12");
    expect(themeColorToHex(theme.colors.accent)?.toLowerCase()).toBe("#7aa2f7");
  });

  it("falls back to the canvas luminance when type is missing", () => {
    const withoutType = { ...midnightLight, type: undefined };
    expect(parseThemeImport(JSON.stringify(withoutType)).appearance).toBe("light");
  });

  it("rejects a theme without editor.background", () => {
    expect(() =>
      parseThemeImport(JSON.stringify({ name: "Broken", colors: { "editor.foreground": "#fff" } })),
    ).toThrow(/editor\.background/);
  });

  it("humanizes dashed and underscored names", () => {
    expect(humanizeThemeName("one-dark_pro")).toBe("One Dark Pro");
    expect(humanizeThemeName("Already Spaced")).toBe("Already Spaced");
  });
});

describe("importing a folder", () => {
  it("pairs matched light and dark halves into one theme", () => {
    const light = parseThemeImport(JSON.stringify(midnightLight));
    const dark = parseThemeImport(JSON.stringify(midnightDark));
    const paired = pairVsCodeThemes([light, dark]);
    expect(paired).toHaveLength(1);
    expect(paired[0]!.label).toBe("Midnight");
    expect(getThemeModes(paired[0]!)).toEqual(["light", "dark"]);
    expect(paired[0]!.variants?.dark).toBeDefined();
  });

  it("keeps distinct themes with colliding labels by renaming from the file name", () => {
    const first = parseThemeImport(JSON.stringify(midnightDark));
    const second = parseThemeImport(
      JSON.stringify({ ...midnightDark, colors: { ...midnightDark.colors, "editor.background": "#202028" } }),
    );
    expect(first.id).toBe(second.id);
    const resolved = resolveThemeLabelCollisions([
      { theme: first, sourceName: "aurora-one.json" },
      { theme: second, sourceName: "aurora-two.json" },
    ]);
    expect(new Set(resolved.map((theme) => theme.id)).size).toBe(2);
    expect(resolved.map((theme) => theme.label)).toEqual(["Aurora One", "Aurora Two"]);
  });

  it("suffixes duplicates that cannot be renamed", () => {
    const theme = parseThemeImport(JSON.stringify(midnightDark));
    const resolved: ReadonlyArray<ThemeDefinition> = resolveThemeLabelCollisions([
      { theme, sourceName: "midnight-dark.json" },
      { theme, sourceName: "midnight-dark.json" },
    ]);
    expect(resolved[0]!.id).not.toBe(resolved[1]!.id);
    expect(resolved[1]!.label).toBe("Midnight Dark 2");
  });
});
