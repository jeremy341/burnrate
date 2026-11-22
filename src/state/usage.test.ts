import { describe, expect, it } from "vitest";

import {
  effectiveRefreshIntervalSec,
  LIMITS_AUTO_REFRESH_THROTTLE_MS,
  MIN_LIMITS_REFRESH_INTERVAL_SEC,
  MINUTE_MS,
  msUntilNextMinute,
  shouldRefreshLimits,
} from "./usage";
import { resolveLocale, SYSTEM_LOCALE } from "~/lib/locale";

describe("shouldRefreshLimits (5-minute throttle)", () => {
  const now = 1_000_000;

  it("allows the first automatic refresh", () => {
    expect(shouldRefreshLimits(null, now)).toBe(true);
  });

  it("blocks a refresh before the throttle window", () => {
    expect(shouldRefreshLimits(now - 1000, now)).toBe(false);
  });

  it("allows a refresh exactly at the throttle boundary", () => {
    expect(shouldRefreshLimits(now - LIMITS_AUTO_REFRESH_THROTTLE_MS, now)).toBe(true);
  });

  it("allows a refresh after the throttle window", () => {
    expect(shouldRefreshLimits(now - LIMITS_AUTO_REFRESH_THROTTLE_MS - 1, now)).toBe(true);
  });

  it("honours a custom throttle and tolerates clock skew / invalid input", () => {
    expect(shouldRefreshLimits(now - 5000, now, 10_000)).toBe(false);
    expect(shouldRefreshLimits(now + 5000, now)).toBe(false); // clock moved backwards: stay throttled
    expect(shouldRefreshLimits(Number.NaN, now)).toBe(true);
  });
});

describe("effectiveRefreshIntervalSec", () => {
  it("clamps to the 30 s server minimum", () => {
    expect(effectiveRefreshIntervalSec(0)).toBe(MIN_LIMITS_REFRESH_INTERVAL_SEC);
    expect(effectiveRefreshIntervalSec(-5)).toBe(MIN_LIMITS_REFRESH_INTERVAL_SEC);
    expect(effectiveRefreshIntervalSec(12)).toBe(MIN_LIMITS_REFRESH_INTERVAL_SEC);
  });

  it("keeps valid values and floors fractions", () => {
    expect(effectiveRefreshIntervalSec(300)).toBe(300);
    expect(effectiveRefreshIntervalSec(60.9)).toBe(60);
  });

  it("falls back to the minimum for non-finite input", () => {
    expect(effectiveRefreshIntervalSec(Number.NaN)).toBe(MIN_LIMITS_REFRESH_INTERVAL_SEC);
    expect(effectiveRefreshIntervalSec(Number.POSITIVE_INFINITY)).toBe(
      MIN_LIMITS_REFRESH_INTERVAL_SEC,
    );
  });
});

describe("msUntilNextMinute (ticker alignment)", () => {
  it("returns a full minute at an exact boundary", () => {
    expect(msUntilNextMinute(MINUTE_MS * 7)).toBe(MINUTE_MS);
  });

  it("returns the remaining time mid-minute", () => {
    expect(msUntilNextMinute(MINUTE_MS * 7 + 20_000)).toBe(MINUTE_MS - 20_000);
  });

  it("is always in (0, 60000]", () => {
    for (const now of [0, 1, 29_999, 30_000, 59_999, 60_001]) {
      const wait = msUntilNextMinute(now);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(MINUTE_MS);
    }
  });
});

describe("resolveLocale", () => {
  it("uses the browser locale for 'system' and empty values", () => {
    expect(resolveLocale(SYSTEM_LOCALE, "de-DE")).toBe("de-DE");
    expect(resolveLocale("", "fr-FR")).toBe("fr-FR");
    expect(resolveLocale(undefined, "es-ES")).toBe("es-ES");
  });

  it("uses an explicit BCP 47 tag", () => {
    expect(resolveLocale("en-GB", "de-DE")).toBe("en-GB");
    expect(resolveLocale("  ja-JP ", "de-DE")).toBe("ja-JP");
  });

  it("falls back to English when no locale is available", () => {
    expect(resolveLocale("system", "")).toBe("en");
  });
});
