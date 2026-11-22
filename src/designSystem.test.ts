import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { burnrateDark } from "~/themes/engine/burnrateDark";
import { themeColorToHex } from "~/themePalette";
import { preloadInterFont, resetInterPreload } from "./appearanceFonts";

const root = resolve(__dirname, "..");
const css = readFileSync(resolve(root, "src/index.css"), "utf8").replace(/\r\n/g, "\n");
const html = readFileSync(resolve(root, "index.html"), "utf8");

describe("T3 design system is preloaded", () => {
  it("ships every Inter Variable subset T3 ships", () => {
    for (const subset of ["cyrillic-ext", "cyrillic", "greek-ext", "greek", "vietnamese", "latin-ext", "latin"]) {
      expect(css).toContain(`inter-${subset}-wght-normal.woff2`);
    }
    expect(css).toMatch(/--font-sans:\s*-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif/);
  });

  it("keeps T3's tokens: 0.5rem radius, black dark canvas, white 8% dark border", () => {
    expect(css).toMatch(/--radius: 0\.5rem;/);
    expect(css).toMatch(/--background: #000;/);
    expect(css).toMatch(/--border: --alpha\(var\(--color-white\) \/ 8%\);/);
  });

  it("raises a dark-only divider floor that the JS contrast writer cannot reset", () => {
    expect(css).toMatch(/--divider-floor: 0%;/);
    expect(css).toMatch(/@variant dark \{[^}]*--divider-floor: 8%;/);
    // The floor is part of every border chain, next to the JS-owned boost.
    const chains = css.match(/calc\(var\(--appearance-contrast-border-boost\) \+ var\(--divider-floor(?:-input)?\)\)/g) ?? [];
    expect(chains.length).toBeGreaterThanOrEqual(4);
  });

  it("paints the edge-of-night canvas before React mounts", () => {
    expect(html).toContain('var DARK_BG = "#181818"');
    expect(html).toContain('<meta name="theme-color" content="#181818" />');
  });
});

describe("burnrate-dark is the user's edge of night palette", () => {
  it("uses the #181818 canvas, derived surfaces and text", () => {
    const c = burnrateDark.colors;
    expect(themeColorToHex(c.canvas)).toBe("#181818");
    expect(themeColorToHex(c.text)).toBe("#eeeeee");
    expect(themeColorToHex(c.accent)).toBe("#ffffff");
  });
});

describe("preloadInterFont", () => {
  it("adds one font preload hint and is idempotent", () => {
    resetInterPreload();
    const appended: Array<Record<string, unknown>> = [];
    const doc = {
      head: { querySelector: () => null, appendChild: (n: Record<string, unknown>) => appended.push(n) },
      createElement: () => ({}) as Record<string, unknown>,
      fonts: { load: () => Promise.resolve([]) },
    } as unknown as Document;
    expect(preloadInterFont(doc)).toBe(true);
    expect(preloadInterFont(doc)).toBe(false);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ rel: "preload", as: "font", type: "font/woff2", crossOrigin: "anonymous" });
    expect(String(appended[0].href)).toContain("inter-latin-wght-normal");
    resetInterPreload();
  });
});
