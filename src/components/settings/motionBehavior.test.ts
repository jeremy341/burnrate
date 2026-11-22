import { describe, expect, it } from "vitest";

import { resolveReducedMotion } from "~/appearance";
import { mFallback, useGT } from "~/i18n";

describe("motion preference", () => {
  it("uses the system preference only when the setting is system", () => {
    expect(resolveReducedMotion("system", true)).toBe(true);
    expect(resolveReducedMotion("system", false)).toBe(false);
    expect(resolveReducedMotion("on", false)).toBe(true);
    expect(resolveReducedMotion("off", true)).toBe(false);
  });

  it("returns the stable translation function", () => {
    expect(useGT()).toBe(mFallback);
    expect(useGT()).toBe(useGT());
  });
});
