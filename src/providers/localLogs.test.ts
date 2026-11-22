import { describe, expect, it } from "vitest";

import type { ProviderInfo } from "~/contracts";

import {
  addFolderDeepLink,
  hasLocalLogsPanel,
  isLocalLogsProvider,
  localStats,
  localStatusLine,
  withHidden,
} from "./localLogs";

function provider(overrides: Partial<ProviderInfo> & Pick<ProviderInfo, "id" | "label">): ProviderInfo {
  return {
    color: "#000000",
    auth: "localLogs",
    connected: false,
    accounts: [],
    ...overrides,
  };
}

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const stats = {
  sessions: 41,
  lastUsedAt: "2026-11-21T10:00:00.000Z",
  folder: "C:\\Users\\jane\\.pi\\agent\\sessions",
};

describe("local-log providers", () => {
  it("knows which rows are local logs and which get the panel", () => {
    const pi = provider({ id: "pi", label: "Pi" });
    const muse = provider({ id: "muse", label: "Muse Code" });
    const antigravity = provider({ id: "antigravity", label: "Antigravity" });
    const key = provider({ id: "mistral", label: "Mistral", auth: "apiKey" });
    expect(isLocalLogsProvider(pi)).toBe(true);
    expect(isLocalLogsProvider(key)).toBe(false);
    // Antigravity is local logs too, but has a sign-in Burnrate can start: it keeps its own row.
    expect(hasLocalLogsPanel(pi)).toBe(true);
    expect(hasLocalLogsPanel(muse)).toBe(true);
    expect(hasLocalLogsPanel(antigravity)).toBe(false);
    expect(hasLocalLogsPanel(key)).toBe(false);
  });

  it("says what the files really contain, or that the agent was not found", () => {
    expect(localStatusLine(provider({ id: "pi", label: "Pi" }), { nowMs: NOW })).toBe(
      "Not found on this computer",
    );
    expect(
      localStatusLine(provider({ id: "pi", label: "Pi" }), { hidden: true, nowMs: NOW }),
    ).toBe("Not tracked");
    expect(
      localStatusLine(provider({ id: "muse", label: "Muse Code", stats: { sessions: 41, folder: "C:\\m" } }), {
        nowMs: NOW,
      }),
    ).toBe("Tracking 41 sessions");
    expect(
      localStatusLine(provider({ id: "pi", label: "Pi", stats }), { nowMs: NOW }),
    ).toBe("Tracking 41 sessions · last used 2h ago");
    expect(
      localStatusLine(provider({ id: "pi", label: "Pi", stats: { ...stats, sessions: 1 } }), { nowMs: NOW }),
    ).toBe("Tracking 1 session · last used 2h ago");
    expect(
      localStatusLine(provider({ id: "pi", label: "Pi", stats: { ...stats, sessions: 0, lastUsedAt: undefined } })),
    ).toBe("Found on this computer, no sessions yet");
    // No stats = the server found no folder; localStats never invents one.
    expect(localStats(provider({ id: "pi", label: "Pi" }))).toBeUndefined();
    expect(localStats(provider({ id: "pi", label: "Pi", stats }))).toBe(stats);
  });

  it("deep-links to the Pi and Muse folder blocks in Settings > Providers", () => {
    expect(addFolderDeepLink("pi")).toBe("#settings/providers-sources-pi");
    expect(addFolderDeepLink("muse")).toBe("#settings/providers-sources-muse");
  });

  it("adds and removes one id without disturbing the others or duplicating it", () => {
    expect(withHidden(["codex"], "pi", true)).toEqual(["codex", "pi"]);
    expect(withHidden(["codex", "pi"], "pi", true)).toEqual(["codex", "pi"]);
    expect(withHidden(["codex", "pi", "muse"], "pi", false)).toEqual(["codex", "muse"]);
    expect(withHidden(["codex"], "pi", false)).toEqual(["codex"]);
  });
});
