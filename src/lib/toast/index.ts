import { toastStore } from "./store";
import type { ToastOptions, ToastType } from "./types";

/**
 * The public toast API. Safe to call from anywhere — including before the overlay
 * mounts — because the queue lives outside React.
 *
 *   import { toast } from "~/lib/toast";
 *   toast.success("Settings saved", { action: { label: "Undo", onClick: undo } });
 */
export const toast = {
  show(type: ToastType, message: string, options?: ToastOptions): number {
    return toastStore.add(type, message, options);
  },
  success(message: string, options?: ToastOptions): number {
    return toastStore.add("success", message, options);
  },
  error(message: string, options?: ToastOptions): number {
    return toastStore.add("error", message, options);
  },
  info(message: string, options?: ToastOptions): number {
    return toastStore.add("info", message, options);
  },
  warning(message: string, options?: ToastOptions): number {
    return toastStore.add("warning", message, options);
  },
  dismiss(id: number): void {
    toastStore.dismiss(id);
  },
  clear(): void {
    toastStore.clear();
  },
  subscribe: toastStore.subscribe,
  getSnapshot: toastStore.getSnapshot,
};

export { createToastStore, toastStore, DEFAULT_TOAST_DURATION, DEFAULT_MAX_TOASTS } from "./store";
export type { ToastStore, ToastStoreOptions } from "./store";
export { useToasts } from "./hooks";
export type {
  ToastAction,
  ToastItem,
  ToastListener,
  ToastOptions,
  ToastTimers,
  ToastType,
  TimerHandle,
} from "./types";
