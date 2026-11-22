import { describe, expect, it } from "vitest";

import { previewColorsOf, STANDARD_THEME_CARDS } from "./ThemePreviewCircles";
import {
  activeThemeModes,
  themeActivationModes,
  themeCardUseTarget,
  themeHalfOwners,
  visibleBuiltinThemes,
} from "./ThemeSettings";

describe("themeHalfOwners", () => {
  it("keeps the stock palette (null) distinct from a theme id", () => {
    expect(themeHalfOwners({ lightThemeId: null, darkThemeId: "burnrate-dark" })).toEqual({
      light: null,
      dark: "burnrate-dark",
    });
    expect(themeHalfOwners({ lightThemeId: "ocean", darkThemeId: "ocean" })).toEqual({
      light: "ocean",
      dark: "ocean",
    });
  });

  it("treats a missing half (cleared by the local merge) as the stock palette", () => {
    expect(themeHalfOwners({})).toEqual({ light: null, dark: null });
    expect(themeHalfOwners({ lightThemeId: undefined, darkThemeId: "ember" })).toEqual({
      light: null,
      dark: "ember",
    });
  });
});

describe("activeThemeModes", () => {
  const owners = { light: "ocean", dark: "ember" } as const;

  it("reports only the halves that own the theme", () => {
    expect(activeThemeModes("ocean", owners)).toEqual(["light"]);
    expect(activeThemeModes("ember", owners)).toEqual(["dark"]);
    expect(activeThemeModes("grove", owners)).toEqual([]);
  });

  it("rings both modes for a theme used by both halves", () => {
    expect(activeThemeModes("ocean", { light: "ocean", dark: "ocean" })).toEqual([
      "light",
      "dark",
    ]);
  });

  it("treats the stock card (null) as owning every half set to the stock palette", () => {
    expect(activeThemeModes(null, { light: null, dark: null })).toEqual(["light", "dark"]);
    expect(activeThemeModes(null, { light: null, dark: "ember" })).toEqual(["light"]);
    expect(activeThemeModes(null, owners)).toEqual([]);
  });
});

describe("themeActivationModes", () => {
  it("applies two-appearance themes to both halves", () => {
    expect(themeActivationModes(["light", "dark"])).toBe("both");
  });

  it("applies single-appearance themes only to their own half", () => {
    expect(themeActivationModes(["light"])).toBe("light");
    expect(themeActivationModes(["dark"])).toBe("dark");
  });

  it("does nothing for a theme without colors", () => {
    expect(themeActivationModes([])).toBeNull();
  });

  it("does not depend on the order of the modes", () => {
    expect(themeActivationModes(["dark", "light"])).toBe("both");
  });
});

describe("themeCardUseTarget", () => {
  it("describes a two-mode card as applying to both halves", () => {
    expect(themeCardUseTarget(["light", "dark"])).toBe("both");
    expect(themeCardUseTarget(["dark", "light"])).toBe("both");
  });

  it("describes a single-mode card by its only mode", () => {
    expect(themeCardUseTarget(["light"])).toBe("light");
    expect(themeCardUseTarget(["dark"])).toBe("dark");
  });

  it("has no hint for a card with no colors", () => {
    expect(themeCardUseTarget([])).toBe("none");
  });
});

describe("theme preview tiles", () => {
  it("the stock card paints both light and dark", () => {
    const card = STANDARD_THEME_CARDS[0]!;
    expect(card.previews.map((preview) => preview.mode)).toEqual(["light", "dark"]);
    expect(previewColorsOf(card, "light")?.surface).toBe("#ffffff");
    expect(previewColorsOf(card, "dark")?.surface).toBe("#121212");
  });
});

describe("visibleBuiltinThemes", () => {
  const themes = [
    { id: "burnrate-dark", label: "edge of night" },
    { id: "burnrate-light", label: "Burnrate Light" },
    { id: "ocean", label: "Ocean" },
  ] as never as Parameters<typeof visibleBuiltinThemes>[0];
  const ids = (list: ReturnType<typeof visibleBuiltinThemes>) => list.map((theme) => theme.id);

  it("hides Burnrate Light, which duplicates the default card's light half", () => {
    expect(ids(visibleBuiltinThemes(themes, { light: null, dark: "burnrate-dark" }))).toEqual([
      "burnrate-dark",
      "ocean",
    ]);
  });

  it("keeps it when someone already pinned it, so the active card never vanishes", () => {
    expect(ids(visibleBuiltinThemes(themes, { light: "burnrate-light", dark: null }))).toContain(
      "burnrate-light",
    );
    expect(ids(visibleBuiltinThemes(themes, { light: null, dark: "burnrate-light" }))).toContain(
      "burnrate-light",
    );
  });
});
