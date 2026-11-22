/** Plain-TypeScript data shapes shared by the Burnrate UI and server (no schema runtime). */

export type ProviderId = string;
export type IsoDateTime = string;

/** Where a number comes from. "official" = documented provider API, "unofficial" = undocumented endpoint, "statusline" = pushed by the Claude Code statusline, "local" = measured from local logs/budgets, "estimated" = derived. */
export type Provenance = "official" | "unofficial" | "statusline" | "local" | "estimated";

/** Money-shaped data that does not fit a percent window (balance, spend, key cap). Amounts are in major units (dollars). */
export interface UsageBalance {
  readonly id: string;
  readonly label: string;
  readonly kind: "credit" | "spend" | "cap";
  readonly amount: number;
  readonly currency: string;
  /** For kind "cap"/"spend": the limit the amount counts against. */
  readonly limit?: number;
  readonly resetsAt?: IsoDateTime;
  readonly provenance?: Provenance;
}

export interface UsageWindow {
  readonly id: string;
  readonly provenance?: Provenance;
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
  readonly balances?: readonly UsageBalance[];
  readonly externalUsage?: { readonly label: string; readonly url: string };
  readonly unavailable?: { readonly reason: "unsupported" | "probeFailed"; readonly message?: string };
  /** The numbers are the last good read because the provider is rate limiting or unreachable. */
  readonly stale?: boolean;
  /** When the stale numbers were read. */
  readonly staleSince?: IsoDateTime;
  /** Ready-to-show sentence, e.g. "Showing values from 12 minutes ago". */
  readonly staleMessage?: string;
  /** Why the refresh failed, e.g. "Claude usage unavailable (HTTP 429)." */
  readonly staleReason?: string;
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
  /** Name of this computer, shown where T3 Code shows the environment. */
  readonly hostLabel?: string;
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
  readonly accountsRenamable?: boolean;
  /**
   * What kind of source this is, so the Providers screen can lead with agents and keep
   * organisation keys under Advanced. Older servers omit it; the UI then groups by id/auth.
   */
  readonly category?: ProviderCategory;
  /** A CLI sign-in Burnrate can run for this provider. `null` = none; absent = server unaware. */
  readonly login?: ProviderLogin | null;
  /** Where the user creates a key for this provider (key-based plans such as OpenCode Go). */
  readonly keyUrl?: string;
  /** One short line shown under the name, e.g. "Detected on this computer". */
  readonly hint?: string;
  /**
   * Folders the user listed under Settings > Providers > Local sources for this provider's agent,
   * each with whether the server can see it. Absent when nothing is configured or an older server
   * does not report it. Shape of `SourceStatus` in `src/settings/sources.ts`.
   */
  readonly sources?: readonly { readonly path: string; readonly found: boolean }[];
  /** Found on this computer (a local login or local files exist), whether or not it is connected yet. */
  readonly detected?: boolean;
  /**
   * What a local-log provider's own files measured (Pi, Muse Code; `auth: "localLogs"` only, when
   * the server found their folder). Counts and timestamps from the session logs, never a quota.
   */
  readonly stats?: {
    readonly sessions: number;
    readonly lastUsedAt?: IsoDateTime;
    /** The folder the logs were found in (first existing candidate). */
    readonly folder: string;
  };
  /** A key this provider's own app already holds that can be imported in one click (e.g. Mistral Vibe). */
  readonly localImport?: { readonly source: string };
}

export type ProviderCategory = "agent" | "apiKey" | "admin" | "localLogs";

export interface ProviderLogin {
  readonly kind: "cli";
  /** The command the sign-in runs, e.g. `claude`, `codex`. */
  readonly command: string;
  readonly installed: boolean;
  readonly installUrl: string;
}

// ---- Accounts and CLI sign-in ----

/** One saved account as reported by `/api/providers`. */
export interface ProviderAccount {
  readonly id: string;
  readonly label: string;
}

/** Where a CLI sign-in flow is (`GET /api/accounts/flows/<id>`). Claude's old routes use the same words. */
export type LoginFlowPhase = "starting" | "waitingForBrowser" | "connected" | "failed" | "cancelled";

export interface TestKeyResult {
  readonly ok: boolean;
  readonly error?: string;
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
  /** Distinct sessions active in the requested window. Older servers omit it; fall back to distinctSessions. */
  windowSessions?: number;
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
