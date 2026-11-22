import type {
  Provenance,
  ResetCredits as ServerProviderResetCredits,
  UsageLimits as ServerProviderUsageLimits,
  UsageWindow as ServerProviderUsageWindow,
} from "~/contracts";
import { mFallback, msg, type MFunctionType } from "~/i18n";

import {
  cursorUsageWindowDetails as cursorUsageWindowDetailsBase,
  isLimitSnapshotStale,
  type LimitPool,
  type ProjectedEmpty,
  type ResetCreditChoice,
  resetCountdown,
} from "./usageLimits";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CURSOR_USAGE_WINDOW_COPY: Readonly<
  Record<string, { readonly label: string; readonly description: string }>
> = {
  totalPercentUsed: {
    label: msg("Overall", { $context: "usage limit covering the whole plan" }),
    description: msg("All usage on your plan this billing cycle."),
  },
  autoPercentUsed: {
    label: msg("Cursor Models"),
    description: msg("Grok, Composer, and Auto use this allowance."),
  },
  apiPercentUsed: {
    label: msg("Other Models"),
    description: msg("Usage allowance for third-party models such as Claude, GPT, and Gemini."),
  },
};

/** @public */
export function cursorUsageWindowDetails(
  id: string,
  pool: LimitPool,
  resolve: MFunctionType = mFallback,
) {
  const details = cursorUsageWindowDetailsBase(id, pool);
  const copy = CURSOR_USAGE_WINDOW_COPY[id];
  if (!details || !copy) return details;
  return {
    ...details,
    label: details.label === null ? null : resolve(copy.label),
    description: details.description === undefined ? undefined : resolve(copy.description),
  };
}

/** @public */
export function limitsNotice(
  limits: ServerProviderUsageLimits,
  resolve: MFunctionType = mFallback,
): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? resolve(msg("This account has no subscription limits."));
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? resolve(msg("Could not read limits."));
  }
  return limits.windows.length === 0 ? resolve(msg("No limits reported.")) : null;
}

/** @public */
export function formatDuration(ms: number, resolve: MFunctionType = mFallback): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return resolve(msg("{days}d {hours}h", { days, hours }));
  if (hours > 0) return resolve(msg("{hours}h {minutes}m", { hours, minutes }));
  return resolve(msg("{minutes}m", { minutes }));
}

export interface LimitFreshness {
  readonly short: string;
  readonly message: string;
  readonly description: string;
}

export function limitFreshness(
  limits: ServerProviderUsageLimits,
  now: number,
  refreshIntervalSec: number,
  resolve: MFunctionType = mFallback,
): LimitFreshness | null {
  if (!isLimitSnapshotStale(limits, now, refreshIntervalSec)) return null;

  const cachedAt = limits.staleSince === undefined ? NaN : Date.parse(limits.staleSince);
  const readAt = Number.isFinite(cachedAt) ? cachedAt : Date.parse(limits.checkedAt);
  const age = now - readAt;
  const duration = age >= MINUTE ? formatDuration(age, resolve) : null;
  const message = limits.staleMessage || staleAgeMessage(age, resolve);
  const description = limits.staleReason
    ? `${message}${/[.!?]$/.test(message) ? " " : ". "}${limits.staleReason}`
    : message;

  return {
    short: duration === null ? resolve(msg("Old data")) : resolve(msg("{duration} old", { duration })),
    message,
    description,
  };
}

function staleAgeMessage(age: number, resolve: MFunctionType): string {
  if (age >= DAY) {
    return resolve(msg("Showing values from {count, plural, one {{count} day} other {{count} days}} ago", { count: Math.floor(age / DAY) }));
  }
  if (age >= HOUR) {
    return resolve(msg("Showing values from {count, plural, one {{count} hour} other {{count} hours}} ago", { count: Math.floor(age / HOUR) }));
  }
  if (age >= MINUTE) {
    return resolve(msg("Showing values from {count, plural, one {{count} minute} other {{count} minutes}} ago", { count: Math.floor(age / MINUTE) }));
  }
  return resolve(msg("Showing the last known values"));
}

