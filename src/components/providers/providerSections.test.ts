import { describe, expect, it } from "vitest";

import type { ProviderInfo } from "~/contracts";

import { providerSection } from "./providerSections";

function provider(overrides: Partial<ProviderInfo> & Pick<ProviderInfo, "id" | "label">): ProviderInfo {
  return {
    color: "#000000",
    auth: "apiKey",
    connected: false,
    accounts: [],
    ...overrides,
  };
}

const installedCli = { kind: "cli" as const, command: "claude", installed: true, installUrl: "https://example.com" };

describe("providerSection", () => {
  it("puts a saved or found login or key in Connected", () => {
    expect(
      providerSection(provider({ id: "codex", label: "Codex", auth: "localLogin", connected: true }), false),
    ).toBe("connected");
    expect(
      providerSection(provider({ id: "mistral", label: "Mistral", accounts: [{ id: "main", label: "main" }] }), false),
    ).toBe("connected");
  });

  it("puts an agent to sign in to, an install, a key to add, or an import in Available", () => {
    expect(
      providerSection(provider({ id: "claudeAgent", label: "Claude Code", auth: "localLogin", login: installedCli }), false),
    ).toBe("available");
    expect(
      providerSection(
        provider({
          id: "codex",
          label: "Codex",
          auth: "localLogin",
          login: { ...installedCli, command: "codex login", installed: false },
        }),
        false,
      ),
    ).toBe("available");
    expect(providerSection(provider({ id: "deepseek", label: "DeepSeek" }), false)).toBe("available");
    expect(
      providerSection(Object.assign(provider({ id: "mistral", label: "Mistral" }), { localImport: { source: "Mistral Vibe" } }), false),
    ).toBe("available");
  });

  it("folds an agent with nothing found and nothing to do into Not found", () => {
    expect(providerSection(provider({ id: "muse", label: "Muse Code", auth: "localLogs" }), false)).toBe("notFound");
  });

  it("keeps a hidden provider in Hidden whatever its state", () => {
    expect(providerSection(provider({ id: "deepseek", label: "DeepSeek" }), true)).toBe("hidden");
    expect(
      providerSection(provider({ id: "codex", label: "Codex", auth: "localLogin", connected: true }), true),
    ).toBe("hidden");
  });
});
