import { afterEach, describe, expect, it, vi } from "vitest";

import type { UsageSummaryInput } from "~/contracts";

import {
  cachedUsage,
  clearUsageCache,
  describeScan,
  fetchUsage,
  isWaitingForFirstData,
  prefetchUsage,
  usageQuery,
  type ScanProgress,
  type UsageResponse,
} from "./usage";

const input = (over: Partial<UsageSummaryInput> = {}): UsageSummaryInput =>
  ({ sinceDay: "2026-11-14", untilDay: "2026-11-20", timeZone: "Europe/Paris", resolution: "day", ...over }) as UsageSummaryInput;

const scan = (over: Partial<ScanProgress> = {}): ScanProgress => ({ state: "scanning", filesDone: 1240, filesTotal: 8400, completedOnce: false, ...over });

afterEach(() => {
  clearUsageCache();
  vi.unstubAllGlobals();
});

describe("usageQuery", () => {
  it("carries the exact edges of a 24 h window so the server can exclude the rest of the day", () => {
    const a = usageQuery(input({ resolution: "hour", sinceTime: "2026-11-19T10:00:00.000Z", untilTime: "2026-11-20T10:00:00.000Z" } as Partial<UsageSummaryInput>));
    const b = usageQuery(input({ resolution: "hour", sinceTime: "2026-11-19T10:01:00.000Z", untilTime: "2026-11-20T10:01:00.000Z" } as Partial<UsageSummaryInput>));
    expect(a).not.toBe(b);
    expect(a).toContain("sinceTime=2026-11-19T10%3A00%3A00.000Z");
    expect(a).toContain("untilTime=2026-11-20T10%3A00%3A00.000Z");
    expect(a).toContain("resolution=hour");
    expect(usageQuery(input())).not.toContain("resolution");
    expect(usageQuery(input())).not.toContain("sinceTime");
  });
});

describe("describeScan", () => {
  it("is idle without a scan or when the scan finished", () => {
    expect(describeScan(undefined)).toEqual({ kind: "idle" });
    expect(describeScan(null)).toEqual({ kind: "idle" });
    expect(describeScan(scan({ state: "idle" }))).toEqual({ kind: "idle" });
  });

  it("is preparing until the files have been listed", () => {
    expect(describeScan(scan({ filesTotal: 0, filesDone: 0 }))).toEqual({ kind: "preparing" });
  });

  it("reports done/total and a fraction that stays below 1 while scanning", () => {
    expect(describeScan(scan())).toEqual({ kind: "scanning", done: 1240, total: 8400, fraction: 1240 / 8400 });
    const nearlyDone = describeScan(scan({ filesDone: 8400 }));
    expect(nearlyDone.kind === "scanning" && nearlyDone.fraction).toBe(0.99);
  });

  it("clamps nonsense counts", () => {
    expect(describeScan(scan({ filesDone: 9000, filesTotal: 10 }))).toMatchObject({ done: 10, total: 10 });
    expect(describeScan(scan({ filesDone: -5, filesTotal: 10 }))).toMatchObject({ done: 0 });
  });
});

describe("isWaitingForFirstData", () => {
  const response = (over: Partial<UsageResponse>) => ({ buckets: [], sources: [], ...over }) as unknown as UsageResponse;

  it("is true only while scanning with nothing read yet", () => {
    expect(isWaitingForFirstData(null)).toBe(false);
    expect(isWaitingForFirstData(response({ scan: scan() }))).toBe(true);
    expect(isWaitingForFirstData(response({ scan: scan({ state: "idle" }) }))).toBe(false);
    expect(isWaitingForFirstData(response({ scan: scan(), buckets: [{}] as never }))).toBe(false);
    expect(isWaitingForFirstData(response({}))).toBe(false);
  });
});

describe("answer cache", () => {
  const stubFetch = (body: unknown) => {
    const fn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fn);
    return fn;
  };

  it("remembers the last answer per window so a window switch can show it at once", async () => {
    stubFetch({ buckets: [], sources: [], scan: scan({ state: "idle", completedOnce: true }) });
    expect(cachedUsage(input())).toBeUndefined();
    await fetchUsage(input());
    expect(cachedUsage(input())?.scan?.completedOnce).toBe(true);
    expect(cachedUsage(input({ sinceDay: "2026-10-21" }))).toBeUndefined();
  });

  it("prefetch skips windows that are cached and stops when aborted", async () => {
    const fetchFn = stubFetch({ buckets: [], sources: [] });
    await fetchUsage(input());
    fetchFn.mockClear();
    const controller = new AbortController();
    prefetchUsage([input(), input({ sinceDay: "2026-11-01" }), input({ sinceDay: "2026-10-01" })], controller.signal);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    controller.abort();
  });

  it("does not cache failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await expect(fetchUsage(input())).rejects.toThrow();
    expect(cachedUsage(input())).toBeUndefined();
  });
});
