import { describe, expect, it } from "vitest";

import type { Provenance, UsageWindow } from "~/contracts";
import {
  barValue,
  collectLimitPools,
  isLimitStale,
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
  paceOf,
  projectedEmpty,
  remainingPercent,
} from "./usageLimits";
import {
  barValueText,
  formatMoney,
  formatTimeToEmpty,
  provenanceDescription,
  provenanceShortLabel,
} from "./usageLimitsCopy";

const NOW = 1_000_000;

function window(usedPercent: number, extra: Partial<UsageWindow> = {}): UsageWindow {
  return { id: "w", kind: "session", label: "Session", usedPercent, ...extra };
}

describe("barValue (usage.barMode)", () => {
  it("defaults to remaining and switches to used", () => {
    const w = window(30);
    expect(barValue(w, "remaining")).toBe(70);
    expect(barValue(w, "used")).toBe(30);
  });

  it("clamps out-of-range percentages", () => {
    expect(barValue(window(-5), "used")).toBe(0);
    expect(barValue(window(150), "used")).toBe(100);
    expect(barValue(window(150), "remaining")).toBe(0);
  });
});

describe("projectedEmpty (time to empty)", () => {
  // 30 minutes left of a 60-minute window, so 30 minutes have elapsed.
  const clock = {
    resetsAt: new Date(NOW + 30 * 60_000).toISOString(),
    windowDurationMins: 60,
  };

  it("projects exhaustion only when it lands before the reset", () => {
    const highBurn = projectedEmpty(window(75, clock), NOW);
    expect(highBurn).not.toBeNull();
    expect(highBurn!.ms).toBeCloseTo(600_000);
    expect(highBurn!.at).toBeLessThan(Date.parse(clock.resetsAt));

    // At this burn rate the window would only be empty after it resets.
    expect(projectedEmpty(window(25, clock), NOW)).toBeNull();
    // Exactly on the reset is not "before the reset".
    expect(projectedEmpty(window(50, clock), NOW)).toBeNull();
  });

  it("returns null without a usable clock or burn rate", () => {
    expect(projectedEmpty(window(50), NOW)).toBeNull();
    expect(projectedEmpty(window(50, { windowDurationMins: 60 }), NOW)).toBeNull();
    expect(projectedEmpty(window(50, { resetsAt: clock.resetsAt }), NOW)).toBeNull();
    expect(projectedEmpty(window(0, clock), NOW)).toBeNull();
    expect(projectedEmpty(window(100, clock), NOW)).toBeNull();
  });
});

describe("isLimitStale", () => {
  it("uses three refresh intervals with a 30s floor", () => {
    const oneMinuteAgo = new Date(NOW - 60_000).toISOString();
    const twoMinutesAgo = new Date(NOW - 120_000).toISOString();
    expect(isLimitStale(oneMinuteAgo, NOW, 30)).toBe(false);
    expect(isLimitStale(twoMinutesAgo, NOW, 30)).toBe(true);
    expect(isLimitStale(twoMinutesAgo, NOW, 600)).toBe(false);
  });

  it("does not flag a missing or invalid clock", () => {
    expect(isLimitStale(undefined, NOW, 30)).toBe(false);
    expect(isLimitStale("not a date", NOW, 30)).toBe(false);
  });
});

describe("provenance copy", () => {
  const all: Provenance[] = ["official", "unofficial", "statusline", "local", "estimated"];

  it("has a short label and a full description for every source", () => {
    const labels = new Set(all.map((p) => provenanceShortLabel(p)));
    expect(labels.size).toBe(all.length);
    for (const p of all) {
      expect(provenanceShortLabel(p).length).toBeGreaterThan(0);
      expect(provenanceDescription(p).length).toBeGreaterThan(provenanceShortLabel(p).length);
    }
  });
});

describe("copy formatting", () => {
  it("reads a meter value in remaining or used terms", () => {
    expect(barValueText(70, "remaining")).toBe("70% left");
    expect(barValueText(30, "used")).toBe("30% used");
  });

  it("formats money and falls back for unknown currencies", () => {
    expect(formatMoney(12.34, "USD")).toBe("$12.34");
    expect(formatMoney(12.34, "NOPE")).toBe("NOPE 12.34");
  });

  it("formats a projected empty time as a duration", () => {
    expect(formatTimeToEmpty({ at: NOW + 2 * 3_600_000, ms: 2 * 3_600_000 }, NOW)).toBe(
      "empty in 2h 0m",
    );
  });
});

