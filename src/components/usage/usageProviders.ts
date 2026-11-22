import type { Provenance, UsageProviderKind } from "~/contracts";
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
  // Mistral Vibe sessions are Mistral usage whichever id a reader files them under.
  vibe: "mistral",
  "mistral-vibe": "mistral",
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

/**
 * Usage-limit sources that are not agent drivers (so not in `PROVIDER_PRESENTATION`), keyed by driver kind.
 * Add a new limit-only provider here: label and bar color. Its icon goes in `PROVIDER_ICON_BY_PROVIDER`.
 */
export const LIMIT_SOURCE_PRESENTATION: Readonly<
  Record<string, { readonly label: string; readonly color: string }>
> = {
  mistral: { label: "Mistral", color: "#e8b923" },
};

/**
 * burnrate: a small accent stripe for provenance badges. It always accompanies text
 * (see `usageLimitsCopy.provenanceDescription`), so the distinction never relies on colour alone.
 */
export const PROVENANCE_ACCENT: Readonly<Record<Provenance, string>> = {
  official: "oklch(0.62 0.14 150)",
  unofficial: "oklch(0.72 0.14 75)",
  statusline: "oklch(0.65 0.13 250)",
  local: "oklch(0.62 0.14 300)",
  estimated: "oklch(0.60 0.02 260)",
};

/** Display name for any driver that can appear in the limits view. */
export function usageDriverLabel(driver: string, clientLabel: string | undefined): string {
  return clientLabel ?? LIMIT_SOURCE_PRESENTATION[driver]?.label ?? driver;
}

/** Display order: well-known providers first, then any other provider the server reports. */
// OpenCode Go is a plan of OpenCode, and its sessions are filed under "opencode": one entry, not two.
export const PROVIDER_ORDER: UsageProviderKind[] = ["claude", "codex", "opencode", "mistral"];

export function registerUsageProviders(ids: readonly UsageProviderKind[]): void {
  for (const id of ids) if (!PROVIDER_ORDER.includes(id)) PROVIDER_ORDER.push(id);
}

/**
 * The providers worth offering in the filter: the ones connected on this computer (limit accounts,
 * or `/api/providers` `connected`/`detected`), with a log reader that found files (source status
 * "ok"/"partial"), or with usage in the loaded periods, or currently selected in the saved
 * preferences — a saved choice never silently disappears. Never the full catalogue: a source whose
 * reader found nothing ("missing"/"failed") and a saved id whose provider no longer exists are
 * ignored. Keeps the display order.
 */
export function configuredUsageProviders(
  sources: readonly {
    readonly fingerprint: { readonly provider: UsageProviderKind };
    readonly status?: string;
  }[],
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
  detectedProviders: Iterable<UsageProviderKind> = [],
): readonly UsageProviderKind[] {
  const present = new Set(detectedProviders);
  for (const source of sources)
    if (source.status === undefined || source.status === "ok" || source.status === "partial")
      present.add(source.fingerprint.provider);
  for (const provider of providersWithUsage(totals)) present.add(provider);
  const ordered = PROVIDER_ORDER.filter((provider) => present.delete(provider));
  return [...ordered, ...present];
}

export function setUsageProvidersVisible(
  hiddenProviders: ReadonlySet<UsageProviderKind>,
  providers: Iterable<UsageProviderKind>,
  visible: boolean,
): readonly UsageProviderKind[] {
  const next = new Set(hiddenProviders);
  for (const provider of providers) {
    if (visible) next.delete(provider);
    else next.add(provider);
  }
  return [...next];
}

export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  // Any provider with usage counts, even an id the server has not registered yet; offering it keeps
  // the menu in step with the totals, not with a fixed list.
  return totals
    .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
    .map((entry) => entry.provider);
}

/**
 * Apply Settings > Usage "Hide empty providers" to every provider list the page draws (the ranking
 * list, the chart legend and the filter menu), so they never disagree about what is shown.
 */
export function filterEmptyProviders(
  providers: readonly UsageProviderKind[],
  withData: ReadonlySet<UsageProviderKind>,
  hideEmpty: boolean,
): readonly UsageProviderKind[] {
  return hideEmpty ? providers.filter((provider) => withData.has(provider)) : providers;
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
