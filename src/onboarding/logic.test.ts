import { describe, expect, it } from "vitest";

import type { ProviderInfo } from "~/contracts";

import {
  CLAUDE_PROVIDER_ID,
  ONBOARDING_STEPS,
  clampStep,
  detectAgents,
  isProviderConnected,
  pickKeyProvider,
  shouldShowOnboarding,
  tourLandingView,
} from "./logic";

function provider(
  id: string,
  overrides: Partial<ProviderInfo> = {},
): ProviderInfo {
  return {
    id,
    label: id,
    color: "#000000",
    auth: "apiKey",
    connected: false,
    accounts: [],
    ...overrides,
  };
}

describe("shouldShowOnboarding", () => {
  it("shows only when neither flag is set", () => {
    expect(shouldShowOnboarding(false, false)).toBe(true);
    expect(shouldShowOnboarding(true, false)).toBe(false);
    expect(shouldShowOnboarding(false, true)).toBe(false);
    expect(shouldShowOnboarding(true, true)).toBe(false);
  });

  it("does not nag a returning profile that already has a connected agent", () => {
    expect(shouldShowOnboarding(false, false, false)).toBe(true);
    expect(shouldShowOnboarding(false, false, true)).toBe(false);
    expect(shouldShowOnboarding(true, false, true)).toBe(false);
  });
});

describe("ONBOARDING_STEPS", () => {
  it("is just the welcome and done screens", () => {
    expect(ONBOARDING_STEPS).toEqual(["Welcome", "Done"]);
  });
});

describe("clampStep", () => {
  it("keeps navigation inside both wizard steps", () => {
    expect(clampStep(-5)).toBe(0);
    expect(clampStep(0)).toBe(0);
    expect(clampStep(1)).toBe(1);
    expect(clampStep(2)).toBe(ONBOARDING_STEPS.length - 1);
    expect(clampStep(3)).toBe(ONBOARDING_STEPS.length - 1);
    expect(clampStep(99)).toBe(ONBOARDING_STEPS.length - 1);
  });
});

describe("isProviderConnected", () => {
  it("treats either a connection or a saved account as connected", () => {
    expect(isProviderConnected(provider("a"))).toBe(false);
    expect(isProviderConnected(provider("b", { connected: true }))).toBe(true);
    expect(isProviderConnected(provider("c", { accounts: [{ id: "c-1", label: "one" }] }))).toBe(
      true,
    );
  });
});

describe("detectAgents", () => {
  const claude = provider(CLAUDE_PROVIDER_ID, {
    label: "Claude",
    auth: "localLogin",
    connected: true,
    accounts: [
      { id: "claude-work", label: "work" },
      { id: "claude-personal", label: "personal" },
    ],
  });
  const openrouter = provider("openrouter", { label: "OpenRouter" });
  const codex = provider("codex", { auth: "localLogin", connected: true });

  it("groups connected and available agents and finds Claude", () => {
    const result = detectAgents([claude, openrouter, codex]);
    expect(result.connected.map((p) => p.id)).toEqual([CLAUDE_PROVIDER_ID, "codex"]);
    expect(result.available.map((p) => p.id)).toEqual(["openrouter"]);
    expect(result.claude).toBe(claude);
    expect(result.hasAnyConnection).toBe(true);
  });

  it("lists only API-key providers as key providers", () => {
    const result = detectAgents([claude, openrouter, codex, provider("groq")]);
    expect(result.keyProviders.map((p) => p.id)).toEqual(["openrouter", "groq"]);
  });

  it("handles an empty provider list", () => {
    const result = detectAgents([]);
    expect(result.connected).toEqual([]);
    expect(result.available).toEqual([]);
    expect(result.claude).toBeNull();
    expect(result.keyProviders).toEqual([]);
    expect(result.hasAnyConnection).toBe(false);
  });

  it("leaves claude null when the server does not know it", () => {
    expect(detectAgents([openrouter]).claude).toBeNull();
  });
});

describe("pickKeyProvider", () => {
  const connectedKey = provider("connected-key", {
    connected: true,
    accounts: [{ id: "a", label: "a" }],
  });
  const freeKey = provider("free-key");
  const otherKey = provider("other-key");

  it("uses an explicit choice when it is an API-key provider", () => {
    expect(pickKeyProvider([connectedKey, freeKey, otherKey], "other-key")?.id).toBe("other-key");
  });

  it("ignores an explicit choice that is not an API-key provider", () => {
    expect(pickKeyProvider([connectedKey, freeKey], "claudeAgent")?.id).toBe("free-key");
  });

  it("prefers an unconnected provider, then falls back to the first connected one", () => {
    expect(pickKeyProvider([connectedKey, freeKey, otherKey])?.id).toBe("free-key");
    expect(pickKeyProvider([connectedKey, otherKey])?.id).toBe("other-key");
    const secondConnected = provider("second-connected", { connected: true });
    expect(pickKeyProvider([connectedKey, secondConnected])?.id).toBe("connected-key");
  });

  it("returns null when there are no API-key providers", () => {
    expect(pickKeyProvider([provider("codex", { auth: "localLogin" })])).toBeNull();
  });
});

describe("tourLandingView", () => {
  it("opens the limits when something is connected and Providers when nothing is", () => {
    expect(tourLandingView(true)).toBe("usage");
    expect(tourLandingView(false)).toBe("providers");
  });
});