describe("pooled session keeps its own figures and notes a tighter weekly limit", () => {
  const resets = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
  /** A Claude account as the usage probe reports it: a 5-hour session window and a weekly window. */
  const claude = (
    key: string,
    session: number,
    weekly: number,
    { weeklyResetMin = 5_000 }: { readonly weeklyResetMin?: number } = {},
  ): LimitAccount =>
    ({
      key,
      driver: "claudeAgent",
      displayName: key,
      limits: {
        checkedAt: new Date(NOW).toISOString(),
        windows: [
          { id: "five_hour", kind: "session", label: "Session", usedPercent: session, resetsAt: resets(180), windowDurationMins: 300 },
          { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: weekly, resetsAt: resets(weeklyResetMin), windowDurationMins: 10_080 },
        ],
      },
    }) as unknown as LimitAccount;
  const slot = (pool: LimitPool, kind: "session" | "weekly") =>
    pool.windows.find((window) => window.kind === kind)!;
  const member = (window: LimitPoolWindow, key: string) =>
    window.members.find((entry) => entry.account.key === key)!;

  it("shows each session's own figures and notes a tighter week beside it", () => {
    // Jerry: 69% of the session left but only 1% of the week. Kernel: 3% session left, 42% weekly left.
    const pools = collectLimitPools(
      [claude("Jerry", 31, 99, { weeklyResetMin: 5_000 }), claude("Kernel", 97, 58, { weeklyResetMin: 8_000 })],
      NOW,
    );
    const session = slot(pools[0]!, "session");
    expect(remainingPercent(member(session, "Jerry").window)).toBe(69);
    expect(member(session, "Jerry").limitedByWeeklyLeft).toBe(1);
    // Kernel's session (3% left) is already tighter than its week (42% left): nothing to note.
    expect(remainingPercent(member(session, "Kernel").window)).toBe(3);
    expect(member(session, "Kernel").limitedByWeeklyLeft).toBeUndefined();
    // The headline is the mean of the real session figures: (69 + 3) / 2 = 36% left.
    expect(session.remainingPercent).toBe(36);
  });

  it("keeps the session's own reset, and sends the recovery to the weekly reset", () => {
    const [pool] = collectLimitPools([claude("Jerry", 31, 99)], NOW);
    const session = slot(pool!, "session");
    const jerry = member(session, "Jerry");
    expect(jerry.window.resetsAt).toBe(resets(180));
    expect(jerry.window.windowDurationMins).toBe(300);
    // Usable quota only comes back when the week resets, so that is when the 31% restores.
    expect(jerry.restoresAt).toBe(resets(5_000));
    expect(session.resets).toEqual([
      expect.objectContaining({ at: Date.parse(resets(5_000)), restoresPercent: 31 }),
    ]);
  });

  it("reads a session at 0% used with the week at 58% used as 100% left, noting the week's 42%", () => {
    const [pool] = collectLimitPools([claude("Kernel", 0, 58)], NOW);
    const session = slot(pool!, "session");
    expect(remainingPercent(member(session, "Kernel").window)).toBe(100);
    expect(session.remainingPercent).toBe(100);
    expect(member(session, "Kernel").limitedByWeeklyLeft).toBe(42);
    // The weekly figures stay as reported.
    expect(slot(pool!, "weekly").remainingPercent).toBe(42);
  });

  it("reads a session at 40% used with the week spent as 60% left, with a 0% cap note", () => {
    const [pool] = collectLimitPools([claude("Jerry", 40, 100)], NOW);
    const session = slot(pool!, "session");
    expect(remainingPercent(member(session, "Jerry").window)).toBe(60);
    expect(session.remainingPercent).toBe(60);
    expect(member(session, "Jerry").limitedByWeeklyLeft).toBe(0);
    expect(slot(pool!, "weekly").remainingPercent).toBe(0);
    // Nothing is usable until the week resets, which lands after the session's own reset.
    expect(member(session, "Jerry").restoresAt).toBe(resets(5_000));
  });

  it("pairs the two cases: Session reads Kernel 100% and Jerry 60% left, Weekly stays 42% and 0%", () => {
    const [pool] = collectLimitPools([claude("Kernel", 0, 58), claude("Jerry", 40, 100)], NOW);
    const session = slot(pool!, "session");
    const weekly = slot(pool!, "weekly");
    expect(remainingPercent(member(session, "Kernel").window)).toBe(100);
    expect(remainingPercent(member(session, "Jerry").window)).toBe(60);
    // The headline is the mean of the real session figures, not of the caps: (0 + 40) / 2 used.
    expect(session.remainingPercent).toBe(80);
    expect(remainingPercent(member(weekly, "Kernel").window)).toBe(42);
    expect(remainingPercent(member(weekly, "Jerry").window)).toBe(0);
    expect(member(weekly, "Jerry").limitedByWeeklyLeft).toBeUndefined();
    expect(weekly.remainingPercent).toBe(21);
  });

  it("paces the session on its own clock even while the week caps it", () => {
    // 40% of the 5-hour window has passed and 40% is used: on pace, however the week stands.
    const [pool] = collectLimitPools([claude("Jerry", 40, 100)], NOW);
    const session = slot(pool!, "session");
    expect(member(session, "Jerry").window.windowDurationMins).toBe(300);
    expect(paceOf(member(session, "Jerry").window, NOW)).toBe("on");
    expect(session.pace).toBe("on");
  });
});
