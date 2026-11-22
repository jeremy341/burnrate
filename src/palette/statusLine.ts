import { m } from "~/i18n";

/** Minimal subset of the compact status payload (CONTRACTS section 8) needed for a status line. */
export interface StatusLineWindow {
  readonly label?: string;
  readonly kind?: string;
  readonly usedPercent: number;
  readonly remainingPercent?: number;
  readonly resetsAt?: string;
}

export interface StatusLineAccount {
  readonly label?: string;
  readonly provider?: string;
  readonly windows?: readonly StatusLineWindow[];
}

export interface StatusLinePayload {
  readonly accounts?: readonly StatusLineAccount[];
}

/** `2026-11-20T14:30:00Z` -> `2h 30m` (also `3d 14h`, `45m`; `0m` for a past timestamp). */
export function formatResetDuration(resetsAt: string, now: number = Date.now()): string {
  const ms = Date.parse(resetsAt) - now;
  if (!Number.isFinite(ms)) return "?";
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function remainingOf(window: StatusLineWindow): number {
  const value = window.remainingPercent ?? 100 - window.usedPercent;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * One-line, paste-friendly answer to "how much can I still use?": for each account, the window that
 * will run out first, e.g. `Jerry 6% left (Weekly), resets in 3d 14h · Kernel 53% left (Session)`.
 */
export function formatStatusLine(
  status: StatusLinePayload,
  now: number = Date.now(),
  nameOf: (account: StatusLineAccount) => string = (account) => account.label ?? account.provider ?? "Account",
): string {
  const parts: string[] = [];
  for (const account of status.accounts ?? []) {
    const windows = account.windows ?? [];
    if (windows.length === 0) continue;
    const tightest = windows.reduce((best, next) => (remainingOf(next) < remainingOf(best) ? next : best));
    const windowName = tightest.label ?? tightest.kind;
    const detail = [
      windowName,
      tightest.resetsAt ? `resets in ${formatResetDuration(tightest.resetsAt, now)}` : undefined,
    ].filter(Boolean);
    const suffix = detail.length > 0 ? ` (${detail.join(", ")})` : "";
    parts.push(`${nameOf(account)} ${remainingOf(tightest)}% left${suffix}`);
  }
  return parts.length > 0 ? parts.join(" · ") : m("No limits available");
}
