import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProviderInfo } from "~/contracts";

import { AgentConnectPanel } from "./AgentConnectPanel";

function provider(overrides: Partial<ProviderInfo> & Pick<ProviderInfo, "id" | "label">): ProviderInfo {
  return {
    color: "#000000",
    auth: "apiKey",
    connected: false,
    accounts: [],
    ...overrides,
  };
}

function render(p: ProviderInfo) {
  return renderToStaticMarkup(
    <AgentConnectPanel
      provider={p}
      onConnected={() => {}}
      onRecheck={() => {}}
      onOpenSettings={() => {}}
      onBack={() => {}}
    />,
  );
}

describe("per-agent connect panel", () => {
  it("offers an explicit status dot and one action, never an automatic connect", () => {
    const html = render(provider({ id: "mistral", label: "Mistral" }));
    expect(html).toContain('data-slot="agent-connect-panel"');
    expect(html).toContain('data-auto-connect="false"');
    expect(html).toContain('data-slot="connection-status-dot"');
    expect(html).toContain("Add key");
    // No sign-in flow is mounted just because the panel opened.
    expect(html).not.toContain("Finish signing in in your browser");
  });

  it("shows one explicit import button when a local Mistral Vibe key was found", () => {
    const html = render({ ...provider({ id: "mistral", label: "Mistral" }), localImport: { source: "Mistral Vibe" } } as ProviderInfo);
    expect(html).toContain("Import from Mistral Vibe");
    expect(html).toContain("copies the key");
    expect(html).toContain("Add key");
    expect(html).toContain('data-auto-connect="false"');
  });

  it("lists every saved Mistral key and offers another key or a Vibe import, never a sign-in", () => {
    const html = render({
      ...provider({
        id: "mistral",
        label: "Mistral",
        connected: true,
        accounts: [
          { id: "Vibe", label: "Vibe" },
          { id: "Vibe 2", label: "Vibe 2" },
        ],
      }),
      localImport: { source: "Mistral Vibe" },
    } as ProviderInfo);
    expect(html).toContain("Vibe 2");
    expect(html).toContain("Saved keys");
    expect(html).toContain("Add another key");
    expect(html).toContain('aria-label="Rename Vibe 2"');
    expect(html).toContain('aria-label="Remove Vibe 2"');
    expect(html).toContain("Import another key from Mistral Vibe");
    expect(html).not.toContain("Add another account");
    expect(html).not.toContain("Account to connect");
  });

  it("gives OpenCode Go Add key first and one honest link to the key page, with no auto-connect", () => {
    const html = render(
      provider({ id: "opencode-go", label: "OpenCode Go", category: "agent", keyUrl: "https://opencode.ai/auth" }),
    );
    expect(html).toContain("Get your Go key");
    expect(html).not.toContain("Sign in to OpenCode Go");
    expect(html).toContain("copy your Go key");
    expect(html).toContain('data-slot="opencode-go-explicit"');
    expect(html.indexOf("Add key")).toBeLessThan(html.indexOf("Get your Go key"));
    // One link, one URL: no footer row repeating it.
    expect(html.match(/href="https:\/\/opencode\.ai[^"]*"/g)).toEqual(['href="https://opencode.ai/console/go"']);
    expect(html).not.toContain("Open browser");
    expect(html).not.toContain("Provider sign-in link");
  });

  it("hides the connect block for a connected OpenCode Go and keeps the saved keys", () => {
    const html = render(
      provider({
        id: "opencode-go",
        label: "OpenCode Go",
        category: "agent",
        keyUrl: "https://opencode.ai/auth",
        connected: true,
        accounts: [{ id: "k1", label: "Go key" }],
      }),
    );
    expect(html).not.toContain('data-slot="agent-connect-action"');
    expect(html).not.toContain("Get your Go key");
    expect(html).not.toContain("opencode.ai");
    expect(html).toContain("Saved keys");
    expect(html).toContain("Go key");
    expect(html).toContain("Add another key");
    expect(html).toContain("Already added");
  });

  it("offers the ChatGPT account picker for a connected Codex", () => {
    const html = render(
      provider({
        id: "codex",
        label: "Codex",
        auth: "localLogin",
        connected: true,
        accounts: [{ id: "codex-main", label: "Personal" }],
      }),
    );
    expect(html).toContain("ChatGPT account to connect");
    expect(html).toContain("Add ChatGPT account");
    expect(html).toContain("Personal");
    expect(html).not.toContain('aria-label="Remove Personal"');
  });

  it("routes an admin key to setup instead of a sign-in", () => {
    const html = render(provider({ id: "anthropic-admin", label: "Anthropic Admin", category: "admin" }));
    expect(html).toContain("Open provider setup");
    expect(html).toContain("organization admin key");
    expect(html).not.toContain("Sign in</button>");
  });
});
