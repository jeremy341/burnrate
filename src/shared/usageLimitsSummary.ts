// burnrate: the one-line summary a collapsed provider section shows on its heading row.
// Pure data + copy, so it is unit-testable without rendering. The component only lays it out.
import type { UsageWindow as ServerProviderUsageWindow } from "~/contracts";
import { mFallback, msg, type MFunctionType } from "~/i18n";

import {
  type BarValueMode,
  displayLimitWindows,
  isLimitSnapshotStale,
  type LimitPace,
  type LimitPool,
  type LimitPoolWindow,
} from "./usageLimits";
import { formatMoney, formatResetsIn } from "./usageLimitsCopy";

/** At or below this much left a window is critical; the colour never carries this alone (see `tone`). */
export const CRITICAL_REMAINING_PERCENT = 10;
/** How many windows fit on one heading row before the rest fold into "+N more". */
export const SUMMARY_MAX_CHIPS = 4;

export type SummaryTone = "normal" | "warning" | "critical";
export type PoolStatus = "ok" | "stale" | "unavailable" | "empty";

export interface WindowSummary {
  readonly key: string;
  /** Short heading-row label ("Session", "Weekly", ...). */
  readonly label: string;
  /** The full label, for the hover card and the screen reader. */
  readonly fullLabel: string;
  /** The number the bar shows (left or used, per the bar mode). */
  readonly shown: number;
  readonly remaining: number;
  readonly pace: LimitPace | null;
  readonly tone: SummaryTone;
  /** The soonest reset of any account in this window, as the window it came from. */
  readonly resetWindow: ServerProviderUsageWindow | null;
}

export interface BalanceSummary {
  readonly key: string;
  readonly label: string;
  /** Already formatted money ("$12.40"). */
  readonly text: string;
}

export interface PoolSummary {
  readonly status: PoolStatus;
  readonly windows: readonly WindowSummary[];
  /** Index into `windows` of the tightest window (least left), or null when there is nothing to rank. */
  readonly worst: number | null;
  /** First reported message when nothing is available, so it is never shown as blank. */
  readonly message: string | null;
  /** Money-shaped balances, shown when a provider has no usage windows (or alongside them). */
  readonly balances: readonly BalanceSummary[];
  readonly accounts: number;
  readonly unavailableAccounts: number;
}

export function summaryTone(remaining: number, pace: LimitPace | null): SummaryTone {
  if (remaining <= CRITICAL_REMAINING_PERCENT) return "critical";
  return pace === "ahead" ? "warning" : "normal";
}

/**
 * "Go · Session" -> "Session", "Claude Sonnet (weekly)" stays whole. Falls back to the full
 * label if shortening would make two windows of one provider read the same.
 */
export function shortWindowLabels(labels: readonly string[]): readonly string[] {
  const short = labels.map((label) => {
    const parts = label.split("·").map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1]! : label.trim();
  });
  return short.map((value, index) =>
    short.filter((other) => other === value).length > 1 ? labels[index]!.trim() : value,
  );
}

/** The soonest moment usable quota comes back, as the window carrying it (a capped session's is the week's). */
function soonestReset(pool: LimitPoolWindow): ServerProviderUsageWindow | null {
  const first = pool.resets[0];
  return first ? { ...first.member.window, resetsAt: first.member.restoresAt } : null;
}

export function summarizePool(
  pool: LimitPool,
  now: number,
  options: {
    readonly barMode: BarValueMode;
    readonly refreshIntervalSec: number;
    /** Lets a provider rename its windows (Cursor does). */
    readonly labelFor?: (window: LimitPoolWindow) => string | undefined;
  },
): PoolSummary {
  const windows = displayLimitWindows(pool);
  const fullLabels = windows.map((window) => options.labelFor?.(window) ?? window.label);
  const labels = shortWindowLabels(fullLabels);
  const summaries = windows.map((window, index): WindowSummary => {
    const pace = window.pace;
    const remaining = Math.round(window.remainingPercent);
    return {
      key: `${window.kind}:${window.id}`,
      label: labels[index]!,
      fullLabel: fullLabels[index]!,
      shown: options.barMode === "used" ? window.usedPercent : window.remainingPercent,
      remaining,
      pace,
      tone: summaryTone(remaining, pace),
      resetWindow: soonestReset(window),
    };
  });

  // The tightest window is the one with the least left (the earliest wins a tie). A lone,
  // healthy window needs no marker: it is the whole story.
  let worst: number | null = null;
  summaries.forEach((summary, index) => {
    if (worst === null || summary.remaining < summaries[worst]!.remaining) worst = index;
  });
  if (summaries.length === 1 && summaries[0]!.tone === "normal") worst = null;

  const unavailableAccounts = pool.accounts.filter(
    (account) => account.limits.unavailable?.reason === "probeFailed",
  ).length;
  const unsupportedMessage = pool.accounts.find((account) => account.limits.unavailable)?.limits
    .unavailable?.message;
  const stale =
    unavailableAccounts > 0 ||
    pool.accounts.some((account) =>
      isLimitSnapshotStale(account.limits, now, options.refreshIntervalSec),
    );
  const balances = pool.accounts.flatMap((account) =>
    (account.limits.balances ?? []).map((balance) => ({
      key: `${account.key}:${balance.id}`,
      label: balance.label,
      text: formatMoney(balance.amount, balance.currency),
    })),
  );
  const hasBalances = balances.length > 0;

  let status: PoolStatus = "ok";
  if (summaries.length === 0) status = hasBalances ? "ok" : unavailableAccounts > 0 ? "unavailable" : "empty";
  else if (stale) status = "stale";

  return {
    status,
    windows: summaries,
    worst,
    message: unsupportedMessage ?? null,
    balances,
    accounts: pool.accounts.length,
    unavailableAccounts,
  };
}

