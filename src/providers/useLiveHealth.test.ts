import { describe, expect, it } from "vitest";

import { accountHealth } from "./health";
import { claudeAccountForName } from "./useLiveHealth";

describe("claudeAccountForName", () => {
  it("names a new Claude account the way the server lists it, so its limits row is found", () => {
    const account = claudeAccountForName("work");
    expect(account).toEqual({ id: "claude-work", label: "work" });
    const report = {
      accounts: [
        { id: "claude-claude-work", driver: "claudeAgent", label: "work", limits: { checkedAt: "x", windows: [{ id: "w", kind: "weekly" as const, label: "Weekly", usedPercent: 12 }] } },
        { id: "claude-claude", driver: "claudeAgent", label: "Jerry", limits: { checkedAt: "x", windows: [{ id: "w", kind: "weekly" as const, label: "Weekly", usedPercent: 94 }] } },
      ],
    };
    const health = accountHealth(report, { id: "claudeAgent", accounts: [] }, account);
    expect(health.kind === "ok" && health.window.usedPercent).toBe(12);
  });

  it("never shows another account's percent while the new account has no row yet", () => {
    const report = {
      accounts: [
        { id: "claude-claude", driver: "claudeAgent", label: "Jerry", limits: { checkedAt: "x", windows: [{ id: "w", kind: "weekly" as const, label: "Weekly", usedPercent: 94 }] } },
      ],
    };
    expect(accountHealth(report, { id: "claudeAgent", accounts: [] }, claudeAccountForName("work"))).toEqual({ kind: "unknown" });
  });
});
