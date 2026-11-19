import type { UsageProviderKind } from "~/contracts";
import { providerColor, providerLabel } from "~/providers/registry";

import type { UsageMetric } from "./usageShortcuts";

interface UsageProviderPresentation {
  readonly label: string;
  readonly color: string;
  readonly driverKind: string;
}

/** Usage records name providers by short ids ("claude"); limits name their drivers ("claudeAgent"). */
const DRIVER_BY_USAGE_PROVIDER: Readonly<Record<string, string>> = {
  claude: "claudeAgent",
};

const presentationOf = (provider: string): UsageProviderPresentation => {
  const driverKind = DRIVER_BY_USAGE_PROVIDER[provider] ?? provider;
  return { label: providerLabel(driverKind), color: providerColor(driverKind), driverKind };
};

/** Any provider id resolves: the server decides what exists, so there is no fixed list here. */
export const PROVIDER_PRESENTATION: Readonly<Record<string, UsageProviderPresentation>> = new Proxy(
  {} as Record<string, UsageProviderPresentation>,
  { get: (_target, key) => (typeof key === "string" ? presentationOf(key) : undefined) },
);

/** Display order: well-known providers first, then any other provider the server reports. */
export const PROVIDER_ORDER: UsageProviderKind[] = ["claude", "codex", "opencode", "mistral"];

export function registerUsageProviders(ids: readonly UsageProviderKind[]): void {
  for (const id of ids) if (!PROVIDER_ORDER.includes(id)) PROVIDER_ORDER.push(id);
}

export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const active = new Set(
    totals
      .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
      .map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => active.has(provider));
}

export function rankProvidersByMetric(
  providers: readonly UsageProviderKind[],
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
  metric: UsageMetric,
): readonly UsageProviderKind[] {
  const field = metric === "cost" ? "costUsd" : "totalTokens";
  const value = (provider: UsageProviderKind) =>
    totals.find((entry) => entry.provider === provider)?.[field] ?? 0;
  return providers.toSorted((left, right) => value(right) - value(left));
}
