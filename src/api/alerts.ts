/**
 * Alerts API client (docs/CONTRACTS.md section 10).
 *
 * The engine itself is server-side and publishes events on `/api/stream`; this client only sends
 * the optional test delivery from Settings.
 */
import { request } from "./http";

export interface TestAlertResult {
  readonly ok: boolean;
  readonly message?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
