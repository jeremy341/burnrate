import { describe, expect, it } from "vitest";

import type { ProviderInfo } from "~/contracts";

import {
  canAddAccount,
  detectedAgentsToConnect,
  groupProviders,
  isProviderConnected,
  listedProviderIds,
  primaryAction,
  providerCategory,
  providerGroupId,
  providerLogin,
  providerMatches,
  providerStatus,
  providerSubtitle,
  shouldOfferConnect,
  sortProviders,
} from "./providersList";

function provider(overrides: Partial<ProviderInfo> & Pick<ProviderInfo, "id" | "label">): ProviderInfo {
  return {
    color: "#000000",
    auth: "apiKey",
    connected: false,
    accounts: [],
    ...overrides,
  };
}

const claude = provider({
  id: "claudeAgent",
  label: "Claude Code",
  auth: "localLogin",
  connected: true,
  accounts: [{ id: "claude-work", label: "work" }],
});
const cursor = provider({
  id: "cursor",
  label: "Cursor",
  auth: "apiKey",
  accounts: [{ id: "personal", label: "Personal" }],
});
const mistral = provider({ id: "mistral", label: "Mistral", auth: "apiKey" });
const openrouter = provider({
  id: "openrouter",
  label: "OpenRouter",
  auth: "apiKey",
  accounts: [
    { id: "openrouter-1", label: "Main" },
    { id: "openrouter-2", label: "Side" },
  ],
});

describe("providerMatches", () => {
  it("matches an empty query", () => {
    expect(providerMatches(mistral, "")).toBe(true);
    expect(providerMatches(mistral, "   ")).toBe(true);
  });

  it("matches id, label, auth hint and account labels case-insensitively", () => {
    expect(providerMatches(claude, "CLAUDE")).toBe(true);
    expect(providerMatches(cursor, "api key")).toBe(true);
    expect(providerMatches(openrouter, "main")).toBe(true);
    expect(providerMatches(openrouter, "side key")).toBe(true);
  });

  it("requires every whitespace-separated token", () => {
    expect(providerMatches(claude, "claude work")).toBe(true);
    expect(providerMatches(claude, "claude mistral")).toBe(false);
  });
});

describe("isProviderConnected", () => {
  it("treats saved accounts as connected even when the server flag is false", () => {
    expect(isProviderConnected(cursor)).toBe(true);
    expect(isProviderConnected(mistral)).toBe(false);
    expect(isProviderConnected(claude)).toBe(true);
  });
});

const codex = provider({
  id: "codex",
  label: "Codex",
  auth: "localLogin",
  connected: false,
  login: { kind: "cli", command: "codex", installed: true, installUrl: "https://example.test/codex" },
});
const codexMissing = provider({
  id: "codex",
  label: "Codex",
  auth: "localLogin",
  login: { kind: "cli", command: "codex", installed: false, installUrl: "https://example.test/codex" },
});
const anthropicAdmin = provider({ id: "anthropic-admin", label: "Anthropic Admin", auth: "apiKey" });
const logsOnly = provider({ id: "pi", label: "Pi", auth: "localLogs", connected: true });

describe("providerCategory and group", () => {
  it("trusts the server's category", () => {
    expect(providerCategory(provider({ id: "x", label: "X", category: "admin" }))).toBe("admin");
    expect(providerGroupId(provider({ id: "opencode-go", label: "Go", category: "agent" }))).toBe("agents");
    expect(providerGroupId(provider({ id: "x", label: "X", category: "localLogs" }))).toBe("agents");
  });

  it("falls back to id and auth for an older server", () => {
    expect(providerGroupId(claude)).toBe("agents");
    expect(providerGroupId(logsOnly)).toBe("agents");
    expect(providerGroupId(mistral)).toBe("apiKeys");
    expect(providerGroupId(anthropicAdmin)).toBe("advanced");
    expect(providerGroupId(provider({ id: "openai-admin", label: "OpenAI Admin" }))).toBe("advanced");
    // A key-based plan on an agent is still listed with the agents.
    expect(providerGroupId(provider({ id: "opencode-go", label: "OpenCode Go", auth: "apiKey" }))).toBe("agents");
  });
});

