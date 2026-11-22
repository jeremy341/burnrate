import { PlugIcon } from "lucide-react";
import { lazy, Suspense } from "react";

import { ProvidersSkeleton } from "~/components/skeletons/ProvidersSkeleton";
import { msg } from "~/i18n";
import type { ViewDef } from "./types";

// Loaded on first visit, like Settings.
const ProvidersPage = lazy(() => import("~/ProvidersPage").then((m) => ({ default: m.ProvidersPage })));

export const view: ViewDef = {
  id: "providers",
  title: msg("Providers"),
  icon: PlugIcon,
  order: 10,
  Component: ({ providers, limits }) => (
    <Suspense fallback={<ProvidersSkeleton />}>
      <ProvidersPage providers={providers} limits={limits} />
    </Suspense>
  ),
};
