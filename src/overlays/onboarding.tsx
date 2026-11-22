import { lazy, Suspense, useEffect, useState } from "react";

import { api } from "~/api";
import {
  detectAgents,
  OPEN_TOUR_EVENT,
  persistOnboardedServerFlag,
  readOnboardedFlag,
  readOnboardedServerFlag,
  shouldShowOnboarding,
  syncServerFlagLocally,
  writeOnboardedFlag,
} from "~/onboarding";
import { getSettings, loadSettings } from "~/settings/store";

const OnboardingDialog = lazy(() => import("~/onboarding/OnboardingDialog").then((module) => ({ default: module.OnboardingDialog })));

/**
 * First-run welcome tour. Opens by itself once for a fresh profile, and again whenever a labelled
 * "Welcome tour" entry (Settings or the palette) asks via `openTour()`. Closing it any way counts as
 * done. An existing profile that already has a connected agent is marked done without a nag.
 */
export function Overlay() {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const markDone = () => {
      writeOnboardedFlag();
      void persistOnboardedServerFlag().catch(() => undefined);
    };
    const showTour = () => {
      setHasOpened(true);
      setOpen(true);
    };
    // The server flag is only known after settings load; if they cannot load, stay out of the way.
    loadSettings().then(
      () => {
        if (cancelled) return;
        const serverDone = readOnboardedServerFlag(getSettings());
        if (serverDone) syncServerFlagLocally();
        if (!shouldShowOnboarding(readOnboardedFlag(), serverDone)) return;
        // A returning user with a connected agent has already onboarded; don't nag them.
        api.providers().then(
          (providers) => {
            if (cancelled) return;
            if (detectAgents(providers).hasAnyConnection) {
              markDone();
              return;
            }
            showTour();
          },
          () => {
            // Providers unreachable: fall back to the flags and show the tour for a fresh profile.
            if (!cancelled) showTour();
          },
        );
      },
      () => undefined,
    );
    const onTour = () => showTour();
    const onLoadingEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !document.querySelector("[data-onboarding-loading]")) return;
      event.preventDefault();
      setOpen(false);
      markDone();
    };
    window.addEventListener(OPEN_TOUR_EVENT, onTour);
    window.addEventListener("keydown", onLoadingEscape);
    return () => {
      cancelled = true;
      window.removeEventListener(OPEN_TOUR_EVENT, onTour);
      window.removeEventListener("keydown", onLoadingEscape);
    };
  }, []);

  const close = () => {
    setOpen(false);
    writeOnboardedFlag();
    void persistOnboardedServerFlag().catch(() => undefined);
  };

  return hasOpened ? (
    <Suspense fallback={open ? <div role="dialog" aria-label="Welcome tour" data-open data-onboarding-loading className="fixed top-4 right-4 z-50 rounded-lg border bg-background px-4 py-3 text-sm shadow-lg">Loading welcome tour…</div> : null}>
      <OnboardingDialog open={open} onClose={close} />
    </Suspense>
  ) : null;
}
