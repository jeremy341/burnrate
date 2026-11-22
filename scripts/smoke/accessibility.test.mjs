import { describe, expect, it } from "vitest";

import {
  A11Y_AUDIT_EXPRESSION,
  THRESHOLDS,
  blockingFindings,
  composite,
  contrastRatio,
  relativeLuminance,
} from "./accessibility.mjs";

describe("WCAG contrast maths", () => {
  it("matches the reference values", () => {
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 3);
    expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 1);
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBe(1);
  });

  it("composites translucent borders over their backdrop, so an invisible dark divider is caught", () => {
    const backdrop = [20, 20, 22];
    const hairline = composite([255, 255, 255, 0.02], backdrop);
    expect(contrastRatio(hairline, backdrop)).toBeLessThan(THRESHOLDS.divider);
    const visible = composite([255, 255, 255, 0.1], backdrop);
    expect(contrastRatio(visible, backdrop)).toBeGreaterThanOrEqual(THRESHOLDS.divider);
  });
});

describe("page audit expression", () => {
  it("is a syntactically valid, self-contained expression", () => {
    expect(() => new Function(`return ${A11Y_AUDIT_EXPRESSION}`)).not.toThrow();
  });

  it("covers the rules the app commits to", () => {
    for (const rule of ["accessible-name", "color-contrast", "divider-contrast", "target-size", "html-lang", "tabindex", "landmark-one-main"]) {
      expect(A11Y_AUDIT_EXPRESSION).toContain(`'${rule}'`);
    }
  });
});

describe("blockingFindings", () => {
  it("fails only critical and serious findings", () => {
    const report = {
      findings: [
        { severity: "critical" },
        { severity: "serious" },
        { severity: "moderate" },
        { severity: "minor" },
      ],
    };
    expect(blockingFindings(report)).toHaveLength(2);
  });
});
