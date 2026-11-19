import type { UsageProviderKind, UsageTokenTotals } from "../../src/contracts.ts";

export type UsageSpeed = "standard" | "fast" | "ultrafast";

export interface UsageRecord {
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly rateModel?: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  /** The part of `totals.cacheCreationTokens` written with a 1-hour TTL. */
  readonly cacheCreation1hTokens?: number;
  readonly reportedCostUsd: number | null;
  readonly speed: UsageSpeed;
  readonly dedupeKey: string | null;
}

export function totalTokens(t: UsageTokenTotals): number {
  // Reasoning is a subset of output and must not be added again.
  return t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens + t.outputTokens;
}

export const tokenCount = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;

export const parseTimestampMs = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
