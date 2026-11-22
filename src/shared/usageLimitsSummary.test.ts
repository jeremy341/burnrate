import { describe, expect, it } from "vitest";

import type { LimitsAccount, UsageLimits, UsageWindow } from "~/contracts";
import { collectLimitPools, toLimitAccounts } from "./usageLimits";
import {
  SUMMARY_MAX_CHIPS,
  shortWindowLabels,
  statusText,
  summarizePool,
  summaryAnnouncement,
  summaryReset,
  summaryTone,
  visibleChips,
  windowChipText,
} from "./usageLimitsSummary";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const MIN = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MIN).toISOString();

function win(
  id: string,
  kind: UsageWindow["kind"],
  label: string,
  used: number,
  extra: Partial<UsageWindow> = {},
): UsageWindow {
  return { id, kind, label, usedPercent: used, ...extra };
}

function account(id: string, driver: string, limits: Partial<UsageLimits>): LimitsAccount {
  return {
    id,
    driver,
    label: id,
    limits: { checkedAt: new Date(NOW).toISOString(), windows: [], ...limits },
  } as LimitsAccount;
}

function summarize(
  accounts: LimitsAccount[],
  barMode: "remaining" | "used" = "remaining",
  refreshIntervalSec = 60,
) {
  const [pool] = collectLimitPools(toLimitAccounts(accounts), NOW);
  return summarizePool(pool!, NOW, { barMode, refreshIntervalSec });
}

describe("summaryTone", () => {
  it("is critical at 10% or less, warning when ahead of pace, normal otherwise", () => {
    expect(summaryTone(10, null)).toBe("critical");
    expect(summaryTone(0, "under")).toBe("critical");
    expect(summaryTone(11, "ahead")).toBe("warning");
    expect(summaryTone(80, "on")).toBe("normal");
    expect(summaryTone(80, null)).toBe("normal");
  });
});

describe("shortWindowLabels", () => {
  it("drops a provider prefix", () => {
    expect(shortWindowLabels(["Go · Session", "Go · Weekly"])).toEqual(["Session", "Weekly"]);
  });
  it("keeps the full label when shortening would collide", () => {
    expect(shortWindowLabels(["A · Session", "B · Session"])).toEqual([
      "A · Session",
      "B · Session",
    ]);
  });
});

