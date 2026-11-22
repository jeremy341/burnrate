/** Visual severity of a toast. Drives the icon and accent colour. */
export type ToastType = "success" | "error" | "info" | "warning";

/** Optional button rendered at the trailing edge of a toast. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/** Options accepted by every `toast.success/error/info/warning` call. */
export interface ToastOptions {
  /** Optional bold line above the message. */
  title?: string;
  /** Action button and its handler. The toast closes after the handler runs. */
  action?: ToastAction;
  /** Auto-dismiss delay in milliseconds. `0` (or `Infinity`) keeps it until dismissed. */
  duration?: number;
}

/** A toast as consumed by the overlay. */
export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  title?: string;
  action?: ToastAction;
  /** Resolved auto-dismiss delay in milliseconds. */
  duration: number;
}

export type ToastListener = () => void;

/** Opaque timer handle so the queue can be tested without real timers. */
export type TimerHandle = unknown;

/** Minimal timer seam; defaults to `setTimeout`/`clearTimeout`. */
export interface ToastTimers {
  set(fn: () => void, ms: number): TimerHandle;
  clear(handle: TimerHandle): void;
}
