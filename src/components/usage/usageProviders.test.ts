import { afterEach, describe, expect, it } from "vitest";

import {
  PROVIDER_ORDER,
  PROVIDER_PRESENTATION,
  configuredUsageProviders,
  filterEmptyProviders,
  providersWithUsage,
  rankProvidersByMetric,
  registerUsageProviders,
  setUsageProvidersVisible,
  usageDriverLabel,
} from "./usageProviders";

const originalOrder = [...PROVIDER_ORDER];

afterEach(() => {
  PROVIDER_ORDER.splice(0, PROVIDER_ORDER.length, ...originalOrder);
});

describe("Mistral in the Cost/Tokens breakdown", () => {
  it("shows Mistral once its records carry tokens, even when the plan reports no cost", () => {
    // Vibe is a flat monthly plan: sessions have tokens but no per-token price.
    const totals = [
      { provider: "claude", costUsd: 0, totalTokens: 0 },
      { provider: "mistral", costUsd: 0, totalTokens: 1_250_000 },
    ];
    expect(providersWithUsage(totals)).toEqual(["mistral"]);
  });

  it("leaves Mistral out when the reader found nothing: no placeholder row", () => {
    expect(providersWithUsage([{ provider: "mistral", costUsd: 0, totalTokens: 0 }])).toEqual([]);
    expect(providersWithUsage([])).toEqual([]);
  });

  it("names and colours Mistral rows like the limits cards do", () => {
    expect(PROVIDER_PRESENTATION["mistral"]).toMatchObject({ label: "Mistral", driverKind: "mistral" });
    expect(usageDriverLabel("mistral", undefined)).toBe("Mistral");
  });

  it("keeps a Vibe-named usage provider on the Mistral label and colour", () => {
    for (const id of ["vibe", "mistral-vibe"]) {
      expect(PROVIDER_PRESENTATION[id]).toMatchObject({
        label: "Mistral",
        driverKind: "mistral",
        color: PROVIDER_PRESENTATION["mistral"]!.color,
      });
    }
  });

  it("registers an unknown provider id the server reports so it is not dropped", () => {
    registerUsageProviders(["mistral-vibe"]);
    expect(providersWithUsage([{ provider: "mistral-vibe", costUsd: 0, totalTokens: 10 }])).toEqual([
      "mistral-vibe",
    ]);
  });

  it("ranks Mistral against other providers by tokens or cost", () => {
    const totals = [
      { provider: "claude", costUsd: 12, totalTokens: 1_000 },
      { provider: "mistral", costUsd: 0, totalTokens: 9_000 },
    ];
    expect(rankProvidersByMetric(["claude", "mistral"], totals, "tokens")).toEqual(["mistral", "claude"]);
    expect(rankProvidersByMetric(["claude", "mistral"], totals, "cost")).toEqual(["claude", "mistral"]);
  });

  it("keeps providers reported only by Limits or excluded from visible totals available to the filter", () => {
    expect(configuredUsageProviders([], [], ["custom-provider", "claude", "claude"])).toEqual([
      "claude", "custom-provider",
    ]);
  });

  it("hides empty providers everywhere the page lists them, and keeps them when the setting is off", () => {
    const providers = ["claude", "codex", "mistral"] as const;
    const withData = new Set(["claude"]);
    expect(filterEmptyProviders(providers, withData, true)).toEqual(["claude"]);
    expect(filterEmptyProviders(providers, withData, false)).toEqual(providers);
    expect(filterEmptyProviders(providers, new Set(), true)).toEqual([]);
  });

  it("preserves hidden selections that are outside the current filter menu", () => {
    const hidden = new Set(["claude", "limits-only"]);
    expect(setUsageProvidersVisible(hidden, ["claude", "codex"], true)).toEqual(["limits-only"]);
    expect(setUsageProvidersVisible(hidden, ["codex"], false)).toEqual(["claude", "limits-only", "codex"]);
  });
});

describe("The provider filter offers only what this person has", () => {
  it("leaves out a provider with no data that is not connected", () => {
    expect(configuredUsageProviders([], [{ provider: "gemini", costUsd: 0, totalTokens: 0 }])).toEqual(
      [],
    );
  });

  it("offers a connected provider that has no usage in the loaded periods", () => {
    expect(configuredUsageProviders([], [], ["grok"])).toEqual(["grok"]);
  });

  it("offers a provider with usage that has no connection", () => {
    expect(
      configuredUsageProviders([], [{ provider: "qwen", costUsd: 5, totalTokens: 100 }]),
    ).toEqual(["qwen"]);
  });

  it("offers a provider whose log reader found files, even with nothing in the window", () => {
    const sources = [
      { fingerprint: { provider: "gemini" as const }, status: "ok" as const },
      { fingerprint: { provider: "codex" as const }, status: "missing" as const },
    ];
    expect(configuredUsageProviders(sources, [])).toEqual(["gemini"]);
  });

  it("keeps a saved hidden choice that has usage offered, so it can be shown again", () => {
    const totals = [{ provider: "kilo" as const, costUsd: 1, totalTokens: 50 }];
    expect(configuredUsageProviders([], totals)).toEqual(["kilo"]);
  });

  it("ignores a saved id not offered any more: not connected, no logs found, no usage", () => {
    expect(configuredUsageProviders([], [], [])).toEqual([]);
  });

  it("orders Claude, Codex, then the others, whatever brought them in", () => {
    const sources = [
      { fingerprint: { provider: "gemini" as const }, status: "ok" as const },
      { fingerprint: { provider: "roo" as const }, status: "partial" as const },
    ];
    const totals = [{ provider: "qwen" as const, costUsd: 2, totalTokens: 40 }];
    expect(configuredUsageProviders(sources, totals, ["claude", "goose"])).toEqual([
      "claude",
      "goose",
      "gemini",
      "roo",
      "qwen",
    ]);
  });
});
