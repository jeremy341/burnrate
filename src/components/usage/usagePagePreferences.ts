import type { UsageProviderKind } from "~/contracts";

// Same key as T3 so the page opens in the same state when embedded with it.
const STORAGE_KEY = "t3code:usage-page-preferences:v1";

export interface UsagePagePreferences {
  metric: "cost" | "tokens" | "limits";
  windowDays: 1 | 7 | 30 | 90;
  hiddenProviders?: readonly UsageProviderKind[];
}

const DEFAULT_PREFERENCES: UsagePagePreferences = { metric: "limits", windowDays: 30 };

function read(): UsagePagePreferences | null {
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<UsagePagePreferences> | null;
  if (!raw || typeof raw !== "object") return null;
  const metric =
    raw.metric === "cost" || raw.metric === "tokens" || raw.metric === "limits"
      ? raw.metric
      : null;
  const windowDays =
    raw.windowDays === 1 || raw.windowDays === 7 || raw.windowDays === 30 || raw.windowDays === 90
      ? raw.windowDays
      : null;
  if (metric === null || windowDays === null) return null;
  return {
    metric,
    windowDays,
    ...(Array.isArray(raw.hiddenProviders)
      ? {
          hiddenProviders: raw.hiddenProviders.filter(
            (provider): provider is string => typeof provider === "string",
          ),
        }
      : {}),
  };
}

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    return read() ?? DEFAULT_PREFERENCES;
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return DEFAULT_PREFERENCES;
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}

// burnrate: which provider sections of the Limits view are collapsed. Kept under its own key, so
// the page's whole-object save above can never drop it. Only collapsed ids are stored, so a provider
// that appears later starts expanded, and one that disappears simply leaves a harmless stale id.
const COLLAPSED_KEY = "burnrate:usage-collapsed-providers:v1";

type CollapseStorage = Pick<Storage, "getItem" | "setItem">;

export function parseCollapsedProviders(raw: string | null): ReadonlySet<string> {
  if (!raw) return new Set();
  try {
    const value = JSON.parse(raw) as unknown;
    const list = Array.isArray(value)
      ? value
      : value && typeof value === "object" && Array.isArray((value as { collapsed?: unknown }).collapsed)
        ? (value as { collapsed: unknown[] }).collapsed
        : [];
    return new Set(list.filter((id): id is string => typeof id === "string" && id.length > 0));
  } catch {
    return new Set();
  }
}

export function readCollapsedProviders(storage?: CollapseStorage): ReadonlySet<string> {
  try {
    return parseCollapsedProviders((storage ?? localStorage).getItem(COLLAPSED_KEY));
  } catch {
    return new Set();
  }
}

export function saveCollapsedProviders(collapsed: ReadonlySet<string>, storage?: CollapseStorage): void {
  try {
    (storage ?? localStorage).setItem(COLLAPSED_KEY, JSON.stringify({ collapsed: [...collapsed].sort() }));
  } catch (error) {
    console.error("Could not save collapsed providers.", error);
  }
}

/** Collapse or expand one provider; returns a new set so React sees the change. */
export function withProviderCollapsed(
  collapsed: ReadonlySet<string>,
  id: string,
  isCollapsed: boolean,
): ReadonlySet<string> {
  if (collapsed.has(id) === isCollapsed) return collapsed;
  const next = new Set(collapsed);
  if (isCollapsed) next.add(id);
  else next.delete(id);
  return next;
}

/** Collapse or expand every listed provider; ids that are not listed (hidden providers) keep their state. */
export function withProvidersCollapsed(
  collapsed: ReadonlySet<string>,
  ids: readonly string[],
  isCollapsed: boolean,
): ReadonlySet<string> {
  const next = new Set(collapsed);
  for (const id of ids) {
    if (isCollapsed) next.add(id);
    else next.delete(id);
  }
  return next.size === collapsed.size && ids.every((id) => collapsed.has(id) === isCollapsed)
    ? collapsed
    : next;
}

let collapsedSnapshot: ReadonlySet<string> | null = null;
const collapsedListeners = new Set<() => void>();

/** The shared, persisted collapse state (a tiny external store, so every section stays in step). */
export const collapsedProvidersStore = {
  get(): ReadonlySet<string> {
    return (collapsedSnapshot ??= readCollapsedProviders());
  },
  set(next: ReadonlySet<string>): void {
    if (next === collapsedProvidersStore.get()) return;
    collapsedSnapshot = next;
    saveCollapsedProviders(next);
    for (const listener of collapsedListeners) listener();
  },
  subscribe(listener: () => void): () => void {
    collapsedListeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== COLLAPSED_KEY) return;
      collapsedSnapshot = parseCollapsedProviders(event.newValue);
      listener();
    };
    if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
    return () => {
      collapsedListeners.delete(listener);
      if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    };
  },
  /** Test hook: forget the cached snapshot so the next read goes back to storage. */
  reset(): void {
    collapsedSnapshot = null;
  },
};
