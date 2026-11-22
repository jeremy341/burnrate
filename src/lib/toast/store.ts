import type { ToastItem, ToastListener, ToastOptions, ToastTimers, ToastType } from "./types";

export const DEFAULT_TOAST_DURATION = 5_000;
export const DEFAULT_MAX_TOASTS = 4;

const browserTimers: ToastTimers = {
  set(fn, ms) {
    return setTimeout(fn, ms);
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface ToastStoreOptions {
  /** Maximum simultaneous toasts. The oldest is dropped when the queue overflows. Default 4. */
  max?: number;
  /** Default auto-dismiss delay in milliseconds. Default 5000. */
  duration?: number;
  /** Timer seam, injectable for tests. */
  timers?: ToastTimers;
}

export interface ToastStore {
  add(type: ToastType, message: string, options?: ToastOptions): number;
  dismiss(id: number): void;
  clear(): void;
  subscribe(listener: ToastListener): () => void;
  getSnapshot(): readonly ToastItem[];
}

/**
 * Framework-agnostic toast queue. The snapshot array is replaced only on a real change,
 * which keeps `useSyncExternalStore` (and any other subscriber) stable between renders.
 */
export function createToastStore(options: ToastStoreOptions = {}): ToastStore {
  const max = Math.max(1, options.max ?? DEFAULT_MAX_TOASTS);
  const defaultDuration = options.duration ?? DEFAULT_TOAST_DURATION;
  const timers = options.timers ?? browserTimers;

  let items: readonly ToastItem[] = [];
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  const listeners = new Set<ToastListener>();
  let nextId = 1;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const clearTimer = (id: number) => {
    const handle = pending.get(id);
    if (handle !== undefined) {
      timers.clear(handle);
      pending.delete(id);
    }
  };

  const dismiss = (id: number) => {
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return;
    clearTimer(id);
    items = items.filter((item) => item.id !== id);
    emit();
  };

  const add = (type: ToastType, message: string, toastOptions?: ToastOptions): number => {
    const id = nextId++;
    const duration = toastOptions?.duration ?? defaultDuration;
    const item: ToastItem = {
      id,
      type,
      message,
      duration,
      ...(toastOptions?.title !== undefined ? { title: toastOptions.title } : {}),
      ...(toastOptions?.action !== undefined ? { action: toastOptions.action } : {}),
    };

    items = [...items, item];
    if (items.length > max) {
      const dropped = items[0]!;
      clearTimer(dropped.id);
      items = items.slice(1);
    }

    if (Number.isFinite(duration) && duration > 0) {
      pending.set(id, timers.set(() => dismiss(id), duration) as ReturnType<typeof setTimeout>);
    }

    emit();
    return id;
  };

  const clear = () => {
    for (const id of [...pending.keys()]) clearTimer(id);
    items = [];
    emit();
  };

  return {
    add,
    dismiss,
    clear,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => items,
  };
}

/** The one queue shared by the whole app (and lazily imported consumers). */
export const toastStore = createToastStore();
