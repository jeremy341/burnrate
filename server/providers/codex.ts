import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LimitsAccount, UsageWindow } from "../../src/contracts.ts";
import type { ProviderModule } from "../types.ts";

interface Win {
  used_percent?: number;
  reset_at?: number | null;
  reset_after_seconds?: number | null;
  limit_window_seconds?: number;
}

const authPath = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");

const PLAN: Record<string, string> = {
  plus: "ChatGPT Plus Subscription",
  pro: "ChatGPT Pro 200 Subscription",
  prolite: "ChatGPT Pro 100 Subscription",
};

function toWindow(id: string, w: Win | null | undefined): UsageWindow | null {
  if (!w || typeof w.used_percent !== "number") return null;
  const mins = w.limit_window_seconds ? w.limit_window_seconds / 60 : undefined;
  const kind = mins !== undefined && mins >= 60 * 24 * 5 ? "weekly" : "session";
  const resetMs = w.reset_at
    ? w.reset_at * 1000
    : w.reset_after_seconds != null
      ? Date.now() + w.reset_after_seconds * 1000
      : null;
  return {
    id,
    kind,
    label: kind === "weekly" ? "Weekly" : "Session",
    usedPercent: Math.max(0, Math.min(100, w.used_percent)),
    ...(resetMs ? { resetsAt: new Date(resetMs).toISOString() } : {}),
    ...(mins !== undefined ? { windowDurationMins: Math.round(mins) } : {}),
  };
}

export const codex: ProviderModule = {
  id: "codex",
  label: "Codex",
  color: "var(--contrast-foreground)",
  auth: "localLogin",
  hasLogin: () => existsSync(authPath()),
  async read() {
    let tokens: { access_token?: string; account_id?: string } | undefined;
    try {
      tokens = (JSON.parse(readFileSync(authPath(), "utf8")) as { tokens?: typeof tokens }).tokens;
    } catch {
      return [];
    }
    if (!tokens?.access_token) return [];
    const head = {
      id: "chatgpt-login",
      driver: "codex",
      label: "ChatGPT login",
      displayName: "ChatGPT login",
    };
    try {
      const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "OpenAI-Beta": "codex-1",
          Originator: "Codex Desktop",
          ...(tokens.account_id ? { "Chatgpt-Account-Id": tokens.account_id } : {}),
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        plan_type?: string;
        rate_limit?: { primary_window?: Win | null; secondary_window?: Win | null } | null;
      };
      const windows = [
        toWindow("primary", body.rate_limit?.primary_window),
        toWindow("secondary", body.rate_limit?.secondary_window),
      ].filter((w): w is UsageWindow => w !== null);
      const plan = body.plan_type ? PLAN[body.plan_type] : undefined;
      const account: LimitsAccount = {
        ...head,
        ...(plan ? { plan } : {}),
        limits: { checkedAt: new Date().toISOString(), windows },
      };
      return [account];
    } catch (e) {
      return [
        {
          ...head,
          limits: {
            checkedAt: new Date().toISOString(),
            windows: [],
            unavailable: {
              reason: "probeFailed",
              message: `Codex usage unavailable (${e instanceof Error ? e.message : "error"}).`,
            },
          },
        },
      ];
    }
  },
};
