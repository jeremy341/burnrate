/**
 * Adapter for the T3 `state/presentation` atom that lists environments.
 * Burnrate exposes exactly one environment: this computer.
 */

import { LOCAL_ENVIRONMENT_ID } from "~/state/usage";

import { Atom } from "./effectReactivity";

const PRESENTATIONS = new Map([
  [
    LOCAL_ENVIRONMENT_ID,
    {
      entry: { target: { label: "This computer" } },
      serverConfig: { environment: { capabilities: { usageModelAliases: true } } },
      connection: { phase: "connected" },
    },
  ],
]);

export const environmentPresentations = {
  presentationsAtom: Atom.make(() => PRESENTATIONS),
};
