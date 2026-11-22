import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Loaded } from "~/api";
import { clearUsageCache, type ScanProgress, useUsageWindow } from "~/api/usage";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type LimitsReport,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "~/contracts";
import { registerUsageProviders } from "~/components/usage/usageProviders";
import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "~/shared/usageMerge";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly canReadDiagnostics: boolean;
  readonly isConnected: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly isPending: boolean;
  readonly shown: { readonly window: UsageSummaryInput; readonly merged: MergedUsage } | null;
  readonly isPartial: boolean;
  /** Scan state the server reported with the answer (null for older servers). */
  readonly scan: ScanProgress | null;
  /** The answer is the last saved one, shown until this run's first scan finishes. */
  readonly stale: boolean;
  /** The last read failed and nothing is cached for this window. */
  readonly error: string | null;
  readonly refresh: (input?: UsageSummaryInput) => Promise<void>;
}

/** Burnrate reads one environment: this computer. */
export const LOCAL_ENVIRONMENT_ID: EnvironmentId = "local";
const LOCAL_LABEL = "This computer";
const NO_HIDDEN_PROVIDERS: ReadonlySet<UsageProviderKind> = new Set();
const usagePriceChanges = new EventTarget();

/** Price edits also invalidate figures in Usage when that screen is hidden. */
export function notifyUsagePricesChanged(): void {
  clearUsageCache();
  usagePriceChanges.dispatchEvent(new Event("change"));
}

export function mergeAnsweredUsage(
  environments: readonly EnvironmentUsageStatus[],
  keepBucket?: (bucket: UsageBucket) => boolean,
): MergedUsage {
  const answered: EnvironmentUsage[] = environments.flatMap(({ environmentId, label, summary }) =>
    summary === null
      ? []
      : [
          {
            environmentId,
            label,
            summary:
              keepBucket === undefined
                ? summary
                : { ...summary, buckets: summary.buckets.filter(keepBucket) },
          },
        ],
  );
  return mergeUsage(answered, USAGE_CONTRACT_VERSION);
}

function withoutProviders(
  environments: readonly EnvironmentUsageStatus[],
  hiddenProviders: ReadonlySet<UsageProviderKind>,
): readonly EnvironmentUsageStatus[] {
  if (hiddenProviders.size === 0) return environments;
  return environments.map((environment) =>
    environment.summary === null
      ? environment
      : {
          ...environment,
          summary: {
            ...environment.summary,
            buckets: environment.summary.buckets.filter(
              (bucket) => !hiddenProviders.has(bucket.provider),
            ),
            sources: environment.summary.sources.filter(
              (source) => !hiddenProviders.has(source.fingerprint.provider),
            ),
          },
        },
  );
}

function deriveSelection(
  environments: readonly EnvironmentUsageStatus[],
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
) {
  const selectedEnvironments =
    selectedEnvironmentIds === null
      ? environments
      : environments.filter((environment) => selectedEnvironmentIds.has(environment.environmentId));
  return {
    selectedEnvironments,
    merged: mergeAnsweredUsage(withoutProviders(selectedEnvironments, hiddenProviders)),
  };
}

/**
 * Same shape as T3's `useUsage`, backed by Burnrate's `/api/usage` fetch layer instead of Effect atoms.
 * There is one environment here, but selection/hiding follow T3's derivation rules so the page behaves
 * identically when the local environment is deselected.
 */
