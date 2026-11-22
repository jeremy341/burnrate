/**
 * In-app toast delivery. The real manager is owned by the toast-system package (`~/lib/toast`);
 * it is loaded lazily and is optional so this package works standalone. When it is absent a tiny
 * fallback queue is exposed for the overlay to render in an `aria-live` region.
 */
import type { AlertEvent } from "./types";

export interface ToastOptions {
  duration?: number;
  action?: { label: string; onClick: () => void };
}
export interface ToastApi {
  success(message: string, options?: ToastOptions): void;
  error(message: string, options?: ToastOptions): void;
  info(message: string, options?: ToastOptions): void;
  warning(message: string, options?: ToastOptions): void;
}

export type ToastLevel = "info" | "warning" | "error" | "success";
export interface ToastMessage {
  readonly id: string;
  readonly level: ToastLevel;
  readonly text: string;
}

// A literal glob: no static dependency, no runtime import of an unresolvable alias. When the
// toast-system package lands, `src/lib/toast/index.ts(x)` is discovered automatically.
const toastLoaders = import.meta.glob<{ toast?: ToastApi }>("../lib/toast/index.{ts,tsx}");

let cached: ToastApi | null | undefined;

export async function getToastApi(): Promise<ToastApi | null> {
  if (cached !== undefined) return cached;
  const loader = Object.values(toastLoaders)[0];
  if (!loader) {
    cached = null;
    return null;
  }
  try {
    const mod = await loader();
    cached = mod?.toast ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Only useful in tests / hot reload; drops the memoised toast module. */
export function resetToastCache(): void {
  cached = undefined;
}

const fallbackListeners = new Set<(messages: readonly ToastMessage[]) => void>();
let fallback: readonly ToastMessage[] = [];

export function subscribeFallback(listener: (messages: readonly ToastMessage[]) => void): () => void {
  fallbackListeners.add(listener);
  listener(fallback);
  return () => {
    fallbackListeners.delete(listener);
  };
}

export function publishFallback(message: ToastMessage): void {
  // Keep the last few only: an alert storm must not grow the DOM without bound.
  fallback = [...fallback.slice(-3), message];
  for (const listener of fallbackListeners) listener(fallback);
}

export function clearFallback(): void {
  fallback = [];
  for (const listener of fallbackListeners) listener(fallback);
}

export function alertToastLevel(event: AlertEvent): ToastLevel {
  if (event.severity === "critical") return "error";
  if (event.severity === "warn") return "warning";
  return "info";
}

export function alertToastText(event: AlertEvent): string {
  return event.body ? `${event.title}: ${event.body}` : event.title;
}
