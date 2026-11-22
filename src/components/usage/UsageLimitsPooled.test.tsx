import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LimitsAccount } from "~/contracts";
import { collectLimitPools, toLimitAccounts } from "~/shared/usageLimits";
import { ProviderDetail } from "./UsageLimitsCollapse";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const NOW = Date.parse("2026-11-21T10:00:00.000Z");

function account(id: string, limits: Partial<LimitsAccount["limits"]>, displayName?: string): LimitsAccount {
  return {
    id,
    driver: "claude",
    label: `Account ${id}`,
    ...(displayName ? { displayName } : {}),
    limits: { checkedAt: "2026-11-21T09:59:00.000Z", windows: [], ...limits },
  } as LimitsAccount;
}

describe("UsageLimitsPooled honest states", () => {
  it("names an account whose limits could not be read instead of showing a generic empty state", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitsPooled
        accounts={[account("a", { unavailable: { reason: "probeFailed" } })]}
        notices={[]}
        now={NOW}
      />,
    );
    expect(markup).toContain("Account a");
    expect(markup).toContain("Could not read limits.");
    expect(markup).not.toContain("data-slot=\"limits-empty\"");
  });

  it("says when an account has no subscription limits", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitsPooled
        accounts={[account("b", { unavailable: { reason: "unsupported" } })]}
        notices={[]}
        now={NOW}
      />,
    );
    expect(markup).toContain("This account has no subscription limits.");
  });

  it("marks only the cached member and describes the unchanged pool value", () => {
    const session = { id: "session", kind: "session", label: "Session" } as const;
    const markup = renderToStaticMarkup(
      <UsageLimitsPooled
        accounts={[
          account("Kernel", {
            stale: true,
            staleSince: "2026-11-21T09:52:00.000Z",
            staleMessage: "Showing values from 8 minutes ago",
            staleReason: "Claude is limiting usage checks right now.",
            windows: [{ ...session, usedPercent: 80 }],
          }, "Kernel"),
          account("Jerry", { windows: [{ ...session, usedPercent: 20 }] }, "Jerry"),
        ]}
        notices={[]}
        now={NOW}
      />,
    );

    expect(markup).toContain('aria-label="Kernel: 20% left, Showing values from 8 minutes ago. Claude is limiting usage checks right now."');
    expect(markup).toContain('aria-label="Jerry: 80% left"');
    expect(markup).toContain('aria-valuenow="20"');
    expect(markup.match(/data-stale-member="true"/g)).toHaveLength(1);
    expect(markup).toContain("8m old");
    expect(markup).toMatch(/aria-describedby="([^"]+)"><span[^>]*>50%<.*?id="\1"[^>]*>.*?Includes old data/);
  });

  it("keeps a stale account's last known 0% visible instead of dropping it", () => {
    const session = { id: "session", kind: "session", label: "Session" } as const;
    const markup = renderToStaticMarkup(
      <UsageLimitsPooled
        accounts={[
          account("Kernel", {
            stale: true,
            staleSince: "2026-11-21T09:52:00.000Z",
            staleMessage: "Showing values from 8 minutes ago",
            staleReason: "Claude is limiting usage checks right now.",
            windows: [{ ...session, usedPercent: 100 }],
          }, "Kernel"),
        ]}
        notices={[]}
        now={NOW}
      />,
    );

    // The exhausted account stays on screen at 0% left, marked with its age rather than hidden.
    expect(markup).toContain('aria-label="Kernel: 0% left, Showing values from 8 minutes ago. Claude is limiting usage checks right now."');
    expect(markup).toContain("0%");
    expect(markup).toContain("8m old");
    expect(markup).toContain("Limits unavailable");
  });

  it("announces a stale member in the collapsed provider detail using its recorded age", () => {
    const session = { id: "session", kind: "session", label: "Session" } as const;
    const [pool] = collectLimitPools(toLimitAccounts([
      account("old", {
        checkedAt: "2026-11-21T09:52:00.000Z",
        windows: [{ ...session, usedPercent: 80 }],
      }, "Kernel"),
      account("fresh", { windows: [{ ...session, usedPercent: 20 }] }, "Jerry"),
    ]), NOW);
    const markup = renderToStaticMarkup(<ProviderDetail pool={pool!} label="Claude" now={NOW} />);

    expect(markup).toMatch(/role="meter" aria-label="Kernel"[^>]*aria-valuetext="20% left, Showing values from 8 minutes ago"/);
    expect(markup).toMatch(/role="meter" aria-label="Jerry"[^>]*aria-valuetext="80% left"/);
    expect(markup.match(/data-stale-member="true"/g)).toHaveLength(1);
    expect(markup).toContain("Includes old data");
  });

  it("leaves a pool of fresh members unmarked", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitsPooled
        accounts={[account("Jerry", { windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 20 }] })]}
        notices={[]}
        now={NOW}
      />,
    );

    expect(markup).not.toContain("Includes old data");
    expect(markup).not.toContain("data-stale-member");
  });
});

