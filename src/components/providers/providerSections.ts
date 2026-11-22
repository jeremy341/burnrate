import type { ProviderInfo } from "~/contracts";

import { localImportOffer } from "./agentTiles";
import { isProviderConnected, primaryAction } from "./providersList";

/** The blocks the Providers screen draws, top to bottom. `connected` stays open; the others fold. */
export type ProviderSectionId = "connected" | "available" | "notFound" | "hidden";

/**
 * Which block a provider-level row belongs to. Hidden wins, so a hidden provider waits in its block
 * until it is shown again. A saved or found login or key is connected. An agent this computer does
 * not have, with no sign-in, install or import to offer, folds into "not found".
 */
export function providerSection(provider: ProviderInfo, hidden: boolean): ProviderSectionId {
  if (hidden) return "hidden";
  if (isProviderConnected(provider)) return "connected";
  if (primaryAction(provider).kind === "none" && localImportOffer(provider) === null) return "notFound";
  return "available";
}
