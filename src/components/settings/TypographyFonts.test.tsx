import { describe, expect, it } from "vitest";

import {
  appearanceFontStack,
  applyAppearanceFontVariables,
  cssFontFamilies,
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  displayFontFamily,
  isFontFamilyAvailable,
} from "~/appearanceFonts";

function fakeRoot() {
  const properties = new Map<string, string>();
  const root = {
    style: {
      setProperty: (name: string, value: string) => {
        properties.set(name, value);
      },
      removeProperty: (name: string) => {
        properties.delete(name);
      },
    },
  } as unknown as HTMLElement;
  return { root, properties };
}

describe("appearanceFonts", () => {
  it("normalises and quotes family lists", () => {
    expect(cssFontFamilies("   ")).toBeNull();
    expect(cssFontFamilies("Inter")).toBe("Inter");
    expect(cssFontFamilies("Segoe UI, Menlo")).toBe('"Segoe UI", Menlo');
    expect(cssFontFamilies("'SF Mono', Menlo")).toBe("'SF Mono', Menlo");
  });

  it("appends the safe default stack after a custom family", () => {
    expect(appearanceFontStack(null, "sans-serif")).toBe("sans-serif");
    expect(appearanceFontStack("", "sans-serif")).toBe("sans-serif");
    expect(appearanceFontStack("Inter", "sans-serif")).toBe("Inter, sans-serif");
    expect(appearanceFontStack("Segoe UI", "sans-serif")).toBe('"Segoe UI", sans-serif');
  });

  it("writes and clears the runtime font variables", () => {
    const { root, properties } = fakeRoot();

    applyAppearanceFontVariables(root, { fontFamily: null, monoFontFamily: null });
    expect(properties.size).toBe(0);

    applyAppearanceFontVariables(root, {
      fontFamily: "Inter",
      monoFontFamily: "Cascadia Mono",
    });
    expect(properties.get("--font-sans")).toBe(`Inter, ${DEFAULT_SANS_FONT_STACK}`);
    expect(properties.get("--font-mono")).toBe(`"Cascadia Mono", ${DEFAULT_MONO_FONT_STACK}`);

    applyAppearanceFontVariables(root, { fontFamily: null, monoFontFamily: null });
    expect(properties.has("--font-sans")).toBe(false);
    expect(properties.has("--font-mono")).toBe(false);
  });

  it("recognises generic families and labels concrete ones", () => {
    expect(isFontFamilyAvailable("system-ui")).toBe(true);
    expect(isFontFamilyAvailable("monospace")).toBe(true);
    expect(isFontFamilyAvailable("")).toBe(false);
    expect(displayFontFamily("Menlo")).toBe("Menlo");
  });
});
