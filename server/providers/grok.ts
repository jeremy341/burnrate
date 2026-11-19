import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LimitsAccount, UsageWindow } from "../../src/contracts.ts";
import type { ProviderModule } from "../types.ts";

// Logic derived from T3 Code's Grok usage-limit reader (MIT, see NOTICE).
const GROK_USAGE_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const home = () => process.env.GROK_HOME?.trim() || join(homedir(), ".grok");

interface Credential {
  key?: string;
  auth_mode?: string;
  email?: string;
}

function readCredential(): Credential | undefined {
  // An API key or a custom deployment is not a Grok subscription login.
  if (process.env.XAI_API_KEY?.trim()) return undefined;
  try {
    const all = JSON.parse(readFileSync(join(home(), "auth.json"), "utf8")) as Record<string, Credential>;
    // Never pick an arbitrary account from other deployments stored in the same file.
    const credential = all["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"] ?? all["https://accounts.x.ai/sign-in"];
    return credential?.auth_mode === "api_key" ? undefined : credential;
  } catch {
    return undefined;
  }
}

const parse = (value: unknown): number => (typeof value === "string" ? Date.parse(value) : Number.NaN);

export function grokUsageToWindows(body: {
  config?: { creditUsagePercent?: number; currentPeriod?: { type?: string; start?: unknown; end?: string } };
}): UsageWindow[] {
  const period = body.config?.currentPeriod;
  const type = period?.type?.replace(/^USAGE_PERIOD_TYPE_/, "");
  const kind: UsageWindow["kind"] = type === "WEEKLY" ? "weekly" : type === "MONTHLY" ? "monthly" : "other";
  const start = parse(period?.start);
  const end = parse(period?.end);
  const mins = Math.round((end - start) / 60_000);
  let used = body.config?.creditUsagePercent;
  // Grok omits a zero percentage while keeping the subscription period.
  if (used === undefined && (kind === "weekly" || kind === "monthly") && start < end) used = 0;
  if (used === undefined || !Number.isFinite(used)) return [];
  return [
    {
      id: "subscription",
      kind,
      label: kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Subscription",
      usedPercent: Math.max(0, Math.min(100, used)),
      ...(Number.isFinite(end) ? { resetsAt: new Date(end).toISOString() } : {}),
      ...(mins > 0 ? { windowDurationMins: mins } : {}),
    },
  ];
}

export const grok: ProviderModule = {
  id: "grok",
  label: "Grok",
  color: "#8b8b8b",
  auth: "localLogin",
  hasLogin: () => existsSync(join(home(), "auth.json")),
  async read() {
    const credential = readCredential();
    const token = credential?.key?.trim();
    if (!token) return [];
    const email = credential?.email?.trim() || undefined;
    const head = { id: "grok-login", driver: "grok", label: email ?? "Grok login", ...(email ? { email } : {}) };
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch(GROK_USAGE_URL, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 403) {
        const text = await res.text();
        if (text.includes("WKE=privacy-mode:")) throw new Error("Switch your xAI account to Privacy Mode to show Grok usage limits");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const account: LimitsAccount = { ...head, limits: { checkedAt, windows: grokUsageToWindows((await res.json()) as never) } };
      return [account];
    } catch (e) {
      return [{ ...head, limits: { checkedAt, windows: [], unavailable: { reason: "probeFailed", message: `Grok usage unavailable (${e instanceof Error ? e.message : "error"}).` } } }];
    }
  },
};
