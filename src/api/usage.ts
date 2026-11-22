/** Client for `/api/usage` (answers at once from what is scanned so far, with `scan` progress) and its in-memory per-window cache. */
import { useCallback, useEffect, useRef, useState } from "react";

import { request } from "~/api/http";
import type { UsageSummary, UsageSummaryInput } from "~/contracts";

export interface ScanProviderProgress {
  readonly id: string;
  readonly state: "pending" | "scanning" | "done";
  readonly filesDone: number;
  readonly filesTotal: number;
}

export interface ScanProgress {
  readonly state: "idle" | "scanning";
  readonly filesDone: number;
  readonly filesTotal: number;
  /** A scan has finished in this server process, so the numbers are complete as of `finishedAt`. */
  readonly completedOnce: boolean;
  readonly providers?: readonly ScanProviderProgress[];
}

/** A usage summary plus the scan state the server attaches. Older servers omit both extras. */
export type UsageResponse = UsageSummary & {
  readonly scan?: ScanProgress;
  /** The last saved answer, shown until the first scan of this run has finished. */
  readonly stale?: boolean;
};

/** How often to ask again while the server is still scanning. */
export const SCAN_POLL_MS = 1500;
/** Retry delay after a failed read (server still starting, brief network error). */
export const RETRY_MS = 4000;

/** The server-side identity of a window. Day windows send only days; a 24 h window also sends its exact edges. */
export function usageQuery(input: UsageSummaryInput): string {
  const params = new URLSearchParams({
    since: input.sinceDay,
    until: input.untilDay,
    tz: input.timeZone,
    ...(input.resolution === "hour" ? { resolution: "hour" } : {}),
  });
  if (input.sinceTime !== undefined && input.untilTime !== undefined) {
    params.set("sinceTime", input.sinceTime);
    params.set("untilTime", input.untilTime);
  }
  return `/api/usage?${params.toString()}`;
}

const cache = new Map<string, UsageResponse>();
/** Exact 24 h windows get a new key each minute; keep only the recent ones. */
const MAX_CACHED_WINDOWS = 12;

export function cachedUsage(input: UsageSummaryInput): UsageResponse | undefined {
  return cache.get(usageQuery(input));
}

/** Test hook and sign-out/reset path. */
export function clearUsageCache(): void {
  cache.clear();
}

export async function fetchUsage(
  input: UsageSummaryInput,
  signal?: AbortSignal,
): Promise<UsageResponse> {
  const path = usageQuery(input);
  const response = await request<UsageResponse>(path, { signal });
  cache.set(path, response);
  if (cache.size > MAX_CACHED_WINDOWS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return response;
}

export type ScanView =
  | { readonly kind: "idle" }
  /** The first listing of files is still running: the total is not known yet. */
  | { readonly kind: "preparing" }
  | {
      readonly kind: "scanning";
      readonly done: number;
      readonly total: number;
      /** 0..1, never 1 while files remain. */
      readonly fraction: number;
    };

/** Pure description of a scan for the status line (formatting stays in the component). */
export function describeScan(scan: ScanProgress | undefined | null): ScanView {
  if (!scan || scan.state !== "scanning") return { kind: "idle" };
  const total = Math.max(0, Math.floor(scan.filesTotal));
  if (total === 0) return { kind: "preparing" };
  const done = Math.min(total, Math.max(0, Math.floor(scan.filesDone)));
  return { kind: "scanning", done, total, fraction: done >= total ? 0.99 : done / total };
}

/** True when the answer holds nothing yet and a scan is the reason. */
export function isWaitingForFirstData(response: UsageResponse | null | undefined): boolean {
  if (!response) return false;
  return response.scan?.state === "scanning" && response.buckets.length === 0;
}

export interface UsageWindowState {
  readonly response: UsageResponse | null;
  /** No answer at all yet (first request in flight). */
  readonly loading: boolean;
  readonly error: string | null;
  readonly scan: ScanProgress | null;
  readonly stale: boolean;
  /** Ask again now; resolves with the answer. */
  readonly refresh: (next?: UsageSummaryInput) => Promise<void>;
}

/** Stale-while-revalidate: a cached answer shows at once, then it is re-read; during a scan, every `SCAN_POLL_MS` (visible tab only). */
export function useUsageWindow(input: UsageSummaryInput, enabled = true): UsageWindowState {
  const path = usageQuery(input);
  const [fetched, setFetched] = useState<{ path: string; response: UsageResponse } | null>(null);
  const [error, setError] = useState<{ path: string; message: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const inputRef = useRef(input);
  const pendingRefresh = useRef<{ input: UsageSummaryInput; resolve: () => void } | null>(null);
  inputRef.current = input;

  const cached = cache.get(path) ?? null;
  const response = fetched !== null && fetched.path === path ? fetched.response : cached;

  useEffect(() => {
    if (!enabled) {
      pendingRefresh.current?.resolve();
      pendingRefresh.current = null;
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = pendingRefresh.current;
    pendingRefresh.current = null;
    const target = pending?.input ?? inputRef.current;
    const targetPath = usageQuery(target);
    let inFlight = false;

    const settleRefresh = () => pending?.resolve();

    const schedule = (ms: number) => {
      if (controller.signal.aborted) return;
      timer = setTimeout(() => {
        timer = undefined;
        void load();
      }, ms);
    };
    const load = async () => {
      if (controller.signal.aborted || inFlight) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        // Nothing polls while the window is hidden; the visibility handler resumes it.
        timer = undefined;
        return;
      }
      inFlight = true;
      try {
        const next = await fetchUsage(target, controller.signal);
        if (controller.signal.aborted) return;
        setFetched({ path: targetPath, response: next });
        setError(null);
        if (next.scan?.state === "scanning") schedule(SCAN_POLL_MS);
      } catch (cause) {
        if (controller.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setError({ path: targetPath, message: cause instanceof Error ? cause.message : "error" });
        schedule(RETRY_MS);
      } finally {
        inFlight = false;
        settleRefresh();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && timer === undefined) void load();
    };

    void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      settleRefresh();
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, enabled, nonce]);

  useEffect(() => () => {
    pendingRefresh.current?.resolve();
    pendingRefresh.current = null;
  }, []);

  const refresh = useCallback((next?: UsageSummaryInput) => {
    return new Promise<void>((resolve) => {
      pendingRefresh.current?.resolve();
      pendingRefresh.current = { input: next ?? inputRef.current, resolve };
      setNonce((value) => value + 1);
    });
  }, []);

  return {
    response,
    loading: response === null && (error === null || error.path !== path),
    error: response === null && error !== null && error.path === path ? error.message : null,
    scan: response?.scan ?? null,
    stale: response?.stale === true,
    refresh,
  };
}

/** Warm the other windows one at a time so the period switch is instant. */
export function prefetchUsage(inputs: readonly UsageSummaryInput[], signal: AbortSignal): void {
  void (async () => {
    for (const input of inputs) {
      if (signal.aborted) return;
      if (cache.has(usageQuery(input))) continue;
      try {
        await fetchUsage(input, signal);
      } catch {
        return;
      }
    }
  })();
}
