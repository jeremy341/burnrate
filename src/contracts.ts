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
