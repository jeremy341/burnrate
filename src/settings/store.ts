/**
 * Client settings store (docs/CONTRACTS.md section 2).
 *
 * The server is the source of truth; the browser keeps a write-through mirror for first paint.
 * `updateSettings` is optimistic and coalesces rapid calls (sliders, colour pickers) into one
 * PATCH after 300 ms. A failed PATCH rolls the store back to the last server-confirmed state and
 * publishes an error that UI can render with `useSettingsError()` plus a toast. When the server
 * pushes a `settings` event on `/api/stream` it is applied while the page is visible, with reconnect
 * backoff. Snapshots that equal the current state never notify subscribers, and snapshots arriving
 * while an edit is debounced or in flight never overwrite the value the user is typing.
 * Startup loading and the stream are started automatically in the browser; call
 * `startSettingsSync`/`stopSettingsSync` explicitly in tests or non-DOM hosts.
 */
import { useSyncExternalStore } from "react";

import { fetchSettings, sendSettingsPatch } from "~/api/settings";
import { toast } from "~/lib/toast";

import {
  cloneDefaults,
  deepMerge,
  isPlainObject,
  readInitialSettings,
  writeMirror,
} from "./migrate";
import type { AppSettings, SettingsPatch } from "./schema";
import { seedUsageDefaults } from "./usageDefaults";

export { deepMerge };
export { MIRROR_KEY, LEGACY_SETTINGS_KEY, LEGACY_USAGE_PREFS_KEY } from "./migrate";
export const DEBOUNCE_MS = 300;
const MAX_BACKOFF_MS = 30_000;

export interface SettingsError {
  /** Already human-readable (the HTTP layer translates known server codes). */
  message: string;
  /** e.g. "appearance.radius" when the server reported one. */
  field?: string;
}

