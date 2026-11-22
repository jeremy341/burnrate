import { describe, expect, it } from "vitest";

import { getInstalledFontsState, normalizeFontFamilies, startInstalledFontsLoad } from "./installedFonts";

describe("normalizeFontFamilies", () => {
  it("trims, drops empties, dedupes case-insensitively keeping the first spelling, and sorts", () => {
    expect(
      normalizeFontFamilies(["Consolas", "arial", " Arial ", "", "Cascadia Code", "ARIAL", "  "]),
    ).toEqual(["arial", "Cascadia Code", "Consolas"]);
  });

  it("falls back to exact comparison for families that differ only by case beyond the key", () => {
    expect(normalizeFontFamilies(["B", "a"])).toEqual(["a", "B"]);
  });
});

describe("startInstalledFontsLoad", () => {
  it("marks enumeration unavailable outside the browser (no queryLocalFonts)", async () => {
    startInstalledFontsLoad();
    // Let the query promise chain settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getInstalledFontsState().status).toBe("unavailable");
    expect(getInstalledFontsState().families).toEqual([]);
  });
});
