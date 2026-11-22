import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProviderInfo } from "~/contracts";

import { buildAgentTiles, filterAgentTiles, groupAgentTiles } from "./agentTiles";
import { AgentChooserContent } from "./AgentChooser";

function provider(overrides: Partial<ProviderInfo> & Pick<ProviderInfo, "id" | "label">): ProviderInfo {
  return {
    color: "#000000",
    auth: "apiKey",
    connected: false,
    accounts: [],
    ...overrides,
  };
}

const providers: ProviderInfo[] = [
  provider({
    id: "claudeAgent",
    label: "Claude Code",
    auth: "localLogin",
    connected: true,
    accounts: [{ id: "claude-work", label: "work" }],
  }),
  provider({ id: "codex", label: "Codex", auth: "localLogin" }),
  provider({ id: "anthropic-admin", label: "Anthropic Admin", category: "admin" }),
];

function render(query = "") {
  const tiles = buildAgentTiles(providers);
  const sections = groupAgentTiles(filterAgentTiles(tiles, query));
  return renderToStaticMarkup(
    <AgentChooserContent
      sections={sections}
      query={query}
      onQueryChange={() => {}}
      onSelect={() => {}}
      onOpenSettings={() => {}}
    />,
  );
}

describe("Choose an agent chooser", () => {
  it("uses the T3 title, search label, scrollFade area and icon-tile grid", () => {
    const html = render();
    expect(html).toContain("Choose an agent");
    expect(html).toContain("Search agents…");
    expect(html).toContain('data-slot="agent-chooser"');
    expect(html).toContain('data-slot="agent-chooser-scroll"');
    expect(html).toContain("grid gap-3 sm:grid-cols-2");
    expect(html).toContain('data-agent="claudeAgent"');
    expect(html).toContain('data-agent="anthropic-admin"');
    expect(html).toContain('data-admin="true"');
  });

  it("shows Added / Already added states and the admin-vs-login distinction", () => {
    const html = render();
    expect(html).toContain("Already added");
    expect(html).toContain("Open provider setup");
    expect(html).toContain("Organization admin keys read API spend");
  });

  it("narrows the grid by search and gives a calm empty state", () => {
    const found = render("claude");
    expect(found).toContain('data-agent="claudeAgent"');
    expect(found).not.toContain('data-agent="codex"');
    expect(render("nothing-here")).toContain("No agents match your search.");
  });
});
