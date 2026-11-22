/** Parse the `data:` payload of an SSE `alert` event without trusting the network. */
import { msg } from "~/i18n";

import type { AlertEvent, AlertKind, AlertSeverity } from "./types";

const KINDS: readonly AlertKind[] = ["threshold", "runout", "reset", "login"];
const SEVERITIES: readonly AlertSeverity[] = ["info", "warn", "critical"];

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Default copy used when a server event omits a human-readable title/body. */
export function fallbackCopy(kind: AlertKind): { title: string; body: string } {
  switch (kind) {
    case "threshold":
      return {
        title: msg("Usage threshold reached"),
        body: msg("One of your provider windows crossed a usage threshold."),
      };
    case "runout":
      return {
        title: msg("Running out early"),
        body: msg("At this pace the window will run out before it resets."),
      };
    case "reset":
      return {
        title: msg("Usage window reset"),
        body: msg("A usage window has reset and your quota is back."),
      };
    case "login":
      return {
        title: msg("Login expired"),
        body: msg("A provider needs you to sign in again."),
      };
  }
}

/**
 * Turn an SSE payload into a validated `AlertEvent`. Returns `null` for anything malformed so a
 * broken event can never throw inside the stream handler.
 */
export function parseAlertEvent(raw: string): AlertEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;

  const id = str(o.id);
  const kindRaw = str(o.kind);
  const severityRaw = str(o.severity);
  const accountId = str(o.accountId);
  const provider = str(o.provider);
  if (!id || !kindRaw || !severityRaw || !accountId || !provider) return null;
  if (!KINDS.includes(kindRaw as AlertKind) || !SEVERITIES.includes(severityRaw as AlertSeverity)) return null;

  const kind = kindRaw as AlertKind;
  const copy = fallbackCopy(kind);
  const windowId = str(o.windowId);
  const usedPercent = num(o.usedPercent);

  return {
    id,
    ts: num(o.ts) ?? Date.now(),
    kind,
    accountId,
    provider,
    ...(windowId ? { windowId } : {}),
    title: str(o.title) ?? copy.title,
    body: str(o.body) ?? copy.body,
    severity: severityRaw as AlertSeverity,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
  };
}
