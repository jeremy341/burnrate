import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("../../../appearance.css", import.meta.url)),
  "utf8",
);

describe("appearance.css accessibility extras", () => {
  // Density, UI scale and the corner-radius setting are removed: the app uses T3's
  // fixed --spacing / --radius tokens. Their saved keys are tolerated but ignored
  // by applyAppearance (see src/appearance.test.ts), so no CSS contract is needed.

  it("implements the reduce-motion attribute and the OS preference", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(/html\[data-reduce-motion="on"\]/);
    expect(css).toMatch(/html\[data-reduce-motion="reduce"\]/);
    expect(css).toMatch(/data-reduce-motion="off"/);
    expect(css).toContain("animation-duration: 0.01ms !important");
    expect(css).toContain("transition-duration: 0.01ms !important");
  });

  it("implements high contrast with theme tokens, not hard-coded palette values", () => {
    expect(css).toMatch(/html\[data-high-contrast="true"\]/);
    expect(css).toContain("@media (prefers-contrast: more)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("color-mix(in oklab, var(--foreground)");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
