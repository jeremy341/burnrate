import { useCallback, useEffect, useState } from "react";

import type { LimitsReport, ProviderInfo } from "~/contracts";
import { registerProviders } from "~/providers/registry";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "X-Burnrate": "1", ...init?.headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  limits: () => request<LimitsReport>("/api/limits"),
  providers: () => request<ProviderInfo[]>("/api/providers"),
  saveKey: (providerId: string, name: string, apiKey: string) =>
    request(`/api/providers/${providerId}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, apiKey }),
    }),
  removeKey: (providerId: string, name: string) =>
    request(`/api/providers/${providerId}/keys/${encodeURIComponent(name)}`, { method: "DELETE" }),
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
