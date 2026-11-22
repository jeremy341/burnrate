import { describe, expect, it } from "vitest";

import {
  ACCENT_SWATCHES,
  PROVIDER_COLORS,
  normalizeAccentColor,
  providerFallbackColor,
  providerInitials,
} from "./presentation";

describe("normalizeAccentColor", () => {
  it("expands short hex and lowercases long hex", () => {
    expect(normalizeAccentColor("#AbC")).toBe("#aabbcc");
    expect(normalizeAccentColor("#6467F2")).toBe("#6467f2");
  });

  it("rejects anything that is not a hex colour", () => {
    expect(normalizeAccentColor("red")).toBeUndefined();
    expect(normalizeAccentColor("var(--foreground)")).toBeUndefined();
    expect(normalizeAccentColor("#12345")).toBeUndefined();
    expect(normalizeAccentColor(null)).toBeUndefined();
  });
});

describe("providerInitials", () => {
  it("uses the first letters of two words", () => {
    expect(providerInitials("Claude Code")).toBe("CC");
    expect(providerInitials("Z.ai")).toBe("ZA");
  });

  it("uses the first two letters of a single word", () => {
    expect(providerInitials("Mistral")).toBe("MI");
    expect(providerInitials("?")).toBe("?");
  });

  it("falls back for an empty label", () => {
    expect(providerInitials("   ")).toBe("?");
  });
});

describe("fallback colours", () => {
  it("covers the definitions added with the engine", () => {
    for (const id of ["openrouter", "deepseek", "moonshot", "xai", "groq", "together"]) {
      expect(providerFallbackColor(id)).toBe(PROVIDER_COLORS[id]);
    }
    expect(providerFallbackColor("unknown-provider")).toBeUndefined();
  });

  it("offers a usable swatch set", () => {
    expect(ACCENT_SWATCHES.length).toBeGreaterThanOrEqual(6);
    for (const colour of ACCENT_SWATCHES) expect(normalizeAccentColor(colour)).toBe(colour);
  });
});
