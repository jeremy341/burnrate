import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetDesktopChromeCache, syncDesktopChrome } from "~/appearance";
import { DEFAULT_SETTINGS } from "~/settings/schema";
import { computeBootPalette } from "~/themes/engine/boot";

const root = resolve(__dirname, "..");

/** Runs the inline first-paint script from index.html against a fake document/localStorage. */
function runBootScript(options: { storage?: Record<string, string>; osDark?: boolean }) {
  const html = readFileSync(resolve(root, "index.html"), "utf8");
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("boot script not found in index.html");

  const classes = new Set<string>();
  const properties = new Map<string, string>();
  const meta = { value: "", setAttribute: (_: string, v: string) => (meta.value = v) };
  const documentElement = {
    classList: {
      toggle: (name: string, force?: boolean) => void (force ? classes.add(name) : classes.delete(name)),
    },
    style: {
      background: "",
      colorScheme: "",
      setProperty: (name: string, value: string) => properties.set(name, value),
    },
    dataset: {} as Record<string, string>,
  };
  const storage = options.storage ?? {};
  const context = {
    document: { documentElement, querySelector: () => meta },
    localStorage: { getItem: (key: string) => storage[key] ?? null },
    matchMedia: () => ({ matches: options.osDark === true }),
  };
  vm.runInNewContext(match[1]!, context);
  return { dark: classes.has("dark"), documentElement, properties, themeColor: meta.value };
}

const mirror = (appearance: Record<string, unknown>) => ({
  "burnrate.settings.mirror": JSON.stringify({ appearance }),
});

describe("dark by default", () => {
  it("ships dark in the client defaults, with the burnrate-dark half selected", () => {
    expect(DEFAULT_SETTINGS.appearance.themeMode).toBe("dark");
    expect(DEFAULT_SETTINGS.appearance.darkThemeId).toBe("burnrate-dark");
  });

  it("keeps the server defaults identical (server-rs/src/settings.rs)", () => {
    const rust = readFileSync(resolve(root, "server-rs/src/settings.rs"), "utf8");
    const defaults = /pub fn default_settings\(\)[\s\S]*?"themeMode":\s*"(\w+)"/.exec(rust);
    expect(defaults?.[1]).toBe(DEFAULT_SETTINGS.appearance.themeMode);
  });

  it("computes the #181818 boot palette for a new install even when the OS is light", () => {
    for (const osDark of [true, false]) {
      const palette = computeBootPalette(DEFAULT_SETTINGS, osDark);
      expect(palette).toMatchObject({ dark: true, bg: "#181818" });
    }
  });

  it("still lets stored system and light choices follow the OS / stay light", () => {
    const system = { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, themeMode: "system" as const } };
    expect(computeBootPalette(system, false).dark).toBe(false);
    expect(computeBootPalette(system, true).dark).toBe(true);
    const light = { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, themeMode: "light" as const } };
    expect(computeBootPalette(light, true).dark).toBe(false);
  });
});

describe("index.html first paint (no flash)", () => {
  it("paints dark #181818 on a first run in a light OS", () => {
    const result = runBootScript({ osDark: false });
    expect(result.dark).toBe(true);
    expect(result.documentElement.style.background).toBe("#181818");
    expect(result.documentElement.style.colorScheme).toBe("dark");
    expect(result.themeColor).toBe("#181818");
  });

  it("honours a stored light choice", () => {
    const result = runBootScript({ storage: mirror({ themeMode: "light" }), osDark: true });
    expect(result.dark).toBe(false);
    expect(result.documentElement.style.background).toBe("#fcfcfc");
  });

  it("honours a stored system choice in both OS modes", () => {
    expect(runBootScript({ storage: mirror({ themeMode: "system" }), osDark: false }).dark).toBe(false);
    expect(runBootScript({ storage: mirror({ themeMode: "system" }), osDark: true }).dark).toBe(true);
  });

  it("treats an unknown stored mode like a new install (dark)", () => {
    expect(runBootScript({ storage: mirror({ themeMode: "neon" }), osDark: false }).dark).toBe(true);
  });

  it("prefers the precomputed boot palette (custom themes) over the mode", () => {
    const result = runBootScript({
      storage: {
        ...mirror({ themeMode: "dark", darkThemeId: "grove" }),
        "burnrate.boot": JSON.stringify({ dark: true, bg: "#101810", fg: "#e0ffe0" }),
      },
    });
    expect(result.documentElement.style.background).toBe("#101810");
    expect(result.properties.get("--app-theme-text")).toBe("#e0ffe0");
    expect(result.documentElement.dataset.themeId).toBe("grove");
  });
});

describe("desktop window chrome bridge", () => {
  beforeEach(() => resetDesktopChromeCache());

  it("is a no-op in a browser (no shell bridge)", () => {
    expect(syncDesktopChrome({ dark: true, bg: "#181818", fg: "#f5f5f5" }, undefined)).toBe(false);
  });

  it("sends the resolved palette once and again only when it changes", () => {
    const setChrome = vi.fn();
    const palette = { dark: true, bg: "#181818", fg: "#f5f5f5" };
    expect(syncDesktopChrome(palette, { setChrome })).toBe(true);
    expect(syncDesktopChrome(palette, { setChrome })).toBe(false);
    expect(syncDesktopChrome({ dark: false, bg: "#fcfcfc", fg: "#27272a" }, { setChrome })).toBe(true);
    expect(setChrome.mock.calls).toEqual([
      [true, "#181818", "#f5f5f5"],
      [false, "#fcfcfc", "#27272a"],
    ]);
  });
});
