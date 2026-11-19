import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { LimitsAccount, UsageWindow } from "../../src/contracts.ts";
import type { ProviderModule } from "../types.ts";

// Logic derived from T3 Code's OpenCode Go usage-limit reader (MIT, see NOTICE).
const dataHome = () => process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
const authPath = () => join(dataHome(), "opencode", "auth.json");
const dbPath = () => resolve(dataHome(), "opencode", process.env.OPENCODE_DB ?? "opencode.db");

function authFileKey(): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(authPath(), "utf8")) as Record<string, { type?: string; key?: string }>;
    const entry = auth["opencode-go"];
    return entry?.type === "api" ? entry.key?.trim() : undefined;
  } catch {
    return undefined;
  }
}

function storedKey(integrationId: "opencode" | "opencode-go"): string | undefined {
  const path = dbPath();
  if (!existsSync(path)) return undefined;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 100");
      const row = db
        .prepare(
          `SELECT value FROM credential WHERE integration_id = ? AND active IS NOT 0
           ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`,
        )
        .get(integrationId) as { value?: unknown } | undefined;
      if (typeof row?.value !== "string") return undefined;
      const stored = JSON.parse(row.value) as {
        type?: string;
        key?: string;
        metadata?: { server?: unknown } | null;
      };
      if (stored.type !== "key") return undefined;
      const server = stored.metadata?.server;
      if (typeof server === "string") {
        const url = new URL(server);
        if (`${url.origin}${url.pathname.replace(/\/+$/, "")}` !== "https://opencode.ai/console") return undefined;
      }
      return stored.key?.trim();
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

interface Win {
  percent: number;
  resetsAt: string;
}
const clamp = (n: number) => Math.max(0, Math.min(100, n));
const win = (
  id: string,
  kind: UsageWindow["kind"],
  label: string,
  w: Win,
  mins?: number,
): UsageWindow => ({
  id,
  kind,
  label,
  usedPercent: clamp(w.percent),
  ...(Number.isFinite(Date.parse(w.resetsAt)) ? { resetsAt: new Date(w.resetsAt).toISOString() } : {}),
  ...(mins ? { windowDurationMins: mins } : {}),
});

export const opencode: ProviderModule = {
  id: "opencode",
  label: "OpenCode",
  color: "#5b9bbd",
  auth: "localLogin",
  hasLogin: () => existsSync(authPath()) || existsSync(dbPath()),
  async read() {
    const keys = [
      ...new Set(
        [storedKey("opencode"), storedKey("opencode-go"), authFileKey(), process.env.OPENCODE_API_KEY?.trim()].filter(
          (k): k is string => Boolean(k),
        ),
      ),
    ];
    if (keys.length === 0) return [];
    const head = { id: "opencode-go", driver: "opencode", label: "OpenCode", displayName: "OpenCode" };
    const checkedAt = new Date().toISOString();
    try {
      let res: Response | undefined;
      for (const key of keys) {
        res = await fetch("https://opencode.ai/zen/go/v1/usage", {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(8000),
        });
        if (res.status !== 401 && res.status !== 403) break;
      }
      // A valid Zen key can exist without a Go subscription: nothing to show.
      if (!res || res.status === 403 || res.status === 401) return [];
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { usage } = (await res.json()) as { usage: { rolling: Win; weekly: Win; monthly: Win } };
      const account: LimitsAccount = {
        ...head,
        limits: {
          checkedAt,
          windows: [
            win("go_rolling", "session", "Go · Session", usage.rolling, 5 * 60),
            win("go_weekly", "weekly", "Go · Weekly", usage.weekly, 7 * 24 * 60),
            win("go_monthly", "monthly", "Go · Monthly", usage.monthly),
          ],
        },
      };
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
              message: `OpenCode Go could not read usage (${e instanceof Error ? e.message : "error"}).`,
            },
          },
        },
      ];
    }
  },
};