describe("providerLogin", () => {
  it("assumes a CLI sign-in for Claude only when the server says nothing", () => {
    expect(providerLogin(claude)).toMatchObject({ command: "claude", installed: true });
    expect(providerLogin({ ...claude, login: null })).toBeNull();
    expect(providerLogin(mistral)).toBeNull();
    expect(providerLogin(codex)).toMatchObject({ command: "codex" });
  });
});

describe("providerStatus and primaryAction", () => {
  it("connected rows lead with nothing", () => {
    expect(providerStatus(claude)).toBe("connected");
    expect(primaryAction(claude)).toEqual({ kind: "none" });
    expect(providerStatus(logsOnly)).toBe("connected");
  });

  it("an installed CLI that is not signed in offers Sign in", () => {
    expect(providerStatus(codex)).toBe("needsSignIn");
    expect(primaryAction(codex)).toEqual({ kind: "signIn" });
  });

  it("a missing CLI offers the install page instead of a dead button", () => {
    expect(providerStatus(codexMissing)).toBe("notInstalled");
    expect(primaryAction(codexMissing)).toEqual({
      kind: "install",
      url: "https://example.test/codex",
      command: "codex",
    });
  });

  it("key providers offer Add key until a key exists", () => {
    expect(providerStatus(mistral)).toBe("available");
    expect(primaryAction(mistral)).toEqual({ kind: "addKey" });
    expect(primaryAction(openrouter)).toEqual({ kind: "none" });
  });

  it("an agent with no login and nothing found just says so", () => {
    const grok = provider({ id: "grok", label: "Grok", auth: "localLogin" });
    expect(providerStatus(grok)).toBe("notDetected");
    expect(primaryAction(grok)).toEqual({ kind: "none" });
    // ...but a key-based agent still wants its key.
    const go = provider({ id: "opencode-go", label: "OpenCode Go", auth: "apiKey", category: "agent" });
    expect(primaryAction(go)).toEqual({ kind: "addKey" });
  });

  it("lets a connected Claude or key provider add another account", () => {
    expect(canAddAccount(claude)).toBe("signIn");
    expect(canAddAccount(openrouter)).toBe("addKey");
    expect(canAddAccount(codex)).toBeNull();
  });
});

describe("detectedAgentsToConnect", () => {
  it("lists installed agents that are not connected, never keys or connected agents", () => {
    const list = detectedAgentsToConnect([mistral, claude, codex, codexMissing, logsOnly, anthropicAdmin]);
    expect(list.map((entry) => entry.id)).toEqual(["codex"]);
  });

  it("is empty when everything detected is connected", () => {
    expect(detectedAgentsToConnect([claude, logsOnly, mistral])).toEqual([]);
  });

  it("offers Claude when the old server says nothing but Claude is not signed in", () => {
    const fresh = provider({ id: "claudeAgent", label: "Claude Code", auth: "localLogin" });
    expect(detectedAgentsToConnect([fresh]).map((entry) => entry.id)).toEqual(["claudeAgent"]);
  });
});

