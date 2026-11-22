import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyUsageDefaults,
  preferencesFromDefaults,
  readHideEmptyProviders,
  seedUsageDefaults,
  setHideEmptyProviders,
} from "./usageDefaults";

const KEY = "t3code:usage-page-preferences:v1";
const HIDE_EMPTY_KEY = "burnrate:usage-hide-empty-providers:v1";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  };
}

describe("usage defaults bridge", () => {
  let storage: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("maps the settings vocabulary onto the page's remembered view and window", () => {
    const base = { metric: "limits", windowDays: 30 } as const;
    expect(preferencesFromDefaults({ defaultView: "cost", defaultPeriod: "today" }, base)).toEqual({
      metric: "cost",
      windowDays: 1,
    });
    expect(preferencesFromDefaults({ defaultView: "tokens", defaultPeriod: "90d" }, base)).toEqual({
      metric: "tokens",
      windowDays: 90,
    });
  });

  it("choosing a default in Settings changes what the Usage page opens on (it used to be ignored)", () => {
    applyUsageDefaults({ defaultView: "cost", defaultPeriod: "7d" });
    expect(JSON.parse(storage.data.get(KEY)!)).toMatchObject({ metric: "cost", windowDays: 7 });
  });

  it("keeps the page's hidden providers when it applies a default", () => {
    storage.setItem(KEY, JSON.stringify({ metric: "limits", windowDays: 30, hiddenProviders: ["cursor"] }));
    applyUsageDefaults({ defaultView: "tokens", defaultPeriod: "30d" });
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual({
      metric: "tokens",
      windowDays: 30,
      hiddenProviders: ["cursor"],
    });
  });

  it("seeds a brand-new profile from the settings, but never overrides a saved choice", () => {
    seedUsageDefaults({ defaultView: "limits", defaultPeriod: "7d" });
    expect(JSON.parse(storage.data.get(KEY)!)).toMatchObject({ metric: "limits", windowDays: 7 });

    storage.setItem(KEY, JSON.stringify({ metric: "cost", windowDays: 90 }));
    seedUsageDefaults({ defaultView: "limits", defaultPeriod: "7d" });
    expect(JSON.parse(storage.data.get(KEY)!)).toMatchObject({ metric: "cost", windowDays: 90 });
  });
});

describe("hide empty providers preference", () => {
  let storage: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is off by default and applies instantly when switched on and off", () => {
    expect(readHideEmptyProviders()).toBe(false);
    setHideEmptyProviders(true);
    expect(storage.data.get(HIDE_EMPTY_KEY)).toBe("1");
    expect(readHideEmptyProviders()).toBe(true);
    setHideEmptyProviders(false);
    expect(storage.data.has(HIDE_EMPTY_KEY)).toBe(false);
    expect(readHideEmptyProviders()).toBe(false);
  });

  it("survives applying a default metric or period (it uses its own key)", () => {
    setHideEmptyProviders(true);
    applyUsageDefaults({ defaultView: "cost", defaultPeriod: "30d" });
    expect(readHideEmptyProviders()).toBe(true);
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual({ metric: "cost", windowDays: 30 });
  });
});
