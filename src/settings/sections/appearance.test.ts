import { describe, expect, it } from "vitest";

import { keywords, section } from "./appearance";

describe("appearance settings section", () => {
  it("registers with the ordered settings registry", () => {
    expect(section.id).toBe("appearance");
    expect(section.title).toBe("Appearance");
    expect(section.order).toBe(20);
    expect(typeof section.Component).toBe("function");
  });

  it("indexes the appearance, theme and typography terms for search", () => {
    expect(keywords).toContain("theme");
    expect(keywords).toContain("typography");
    expect(keywords).toContain("monospace");
  });

  it("does not index the removed corner-radius and density settings", () => {
    for (const removed of ["radius", "corners", "density", "spacing", "ui scale", "zoom"]) {
      expect(keywords).not.toContain(removed);
    }
  });
});
