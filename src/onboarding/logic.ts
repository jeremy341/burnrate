/** Pure, UI-free logic for the first-run welcome tour. */
import type { ProviderInfo } from "~/contracts";

/** The Claude provider id used by the rest of the app (see ProvidersPage). */
export const CLAUDE_PROVIDER_ID = "claudeAgent";

/** Two short screens: connect an agent, then where everything lives. */
export const ONBOARDING_STEPS = ["Welcome", "Done"] as const;
export type OnboardingStep = 0 | 1;

/** The tour only ever has two steps; clamp every navigation request into that range. */
export function clampStep(step: number): OnboardingStep {
  if (step <= 0) return 0;
  return (ONBOARDING_STEPS.length - 1) as OnboardingStep;
}

/** A provider is "installed" for our purposes when the server reports a connection or any saved account. */
export function isProviderConnected(provider: ProviderInfo): boolean {
  return provider.connected || provider.accounts.length > 0;
}

export interface DetectedAgents {
  /** Agents with a usable connection (browser login, saved key, or local logins). */
  readonly connected: readonly ProviderInfo[];
  /** Known agents that are not connected yet. */
  readonly available: readonly ProviderInfo[];
  /** The Claude agent, if the server knows it at all. */
  readonly claude: ProviderInfo | null;
  /** Providers that can be connected by saving an API key. */
  readonly keyProviders: readonly ProviderInfo[];
  readonly hasAnyConnection: boolean;
}

/** Group `/api/providers` into the checklist the tour shows. Order comes from the server. */
export function detectAgents(providers: readonly ProviderInfo[]): DetectedAgents {
  const connected = providers.filter(isProviderConnected);
  const connectedIds = new Set(connected.map((p) => p.id));
  return {
    connected,
    available: providers.filter((p) => !connectedIds.has(p.id)),
    claude: providers.find((p) => p.id === CLAUDE_PROVIDER_ID) ?? null,
    keyProviders: providers.filter((p) => p.auth === "apiKey"),
    hasAnyConnection: connected.length > 0,
  };
}

/**
 * Pick the provider for the one-click "Add API key provider" action. The user's explicit choice wins;
 * otherwise prefer a key provider that is not connected yet, then fall back to the first one.
 */
export function pickKeyProvider(
  providers: readonly ProviderInfo[],
  preferredId?: string | null,
): ProviderInfo | null {
  const keyProviders = providers.filter((p) => p.auth === "apiKey");
  if (preferredId) {
    const match = keyProviders.find((p) => p.id === preferredId);
    if (match) return match;
  }
  return keyProviders.find((p) => !isProviderConnected(p)) ?? keyProviders[0] ?? null;
}

/**
 * The tour is first-run only. Either persistence flag silences it for good, and an existing profile
 * that already has a connected agent is never nagged even if its flags are missing (e.g. after a
 browser data wipe). The third argument defaults to false so flag-only callers keep their behaviour.
 */
export function shouldShowOnboarding(
  localDone: boolean,
  serverDone: boolean,
  hasAnyConnection = false,
): boolean {
  if (localDone || serverDone) return false;
  return !hasAnyConnection;
}

/** Where the tour's last button lands: the limits once something is connected, Providers otherwise. */
export function tourLandingView(hasAnyConnection: boolean): "usage" | "providers" {
  return hasAnyConnection ? "usage" : "providers";
}
