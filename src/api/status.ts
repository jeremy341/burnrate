/** Compact status (docs/CONTRACTS.md section 8): the small payload behind the palette status line. */
import { request } from "~/api/http";

export interface StatusWindowPayload {
  readonly id: string;
  readonly kind: "session" | "weekly" | "monthly" | "other";
  readonly label: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly resetsAt?: string;
  readonly windowMinutes?: number;
  readonly paceDelta?: number;
  readonly state: "ok" | "warn" | "critical" | "unavailable";
}

export interface StatusAccountPayload {
  readonly id: string;
  readonly provider: string;
  readonly label: string;
  readonly plan?: string;
  readonly windows: readonly StatusWindowPayload[];
  readonly stale?: boolean;
  readonly staleMessage?: string;
}

export interface StatusPayload {
  readonly checkedAt: string;
  readonly hostLabel?: string;
  readonly accounts: readonly StatusAccountPayload[];
  readonly notices: readonly string[];
}

/** GET /api/status - the compact status built by the scheduler (contract section 8). */
export function fetchStatus(signal?: AbortSignal): Promise<StatusPayload> {
  return request<StatusPayload>("/api/status", { signal });
}