/** @public */
export function resetCreditChoices(
  credits: ServerProviderResetCredits,
  now: number,
  compact = false,
  resolve: MFunctionType = mFallback,
): ReadonlyArray<ResetCreditChoice> {
  const expiresIn = (at: string | undefined) =>
    at ? formatDuration(Date.parse(at) - now, resolve) : null;
  if (credits.options) {
    return credits.options.map((option) => {
      const expires = expiresIn(option.expiresAt);
      const values = { label: option.label, count: option.availableCount };
      return {
        key: option.creditId,
        summary: expires
          ? resolve(msg("{label} · {count} left · expires in {expires}", { ...values, expires }))
          : resolve(msg("{label} · {count} left", values)),
        actionLabel: resolve(msg("Use", { $context: "button that redeems a reset credit" })),
        confirmDescription: resolve(
          msg("{label}: {description} This cannot be undone.", {
            label: option.label,
            description: option.description,
          }),
        ),
        availableCount: option.availableCount,
      };
    });
  }
  const count = credits.availableCount;
  const expires = expiresIn(credits.nextExpiresAt);
  return [
    {
      key: "next",
      summary:
        count === 0
          ? resolve(msg("No reset credits banked"))
          : compact
            ? expires
              ? resolve(msg("{count} banked · expires in {expires}", { count, expires }))
              : resolve(msg("{count} banked", { count }))
            : expires
              ? resolve(
                  msg(
                    "{count, plural, one {{count} reset credit banked · next expires in {expires}} other {{count} reset credits banked · next expires in {expires}}}",
                    { count, expires },
                  ),
                )
              : resolve(
                  msg(
                    "{count, plural, one {{count} reset credit banked} other {{count} reset credits banked}}",
                    { count },
                  ),
                ),
      actionLabel: resolve(msg("Use reset")),
      confirmDescription: resolve(
        msg(
          "This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.",
        ),
      ),
      availableCount: count,
    },
  ];
}

/**
 * `full` reads "resets in 2h 5m", `in` reads "in 2h 5m", `refill` reads "↻ 2h 5m".
 * @public
 */
export function formatResetsIn(
  window: ServerProviderUsageWindow,
  now: number,
  resolve: MFunctionType = mFallback,
  style: "full" | "in" | "refill" = "full",
): string | null {
  const countdown = resetCountdown(window, now);
  if (countdown === null) return null;
  if (countdown.kind === "now") return resolve(msg("resets now"));
  if (countdown.kind === "momentarily") return resolve(msg("Resets momentarily"));
  const duration = formatDuration(countdown.ms, resolve);
  if (style === "in") {
    return resolve(
      msg("in {duration}", { duration, $context: "time until a usage window resets" }),
    );
  }
  if (style === "refill") return resolve(msg("↻ {duration}", { duration }));
  return resolve(msg("resets in {duration}", { duration }));
}

// burnrate: the short badge text and its full, tooltip/aria explanation for each source.
const PROVENANCE_COPY: Readonly<
  Record<Provenance, { readonly short: string; readonly description: string }>
> = {
  official: {
    short: msg("Official"),
    description: msg("From the provider's documented API."),
  },
  unofficial: {
    short: msg("Unofficial"),
    description: msg("From an undocumented endpoint; it may change without notice."),
  },
  statusline: {
    short: msg("Statusline"),
    description: msg("Reported by Claude Code's statusline."),
  },
  local: {
    short: msg("Local"),
    description: msg("Measured locally from your own usage records."),
  },
  estimated: {
    short: msg("Estimated"),
    description: msg("Estimated from the data available; treat it as approximate."),
  },
};

/** @public burnrate */
export function provenanceShortLabel(provenance: Provenance, resolve: MFunctionType = mFallback) {
  return resolve(PROVENANCE_COPY[provenance].short);
}

/** @public burnrate */
export function provenanceDescription(provenance: Provenance, resolve: MFunctionType = mFallback) {
  return resolve(PROVENANCE_COPY[provenance].description);
}

/** @public burnrate: a human-readable reading of the value a meter bar represents. */
export function barValueText(
  value: number,
  mode: "remaining" | "used",
  resolve: MFunctionType = mFallback,
) {
  return mode === "used"
    ? resolve(msg("{value}% used", { value }))
    : resolve(msg("{value}% left", { value }));
}

/** @public burnrate: short "runs out in ..." copy for a projected exhaustion. */
export function formatTimeToEmpty(
  empty: ProjectedEmpty,
  now: number,
  resolve: MFunctionType = mFallback,
) {
  return resolve(msg("empty in {duration}", { duration: formatDuration(empty.at - now, resolve) }));
}

/** @public burnrate: money-shaped balance amount, with a plain fallback for unknown currencies. */
export function formatMoney(amount: number, currency: string, locale?: string) {
  try {
    return new Intl.NumberFormat(locale === undefined || locale === "en" ? "en-US" : locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}
