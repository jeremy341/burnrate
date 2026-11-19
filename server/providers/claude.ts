import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LimitsAccount, UsageWindow } from "../../src/contracts.ts";
import type { ProviderModule } from "../types.ts";

// Logic derived from T3 Code's Claude usage-limit reader (MIT, see NOTICE).
const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

const configDir = () => process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
const credentialsPath = () => join(configDir(), ".credentials.json");
const accountPath = () =>
  process.env.CLAUDE_CONFIG_DIR?.trim()
    ? join(process.env.CLAUDE_CONFIG_DIR.trim(), ".claude.json")
    : join(homedir(), ".claude.json");

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const iso = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

interface Bucket {
  utilization?: number | null;
  resets_at?: string | null;
}
interface Money {
  amount_minor: number;
  currency: string;
  exponent: number;
}
interface OauthUsage {
  five_hour?: Bucket | null;
  seven_day?: Bucket | null;
  limits?: Array<{
    kind?: string;
    percent?: number;
    resets_at?: string | null;
    scope?: { model?: { display_name?: string } };
  }>;
  spend?: { enabled?: boolean; used?: Money; limit?: Money } | null;
  extra_usage?: {
    is_enabled?: boolean;
    used_credits?: number;
    monthly_limit?: number;
    utilization?: number;
  } | null;
}

function spendPercent(usage: OauthUsage): number | undefined {
  const s = usage.spend;
  if (
    s?.enabled &&
    s.used &&
    s.limit &&
    s.used.currency.trim() === s.limit.currency.trim() &&
    s.used.exponent === s.limit.exponent &&
    s.limit.amount_minor > 0
  ) {
    return clamp((s.used.amount_minor / s.limit.amount_minor) * 100);
  }
  const e = usage.extra_usage;
  if (e?.is_enabled !== true) return undefined;
  const pct =
    e.monthly_limit && e.monthly_limit > 0 && typeof e.used_credits === "number"
      ? (e.used_credits / e.monthly_limit) * 100
      : e.utilization;
  return typeof pct === "number" && Number.isFinite(pct) && pct >= 0 ? clamp(pct) : undefined;
}

export function claudeUsageToWindows(usage: OauthUsage): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const fixed: Array<[string, Bucket | null | undefined, UsageWindow["kind"], string, number]> = [
    ["five_hour", usage.five_hour, "session", "Session", SESSION_MINS],
    ["seven_day", usage.seven_day, "weekly", "Weekly", WEEK_MINS],
  ];
  for (const [id, bucket, kind, label, mins] of fixed) {
    if (!bucket || typeof bucket.utilization !== "number") continue;
    const resetsAt = iso(bucket.resets_at);
    windows.push({
      id,
      kind,
      label,
      windowDurationMins: mins,
      usedPercent: clamp(bucket.utilization),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  for (const limit of usage.limits ?? []) {
    const name = limit.scope?.model?.display_name;
    if (limit.kind !== "weekly_scoped" || !name || typeof limit.percent !== "number") continue;
    const token = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const resetsAt = iso(limit.resets_at);
    windows.push({
      id: `seven_day_${token}`,
      kind: "weekly",
      label: `Weekly · ${name}`,
      windowDurationMins: WEEK_MINS,
      usedPercent: clamp(limit.percent),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const spend = spendPercent(usage);
  if (spend !== undefined) {
    windows.push({ id: "monthly_spend", kind: "monthly", label: "Monthly spend", usedPercent: spend });
  }
  return windows;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export const claude: ProviderModule = {
  id: "claudeAgent",
  label: "Claude Code",
  color: "#d97757",
  auth: "localLogin",
  hasLogin: () => existsSync(credentialsPath()),
  async read() {
    const token = readJson<{ claudeAiOauth?: { accessToken?: string } }>(credentialsPath())
      ?.claudeAiOauth?.accessToken?.trim();
    if (!token) return [];
    const identity = readJson<{ oauthAccount?: { displayName?: string; emailAddress?: string } }>(
      accountPath(),
    )?.oauthAccount;
    const name = identity?.displayName?.trim() || undefined;
    const head = {
      id: "claude-login",
      driver: "claudeAgent",
      label: name ?? "Claude login",
      ...(name ? { displayName: name } : {}),
      ...(identity?.emailAddress ? { email: identity.emailAddress } : {}),
      plan: "Claude Subscription",
    };
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch("https://api.anthropic.com/api/oauth/usage?skip_spend=1", {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          // The endpoint can answer 429 without a Claude Code user agent.
          "User-Agent": "claude-code/2.1.273",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const usage = (await res.json()) as OauthUsage;
      const account: LimitsAccount = { ...head, limits: { checkedAt, windows: claudeUsageToWindows(usage) } };
      return [account];
    } catch (e) {
      return [
        {
          ...head,
          limits: {
            checkedAt,
            windows: [],
            unavailable: {
              reason: "probeFailed",
              message: `Claude usage unavailable (${e instanceof Error ? e.message : "error"}).`,
            },
          },
        },
      ];
    }
  },
};