export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
  hiddenProviders: ReadonlySet<UsageProviderKind> = NO_HIDDEN_PROVIDERS,
): UsageView {
  const usageWindow = useUsageWindow(input);
  const { refresh } = usageWindow;
  useEffect(() => {
    const reprice = () => void refresh();
    usagePriceChanges.addEventListener("change", reprice);
    return () => usagePriceChanges.removeEventListener("change", reprice);
  }, [refresh]);
  const summary = usageWindow.response;
  const pending = usageWindow.loading;
  const error = usageWindow.error;
  useEffect(() => {
    if (summary !== null) {
      registerUsageProviders([...new Set(summary.buckets.map((bucket) => bucket.provider))]);
    }
  }, [summary]);

  const environments = useMemo<readonly EnvironmentUsageStatus[]>(() => {
    const environment: EnvironmentUsageStatus = {
      environmentId: LOCAL_ENVIRONMENT_ID,
      label: LOCAL_LABEL,
      isPending: pending,
      canReadDiagnostics: true,
      isConnected: true,
      error: error === null ? null : "Could not read usage on this computer.",
      summary,
    };
    return [environment];
  }, [summary, pending, error]);

  const { selectedEnvironments, merged } = useMemo(
    () => deriveSelection(environments, selectedEnvironmentIds, hiddenProviders),
    [environments, selectedEnvironmentIds, hiddenProviders],
  );

  const answeredCount = selectedEnvironments.filter(
    (environment) => environment.summary !== null,
  ).length;
  const stillReporting = selectedEnvironments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;
  const isPending = answeredCount === 0 && stillReporting > 0;

  const [lastAnswered, setLastAnswered] = useState<
    | (NonNullable<UsageView["shown"]> & {
        readonly selection: typeof selectedEnvironmentIds;
        readonly hidden: typeof hiddenProviders;
      })
    | null
  >(null);
  if (
    answeredCount > 0 &&
    (lastAnswered?.merged !== merged ||
      lastAnswered.window !== input ||
      lastAnswered.selection !== selectedEnvironmentIds ||
      lastAnswered.hidden !== hiddenProviders)
  ) {
    setLastAnswered({
      window: input,
      merged,
      selection: selectedEnvironmentIds,
      hidden: hiddenProviders,
    });
  }
  const kept =
    lastAnswered?.selection === selectedEnvironmentIds && lastAnswered.hidden === hiddenProviders
      ? lastAnswered
      : null;
  const shown =
    answeredCount > 0
      ? { window: input, merged }
      : (kept ?? (isPending ? null : { window: input, merged }));

  return {
    merged,
    environments,
    selectedEnvironments,
    isPending,
    shown,
    isPartial: answeredCount > 0 && stillReporting > 0,
    scan: usageWindow.scan,
    stale: usageWindow.stale,
    error,
    refresh,
  };
}

// ---------------------------------------------------------------------------
// App-shell refresh helpers (report 05, sections 1-2).
//
// These are deliberately pure where possible so the throttle/ticker rules can be
// unit-tested without a DOM. The React hooks below only add timers/listeners and
// always clean them up.
// ---------------------------------------------------------------------------

/** T3's `refreshUsageLimits` throttle: at most one automatic refresh every five minutes. */
export const LIMITS_AUTO_REFRESH_THROTTLE_MS = 5 * 60 * 1000;
/** The server contract clamps `usage.refreshIntervalSec` to 30 s (contracts section 8). */
export const MIN_LIMITS_REFRESH_INTERVAL_SEC = 30;
/** One minute, aligned to wall-clock boundaries by `useMinuteNow`. */
export const MINUTE_MS = 60_000;

/**
 * Pure throttle check. A `null` timestamp means "never refreshed", so the first
 * automatic refresh is always allowed.
 */
export function shouldRefreshLimits(
  lastRefreshAt: number | null,
  now: number,
  throttleMs: number = LIMITS_AUTO_REFRESH_THROTTLE_MS,
): boolean {
  if (lastRefreshAt === null) return true;
  if (!Number.isFinite(lastRefreshAt)) return true;
  return now - lastRefreshAt >= throttleMs;
}

/** Clamp a configured refresh interval (seconds) to the 30 s minimum. */
export function effectiveRefreshIntervalSec(seconds: number): number {
  const value = Number.isFinite(seconds) ? Math.floor(seconds) : MIN_LIMITS_REFRESH_INTERVAL_SEC;
  return Math.max(MIN_LIMITS_REFRESH_INTERVAL_SEC, value);
}

/** Milliseconds until the next wall-clock minute boundary. */
export function msUntilNextMinute(now: number): number {
  return MINUTE_MS - (now % MINUTE_MS);
}

/**
 * A 60 s ticker for reset countdowns. It aligns to minute boundaries, pauses completely
 * while the document is hidden, and refreshes immediately when the page becomes visible
 * again (no catch-up storm). Enabled only while the view hosting Limits is visible.
 */
export function useMinuteNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      timer = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, msUntilNextMinute(Date.now()));
    };
    const clear = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        if (timer === undefined) schedule();
      } else {
        clear();
      }
    };

    if (document.visibilityState === "visible") schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clear();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled]);

  return now;
}

