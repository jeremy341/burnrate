import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "~/settings/schema";
import type { ThemeAppearance, ThemeDefinition } from "~/shared/themePalettes";

/**
 * H1 regression: `appearance.ts` is the only writer of `.dark`/`colorScheme`. In particular it
 * honours a single-appearance theme's forced mode, which the old `App.tsx` writer (keyed only on
 * `themeMode` + the OS query) overwrote with the raw system mode.
 */
vi.mock("~/themePalette", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/themePalette")>();
  const darkOnly = {
    id: "dark-only",
    label: "Dark Only",
    appearance: "dark",
    colors: actual.getStandardThemeColors("dark"),
    managed: true,
  };
  return {
    ...actual,
    getThemeDefinition: (theme: string) => (theme === "dark-only" ? (darkOnly as ThemeDefinition) : null),
    getThemeColorsForMode: (theme: ThemeDefinition, mode: ThemeAppearance) =>
      mode === theme.appearance ? theme.colors : null,
  };
});

import { applyAppearance } from "~/appearance";

function makeRoot() {
  const classes = new Set<string>();
  const properties = new Map<string, string>();
  const root = {
    classList: {
      toggle: (name: string, force?: boolean) => {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
    style: {
      colorScheme: "",
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => properties.delete(name),
    },
    dataset: {} as Record<string, string>,
  } as unknown as HTMLElement;
  return { root, classes, properties };
}

let dom: ReturnType<typeof makeRoot>;

beforeEach(() => {
  dom = makeRoot();
  vi.stubGlobal("document", {
    documentElement: dom.root,
    createElement: () => ({ getContext: () => null }),
    querySelector: () => null,
  });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyAppearance owns the dark class and color scheme", () => {
  it("forces dark for a single-appearance dark theme even in light OS mode", () => {
    applyAppearance(
      {
        ...DEFAULT_SETTINGS,
        appearance: {
          ...DEFAULT_SETTINGS.appearance,
          themeMode: "system",
          lightThemeId: "dark-only",
          darkThemeId: null,
        },
      },
      false,
    );

    expect(dom.classes.has("dark")).toBe(true);
    expect(dom.root.style.colorScheme).toBe("dark");
  });

  it("App.tsx does not keep a second writer of the dark class", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("useThemeMode");
    expect(source).not.toContain('classList.toggle("dark"');
  });

  it("drives the contrast chain from highContrast (M2)", () => {
    const apply = (highContrast: boolean) => {
      dom = makeRoot();
      vi.stubGlobal("document", {
        documentElement: dom.root,
        createElement: () => ({ getContext: () => null }),
        querySelector: () => null,
      });
      applyAppearance(
        {
          ...DEFAULT_SETTINGS,
          appearance: { ...DEFAULT_SETTINGS.appearance, highContrast, lightThemeId: null, darkThemeId: null },
        },
        false,
      );
    };

    apply(false);
    expect(dom.properties.get("--appearance-contrast-boost")).toBe("0%");
    expect(dom.root.dataset.highContrast).toBeUndefined();

    apply(true);
    expect(dom.properties.get("--appearance-contrast-base")).toBe("100%");
    expect(dom.properties.get("--appearance-contrast-boost")).toBe("50%");
    expect(dom.root.dataset.highContrast).toBe("true");
  });

  it("follows themeMode for the stock palette", () => {
    for (const [themeMode, systemDark, expectedDark] of [
      ["light", true, false],
      ["dark", false, true],
      ["system", false, false],
      ["system", true, true],
    ] as const) {
      dom = makeRoot();
      vi.stubGlobal("document", {
        documentElement: dom.root,
        createElement: () => ({ getContext: () => null }),
        querySelector: () => null,
      });

      applyAppearance(
        {
          ...DEFAULT_SETTINGS,
          appearance: { ...DEFAULT_SETTINGS.appearance, themeMode, lightThemeId: null, darkThemeId: null },
        },
        systemDark,
      );

      expect(dom.classes.has("dark")).toBe(expectedDark);
      expect(dom.root.style.colorScheme).toBe(expectedDark ? "dark" : "light");
    }
  });

  it("ignores the saved corner-radius, density and UI-scale keys (T3 fixed tokens)", () => {
    applyAppearance({
      ...DEFAULT_SETTINGS,
      appearance: {
        ...DEFAULT_SETTINGS.appearance,
        radius: 0.9,
        density: "compact",
        uiScale: 1.4,
      },
    });

    expect(dom.root.dataset.density).toBeUndefined();
    expect(dom.properties.has("--radius")).toBe(false);
    expect(dom.properties.has("--burnrate-ui-scale")).toBe(false);
  });
});
