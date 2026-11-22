/** Snoozing is driven by `notifications.snoozeUntil` (an ISO timestamp from the server). */
export function isSnoozed(snoozeUntil: string | null | undefined, now: number = Date.now()): boolean {
  if (!snoozeUntil) return false;
  const until = Date.parse(snoozeUntil);
  return Number.isFinite(until) && until > now;
}