describe("UsageLimitsPooled weekly cap", () => {
  const SESSION_RESET = "2026-11-21T13:00:00.000Z"; // 3 hours on, of a 5-hour window
  const WEEK_RESET = "2026-11-25T10:00:00.000Z";

  /** A Claude account as the usage probe reports it: a 5-hour session window and a weekly window. */
  function claudeAccount(name: string, session: number, weekly: number): LimitsAccount {
    return {
      id: name,
      driver: "claudeAgent",
      label: `Account ${name}`,
      displayName: name,
      limits: {
        checkedAt: "2026-11-21T09:59:00.000Z",
        windows: [
          { id: "five_hour", kind: "session", label: "Session", usedPercent: session, resetsAt: SESSION_RESET, windowDurationMins: 300 },
          { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: weekly, resetsAt: WEEK_RESET, windowDurationMins: 10_080 },
        ],
      },
    } as LimitsAccount;
  }

  it("shows each session's own figure and the weekly card as reported", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitsPooled
        accounts={[claudeAccount("Kernel", 0, 58), claudeAccount("Jerry", 40, 100)]}
        notices={[]}
        now={NOW}
      />,
    );

    // Session meters: the 5-hour figure.
    expect(markup).toMatch(/aria-label="Kernel: Session"[^>]*aria-valuenow="100"[^>]*aria-valuetext="Kernel: 100% left/);
    expect(markup).toMatch(/aria-label="Jerry: Session"[^>]*aria-valuenow="60"[^>]*aria-valuetext="Jerry: 60% left/);
    // Weekly meters: exactly what the week reports.
    expect(markup).toMatch(/aria-label="Kernel: Weekly"[^>]*aria-valuenow="42"[^>]*aria-valuetext="Kernel: 42% left/);
    expect(markup).toMatch(/aria-label="Jerry: Weekly"[^>]*aria-valuenow="0"[^>]*aria-valuetext="Jerry: 0% left/);
    // No cap note is rendered anywhere.
    expect(markup).not.toContain("Capped by weekly limit");
    expect(markup).not.toContain('data-slot="limits-cap-note"');
  });

  it("takes the session headline from the real session figures, and the weekly headline from the week", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitsPooled
        accounts={[claudeAccount("Kernel", 0, 58), claudeAccount("Jerry", 40, 100)]}
        notices={[]}
        now={NOW}
      />,
    );
    const sessionCard = markup.slice(markup.indexOf(">Session</span>"), markup.indexOf(">Weekly</span>"));
    const weeklyCard = markup.slice(markup.indexOf(">Weekly</span>"));
    expect(sessionCard).toContain(">80%</span>");
    expect(weeklyCard).toContain(">21%</span>");
  });

  it("shows a lone account's session without a cap note", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitsPooled accounts={[claudeAccount("Jerry", 40, 100)]} notices={[]} now={NOW} />,
    );
    expect(markup).toContain('aria-valuetext="Jerry: 60% left');
    expect(markup).not.toContain("Capped by weekly limit");
  });

  it("adds no cap note when the week is looser than the session", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitsPooled accounts={[claudeAccount("Jerry", 20, 10)]} notices={[]} now={NOW} />,
    );
    expect(markup).not.toContain('data-slot="limits-cap-note"');
    expect(markup).not.toContain("Capped by weekly limit");
  });
});
