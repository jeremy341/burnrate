import { describe, expect, it } from "vitest";

import type { ProviderInfo } from "~/contracts";

import {
  accountPickerLabels,
  agentAddedLabel,
  agentAddedState,
  agentDotTone,
  agentSignInLinks,
  buildAgentTiles,
  explicitAgentAction,
  filterAgentTiles,
  groupAgentTiles,
  hasAccountPicker,
  localImportOffer,
  requiresExplicitConnect,
} from "./agentTiles";

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
  login: { kind: "cli", command: "claude", installed: true, installUrl: "https://example.test/claude" },
});
const codex = provider({
  id: "codex",
  label: "Codex",
  auth: "localLogin",
  login: { kind: "cli", command: "codex", installed: true, installUrl: "https://example.test/codex" },
});
const go = provider({
  id: "opencode-go",
  label: "OpenCode Go",
  category: "agent",
  keyUrl: "https://opencode.ai/auth",
});
const admin = provider({ id: "anthropic-admin", label: "Anthropic Admin", category: "admin" });
const mistral = provider({ id: "mistral", label: "Mistral" });

describe("agent tiles", () => {
  it("builds connected-first tiles grouped as agents, keys and more providers", () => {
    const tiles = buildAgentTiles([mistral, admin, claude, go, codex]);
    expect(tiles.map((tile) => tile.id)).toEqual(["claudeAgent", "codex", "anthropic-admin", "mistral", "opencode-go"]);
    expect(tiles.map((tile) => tile.group).sort()).toEqual(["agents", "agents", "agents", "keys", "more"].sort());
    const sections = groupAgentTiles(tiles);
    expect(sections.map((section) => section.id)).toEqual(["agents", "keys", "more"]);
    expect(sections[2]!.label).toBe("More providers");
  });

  it("drops hidden providers unless the settings grid asks to include them", () => {
    expect(buildAgentTiles([claude, codex], { hidden: ["codex"] }).map((t) => t.id)).toEqual(["claudeAgent"]);
    expect(
      buildAgentTiles([claude, codex], { hidden: ["codex"], includeHidden: true }).map((t) => t.id),
    ).toEqual(["claudeAgent", "codex"]);
  });

  it("marks connection dots and added states without inventing an account", () => {
    expect(agentDotTone(claude)).toBe("ready");
    expect(agentDotTone(codex)).toBe("warning");
    expect(agentDotTone({ ...codex, login: { ...codex.login!, installed: false } })).toBe("disabled");
    expect(agentDotTone(mistral)).toBe("neutral");
    expect(agentAddedState(claude)).toBe("alreadyAdded");
    expect(agentAddedLabel(agentAddedState(claude))).toBe("Already added");
    expect(agentAddedLabel(agentAddedState(provider({ id: "pi", label: "Pi", auth: "localLogs", connected: true })))).toBe("Added");
    expect(agentAddedLabel(agentAddedState(mistral))).toBe("");
  });

  it("searches agent aliases, hints and account labels", () => {
    const tiles = buildAgentTiles([claude, codex, go, mistral]);
    expect(filterAgentTiles(tiles, "chatgpt").map((t) => t.id)).toContain("codex");
    expect(filterAgentTiles(tiles, "go plan").map((t) => t.id)).toContain("opencode-go");
    expect(filterAgentTiles(tiles, "work").map((t) => t.id)).toEqual(["claudeAgent"]);
    expect(filterAgentTiles(tiles, "nothing-matches")).toEqual([]);
  });
});

