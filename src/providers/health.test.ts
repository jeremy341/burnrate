import { describe, expect, it } from "vitest";

import type { LimitsAccount, UsageWindow } from "~/contracts";

import {
  accountHealth,
  headlineWindow,
  healthText,
  isLoginExpiredMessage,
  limitsForAccount,
  providerHealth,
} from "./health";

const win = (label: string, usedPercent: number): UsageWindow => ({
  id: label.toLowerCase(),
  kind: "weekly",
  label,
  usedPercent,
});

function row(id: string, driver: string, label: string, limits: Partial<LimitsAccount["limits"]>): LimitsAccount {
  return { id, driver, label, limits: { checkedAt: "2026-11-21T12:00:00Z", windows: [], ...limits } };
}

const claude = {
  id: "claudeAgent",
  accounts: [
    { id: "claude", label: "Jerry" },
    { id: "claude-acc2", label: "Kernel" },
  ],
};

describe("account health", () => {
  it("recognises the server's stable expired-login prefix", () => {
    expect(isLoginExpiredMessage("login-expired: Claude Code login expired, sign in again")).toBe(true);
    expect(isLoginExpiredMessage("  Login-Expired: x")).toBe(true);
    expect(isLoginExpiredMessage("Claude usage unavailable (HTTP 429).")).toBe(false);
    expect(isLoginExpiredMessage(undefined)).toBe(false);
  });

  it("headlines the window closest to its limit", () => {
    expect(headlineWindow([win("Session", 47), win("Weekly", 94)])?.label).toBe("Weekly");
    expect(headlineWindow([])).toBeNull();
  });

  it("matches Claude accounts by the server's claude-<id> row ids, not by suffix", () => {
    const report = {
      accounts: [
        row("claude-claude", "claudeAgent", "Jerry", { windows: [win("Weekly", 94)] }),
        row("claude-claude-acc2", "claudeAgent", "Kernel", { windows: [win("Weekly", 45)] }),
      ],
    };
    expect(limitsForAccount(report, claude, claude.accounts[0]!)?.label).toBe("Jerry");
    expect(limitsForAccount(report, claude, claude.accounts[1]!)?.label).toBe("Kernel");
  });

  it("reports ok, stale, expired and error states", () => {
    const report = {
      accounts: [
        row("claude-claude", "claudeAgent", "Jerry", {
          windows: [],
          unavailable: { reason: "probeFailed", message: "login-expired: sign in again" },
        }),
        row("claude-claude-acc2", "claudeAgent", "Kernel", { windows: [win("Session", 3), win("Weekly", 45)], stale: true }),
      ],
    };
    expect(accountHealth(report, claude, claude.accounts[0]!)).toEqual({ kind: "expired" });
    const kernel = accountHealth(report, claude, claude.accounts[1]!);
    expect(kernel.kind).toBe("ok");
    expect(healthText(kernel)).toBe("Weekly 45% used, last read earlier");
    const failing = accountHealth(
      { accounts: [row("mistral-work", "mistral", "work", { unavailable: { reason: "probeFailed", message: "HTTP 500" } })] },
      { id: "mistral", accounts: [{ id: "work", label: "work" }] },
      { id: "work", label: "work" },
    );
    expect(failing).toEqual({ kind: "error", message: "HTTP 500" });
    expect(healthText(failing)).toBe("HTTP 500");
  });

  it("says nothing without data and never invents a percent", () => {
    expect(accountHealth(null, claude, claude.accounts[0]!)).toEqual({ kind: "unknown" });
    expect(healthText({ kind: "unknown" })).toBeNull();
    expect(
      accountHealth(
        { accounts: [row("x", "codex", "x", { unavailable: { reason: "unsupported" } })] },
        { id: "codex", accounts: [] },
        { id: "x", label: "x" },
      ),
    ).toEqual({ kind: "unknown" });
  });

  it("gives a provider without saved accounts the worst health of its rows", () => {
    const report = {
      accounts: [
        row("chatgpt-login", "codex", "ChatGPT login", { windows: [win("Weekly", 31)] }),
        row("chatgpt-2", "codex", "Other", { unavailable: { reason: "probeFailed", message: "login-expired: x" } }),
      ],
    };
    expect(providerHealth(report, { id: "codex" })).toEqual({ kind: "expired" });
    expect(providerHealth({ accounts: [report.accounts[0]!] }, { id: "codex" }).kind).toBe("ok");
    expect(providerHealth(report, { id: "grok" })).toEqual({ kind: "unknown" });
  });
});
