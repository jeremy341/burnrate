/**
 * Pace / state rules shared by the compact status and the alerts UI.
 * Contract: docs/CONTRACTS.md section 8. Keep this module pure - no React, no I/O -
 * so it can be unit-tested on its own.
 */
export type PaceState = "ok" | "warn" | "critical";

/** The slice of a compact-status window the pace rules need. */
export interface PaceWindow {
  readonly usedPercent: number;
  readonly remainingPercent?: number;
  /** Server-supplied "percent used minus percent of window elapsed" when available. */
  readonly paceDelta?: number;
  /** ISO timestamp at which the window resets. */
  readonly resetsAt?: string;
  /** Total window length in minutes. */
  readonly windowMinutes?: number;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function usedPercentOf(window: PaceWindow): number {
  return clampPercent(finite(window.usedPercent) ?? 0);
}

function remainingPercentOf(window: PaceWindow): number {
  return clampPercent(finite(window.remainingPercent) ?? 100 - usedPercentOf(window));
}

function resetMsOf(window: PaceWindow): number | null {
  if (!window.resetsAt) return null;
  const ms = Date.parse(window.resetsAt);
  return Number.isFinite(ms) ? ms : null;
}

function windowMsOf(window: PaceWindow): number {
  const minutes = finite(window.windowMinutes) ?? 0;
  return minutes > 0 ? minutes * 60_000 : 0;
}

/**
 * Milliseconds (epoch) at which a window is projected to reach 100%, or `null`
 * when there isn't enough information (no reset/length, empty window, or the
 * reset lies in the past relative to `now`).
 *
 * The burn rate is `usedPercent / elapsedSinceWindowStart`; the projection is
 * linear from the window start. `now` is injectable so the rules are testable.
 */
export function projectedExhaustion(window: PaceWindow, now: number = Date.now()): number | null {
  const resetMs = resetMsOf(window);
  const windowMs = windowMsOf(window);
  const used = usedPercentOf(window);
  if (resetMs === null || windowMs <= 0 || used <= 0 || used >= 100) return null;

  const startMs = resetMs - windowMs;
  const elapsedMs = now - startMs;
  if (elapsedMs <= 0) return null;

  const percentPerMs = used / elapsedMs;
  if (percentPerMs <= 0) return null;
  return startMs + 100 / percentPerMs;
}

/** `usedPercent - percentOfWindowElapsed`, used when the server omits `paceDelta`. */
function computedPaceDelta(window: PaceWindow, now: number): number {
  const supplied = finite(window.paceDelta);
  if (supplied !== null) return supplied;

  const resetMs = resetMsOf(window);
  const windowMs = windowMsOf(window);
  if (resetMs === null || windowMs <= 0) return 0;

  const elapsedMs = now - (resetMs - windowMs);
  if (elapsedMs <= 0) return 0;
  const elapsedPercent = Math.min(100, (elapsedMs / windowMs) * 100);
  return usedPercentOf(window) - elapsedPercent;
}

/**
 * Colour/state of a window, identical to the compact-status rule:
 * - critical: remaining <= 10, or projected to run out before the reset
 * - warn: remaining <= 25, or paceDelta >= 15
 * - ok otherwise
 *
 * `unavailable` windows have no meaningful numbers and are reported as `ok`
 * here; the caller renders the unavailable state from the window itself.
 */
export function paceState(
  window: PaceWindow,
  now: number = Date.now(),
): PaceState {
  const remaining = remainingPercentOf(window);
  if (remaining <= 10) return "critical";

  const exhaustion = projectedExhaustion(window, now);
  if (exhaustion !== null) {
    const resetMs = resetMsOf(window);
    if (resetMs !== null && exhaustion < resetMs) return "critical";
  }

  if (remaining <= 25) return "warn";
  if (computedPaceDelta(window, now) >= 15) return "warn";
  return "ok";
}
