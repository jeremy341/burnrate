/**
 * Alerts API client (docs/CONTRACTS.md section 10).
 *
 * The engine itself is server-side and publishes events on `/api/stream`; these calls only read
 * its state/history and control snoozing and the test delivery.
 */
import { request } from "./http";

export type AlertKind = "threshold" | "runout" | "reset" | "login";
export type AlertSeverity = "info" | "warn" | "critical";

export interface AlertEvent {
  readonly id: string;
  /** ISO timestamp; older servers may send epoch milliseconds. */
  readonly ts: string | number;
  readonly kind: AlertKind;
  readonly accountId: string;
  readonly provider: string;
  readonly windowId?: string;
  readonly title: string;
  readonly body: string;
  readonly severity: AlertSeverity;
  readonly usedPercent?: number;
}

export interface AlertsState {
  /** ISO timestamp until which alerts are snoozed, or null. */
  readonly snoozeUntil: string | null;
  readonly lastEvents: AlertEvent[];
}

export interface SnoozeResult {
  readonly snoozeUntil: string | null;
}

export interface TestAlertResult {
  readonly ok: boolean;
  readonly message?: string;
}

const KINDS: readonly string[] = ["threshold", "runout", "reset", "login"];
const SEVERITIES: readonly string[] = ["info", "warn", "critical"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Tolerate small server shape differences so the settings UI never crashes on an old/new build. */
export function asAlertEvent(value: unknown): AlertEvent | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const title = typeof raw.title === "string" ? raw.title : "";
  if (!title) return null;
  return {
    id: typeof raw.id === "string" ? raw.id : `${String(raw.ts ?? "")}-${title}`,
    ts: typeof raw.ts === "string" || typeof raw.ts === "number" ? raw.ts : Date.now(),
    kind: KINDS.includes(String(raw.kind)) ? (raw.kind as AlertKind) : "threshold",
    accountId: typeof raw.accountId === "string" ? raw.accountId : "",
    provider: typeof raw.provider === "string" ? raw.provider : "",
    windowId: typeof raw.windowId === "string" ? raw.windowId : undefined,
    title,
    body: typeof raw.body === "string" ? raw.body : "",
    severity: SEVERITIES.includes(String(raw.severity))
      ? (raw.severity as AlertSeverity)
      : "info",
    usedPercent: typeof raw.usedPercent === "number" ? raw.usedPercent : undefined,
  };
}

function asAlertsState(value: unknown): AlertsState {
  const raw = asRecord(value) ?? {};
  const events = Array.isArray(raw.lastEvents)
    ? raw.lastEvents
    : Array.isArray(raw.recent)
      ? raw.recent
      : Array.isArray(raw.events)
        ? raw.events
        : [];
  return {
    snoozeUntil: typeof raw.snoozeUntil === "string" ? raw.snoozeUntil : null,
    lastEvents: events.map(asAlertEvent).filter((e): e is AlertEvent => e !== null),
  };
}

/** Current snooze deadline and the most recent events kept by the engine. */
export function getAlertsState(): Promise<AlertsState> {
  return request<unknown>("/api/alerts/state").then(asAlertsState);
}

/** Recent alert history (in-app log of missed alerts). Accepts an array or `{ events }`. */
export async function getRecentAlerts(): Promise<AlertEvent[]> {
  const raw = await request<unknown>("/api/alerts/recent");
  const candidate = Array.isArray(raw) ? raw : asRecord(raw)?.events;
  const events = Array.isArray(candidate) ? candidate : [];
  return events.map(asAlertEvent).filter((e): e is AlertEvent => e !== null);
}

/**
 * Sends a test event. With `channel` only that channel is tried and the result is its real
 * delivery outcome; without it the in-app alert and every enabled channel get the event.
 */
export function sendTestAlert(channel?: string): Promise<TestAlertResult> {
  return request<unknown>("/api/alerts/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(channel ? { channel } : {}),
  }).then((raw) => {
    const result = asRecord(raw);
    return {
      // A 2xx response with no explicit flag still means the request was accepted.
      ok: result?.ok !== false,
      message: typeof result?.message === "string" ? result.message : undefined,
    };
  });
}

/** Snooze alerts for `minutes` (the server also supports this from the tray/toast). */
export function snoozeAlerts(minutes: number): Promise<SnoozeResult> {
  return request<SnoozeResult>("/api/alerts/snooze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minutes }),
  });
}

/** Cancel an active snooze. */
export async function clearSnooze(): Promise<void> {
  await request("/api/alerts/snooze", { method: "DELETE" });
}