interface Batch {
  patches: SettingsPatch[];
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

const listeners = new Set<() => void>();
const errorListeners = new Set<() => void>();

let current: AppSettings = readInitialSettings();
/** The last state the server confirmed, used as the rollback point. */
let confirmed: AppSettings = current;
let batch: Batch | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let activeFlush: Promise<void> | null = null;
let serverRevision = 0;
let saveStatus: "idle" | "saving" | "saved" = "idle";
let lastError: SettingsError | null = null;

// --- subscription / snapshot ---------------------------------------------------------------

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSettings(): AppSettings {
  return current;
}

export function useSettings<T = AppSettings>(selector: (settings: AppSettings) => T = (s) => s as T): T {
  return selector(useSyncExternalStore(subscribe, getSettings, getSettings));
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

function commit(next: AppSettings): void {
  current = next;
  writeMirror(next);
  notify();
}

// --- surfaced errors -----------------------------------------------------------------------

export function getSettingsError(): SettingsError | null {
  return lastError;
}

export function subscribeSettingsError(listener: () => void): () => void {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}

export function useSettingsError(): SettingsError | null {
  return useSyncExternalStore(subscribeSettingsError, getSettingsError, getSettingsError);
}

function getSettingsSaveStatus() {
  return saveStatus;
}

export function useSettingsSaveStatus() {
  return useSyncExternalStore(subscribe, getSettingsSaveStatus, getSettingsSaveStatus);
}

export function clearSettingsError(): void {
  if (lastError === null) return;
  lastError = null;
  errorListeners.forEach((listener) => listener());
}

function reportError(error: unknown): void {
  const field = isPlainObject(error) && typeof error.field === "string" ? error.field : undefined;
  const message = error instanceof Error ? error.message : String(error);
  lastError = { message, ...(field ? { field } : {}) };
  errorListeners.forEach((listener) => listener());
  // The rollback already happened synchronously; surface it as a toast as well so the notice is
  // visible from any screen, not just the settings page. Fire-and-forget: never block the caller.
  toast.error(message);
}

// --- normalisation -------------------------------------------------------------------------

const SECTION_KEYS = [
  "general",
  "appearance",
  "usage",
  "providers",
  "notifications",
  "shell",
  "advanced",
] as const;

function looksLikeSettings(value: unknown): boolean {
  return isPlainObject(value) && SECTION_KEYS.some((key) => key in value);
}

/**
 * Deep equality that ignores key order. A GET/SSE snapshot that matches the current state must not
 * call `commit()`: every `commit()` notifies all `useSettings` subscribers, which re-renders
 * controlled inputs and can reset the caret on a field the user is still typing.
 */
function settingsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => settingsEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && settingsEqual(a[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

/** Fill defaults and fold the legacy top-level mirrors into `usage.*`. */
export function normalizeSettings(raw: unknown): AppSettings {
  if (!isPlainObject(raw)) return cloneDefaults();
  const obj: Record<string, unknown> = { ...raw };
  const usage = isPlainObject(obj.usage) ? { ...obj.usage } : {};
  if (!("usagePriceOverrides" in usage) && "usagePriceOverrides" in obj) {
    usage.usagePriceOverrides = obj.usagePriceOverrides;
  }
  if (!("usageModelAliases" in usage) && "usageModelAliases" in obj) {
    usage.usageModelAliases = obj.usageModelAliases;
  }
  delete obj.usagePriceOverrides;
  delete obj.usageModelAliases;
  obj.usage = usage;
  return deepMerge(cloneDefaults(), obj) as AppSettings;
}

// --- loading -------------------------------------------------------------------------------

/** Refetch the server's settings (source of truth) into the store. */
export async function loadSettings(): Promise<void> {
  const revision = serverRevision;
  const writing = activeFlush !== null;
  const raw: unknown = await fetchSettings();
  if (writing || revision !== serverRevision) return;
  const server = normalizeSettings(raw);
  if (batch !== null) {
    // Keep optimistic local edits; they will be reconciled by their own flush.
    confirmed = server;
    return;
  }
  confirmed = server;
  clearSettingsError();
  // An identical snapshot is a no-op: no notify, no re-render, no flicker.
  if (!settingsEqual(current, server)) commit(server);
  seedUsageDefaults(server.usage);
}

// --- optimistic updates --------------------------------------------------------------------

/** Like `deepMerge`, but keeps `null` values so deletions survive into the PATCH payload. */
function mergeWirePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value)
      ? mergeWirePatch(isPlainObject(out[key]) ? (out[key] as Record<string, unknown>) : {}, value)
      : value;
  }
  return out;
}

function coalesce(patches: SettingsPatch[]): SettingsPatch {
  return patches.reduce<SettingsPatch>(
    (acc, patch) => mergeWirePatch(acc as Record<string, unknown>, patch as Record<string, unknown>) as SettingsPatch,
    {} as SettingsPatch,
  );
}

function scheduleFlush(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush().catch(() => undefined);
  }, DEBOUNCE_MS);
}

/** Read without letting TS narrow away writes made from other functions. */
function flush(): Promise<void> {
  if (activeFlush !== null) return activeFlush;
  const pending = batch;
  if (pending === null) return Promise.resolve();
  batch = null;
  serverRevision += 1;
  activeFlush = flushBatch(pending).finally(() => {
    activeFlush = null;
    if (batch !== null && timer === null) scheduleFlush();
  });
  return activeFlush;
}

async function flushBatch(pending: Batch): Promise<void> {
  const patch = coalesce(pending.patches);

  try {
    const raw: unknown = await sendSettingsPatch(patch);
    // A server that answers with something other than the full settings still accepted the
    // PATCH: keep the optimistic state in that case instead of replacing it with defaults.
    const server = looksLikeSettings(raw) ? normalizeSettings(raw) : current;
    confirmed = server;
    clearSettingsError();
    if (batch === null) {
      saveStatus = "saved";
      commit(server);
    } else {
      commit(deepMerge(server, coalesce(batch.patches)) as AppSettings);
    }
    pending.waiters.forEach((waiter) => waiter.resolve());
  } catch (error) {
    reportError(error);
    const newer = batch === null ? null : coalesce(batch.patches);
    if (newer === null) saveStatus = "idle";
    commit(newer === null ? confirmed : (deepMerge(confirmed, newer) as AppSettings));
    pending.waiters.forEach((waiter) => waiter.reject(error));
    throw error;
  }
}

