import type { LimitsAccount, UsageWindow } from "../../src/contracts.ts";
import type { ProviderModule } from "../types.ts";

// Logic derived from T3 Code's Cursor usage-limit reader (MIT, see NOTICE).
const ENDPOINT = "https://api2.cursor.sh";

const WINDOWS = [
  { id: "totalPercentUsed", label: "Overall" },
  { id: "autoPercentUsed", label: "Cursor Models" },
  { id: "apiPercentUsed", label: "Other Models" },
] as const;

interface CursorUsage {
  billingCycleStart?: string | number;
  billingCycleEnd?: string | number;
  planUsage?: { totalPercentUsed?: number; autoPercentUsed?: number; apiPercentUsed?: number };
}

export function cursorUsageToWindows(response: CursorUsage): UsageWindow[] {
  const end = Number(response.billingCycleEnd);
  const start = Number(response.billingCycleStart);
  const resetsAt = end > 0 ? new Date(end).toISOString() : undefined;
  const mins = resetsAt && start > 0 ? Math.round((end - start) / 60_000) : 0;
  const windows: UsageWindow[] = [];
  for (const { id, label } of WINDOWS) {
    const used = response.planUsage?.[id];
    if (used === undefined || !Number.isFinite(used)) continue;
    windows.push({
      id,
      kind: "monthly",
      label,
      usedPercent: Math.max(0, Math.min(100, used)),
      ...(resetsAt ? { resetsAt } : {}),
      ...(mins > 0 ? { windowDurationMins: mins } : {}),
    });
  }
  return windows;
}

async function readOne(name: string, apiKey: string): Promise<LimitsAccount> {
  const head = { id: name, driver: "cursor", label: name, displayName: name };
  const checkedAt = new Date().toISOString();
  try {
    // Trade the user's API key for the access token Cursor's dashboard RPC accepts.
    const exchange = await fetch(`${ENDPOINT}/auth/exchange_user_api_key`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (!exchange.ok) throw new Error(`HTTP ${exchange.status}`);
    const { accessToken } = (await exchange.json()) as { accessToken?: string };
    if (!accessToken) throw new Error("no token");
    const res = await fetch(`${ENDPOINT}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "connect-protocol-version": "1",
        "x-cursor-client-type": "cli",
      },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const windows = cursorUsageToWindows((await res.json()) as CursorUsage);
    return {
      ...head,
      limits: windows.length > 0 ? { checkedAt, windows } : { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
    };
  } catch (e) {
    return { ...head, limits: { checkedAt, windows: [], unavailable: { reason: "probeFailed", message: `Cursor usage unavailable (${e instanceof Error ? e.message : "error"}).` } } };
  }
}

export const cursor: ProviderModule = {
  id: "cursor",
  label: "Cursor",
  color: "#8b8b8b",
  auth: "apiKey",
  read: (keys) => Promise.all(keys.list("cursor").map(({ name, key }) => readOne(name, key))),
};
