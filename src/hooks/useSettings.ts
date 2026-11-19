import { useSyncExternalStore } from "react";
import type { TimestampFormat } from "~/timestampFormat";

export interface AppSettings {
  readonly timestampFormat: TimestampFormat;
  readonly theme: "system" | "light" | "dark";
  readonly hideSensitive: boolean;
}

const KEY = "burnrate.settings";
const DEFAULTS: AppSettings = { timestampFormat: "locale", theme: "system", hideSensitive: false };
const listeners = new Set<() => void>();

function read(): AppSettings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AppSettings>) };
  } catch {
    return DEFAULTS;
  }
}
let current = read();

export function updateSettings(patch: Partial<AppSettings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

export function usePrimarySettings<T = AppSettings>(select?: (s: AppSettings) => T): T {
  const snapshot = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  );
  return (select ? select(snapshot) : snapshot) as T;
}
