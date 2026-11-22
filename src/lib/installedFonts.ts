/**
 * Installed-font enumeration shared by the Settings → Appearance font pickers.
 *
 * Enumerating installed fonts (`queryLocalFonts`) is slow — hundreds of
 * families plus, on first use, a permission prompt — so the list is loaded
 * once per session, kept in a module-level promise and shown from cache the
 * moment a picker opens. The Appearance tab warm-starts the load from an idle
 * callback so cold opens are usually already served; a picker's open click
 * retries from a user gesture when the idle attempt had no activation and the
 * browser refused. Denied loads stay retryable; granted loads are cached.
 */
import { useSyncExternalStore } from "react";

import { queryInstalledFontFamilies } from "~/appearanceFonts";

export type InstalledFontsStatus = "idle" | "loading" | "ready" | "unavailable";

export interface InstalledFontsState {
  readonly status: InstalledFontsStatus;
  /** Deduplicated, case-insensitively sorted families; empty until ready. */
  readonly families: readonly string[];
}

let state: InstalledFontsState = { status: "idle", families: [] };
const listeners = new Set<() => void>();

function publish(next: InstalledFontsState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** The in-flight enumeration, or the failed attempt it ended on. */
let load: Promise<void> | null = null;

/** De-duplicate (case-insensitively) and sort families the pickers display. */
export function normalizeFontFamilies(families: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const family of families) {
    const trimmed = family.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique.sort((left, right) => {
    const byKey = left.toLocaleLowerCase().localeCompare(right.toLocaleLowerCase());
    return byKey !== 0 ? byKey : left.localeCompare(right);
  });
}

/**
 * Start (or join) the enumeration. Idempotent while a load is in flight and a
 * no-op once fonts are ready or enumeration is unsupported; a denial (no user
 * gesture or the user declined) resets to idle so the next call can retry.
 */
export function startInstalledFontsLoad(): void {
  if (state.status === "ready" || state.status === "unavailable") return;
  if (load !== null) return;
  publish({ ...state, status: "loading" });
  load = queryInstalledFontFamilies()
    .then((result) => {
      if (result.status === "granted") {
        publish({ status: "ready", families: normalizeFontFamilies(result.families) });
      } else if (result.status === "unsupported") {
        publish({ status: "unavailable", families: [] });
      } else {
        // "denied": retryable — the next picker open has a user gesture.
        publish({ status: "idle", families: [] });
      }
    })
    .catch(() => {
      publish({ status: "idle", families: [] });
    })
    .finally(() => {
      load = null;
    });
}

/**
 * Schedule the load during idle time. Call when the Settings page (Appearance
 * tab) mounts; returns a cancel function for effect cleanup.
 */
export function warmInstalledFonts(): () => void {
  if (typeof window === "undefined") return () => {};
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(() => {
      startInstalledFontsLoad();
    });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(() => {
    startInstalledFontsLoad();
  }, 200);
  return () => window.clearTimeout(handle);
}

export function subscribeInstalledFonts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getInstalledFontsState(): InstalledFontsState {
  return state;
}

/** Live enumeration state for a picker render; never blocks a popup on it. */
export function useInstalledFontFamilies(): InstalledFontsState {
  return useSyncExternalStore(subscribeInstalledFonts, getInstalledFontsState, getInstalledFontsState);
}
