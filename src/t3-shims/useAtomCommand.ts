/**
 * Adapter for T3's `useAtomCommand`: applies a settings patch through Burnrate's
 * fetch API and returns the Effect-style success/failure tag the dialog expects.
 */

import { useCallback } from "react";

import { api } from "~/api";

import { applySettingsPatch } from "./stateServer";

export function useAtomCommand(
  _command: unknown,
  _options?: { readonly reportFailure?: boolean },
) {
  return useCallback(
    async (input: { input: { patch: Parameters<typeof api.patchSettings>[0] } }): Promise<{
      readonly _tag: "Success" | "Failure";
    }> => {
      try {
        await api.patchSettings(input.input.patch);
        applySettingsPatch(input.input.patch);
        return { _tag: "Success" };
      } catch {
        return { _tag: "Failure" };
      }
    },
    [],
  );
}
