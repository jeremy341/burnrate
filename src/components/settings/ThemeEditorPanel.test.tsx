import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getStandardThemeColors } from "~/themePalette";
import type { ThemeDefinition } from "~/shared/themePalettes";

/**
 * H2 regression: the merge-target appearance switch must not be a render-phase setState. The
 * decision itself is pure (`mergedAppearanceFor`), and rendering the panel against a two-appearance
 * merge target must terminate without looping (the old guarded render-time write was one `mergeKey`
 * recomputation away from the UsagePage loop).
 */
const mockState = vi.hoisted(() => ({ themes: [] as ThemeDefinition[] }));

vi.mock("~/themePalette", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/themePalette")>();
  return {
    ...actual,
    getCustomThemes: () => mockState.themes,
  };
});

import { clampPanelPosition, mergedAppearanceFor, ThemeEditorPanel } from "./ThemeEditorPanel";

beforeEach(() => {
  vi.stubGlobal("window", {
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps the expanded editor's scroll area and footer inside a short window", () => {
  expect(clampPanelPosition({ width: 640, height: 480 }, 600, 460, 416, false)).toEqual({ x: 216, y: 252 });
  expect(clampPanelPosition({ width: 640, height: 480 }, 600, 460, 416, true)).toEqual({ x: 216, y: 424 });
});

function aurora(twoAppearances: boolean): ThemeDefinition {
  return {
    id: "aurora",
    label: "Aurora",
    appearance: "light",
    colors: { ...getStandardThemeColors("light") },
    ...(twoAppearances ? { variants: { dark: { ...getStandardThemeColors("dark") } } } : {}),
    managed: true,
  } as ThemeDefinition;
}

function renderPanel(theme: ThemeDefinition, initialAppearance: "light" | "dark" = "light") {
  mockState.themes = [theme];
  return renderToStaticMarkup(
    <ThemeEditorPanel
      open={true}
      onOpenChange={() => {}}
      onSaved={() => true}
      editingTheme={null}
      initialAppearance={initialAppearance}
      seedName="Aurora"
      restoreTheme={() => {}}
    />,
  );
}

/** The `<button>` element for a named appearance toggle, so assertions stay independent of Base UI's class list. */
function toggleButton(html: string, label: "Light" | "Dark"): string {
  const end = html.indexOf(`>${label}</button>`);
  const start = html.lastIndexOf("<button", end);
  return html.slice(start, end);
}

describe("mergedAppearanceFor", () => {
  it("keeps the active appearance for a two-appearance merge target", () => {
    expect(mergedAppearanceFor(["light", "dark"], "light")).toBeNull();
    expect(mergedAppearanceFor(["light", "dark"], "dark")).toBeNull();
  });

  it("switches to the free appearance for a single-appearance merge target", () => {
    expect(mergedAppearanceFor(["light"], "light")).toBe("dark");
    expect(mergedAppearanceFor(["dark"], "dark")).toBe("light");
    expect(mergedAppearanceFor(["light"], "dark")).toBeNull();
  });
});

describe("ThemeEditorPanel merge target", () => {
  it("renders a two-appearance merge target without a render loop and locks both modes", () => {
    const html = renderPanel(aurora(true));
    expect(html).toContain('data-theme-editor-panel=""');
    // Both palettes are already taken, so neither appearance can be selected.
    expect(toggleButton(html, "Light")).toContain('aria-disabled="true"');
    expect(toggleButton(html, "Dark")).toContain('aria-disabled="true"');
  });

  it("does not switch appearance during render for a single-appearance merge target", () => {
    const html = renderPanel(aurora(false));
    expect(html).toContain('data-theme-editor-panel=""');
    // The switch now happens in an effect, so the first render still shows the seeded appearance.
    // (Before the fix, a render-phase setState flipped this to "dark" during server rendering.)
    expect(toggleButton(html, "Light")).toContain('aria-pressed="true"');
    expect(toggleButton(html, "Dark")).toContain('aria-pressed="false"');
  });
});
