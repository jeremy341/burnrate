import { describe, expect, it } from "vitest";

import { paceState, projectedExhaustion, type PaceWindow } from "./pace";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;

/** A 60-minute window started 30 minutes ago, resetting in 30 minutes. */
function halfWindow(usedPercent: number, extra: Partial<PaceWindow> = {}): PaceWindow {
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: new Date(NOW + 30 * MIN).toISOString(),
    windowMinutes: 60,
    ...extra,
  };
}

describe("projectedExhaustion", () => {
  it("returns null without a reset or a window length", () => {
    expect(projectedExhaustion({ usedPercent: 50 }, NOW)).toBeNull();
    expect(projectedExhaustion({ usedPercent: 50, resetsAt: new Date(NOW + MIN).toISOString() }, NOW)).toBeNull();
    expect(projectedExhaustion({ usedPercent: 50, windowMinutes: 60 }, NOW)).toBeNull();
  });

  it("returns null for an empty, full or not-yet-started window", () => {
    expect(projectedExhaustion(halfWindow(0), NOW)).toBeNull();
    expect(projectedExhaustion(halfWindow(100), NOW)).toBeNull();
    expect(projectedExhaustion({ usedPercent: 50, resetsAt: new Date(NOW + 60 * MIN).toISOString(), windowMinutes: 10 }, NOW)).toBeNull();
  });

  it("projects linearly from the window start", () => {
    // 50% used after 30 of 60 minutes -> exactly on pace, exhausts at the reset.
    expect(projectedExhaustion(halfWindow(50), NOW)).toBe(NOW + 30 * MIN);
    // 25% used after 30 minutes -> exhausts 90 minutes from now.
    expect(projectedExhaustion(halfWindow(25), NOW)).toBe(NOW + 90 * MIN);
    // 60% used after 30 minutes -> exhausts 20 minutes from now (before the reset).
    expect(projectedExhaustion(halfWindow(60), NOW)).toBe(NOW + 20 * MIN);
  });

  it("ignores invalid timestamps and non-finite numbers", () => {
    expect(projectedExhaustion({ usedPercent: 50, resetsAt: "not-a-date", windowMinutes: 60 }, NOW)).toBeNull();
    expect(projectedExhaustion(halfWindow(Number.NaN), NOW)).toBeNull();
    expect(projectedExhaustion(halfWindow(50, { windowMinutes: Number.POSITIVE_INFINITY }), NOW)).toBeNull();
  });
});

describe("paceState", () => {
  it("is critical at or below 10% remaining", () => {
    expect(paceState({ usedPercent: 90 }, NOW)).toBe("critical");
    expect(paceState({ usedPercent: 95, remainingPercent: 5 }, NOW)).toBe("critical");
    expect(paceState({ usedPercent: 90, remainingPercent: 10 }, NOW)).toBe("critical");
  });

  it("is critical when the window is projected to run out before its reset", () => {
    // 60% used in half the window -> exhausts before the 30-minute reset.
    expect(paceState(halfWindow(60), NOW)).toBe("critical");
  });

  it("is not critical when the projection lands at or after the reset", () => {
    expect(paceState(halfWindow(50), NOW)).toBe("ok");
    expect(paceState(halfWindow(25), NOW)).toBe("ok");
  });

  it("is warn at or below 25% remaining without a projection", () => {
    expect(paceState({ usedPercent: 75 }, NOW)).toBe("warn");
    expect(paceState({ usedPercent: 80, remainingPercent: 20 }, NOW)).toBe("warn");
    expect(paceState({ usedPercent: 75, remainingPercent: 25 }, NOW)).toBe("warn");
  });

  it("is warn when paceDelta is at or above 15", () => {
    expect(paceState({ usedPercent: 50, remainingPercent: 50, paceDelta: 15 }, NOW)).toBe("warn");
    expect(paceState({ usedPercent: 50, remainingPercent: 50, paceDelta: 30 }, NOW)).toBe("warn");
    expect(paceState({ usedPercent: 50, remainingPercent: 50, paceDelta: 14 }, NOW)).toBe("ok");
  });

  it("computes paceDelta from the window when the server omits it", () => {
    // 40% used after 50% of the window has elapsed -> 10 points behind pace.
    const window: PaceWindow = {
      usedPercent: 40,
      remainingPercent: 60,
      resetsAt: new Date(NOW + 5 * MIN).toISOString(),
      windowMinutes: 10,
    };
    expect(paceState(window, NOW)).toBe("ok");
    // 70% used after 50% elapsed -> 20 points ahead. With a valid projection
    // that also means exhaustion before the reset, so the critical rule wins.
    expect(paceState({ ...window, usedPercent: 70, remainingPercent: 30 }, NOW)).toBe("critical");
    // An explicit paceDelta >= 15 is warn even when exhaustion is after reset.
    expect(paceState({ ...window, paceDelta: 20 }, NOW)).toBe("warn");
  });

  it("is ok for healthy and unavailable windows", () => {
    expect(paceState({ usedPercent: 27, remainingPercent: 73 }, NOW)).toBe("ok");
    expect(paceState({ usedPercent: 0, remainingPercent: 100 }, NOW)).toBe("ok");
    expect(paceState(halfWindow(50, { resetsAt: "bad" }), NOW)).toBe("ok");
  });

  it("clamps out-of-range inputs", () => {
    expect(paceState({ usedPercent: 150 }, NOW)).toBe("critical");
    expect(paceState({ usedPercent: -10 }, NOW)).toBe("ok");
    expect(paceState({ usedPercent: Number.NaN }, NOW)).toBe("ok");
  });
});