describe("groupProviders", () => {
  it("splits into agents, API keys and advanced; connected first, then label", () => {
    const groups = groupProviders([mistral, openrouter, claude, codex, anthropicAdmin, cursor, logsOnly]);
    expect(groups.total).toBe(7);
    expect(groups.agents.map((entry) => entry.id)).toEqual(["claudeAgent", "cursor", "pi", "codex"]);
    expect(groups.apiKeys.map((entry) => entry.id)).toEqual(["openrouter", "mistral"]);
    expect(groups.advanced.map((entry) => entry.id)).toEqual(["anthropic-admin"]);
  });

  it("keeps cursor with the agents when only the id is known", () => {
    const groups = groupProviders([cursor, mistral]);
    expect(groups.agents.map((entry) => entry.id)).toEqual(["cursor"]);
    expect(groups.apiKeys.map((entry) => entry.id)).toEqual(["mistral"]);
  });

  it("respects the configured display order inside a rank", () => {
    const a = provider({ id: "a", label: "Alpha", connected: true });
    const b = provider({ id: "b", label: "Beta", connected: true });
    const groups = groupProviders([a, b], { order: ["b", "a"] });
    expect(groups.apiKeys.map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("drops hidden providers", () => {
    const groups = groupProviders([mistral, openrouter, claude], { hidden: ["openrouter", "mistral"] });
    expect(listedProviderIds(groups)).toEqual(["claudeAgent"]);
    expect(groups.total).toBe(1);
  });

  it("keeps agents with nothing to do out of the main list, and hidden ones recoverable", () => {
    const nothing = provider({ id: "grok", label: "Grok", auth: "localLogs", connected: false });
    const groups = groupProviders([claude, nothing, mistral], { hidden: ["mistral"] });
    expect(groups.agents.map((entry) => entry.id)).toEqual(["claudeAgent"]);
    expect(groups.notFound.map((entry) => entry.id)).toEqual(["grok"]);
    expect(groups.hidden.map((entry) => entry.id)).toEqual(["mistral"]);
    expect(groups.total).toBe(2);
    expect(groupProviders([claude, nothing, mistral], { hidden: ["mistral"], query: "mist" }).hidden).toHaveLength(1);
  });

  it("applies the search to accounts, hints and the advanced group", () => {
    expect(listedProviderIds(groupProviders([mistral, openrouter, claude], { query: "side" }))).toEqual(["openrouter"]);
    const hinted = provider({ id: "zed", label: "Zed", hint: "Detected on this computer" });
    expect(listedProviderIds(groupProviders([hinted, mistral], { query: "detected" }))).toEqual(["zed"]);
    expect(groupProviders([anthropicAdmin, mistral], { query: "admin" }).advanced).toHaveLength(1);
  });
});

describe("sortProviders", () => {
  it("puts unknown ids after ordered ones", () => {
    const sorted = sortProviders([mistral, cursor, claude], ["cursor"]);
    expect(sorted.map((entry) => entry.id)).toEqual(["cursor", "claudeAgent", "mistral"]);
  });
});

describe("providerSubtitle", () => {
  it("never says there are no accounts for something that auto-detects", () => {
    expect(providerSubtitle(logsOnly)).toBe("Detected on this computer");
    expect(providerSubtitle({ ...logsOnly, hint: "Reads local session files" })).toBe("Reads local session files");
  });

  it("describes saved keys and accounts", () => {
    expect(providerSubtitle(openrouter)).toBe("2 keys");
    expect(providerSubtitle(cursor)).toBe("1 key");
    expect(providerSubtitle(claude)).toBe("work");
  });

  it("says what is missing for the rest", () => {
    expect(providerSubtitle(codex)).toMatch(/Sign in/);
    expect(providerSubtitle(codexMissing)).toBe("codex is not installed on this computer.");
    expect(providerSubtitle(mistral)).toMatch(/API key/);
    expect(providerSubtitle(provider({ id: "grok", label: "Grok", auth: "localLogin" }))).toBe("Not found on this computer.");
  });
});

describe("shouldOfferConnect", () => {
  it("offers Connect when an agent is waiting or nothing is connected", () => {
    expect(shouldOfferConnect([codex, claude])).toBe(true);
    expect(shouldOfferConnect([mistral])).toBe(true);
    expect(shouldOfferConnect([])).toBe(true);
  });

  it("stays quiet when everything detected is connected", () => {
    expect(shouldOfferConnect([claude, logsOnly, mistral])).toBe(false);
  });
});
