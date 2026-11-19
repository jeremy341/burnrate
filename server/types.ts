import type { LimitsAccount, ProviderInfo } from "../src/contracts.ts";

export interface KeyStore {
  /** API keys saved for a provider, by account name. Values never leave the server. */
  list(providerId: string): Array<{ name: string; key: string }>;
}

/**
 * One usage source. To add a provider, write a module that exports one of these and
 * list it in `providers/index.ts`; the UI picks up id, label, color and auth kind from it.
 */
export interface ProviderModule {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  /** apiKey: the user pastes keys. localLogin: read an existing CLI login. */
  readonly auth: "apiKey" | "localLogin";
  /** Whether a local login exists (localLogin only). */
  hasLogin?(): boolean;
  read(keys: KeyStore): Promise<LimitsAccount[]>;
}

export type { LimitsAccount, ProviderInfo };
