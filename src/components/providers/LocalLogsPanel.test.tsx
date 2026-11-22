import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProviderInfo } from "~/contracts";

import { LocalLogsPanel } from "./LocalLogsPanel";

function provider(overrides: Partial<ProviderInfo> & Pick<ProviderInfo, "id" | "label">): ProviderInfo {
  return {
    color: "#000000",
    auth: "localLogs",
    connected: false,
    accounts: [],
    ...overrides,
  };
}

function render(p: ProviderInfo, hidden?: boolean) {
  return renderToStaticMarkup(<LocalLogsPanel provider={p} hidden={hidden} />);
}

const pi = provider({
  id: "pi",
  label: "Pi",
  stats: { sessions: 12, folder: "C:\\Users\\jane\\.pi\\agent\\sessions" },
});

describe("LocalLogsPanel", () => {
  it("shows the measured sessions and the actions that work on them", () => {
    const html = render(pi);
    expect(html).toContain('data-slot="local-logs-panel"');
    expect(html).toContain("Tracking 12 sessions");
    expect(html).toContain("Open data folder");
    expect(html).toContain("Add folder");
    expect(html).toContain('href="#settings/providers-sources-pi"');
    expect(html).toContain("Stop tracking");
    expect(html).not.toContain("Not found on this computer");
  });

  it("says plainly when the agent is not on this computer and still offers Add folder", () => {
    const html = render(provider({ id: "muse", label: "Muse Code" }));
    expect(html).toContain("Not found on this computer");
    expect(html).toContain('href="#settings/providers-sources-muse"');
    // No folder to open was found, so no dead button.
    expect(html).not.toContain("Open data folder");
    expect(html).toContain("Stop tracking");
  });

  it("says Not tracked when stopped, with Track again and no duplicate action", () => {
    const html = render(pi, true);
    expect(html).toContain("Not tracked");
    expect(html).toContain("Track again");
    expect(html).not.toContain("Stop tracking");
    expect(html).toContain('data-mode="hidden"');
  });
});
