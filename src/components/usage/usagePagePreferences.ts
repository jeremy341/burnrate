import type { UsageProviderKind } from "~/contracts";

const STORAGE_KEY = "burnrate:usage-page-preferences:v1";

export interface UsagePagePreferences {
  metric: "cost" | "tokens" | "limits";
  windowDays: 1 | 7 | 30 | 90;
  hiddenProviders?: readonly UsageProviderKind[];
}

const DEFAULT_PREFERENCES: UsagePagePreferences = { metric: "limits", windowDays: 30 };

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<UsagePagePreferences> | null;
    if (!raw) return DEFAULT_PREFERENCES;
    return {
      metric: raw.metric === "cost" || raw.metric === "tokens" || raw.metric === "limits" ? raw.metric : DEFAULT_PREFERENCES.metric,
      windowDays: raw.windowDays === 1 || raw.windowDays === 7 || raw.windowDays === 30 || raw.windowDays === 90 ? raw.windowDays : DEFAULT_PREFERENCES.windowDays,
      ...(Array.isArray(raw.hiddenProviders) ? { hiddenProviders: raw.hiddenProviders.filter((p): p is string => typeof p === "string") } : {}),
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    /* storage unavailable */
  }
}