describe("explicit connect actions", () => {
  it("routes an admin key to setup instead of a login", () => {
    expect(explicitAgentAction(admin)).toEqual({ kind: "manage", label: "Open provider setup" });
  });

  it("signs in a detected CLI agent with an explicit click and names its command", () => {
    expect(explicitAgentAction(codex)).toEqual({ kind: "signIn", label: "Sign in", command: "codex" });
  });

  it("offers install instead of a dead sign-in when the CLI is missing", () => {
    const missing = provider({
      id: "codex",
      label: "Codex",
      auth: "localLogin",
      login: { kind: "cli", command: "codex", installed: false, installUrl: "https://example.test/codex" },
    });
    expect(explicitAgentAction(missing)).toEqual({
      kind: "install",
      label: "Install",
      url: "https://example.test/codex",
    });
  });

  it("never auto-connects OpenCode Go: it links to where the key is created and offers Add key", () => {
    expect(requiresExplicitConnect(go)).toBe(true);
    expect(explicitAgentAction(go)).toEqual({
      kind: "providerLink",
      label: "Get your Go key",
      url: "https://opencode.ai/console/go",
    });
  });

  it("offers each URL once: no footer row when the leading action already links, and no duplicate sign-in link", () => {
    // The leading action already opens a page, so the footer row would only repeat it.
    expect(agentSignInLinks(go)).toEqual({});
    expect(agentSignInLinks(go, { kind: "install", label: "Install", url: "https://example.test/x" })).toEqual({});
    // Another provider keeps one "Open browser" link, never a second link to the same URL.
    const keyed = { ...mistral, keyUrl: "https://console.mistral.ai/api-keys" } as ProviderInfo;
    const links = agentSignInLinks(keyed, { kind: "addKey", label: "Add key" });
    expect(links).toEqual({ openBrowserUrl: "https://console.mistral.ai/api-keys" });
    expect(links.providerSignInUrl).toBeUndefined();
    expect(agentSignInLinks(mistral)).toEqual({});
  });

  it("shows nothing to connect once OpenCode Go has a saved key", () => {
    const connected = { ...go, connected: true, accounts: [{ id: "k1", label: "Go key" }] } as ProviderInfo;
    expect(explicitAgentAction(connected).kind).toBe("none");
  });

  it("offers a one-click import only when the server found a local key", () => {
    const withVibe = { ...mistral, localImport: { source: "Mistral Vibe" } } as ProviderInfo;
    expect(localImportOffer(withVibe)).toEqual({ source: "Mistral Vibe" });
    expect(explicitAgentAction(withVibe)).toEqual({
      kind: "importLocal",
      label: "Import from Mistral Vibe",
      source: "Mistral Vibe",
    });
    expect(localImportOffer(mistral)).toBeNull();
    expect(explicitAgentAction(mistral)).toEqual({ kind: "addKey", label: "Add key" });
    expect(localImportOffer({ ...withVibe, localImport: { source: 42 } } as unknown as ProviderInfo)).toBeNull();
  });

  it("keeps offering the import once a first Vibe key is saved, so a second Vibe profile can be added", () => {
    const connected = {
      ...mistral,
      connected: true,
      accounts: [{ id: "Vibe", label: "Vibe" }],
      localImport: { source: "Mistral Vibe" },
    } as ProviderInfo;
    expect(explicitAgentAction(connected)).toEqual({
      kind: "importLocal",
      label: "Import another key from Mistral Vibe",
      source: "Mistral Vibe",
    });
    // Nothing left to import (server dropped the offer): a connected provider is just connected.
    expect(explicitAgentAction({ ...connected, localImport: undefined } as unknown as ProviderInfo).kind).toBe("none");
  });

  it("labels a key provider's saved keys as keys, never as sign-in accounts", () => {
    const labels = accountPickerLabels({ ...mistral, connected: true, accounts: [{ id: "Vibe", label: "Vibe" }] });
    expect(labels).toEqual({
      heading: "Saved keys",
      add: "Add another key",
      help: "Each key is read as its own account. Add a second key to track another profile.",
    });
    expect(accountPickerLabels(go).add).toBe("Add another key");
  });

  it("does not treat an unsafe sign-in URL as a link", () => {
    const unsafe = { ...go, keyUrl: "javascript:alert(1)" };
    expect(explicitAgentAction(unsafe)).toEqual({ kind: "addKey", label: "Add key" });
    expect(agentSignInLinks(unsafe)).toEqual({});
  });
});

describe("account picker", () => {
  it("offers a ChatGPT account picker only for a connected Codex with accounts", () => {
    expect(hasAccountPicker(codex)).toBe(false);
    const connected = { ...codex, connected: true, accounts: [{ id: "codex-main", label: "Personal" }] };
    expect(hasAccountPicker(connected)).toBe(true);
    expect(accountPickerLabels(connected)).toMatchObject({
      heading: "ChatGPT account to connect",
      add: "Add ChatGPT account",
    });
  });

  it("uses plain account wording for other agents and never for admin keys", () => {
    const other = provider({
      id: "claudeAgent",
      label: "Claude Code",
      auth: "localLogin",
      connected: true,
      accounts: [{ id: "claude-work", label: "work" }],
    });
    expect(accountPickerLabels(other).add).toBe("Add another account");
    expect(hasAccountPicker({ ...other, category: "admin" })).toBe(false);
  });
});
