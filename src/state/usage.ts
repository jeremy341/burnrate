import { useCallback, useEffect, useMemo, useState } from "react";

import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "~/contracts";
import { registerUsageProviders } from "~/components/usage/usageProviders";
import { mergeUsage, type MergedUsage } from "~/shared/usageMerge";

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
  readonly refresh: (input?: UsageSummaryInput) => Promise<void>;
}

/** Burnrate reads one environment: this computer. */
export const LOCAL_ENVIRONMENT_ID: EnvironmentId = "local";
const LOCAL_LABEL = "This computer";
const NO_HIDDEN: ReadonlySet<UsageProviderKind> = new Set();

async function fetchSummary(input: UsageSummaryInput): Promise<UsageSummary> {
  const q = new URLSearchParams({
    since: input.sinceDay,
    until: input.untilDay,
    tz: input.timeZone,
    ...(input.resolution ? { resolution: input.resolution } : {}),
  });
  const res = await fetch(`/api/usage?${q}`, { headers: { "X-Burnrate": "1" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as UsageSummary;
}

export function useUsage(
  input: UsageSummaryInput,
  hiddenProviders: ReadonlySet<UsageProviderKind> = NO_HIDDEN,
): UsageView {
  const windowKey = JSON.stringify({
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    timeZone: input.timeZone,
    resolution: input.resolution,
    sinceTime: input.sinceTime,
    untilTime: input.untilTime,
  });
  const [state, setState] = useState<{
    summary: UsageSummary | null;
    key: string | null;
    error: string | null;
    pending: boolean;
  }>({ summary: null, key: null, error: null, pending: true });

  const load = useCallback(
    async (next: UsageSummaryInput, key: string) => {
      setState((s) => ({ ...s, pending: true }));
      try {
        const summary = await fetchSummary(next);
        registerUsageProviders([...new Set(summary.buckets.map((b) => b.provider))]);
        setState({ summary, key, error: null, pending: false });
      } catch (e) {
        setState((s) => ({ ...s, error: e instanceof Error ? e.message : "error", pending: false }));
      }
    },
    [],
  );

  useEffect(() => {
    void load(JSON.parse(windowKey) as UsageSummaryInput, windowKey);
  }, [windowKey, load]);

  const environment: EnvironmentUsageStatus = useMemo(
    () => ({
      environmentId: LOCAL_ENVIRONMENT_ID,
      label: LOCAL_LABEL,
      isPending: state.pending,
      canReadDiagnostics: true,
      isConnected: true,
      error: state.error === null ? null : "Could not read usage on this computer.",
      summary: state.summary,
    }),
    [state],
  );

  const visible = useMemo((): EnvironmentUsageStatus => {
    if (environment.summary === null || hiddenProviders.size === 0) return environment;
    return {
      ...environment,
      summary: {
        ...environment.summary,
        buckets: environment.summary.buckets.filter((b) => !hiddenProviders.has(b.provider)),
        sources: environment.summary.sources.filter((s) => !hiddenProviders.has(s.fingerprint.provider)),
      },
    };
  }, [environment, hiddenProviders]);

  const environments = useMemo(() => [visible], [visible]);
  const merged = useMemo(
    () =>
      mergeUsage(
        visible.summary === null
          ? []
          : [{ environmentId: LOCAL_ENVIRONMENT_ID, label: LOCAL_LABEL, summary: visible.summary }],
        USAGE_CONTRACT_VERSION,
      ),
    [visible],
  );

  const answered = state.summary !== null;
  // Keep showing the last answer while a new window loads.
  const shown = answered
    ? { window: state.key === windowKey ? input : (JSON.parse(state.key ?? windowKey) as UsageSummaryInput), merged }
    : null;

  const refresh = useCallback(
    (next?: UsageSummaryInput) => load(next ?? (JSON.parse(windowKey) as UsageSummaryInput), windowKey),
    [load, windowKey],
  );

  return {
    merged,
    environments,
    selectedEnvironments: environments,
    isPending: !answered && state.pending,
    shown,
    isPartial: false,
    refresh,
  };
}

export function mergeAnsweredUsage(
  environments: readonly EnvironmentUsageStatus[],
  keepBucket?: (bucket: UsageBucket) => boolean,
): MergedUsage {
  return mergeUsage(
    environments.flatMap(({ environmentId, label, summary }) =>
      summary === null
        ? []
        : [
            {
              environmentId,
              label,
              summary: keepBucket === undefined ? summary : { ...summary, buckets: summary.buckets.filter(keepBucket) },
            },
          ],
    ),
    USAGE_CONTRACT_VERSION,
  );
}
