/**
 * Public surface of the onboarding package.
 *
 * First run opens the setup tour (`OnboardingDialog`, mounted by `overlays/onboarding.tsx`); `openTour()`
 * reopens it. `openOnboarding()` (kept for existing callers) opens the Providers screen.
 *
 * `App.tsx` listens for `OPEN_ONBOARDING_EVENT`. `openSettingsSection()` sets the documented
 * `#settings/<id>` hash and emits `OPEN_SETTINGS_EVENT` for the settings shell to pick up.
 */
export const OPEN_ONBOARDING_EVENT = "burnrate:open-onboarding";
export const OPEN_SETTINGS_EVENT = "burnrate:open-settings";
/** Ask the setup tour to open (first run opens it by itself; Settings > Advanced can reopen it). */
export const OPEN_TOUR_EVENT = "burnrate:open-tour";

export function openTour(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_TOUR_EVENT));
}

export function openOnboarding(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_ONBOARDING_EVENT));
}

export function openSettingsSection(section: "notifications"): void {
  if (typeof window === "undefined") return;
  try {
    window.location.hash = `#settings/${section}`;
  } catch {
    /* some shells disable hash navigation */
  }
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section } }));
}

export {
  ONBOARDED_KEY,
  readOnboardedFlag,
  readOnboardedServerFlag,
  writeOnboardedFlag,
  persistOnboardedServerFlag,
  syncServerFlagLocally,
} from "./flags";
export {
  CLAUDE_PROVIDER_ID,
  ONBOARDING_STEPS,
  clampStep,
  detectAgents,
  isProviderConnected,
  pickKeyProvider,
  shouldShowOnboarding,
} from "./logic";
export type { DetectedAgents, OnboardingStep } from "./logic";