export interface LimitsPollingOptions {
  /** `usage.refreshIntervalSec` from settings; values below 30 s are clamped. */
  readonly refreshIntervalSec: number;
  /** `usage.refreshOnFocus` from settings. */
  readonly refreshOnFocus: boolean;
  /** `usage.pollWhenHidden` from settings. */
  readonly pollWhenHidden: boolean;
  /** True while the view that hosts the Limits panel is visible. */
  readonly active: boolean;
}

export interface LimitsPolling {
  /** Explicit refresh (Refresh button / Retry). In-flight calls are coalesced. */
  readonly refresh: () => void;
  /** Call when entering Limits; throttled to one automatic refresh per five minutes. */
  readonly onLimitsEnter: () => void;
  /** Timestamp of the last accepted refresh, used for freshness UI. */
  readonly lastRefreshAt: number | null;
}

/**
 * Wraps the `Loaded<LimitsReport>` returned by `useLimits()` with the app-shell policies:
 * 5-minute throttle on entering Limits, in-flight coalescing, configurable interval polling,
 * refresh-on-focus and a `pollWhenHidden` opt-out. No polling happens while the host view is
 * hidden unless `pollWhenHidden` is enabled.
 */
export function useLimitsPolling(
  limits: Omit<Loaded<LimitsReport>, "reload"> & {
    readonly reload: () => Promise<void>;
    readonly forceReload: () => Promise<void>;
  },
  options: LimitsPollingOptions,
): LimitsPolling {
  const { refreshIntervalSec, refreshOnFocus, pollWhenHidden, active } = options;
  const intervalMs = effectiveRefreshIntervalSec(refreshIntervalSec) * 1000;
  const lastRefreshAtRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const inFlightForcedRef = useRef(false);
  const pendingForceRef = useRef(false);
  const disposedRef = useRef(false);
  const requestRef = useRef<(force: boolean) => void>(() => {});
  const loadingRef = useRef(limits.loading);
  loadingRef.current = limits.loading;
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      pendingForceRef.current = false;
    };
  }, []);

  const requestRefresh = useCallback((force: boolean) => {
    if (inFlightRef.current || loadingRef.current) {
      if (force && !inFlightForcedRef.current) pendingForceRef.current = true;
      return;
    }
    inFlightRef.current = true;
    inFlightForcedRef.current = force;
    const at = Date.now();
    lastRefreshAtRef.current = at;
    setLastRefreshAt(at);
    const request = force ? limits.forceReload() : limits.reload();
    void request.finally(() => {
      inFlightRef.current = false;
      inFlightForcedRef.current = false;
      if (disposedRef.current) return;
      if (pendingForceRef.current) {
        pendingForceRef.current = false;
        // The promise can settle before React publishes loading=false.
        loadingRef.current = false;
        requestRef.current(true);
      }
    });
  }, [limits.reload, limits.forceReload]);
  requestRef.current = requestRefresh;

  // A manual request arriving during a cached read must still trigger a real probe afterward.
  useEffect(() => {
    if (!limits.loading && !inFlightRef.current && pendingForceRef.current) {
      pendingForceRef.current = false;
      requestRefresh(true);
    }
  }, [limits.loading, requestRefresh]);

  const refresh = useCallback(() => requestRefresh(true), [requestRefresh]);

  const autoRefresh = useCallback(() => {
    if (!shouldRefreshLimits(lastRefreshAtRef.current, Date.now())) return;
    requestRefresh(false);
  }, [requestRefresh]);

  // Interval polling while the host view is visible (or while explicitly allowed when hidden).
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (document.hidden && !pollWhenHidden) return;
      requestRefresh(false);
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, pollWhenHidden, requestRefresh]);

  // Refresh-on-focus, throttled so repeated focus events cannot spam the server.
  useEffect(() => {
    if (!refreshOnFocus) return;
    const onFocus = () => {
      if (!activeRef.current) return;
      if (document.hidden && !pollWhenHidden) return;
      autoRefresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshOnFocus, pollWhenHidden, autoRefresh]);

  return { refresh, onLimitsEnter: autoRefresh, lastRefreshAt };
}

