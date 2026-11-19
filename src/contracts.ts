/** Plain-TypeScript data shapes shared by the Burnrate UI and server (no schema runtime). */

export type ProviderId = string;
export type IsoDateTime = string;

export interface UsageWindow {
  readonly id: string;
  readonly kind: "session" | "weekly" | "monthly" | "other";
  readonly label: string;
  readonly modelIds?: readonly string[];
  readonly providerIds?: readonly string[];
  /** 0..100 */
  readonly usedPercent: number;
  readonly resetsAt?: IsoDateTime;
  readonly windowDurationMins?: number;
}

export interface ResetCreditOption {
  readonly creditId: string;
  readonly label: string;
  readonly description: string;
  readonly availableCount: number;
  readonly expiresAt?: IsoDateTime;
}

export interface ResetCredits {
  readonly availableCount: number;
  readonly nextExpiresAt?: IsoDateTime;
  readonly nextCreditId?: string;
  readonly options?: readonly ResetCreditOption[];
}

export interface UsageLimits {
  readonly checkedAt: IsoDateTime;
  readonly windows: readonly UsageWindow[];
  readonly zeroSpendCap?: boolean;
  readonly resetCredits?: ResetCredits;
  readonly externalUsage?: { readonly label: string; readonly url: string };
  readonly unavailable?: { readonly reason: "unsupported" | "probeFailed"; readonly message?: string };
}

export interface LimitsAccount {
  readonly id: string;
  readonly driver: ProviderId;
  readonly label: string;
  readonly plan?: string;
  readonly email?: string;
  readonly sourceLabel?: string;
  readonly displayName?: string;
  readonly accentColor?: string;
  readonly limits: UsageLimits;
}

export interface LimitsReport {
  readonly createdAt: IsoDateTime;
  readonly accounts: readonly LimitsAccount[];
  readonly notices: readonly string[];
}

/** What the server says about each provider it can read. The UI renders whatever is listed. */
export interface ProviderInfo {
  readonly id: ProviderId;
  readonly label: string;
  readonly color: string;
  /** How the user connects it. */
  readonly auth: "apiKey" | "localLogin" | "localLogs";
  readonly connected: boolean;
  readonly accounts: readonly { readonly id: string; readonly label: string }[];
}

// ---- Cost and tokens ----

export type UsageProviderKind = string;
export type UsageDay = string;
export const UsageDay = { make: (value: string): UsageDay => value };
export type UsageCostSource = "providerReported" | "modelPriced" | "unpriced";

/** Reasoning tokens are already included in output; input is uncached + cache reads + cache writes. */
export interface UsageTokenTotals {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface UsageCategoryCost {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface UsageModelPriceOverride {
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
  cacheReadCostPerMillionTokens?: number;
  cacheWriteCostPerMillionTokens?: number;
}

export interface UsageBucket {
  day: UsageDay;
  sourcePath?: string;
  hourStart?: string;
  provider: UsageProviderKind;
  model: string;
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  categoryCostUsd?: UsageCategoryCost;
  fastCostUsd?: number;
  ultrafastCostUsd?: number;
  speedPremiumUsd?: number;
  costSource: UsageCostSource;
  records: number;
  unpricedRecords: number;
  unpricedTokens?: number;
  sessions: number;
}

export type EnvironmentId = string;

/** Bump for incompatible UsageSummary changes. */
export const USAGE_CONTRACT_VERSION = 6 as const;
export const USAGE_MERGE_COMPATIBLE_SINCE = 4 as const;

export interface UsageSourceFingerprint {
  hostId: string;
  provider: UsageProviderKind;
  resolvedHomePath: string;
  volumeId: string;
  physicalSourceId?: string;
}

export interface UsageSource {
  fingerprint: UsageSourceFingerprint;
  status: "ok" | "missing" | "partial" | "failed";
  scannedFiles: number;
  skippedFiles: number;
  malformedRecords: number;
  distinctSessions: number;
  message: string | null;
  refreshing?: true;
}

export interface UsagePricing {
  status: "fresh" | "cached" | "unavailable";
  source: string;
  fetchedAt: string | null;
  knownModels: number;
}

export type UsageResolution = "day" | "hour";

export interface UsageSummaryInput {
  sinceDay: UsageDay;
  untilDay: UsageDay;
  timeZone: string;
  resolution?: UsageResolution;
  sinceTime?: string;
  untilTime?: string;
  awaitRefresh?: boolean;
  provisional?: boolean;
}

export interface UsageModelSelector {
  provider?: string;
  model: string;
}

export interface UsageModelFilter {
  include?: readonly UsageModelSelector[];
  exclude?: readonly UsageModelSelector[];
}

/** Changes to the price table and model names; `null` removes an entry. */
export interface ServerSettingsPatch {
  usagePriceOverrides?: Record<string, UsageModelPriceOverride | null>;
  usageModelAliases?: Record<string, string | null>;
}

export interface UsageSummary {
  contractVersion: number;
  modelFilter?: UsageModelFilter;
  readAt: string;
  timeZone: string;
  sinceDay: UsageDay;
  untilDay: UsageDay;
  buckets: UsageBucket[];
  sources: UsageSource[];
  pricing: UsagePricing;
  scanDurationMs: number;
}
