/**
 * Adapter for T3's `state/server` settings atom and update command. The data comes
 * from Burnrate's `/api/settings` fetch layer instead of the RPC/Effect runtime.
 */

import { api, type SavedSettings } from "~/api";
import type { ServerSettingsPatch } from "~/contracts";

import { Atom } from "./effectReactivity";
import { notify } from "./store";

let settings: SavedSettings | null = null;
let loading: Promise<void> | null = null;

function ensureSettingsLoaded(): void {
  if (loading !== null) return;
  loading = api.settings().then(
    (loaded) => {
      settings = loaded;
      notify();
    },
    () => {
      notify();
    },
  );
}

const settingsLoadAtom = Atom.make(() => {
  ensureSettingsLoaded();
  return true;
});

export const serverEnvironment = {
  settingsValueAtom: (_environmentId: string) =>
    Atom.make((get): SavedSettings | null => {
      get(settingsLoadAtom);
      return settings;
    }),
  updateSettings: { name: "serverEnvironment.updateSettings" } as const,
};

/** Keeps the atom cache in step with a successful patch so the table updates immediately. */
export function applySettingsPatch(patch: ServerSettingsPatch): void {
  if (settings === null) return;
  const usagePriceOverrides = { ...settings.usagePriceOverrides };
  for (const [model, price] of Object.entries(patch.usagePriceOverrides ?? {})) {
    if (price === null) delete usagePriceOverrides[model];
    else usagePriceOverrides[model] = price;
  }
  const usageModelAliases = { ...settings.usageModelAliases };
  for (const [model, alias] of Object.entries(patch.usageModelAliases ?? {})) {
    if (alias === null) delete usageModelAliases[model];
    else usageModelAliases[model] = alias;
  }
  settings = { usagePriceOverrides, usageModelAliases };
  notify();
}
