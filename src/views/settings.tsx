import { SettingsIcon } from "lucide-react";
import { lazy, Suspense } from "react";

import { SettingsSkeleton } from "~/components/skeletons/SettingsSkeleton";
import { msg } from "~/i18n";
import type { ViewDef } from "./types";

// Loaded on first visit: the settings page and every section stay out of the first-paint bundle.
const SettingsPage = lazy(() => import("~/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));

export const view: ViewDef = {
  id: "settings",
  title: msg("Settings"),
  icon: SettingsIcon,
  order: 90,
  Component: () => (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsPage />
    </Suspense>
  ),
};
