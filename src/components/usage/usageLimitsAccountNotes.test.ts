import { describe, expect, it } from "vitest";

import type { LimitsAccount, UsageLimits } from "~/contracts";
import { accountLimitNotices, resetCreditLines } from "./usageLimitsAccountNotes";

const NOW = Date.parse("2026-11-21T10:00:00.000Z");

function limits(patch: Partial<UsageLimits> = {}): UsageLimits {
  return { checkedAt: "2026-11-21T09:59:00.000Z", windows: [], ...patch };
}

function account(id: string, patch: Partial<LimitsAccount> = {}): LimitsAccount {
  return { id, driver: "claude", label: `Account ${id}`, limits: limits(), ...patch } as LimitsAccount;
}

const window = {
  id: "w",
  kind: "session" as const,
  label: "Session",
  usedPercent: 10,
};

describe("accountLimitNotices", () => {
  it("says an account has no limits instead of dropping it silently", () => {
    const notices = accountLimitNotices([account("a")]);
    expect(notices).toEqual([{ key: "a", name: "Account a", message: "No limits reported." }]);
  });

  it("uses the T3 wording for unsupported and failed probes", () => {
    const notices = accountLimitNotices([
      account("a", { limits: limits({ unavailable: { reason: "unsupported" } }) }),
      account("b", { limits: limits({ unavailable: { reason: "probeFailed" } }) }),
    ]);
    expect(notices.map((notice) => notice.message)).toEqual([
      "This account has no subscription limits.",
      "Could not read limits.",
    ]);
  });

  it("prefers the server's own message and the display name", () => {
    const [notice] = accountLimitNotices([
      account("a", {
        displayName: "Work",
        limits: limits({ unavailable: { reason: "probeFailed", message: "Claude usage unavailable (HTTP 429)." } }),
      }),
    ]);
    expect(notice).toEqual({ key: "a", name: "Work", message: "Claude usage unavailable (HTTP 429)." });
  });

  it("skips accounts that report windows, and accounts the external-link card already explains", () => {
    const notices = accountLimitNotices([
      account("ok", { limits: limits({ windows: [window] }) }),
      account("ext", {
        limits: limits({ externalUsage: { label: "Manage", url: "https://example.com" } }),
      }),
    ]);
    expect(notices).toEqual([]);
  });
});

describe("resetCreditLines", () => {
  it("is empty when the account banks no credits", () => {
    expect(resetCreditLines(limits(), NOW)).toEqual([]);
    expect(resetCreditLines(limits({ resetCredits: { availableCount: 0 } }), NOW)).toEqual([]);
  });

  it("summarises banked credits with the next expiry", () => {
    const lines = resetCreditLines(
      limits({ resetCredits: { availableCount: 2, nextExpiresAt: "2026-11-24T14:00:00.000Z" } }),
      NOW,
    );
    expect(lines).toEqual(["2 reset credits banked · next expires in 3d 4h"]);
  });

  it("lists each option when the server names them", () => {
    const lines = resetCreditLines(
      limits({
        resetCredits: {
          availableCount: 1,
          options: [
            { creditId: "c1", label: "Weekly", description: "Clears the weekly window.", availableCount: 1, expiresAt: "2026-11-21T12:30:00.000Z" },
          ],
        },
      }),
      NOW,
    );
    expect(lines).toEqual(["Weekly · 1 left · expires in 2h 30m"]);
  });
});
