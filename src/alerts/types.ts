/** Client-side shape of a server alert event (docs/CONTRACTS.md section 10). */
export type AlertKind = "threshold" | "runout" | "reset" | "login";
export type AlertSeverity = "info" | "warn" | "critical";

export interface AlertEvent {
  readonly id: string;
  /** Milliseconds since the epoch. The server may send a numeric string; `parseAlertEvent` normalises it. */
  readonly ts: number;
  readonly kind: AlertKind;
  readonly accountId: string;
  readonly provider: string;
  readonly windowId?: string;
  readonly title: string;
  readonly body: string;
  readonly severity: AlertSeverity;
  readonly usedPercent?: number;
}

/** The slice of settings the alert client cares about. */
export interface AlertClientState {
  readonly enabled: boolean;
  readonly desktop: boolean;
  readonly snoozeUntil: string | null;
  readonly hidden: boolean;
}
