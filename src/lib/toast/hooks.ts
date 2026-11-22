import { useSyncExternalStore } from "react";

import { toastStore } from "./store";
import type { ToastItem } from "./types";

/** Subscribe a component to the shared toast queue. */
export function useToasts(): readonly ToastItem[] {
  return useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);
}