describe("summarizePool", () => {
  const claude = account("c1", "claudeAgent", {
    windows: [
      win("five_hour", "session", "Session", 30, { resetsAt: at(137), windowDurationMins: 300 }),
      win("seven_day", "weekly", "Weekly", 88, {
        resetsAt: at(60 * 24 * 2),
        windowDurationMins: 7 * 24 * 60,
      }),
    ],
  });

  it("lists every window with its own value and finds the tightest one", () => {
    const s = summarize([claude]);
    expect(s.status).toBe("ok");
    expect(s.windows.map((w) => [w.label, w.shown])).toEqual([
      // The session keeps its own 70% left; the week's 12% left is the tighter figure.
      ["Session", 70],
      ["Weekly", 12],
    ]);
    expect(s.worst).toBe(1);
  });

  it("shows used instead of left when the bar mode says so, but ranks by what is left", () => {
    const s = summarize([claude], "used");
    expect(s.windows.map((w) => w.shown)).toEqual([30, 88]);
    // The week has the least left (12%), so it is the tightest, whatever the bar shows.
    expect(s.worst).toBe(1);
    expect(windowChipText(s.windows[0]!, "used")).toBe("Session 30% used");
    expect(windowChipText(summarize([claude]).windows[0]!, "remaining")).toBe("Session 70% left");
  });

  it("puts the reset of the tightest window on the row", () => {
    const s = summarize([claude]);
    expect(summaryReset(s, NOW)).toBe("↻ 2d 0h");
  });

  it("marks no window as tightest when a lone window is healthy", () => {
    const s = summarize([account("x", "codex", { windows: [win("a", "session", "Session", 20)] })]);
    expect(s.worst).toBeNull();
    const hot = summarize([account("x", "codex", { windows: [win("a", "session", "Session", 95)] })]);
    expect(hot.worst).toBe(0);
    expect(hot.windows[0]!.tone).toBe("critical");
  });

  it("pools several accounts into one window", () => {
    const s = summarize([
      account("a", "claudeAgent", { windows: [win("five_hour", "session", "Session", 20)] }),
      account("b", "claudeAgent", { windows: [win("five_hour", "session", "Session", 60)] }),
    ]);
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0]!.shown).toBe(60);
    expect(s.accounts).toBe(2);
  });

  it("calls an old snapshot stale instead of showing it as current", () => {
    const old = account("c", "claudeAgent", {
      checkedAt: new Date(NOW - 60 * MIN).toISOString(),
      windows: [win("five_hour", "session", "Session", 30)],
    });
    const s = summarize([old]);
    expect(s.status).toBe("stale");
    expect(statusText(s)).toBe("Stale");
    expect(s.windows).toHaveLength(1);
  });

  it("keeps the last good windows and says so when a probe failed", () => {
    const failed = account("c", "claudeAgent", {
      windows: [win("five_hour", "session", "Session", 30)],
      unavailable: { reason: "probeFailed", message: "HTTP 429" },
    });
    const s = summarize([failed]);
    expect(s.status).toBe("stale");
    expect(s.windows).toHaveLength(1);
  });

  it("counts unreachable accounts when only some of several failed", () => {
    const s = summarize([
      account("a", "claudeAgent", { windows: [win("five_hour", "session", "Session", 20)] }),
      account("b", "claudeAgent", { windows: [], unavailable: { reason: "probeFailed" } }),
    ]);
    expect(statusText(s)).toBe("1 of 2 not reachable");
  });

  it("is honest when nothing is available, and never blank", () => {
    const down = summarize([
      account("c", "claudeAgent", {
        windows: [],
        unavailable: { reason: "probeFailed", message: "Could not read limits." },
      }),
    ]);
    expect(down.status).toBe("unavailable");
    expect(statusText(down)).toBe("Limits unavailable");
    expect(summaryAnnouncement(down, NOW, "remaining")).toBe(
      "Limits unavailable. Could not read limits.",
    );
    const none = summarize([account("c", "codex", { windows: [] })]);
    expect(none.status).toBe("empty");
    expect(statusText(none)).toBe("No limits reported");
  });

  it("is not empty when the provider only has balances", () => {
    const s = summarize([
      account("o", "openrouter", {
        windows: [],
        balances: [{ id: "credit", label: "Credit", kind: "credit", amount: 4, currency: "USD" }],
      }),
    ]);
    expect(s.status).toBe("ok");
    expect(s.balances).toEqual([{ key: "o:credit", label: "Credit", text: "$4.00" }]);
    expect(summaryAnnouncement(s, NOW, "remaining")).toBe("Credit $4.00");
  });

  it("describes the whole row in one sentence for a screen reader", () => {
    const s = summarize([claude]);
    expect(summaryAnnouncement(s, NOW, "remaining")).toBe(
      "Session 70% left, Weekly 12% left. Tightest: Weekly, resets in 2d 0h",
    );
  });
});

describe("visibleChips", () => {
  const many = (count: number, worst: number) =>
    summarize([
      account("g", "antigravity", {
        windows: Array.from({ length: count }, (_, index) =>
          win(`m${index}`, "other", `Model ${index}`, index === worst ? 95 : 10),
        ),
      }),
    ]);

  it("shows everything up to the limit", () => {
    expect(visibleChips(many(SUMMARY_MAX_CHIPS, 0))).toEqual({ shown: [0, 1, 2, 3], hidden: 0 });
  });

  it("folds the rest into a count but never hides the tightest window", () => {
    const s = many(8, 6);
    const { shown, hidden } = visibleChips(s);
    expect(shown).toHaveLength(SUMMARY_MAX_CHIPS);
    expect(shown).toContain(s.worst);
    expect(hidden).toBe(8 - SUMMARY_MAX_CHIPS);
  });
});