/**
 * Optimistically apply `patch`, mirror it for first paint, and send a single coalesced PATCH.
 * The returned promise settles when the server accepted (or rejected) the batch containing it.
 */
export function updateSettings(patch: SettingsPatch): Promise<void> {
  if (batch === null) batch = { patches: [], waiters: [] };
  const active = batch;
  active.patches.push(patch);
  const promise = new Promise<void>((resolve, reject) => {
    active.waiters.push({ resolve, reject });
  });
  // Fire-and-forget controls use the shared error notice. Awaiting callers still receive the error.
  void promise.catch(() => undefined);
  saveStatus = "saving";
  commit(deepMerge(current, patch) as AppSettings);
  scheduleFlush();
  return promise;
}

/** Wait for pending writes and stop the dependent action if a write fails. */
export async function flushSettings(): Promise<void> {
  while (activeFlush !== null || batch !== null) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await flush();
  }
}

// --- server push ---------------------------------------------------------------------------

let syncStarted = false;
let stream: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 1000;
let onVisibility: (() => void) | null = null;

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

function closeStream(): void {
  if (stream !== null) {
    stream.close();
    stream = null;
  }
}

function clearReconnect(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (!syncStarted || pageHidden() || reconnectTimer !== null) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openStream();
  }, delay);
}

function openStream(): void {
  if (!syncStarted || pageHidden() || typeof EventSource === "undefined") return;
  closeStream();
  let source: EventSource;
  try {
    source = new EventSource("/api/stream");
  } catch {
    scheduleReconnect();
    return;
  }
  stream = source;
  source.onopen = () => {
    backoffMs = 1000;
  };
  source.addEventListener("settings", (event: Event) => {
    try {
      const raw: unknown = JSON.parse((event as MessageEvent<string>).data);
      // A pending debounce or an in-flight PATCH means the user's value is not settled yet. Applying
      // the server snapshot now would overwrite it on screen and break the instant-apply contract.
      if (activeFlush !== null || timer !== null || !looksLikeSettings(raw)) return;
      serverRevision += 1;
      const server = normalizeSettings(raw);
      confirmed = server;
      if (batch === null) {
        clearSettingsError();
        // Skip the notify for an identical snapshot: otherwise a save from another client re-renders
        // every settings input and can move the caret while someone is typing elsewhere.
        if (!settingsEqual(current, server)) commit(server);
      }
    } catch {
      /* ignore malformed events; the next one or the next load corrects the state */
    }
  });
  source.onerror = () => {
    closeStream();
    scheduleReconnect();
  };
}

function handleVisibility(): void {
  if (pageHidden()) {
    closeStream();
    clearReconnect();
    return;
  }
  backoffMs = 1000;
  clearReconnect();
  void loadSettings().catch(() => {
    /* keep the mirror when the server is unreachable */
  });
  openStream();
}

/** Start initial load and the `settings` SSE subscription. Idempotent. */
export function startSettingsSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  if (typeof document !== "undefined") {
    onVisibility = handleVisibility;
    document.addEventListener("visibilitychange", onVisibility);
  }
  void loadSettings().catch(() => {
    /* the mirror from migrate.ts is the offline fallback */
  });
  openStream();
}

/** Stop the subscription and all reconnect timers (tests / teardown). */
export function stopSettingsSync(): void {
  if (!syncStarted) return;
  syncStarted = false;
  if (onVisibility !== null && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility);
  }
  onVisibility = null;
  closeStream();
  clearReconnect();
  backoffMs = 1000;
}

// Module import is the app entry point: store.ts is pulled in by the settings hook, which
// App.tsx imports. Node/vitest has no `window`, so tests stay fully explicit.
if (typeof window !== "undefined" && typeof fetch === "function") {
  // First run: let the Usage page open on the settings' default view/period (a saved choice always wins).
  seedUsageDefaults(current.usage);
  startSettingsSync();
}
