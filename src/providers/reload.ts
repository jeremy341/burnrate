/**
 * A tiny bridge so a sign-in finished anywhere (the Usage empty state, the onboarding dialog,
 * the Providers screen) refreshes everything that lists providers or limits. The app shell owns
 * the data, so these surfaces ask rather than reach into it.
 */
import { dispatchPaletteAction } from "~/palette/actions";

export const PROVIDERS_STALE_EVENT = "burnrate:providers-stale";

/** Providers or their accounts changed: reload the list and re-read the limits. */
export function notifyProvidersChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROVIDERS_STALE_EVENT));
  dispatchPaletteAction({ type: "refreshLimits" });
}

/** Listen for `notifyProvidersChanged`. Returns the unsubscribe. */
export function onProvidersStale(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(PROVIDERS_STALE_EVENT, listener);
  return () => window.removeEventListener(PROVIDERS_STALE_EVENT, listener);
}

// ---- "Add provider" requests ----
// The wizard lives on the Providers screen, which loads lazily. A request made from elsewhere
// (the Usage empty state, the onboarding dialog) is therefore remembered until that screen mounts.

export const ADD_PROVIDER_EVENT = "burnrate:add-provider";

let pendingAddProvider = false;

/** Take the Providers screen to the Add provider wizard. */
export function requestAddProvider(): void {
  if (typeof window === "undefined") return;
  pendingAddProvider = true;
  window.dispatchEvent(new CustomEvent(ADD_PROVIDER_EVENT));
  dispatchPaletteAction({ type: "addProvider" });
}

/** True once per request; the Providers screen calls it when it mounts and when the event fires. */
export function consumeAddProviderRequest(): boolean {
  const pending = pendingAddProvider;
  pendingAddProvider = false;
  return pending;
}

export function onAddProviderRequested(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(ADD_PROVIDER_EVENT, listener);
  return () => window.removeEventListener(ADD_PROVIDER_EVENT, listener);
}
