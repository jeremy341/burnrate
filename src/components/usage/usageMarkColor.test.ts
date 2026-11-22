import { describe, expect, it } from "vitest";

import {
  contrastRatio,
  ensureContrast,
  markColors,
  markStyle,
  MARK_MIN_CONTRAST,
  MARK_SURFACE,
  parseHex,
} from "./usageMarkColor";

const rgb = (hex: string) => parseHex(hex)!;

describe("usageMarkColor", () => {
  it("parses 3 and 6 digit hex and rejects anything else", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("#d97757")).toEqual([217, 119, 87]);
    expect(parseHex("var(--foreground)")).toBeNull();
    expect(parseHex("oklch(0.6 0.1 20)")).toBeNull();
  });

  it("keeps a colour that already clears 3:1", () => {
    expect(ensureContrast("#d97757", MARK_SURFACE.dark)).toBe("#d97757");
    expect(ensureContrast("#2d6ae3", MARK_SURFACE.light)).toBe("#2d6ae3");
  });

  it("lifts a near-black provider colour on the dark surface until it is visible", () => {
    const lifted = ensureContrast("#111111", MARK_SURFACE.dark);
    expect(lifted).not.toBe("#111111");
    expect(contrastRatio(rgb(lifted), rgb(MARK_SURFACE.dark))).toBeGreaterThanOrEqual(MARK_MIN_CONTRAST);
  });

  it("darkens a pale colour on the light surface", () => {
    const darkened = ensureContrast("#e8e8a0", MARK_SURFACE.light);
    expect(contrastRatio(rgb(darkened), rgb(MARK_SURFACE.light))).toBeGreaterThanOrEqual(MARK_MIN_CONTRAST);
  });

  it("leaves non-hex colours (theme variables) untouched", () => {
    expect(ensureContrast("var(--foreground)", MARK_SURFACE.dark)).toBe("var(--foreground)");
  });

  it("returns a distinct, legible colour per theme and never changes a provider's identity in the other theme", () => {
    const codex = markColors("#111111");
    expect(codex.light).toBe("#111111");
    expect(codex.dark).not.toBe("#111111");
    expect(markStyle("#111111")).toMatchObject({
      "--usage-mark-light": "#111111",
      "--usage-mark-dark": codex.dark,
    });
  });
});
