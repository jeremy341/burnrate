import { beforeEach, describe, expect, it } from "vitest";

import {
  collapsedProvidersStore,
  parseCollapsedProviders,
  readCollapsedProviders,
  saveCollapsedProviders,
  withProviderCollapsed,
  withProvidersCollapsed,
} from "./usagePagePreferences";

const KEY = "burnrate:usage-collapsed-providers:v1";

function memory(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[KEY, initial]]);
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("collapsed providers", () => {
  beforeEach(() => collapsedProvidersStore.reset());

  it("starts with everything expanded", () => {
    expect(readCollapsedProviders(memory()).size).toBe(0);
  });

  it("round-trips through storage, per provider id", () => {
    const storage = memory();
    saveCollapsedProviders(new Set(["codex", "claudeAgent"]), storage);
    expect([...readCollapsedProviders(storage)].sort()).toEqual(["claudeAgent", "codex"]);
  });

  it("survives corrupt or hostile storage", () => {
    expect(parseCollapsedProviders("{not json")).toEqual(new Set());
    expect(parseCollapsedProviders('{"collapsed":[1,null,"a",""]}')).toEqual(new Set(["a"]));
    expect(parseCollapsedProviders('"x"')).toEqual(new Set());
    expect(parseCollapsedProviders(null)).toEqual(new Set());
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readCollapsedProviders(throwing)).toEqual(new Set());
  });

  it("a provider that appears later starts expanded, and old ids are harmless", () => {
    const saved = readCollapsedProviders(memory('{"collapsed":["claudeAgent","gone"]}'));
    expect(saved.has("newProvider")).toBe(false);
    expect(saved.has("claudeAgent")).toBe(true);
  });

  it("toggles one provider without touching the others, and returns the same set when nothing changes", () => {
    const start = new Set(["a"]);
    const next = withProviderCollapsed(start, "b", true);
    expect([...next].sort()).toEqual(["a", "b"]);
    expect(start.size).toBe(1);
    expect(withProviderCollapsed(next, "b", true)).toBe(next);
    expect([...withProviderCollapsed(next, "a", false)]).toEqual(["b"]);
  });

  it("collapse all / expand all affects only the listed providers", () => {
    const hiddenOne = new Set(["hidden"]);
    const all = withProvidersCollapsed(hiddenOne, ["a", "b"], true);
    expect([...all].sort()).toEqual(["a", "b", "hidden"]);
    expect([...withProvidersCollapsed(all, ["a", "b"], false)]).toEqual(["hidden"]);
    expect(withProvidersCollapsed(all, ["a", "b"], true)).toBe(all);
  });
});
