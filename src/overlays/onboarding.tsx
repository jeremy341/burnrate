import { useEffect, useState } from "react";

import { api } from "~/api";
import { OnboardingDialog } from "~/onboarding/OnboardingDialog";
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

/**
 * First-run welcome tour. Opens by itself once for a fresh profile, and again whenever a labelled
 * "Welcome tour" entry (Settings or the palette) asks via `openTour()`. Closing it any way counts as
 * done. An existing profile that already has a connected agent is marked done without a nag.
 */
export function Overlay() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const markDone = () => {
      writeOnboardedFlag();
      void persistOnboardedServerFlag().catch(() => undefined);
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
            setOpen(true);
          },
          () => {
            // Providers unreachable: fall back to the flags and show the tour for a fresh profile.
            if (!cancelled) setOpen(true);
          },
        );
      },
      () => undefined,
    );
    const onTour = () => setOpen(true);
    window.addEventListener(OPEN_TOUR_EVENT, onTour);
    return () => {
      cancelled = true;
      window.removeEventListener(OPEN_TOUR_EVENT, onTour);
    };
  }, []);

  const close = () => {
    setOpen(false);
    writeOnboardedFlag();
    void persistOnboardedServerFlag().catch(() => undefined);
  };

  return <OnboardingDialog open={open} onClose={close} />;
}
