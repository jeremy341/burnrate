/**
 * "Default view" and "Default period" (Settings > Usage) used to be saved and never read: the Usage page
 * keeps its own remembered tab and window in `localStorage` (T3's `usage-page-preferences` key) and ignored
 * `usage.defaultView` / `usage.defaultPeriod`. This bridges the two without touching the page: choosing a
 * default writes the same remembered preference the page reads when it opens, and a brand-new profile is
 * seeded from the settings instead of the page's hard-coded 30 days.
 */
import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsagePagePreferences,
} from "~/components/usage/usagePagePreferences";

import type { UsageSettings } from "./schema";

/** Same key as `usagePagePreferences.ts` (T3's), needed only to tell "never saved" from "saved defaults". */
const PREFERENCES_KEY = "t3code:usage-page-preferences:v1";

const PERIOD_DAYS: Readonly<Record<UsageSettings["defaultPeriod"], UsagePagePreferences["windowDays"]>> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/** The page preference a pair of usage defaults stands for. */
export function preferencesFromDefaults(
  usage: Pick<UsageSettings, "defaultView" | "defaultPeriod">,
  base: UsagePagePreferences,
): UsagePagePreferences {
  return {
    ...base,
    metric: usage.defaultView,
    windowDays: PERIOD_DAYS[usage.defaultPeriod] ?? base.windowDays,
  };
}

/** Make the Usage page open on these defaults next time (keeps its hidden-provider choice). */
export function applyUsageDefaults(usage: Pick<UsageSettings, "defaultView" | "defaultPeriod">): void {
  saveUsagePagePreferences(preferencesFromDefaults(usage, readUsagePagePreferences()));
}

function hasSavedPreferences(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(PREFERENCES_KEY) !== null;
  } catch {
    return true; // unreadable storage: leave it alone
  }
}

/** First run only: seed the page's remembered view/period from the settings. A saved choice always wins. */
export function seedUsageDefaults(usage: Pick<UsageSettings, "defaultView" | "defaultPeriod">): void {
  if (hasSavedPreferences()) return;
  applyUsageDefaults(usage);
}

/**
 * "Hide empty providers" is a tiny page preference with no equivalent in T3's whole-object
 * `usagePagePreferences` (T3 adds/removes individual provider ids instead). Keeping it under its own
 * key means applying a default metric/period can never drop it, and the toggle applies instantly.
 */
const HIDE_EMPTY_KEY = "burnrate:usage-hide-empty-providers:v1";

const hideEmptyListeners = new Set<() => void>();

/** Subscribe to "hide empty providers" changes, so the Usage page applies a toggle instantly. */
export function subscribeHideEmptyProviders(listener: () => void): () => void {
  hideEmptyListeners.add(listener);
  return () => {
    hideEmptyListeners.delete(listener);
  };
}

export function readHideEmptyProviders(): boolean {
  try {
    return localStorage.getItem(HIDE_EMPTY_KEY) === "1";
  } catch {
    return false;
  }
}

export function getHideEmptyProviders(): boolean {
  return readHideEmptyProviders();
}

export function setHideEmptyProviders(hide: boolean): void {
  try {
    if (hide) localStorage.setItem(HIDE_EMPTY_KEY, "1");
    else localStorage.removeItem(HIDE_EMPTY_KEY);
  } catch (error) {
    console.error("Could not save the Usage page's empty-provider preference.", error);
  }
  hideEmptyListeners.forEach((listener) => listener());
}
