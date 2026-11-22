import { useCallback, useEffect, useState } from "react";

import type {
  LimitsReport,
  ProviderInfo,
  ServerSettingsPatch,
  TestKeyResult,
  UsageModelPriceOverride,
} from "~/contracts";
import { registerProviders } from "~/providers/registry";

import { ApiError, humanMessage, request } from "~/api/http";

export { ApiError, humanMessage };

export interface SavedSettings {
  usagePriceOverrides: Record<string, UsageModelPriceOverride>;
  usageModelAliases: Record<string, string>;
}

export const api = {
  settings: () => request<SavedSettings>("/api/settings"),
  patchSettings: (patch: ServerSettingsPatch) =>
    request<SavedSettings>("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch }),
    }),
  limits: () => request<LimitsReport>("/api/limits"),
  providers: () => request<ProviderInfo[]>("/api/providers"),
  saveKey: (providerId: string, name: string, apiKey: string) =>
    request(`/api/providers/${encodeURIComponent(providerId)}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, apiKey }),
    }),
  removeKey: (providerId: string, name: string) =>
    request(`/api/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  renameKey: (providerId: string, name: string, newName: string) =>
    request(`/api/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    }),
  /** Name (or, with an empty name, un-name) an account Burnrate discovered, such as a Claude login. */
  setAccountName: (providerId: string, accountId: string, name: string) =>
    request(`/api/providers/${encodeURIComponent(providerId)}/nicknames/${encodeURIComponent(accountId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  testKey: (providerId: string, apiKey: string) =>
    request<TestKeyResult>(`/api/providers/${encodeURIComponent(providerId)}/keys/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    }),

  claudeSignOut: (id: string) =>
    request(`/api/providers/claudeAgent/accounts/${encodeURIComponent(id)}/signout`, {
      method: "POST",
    }),
};

export interface Loaded<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly reload: () => void;
}

function useLoad<T>(load: () => Promise<T>, onData?: (data: T) => void): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => {
        onData?.(data);
        setState({ data, error: null, loading: false });
      },
      (e: unknown) =>
        setState((s) => ({ ...s, error: e instanceof Error ? e.message : "error", loading: false })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

export const useLimits = () => useLoad(api.limits);
export const useProviders = () => useLoad(api.providers, registerProviders);
