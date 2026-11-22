import { useSyncExternalStore } from "react";

import { getCommands, subscribe } from "./registry";

/** Subscribe a component to the command registry. */
export function useCommands() {
  return useSyncExternalStore(subscribe, getCommands, getCommands);
}