/** Heading-row text for one window: "Session 70% left". */
export function windowChipText(
  summary: WindowSummary,
  barMode: BarValueMode,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(
    barMode === "used"
      ? msg("{label} {value}% used", { label: summary.label, value: summary.shown })
      : msg("{label} {value}% left", { label: summary.label, value: summary.shown }),
  );
}

/** Whether the windows beyond the chip limit fold into a "+N" count. */
export function visibleChips(summary: PoolSummary): { shown: readonly number[]; hidden: number } {
  const all = summary.windows.map((_, index) => index);
  if (all.length <= SUMMARY_MAX_CHIPS) return { shown: all, hidden: 0 };
  // Never fold away the tightest window: it is the one thing the row promises to show.
  const keep = new Set(all.slice(0, SUMMARY_MAX_CHIPS));
  if (summary.worst !== null && !keep.has(summary.worst)) {
    keep.delete(all[SUMMARY_MAX_CHIPS - 1]!);
    keep.add(summary.worst);
  }
  const shown = all.filter((index) => keep.has(index));
  return { shown, hidden: all.length - shown.length };
}

/** The status words shown beside the chips, or null when everything is current. */
export function statusText(summary: PoolSummary, resolve: MFunctionType = mFallback): string | null {
  switch (summary.status) {
    case "stale":
      return summary.unavailableAccounts > 0 && summary.accounts > 1
        ? resolve(msg("{count} of {total} not reachable", {
            count: summary.unavailableAccounts,
            total: summary.accounts,
          }))
        : resolve(msg("Stale"));
    case "unavailable":
      return resolve(msg("Limits unavailable"));
    case "empty":
      return resolve(msg("No limits reported"));
    default:
      return null;
  }
}

/** Countdown of the tightest window, or the soonest reset when no window stands out. */
export function summaryReset(
  summary: PoolSummary,
  now: number,
  resolve: MFunctionType = mFallback,
): string | null {
  const target = summary.windows[summary.worst ?? 0];
  if (!target?.resetWindow) return null;
  return formatResetsIn(target.resetWindow, now, resolve, "refill");
}

/** The whole row as one sentence for assistive technology (the visual chips are aria-hidden). */
export function summaryAnnouncement(
  summary: PoolSummary,
  now: number,
  barMode: BarValueMode,
  resolve: MFunctionType = mFallback,
): string {
  const parts: string[] = [];
  const status = statusText(summary, resolve);
  if (summary.windows.length === 0 && summary.balances.length > 0) {
    return summary.balances.map((balance) => `${balance.label} ${balance.text}`).join(", ");
  }
  if (summary.windows.length === 0) {
    parts.push(status ?? resolve(msg("No limits reported")));
    if (summary.message) parts.push(summary.message);
    return parts.join(". ");
  }
  parts.push(summary.windows.map((window) => windowChipText(window, barMode, resolve)).join(", "));
  const worst = summary.worst === null ? null : summary.windows[summary.worst]!;
  const target = worst ?? summary.windows[0]!;
  const reset = target.resetWindow ? formatResetsIn(target.resetWindow, now, resolve, "full") : null;
  if (worst) {
    parts.push(
      reset
        ? resolve(msg("Tightest: {label}, {reset}", { label: worst.fullLabel, reset }))
        : resolve(msg("Tightest: {label}", { label: worst.fullLabel })),
    );
  } else if (reset) {
    parts.push(reset);
  }
  if (status) parts.push(status);
  return parts.join(". ");
}
