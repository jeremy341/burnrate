/**
 * First-run flag persistence. The browser flag gives a flash-free first paint; the server flag
 * keeps the tour from returning after a browser data wipe. Both writes are best-effort: a failed
 * server PATCH must never re-open the tour.
 */
import { updateSettings } from "~/settings/store";

export const ONBOARDED_KEY = "burnrate.onboarded";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // blocked third-party/storage access
  }
}

export function readOnboardedFlag(storage: ReadableStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(ONBOARDED_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeOnboardedFlag(storage: WritableStorage | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(ONBOARDED_KEY, "true");
  } catch {
    /* storage full or unavailable: the server flag still covers us */
  }
}

/**
 * Read the server-side completion flag from either shape: newer settings keep it at the top level
 * (`onboarded`), older ones under `advanced.experimental.onboarded`. Accepting both keeps every
 * existing profile silenced while the flag is moved out of advanced/experimental.
 */
export function readOnboardedServerFlag(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const root = settings as Record<string, unknown>;
  if (root.onboarded === true) return true;
  const advanced = root.advanced;
  if (!advanced || typeof advanced !== "object") return false;
  const experimental = (advanced as Record<string, unknown>).experimental;
  if (!experimental || typeof experimental !== "object") return false;
  return (experimental as Record<string, unknown>).onboarded === true;
}

/** Persist the same flag in server settings. Callers catch; local storage remains authoritative. */
export async function persistOnboardedServerFlag(): Promise<void> {
  await updateSettings({ onboarded: true });
}

/** Mirror a server-side completion back into this browser so it never flashes on later starts. */
export function syncServerFlagLocally(): void {
  writeOnboardedFlag();
}
