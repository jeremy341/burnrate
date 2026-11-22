import { describe, expect, it } from "vitest";

import type { ProviderInfo } from "~/contracts";
import {
  buildProviderRows,
  localImportResultText,
  parsePollInterval,
  providerNote,
  providerAccessLabel,
  visibleSourceIds,
} from "./providers";

function provider(id: string, label: string, connected: boolean, hint?: string): ProviderInfo {
  return {
    id,
    label,
    color: "var(--foreground)",
    auth: "apiKey",
    connected,
    accounts: [],
    ...(hint ? { hint } : {}),
  };
}

describe("provider list", () => {
  it("lists connected providers first, then alphabetically, with no manual order", () => {
    const rows = buildProviderRows([
      provider("zeta", "Zeta", false),
      provider("codex", "Codex", true),
      provider("claudeAgent", "Claude", true),
      provider("mistral", "Mistral", false),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["claudeAgent", "codex", "mistral", "zeta"]);
  });

  it("counts a provider with a saved account as connected even if the flag lags", () => {
    const withAccount: ProviderInfo = {
      ...provider("deepseek", "DeepSeek", false),
      accounts: [{ id: "deepseek-main", label: "main" } as ProviderInfo["accounts"][number]],
    };
    expect(buildProviderRows([withAccount])[0]?.connected).toBe(true);
  });

  it("gives each unconnected row the one honest action, and none when there is nothing to do", () => {
    const rows = buildProviderRows([
      provider("deepseek", "DeepSeek", false, "Paste an API key"),
      { ...provider("antigravity", "Antigravity", false), auth: "localLogs", category: "localLogs" },
      {
        ...provider("claudeAgent", "Claude Code", false),
        auth: "localLogin",
        category: "agent",
        login: { kind: "cli", command: "claude auth login", installed: true, installUrl: "https://example.com" },
      },
    ]);
    const kinds = Object.fromEntries(rows.map((row) => [row.id, row.action.kind]));
    expect(kinds).toEqual({ claudeAgent: "signIn", deepseek: "addKey", antigravity: "none" });
  });

  it("shows the server's hint as the one status line, never a badge", () => {
    const rows = buildProviderRows([provider("claudeAgent", "Claude", true, "Detected on this computer")]);
    expect(rows[0]?.status).toBe("Detected on this computer");
  });

  it("has no rows before the server answers", () => {
    expect(buildProviderRows(undefined)).toEqual([]);
  });
});

describe("provider access labels", () => {
  it("distinguishes self-service keys, organization keys, local sign-ins and local logs", () => {
    expect(providerAccessLabel({ auth: "apiKey", category: "agent" })).toBe("Account API key");
    expect(providerAccessLabel({ auth: "apiKey", category: "admin" })).toBe("Organization admin key");
    expect(providerAccessLabel({ auth: "localLogin", category: "agent" })).toBe("Local sign-in");
    expect(providerAccessLabel({ auth: "localLogs", category: "localLogs" })).toBe("Local session files");
  });
});

describe("provider polling interval", () => {
  it("supports the definition default and the full server-validated range", () => {
    expect(parsePollInterval("")).toEqual({ value: undefined });
    expect(parsePollInterval(" 60 ")).toEqual({ value: 60 });
    expect(parsePollInterval("61")).toEqual({ value: 61 });
    expect(parsePollInterval("86400")).toEqual({ value: 86400 });
    for (const draft of ["59", "86401", "60.5", "abc", "Infinity"]) {
      expect(parsePollInterval(draft)).toBeNull();
    }
  });
});

describe("OpenCode Go one-click local login", () => {
  const go = (extra: object = {}): ProviderInfo => ({
    ...provider("opencode-go", "OpenCode Go", false, "OpenCode found. Use its Go key in one click"),
    category: "agent",
    ...extra,
  });

  it("offers the local login only while nothing is connected", () => {
    const offered = buildProviderRows([go({ localImport: { source: "OpenCode" } } as object)])[0];
    expect(offered?.localImport).toEqual({ source: "OpenCode" });
    const connected = buildProviderRows([go({ connected: true, localImport: { source: "OpenCode" } } as object)])[0];
    expect(connected?.localImport).toBeUndefined();
    expect(buildProviderRows([go()])[0]?.localImport).toBeUndefined();
  });

  it("says in plain words that Go limits and OpenCode's local usage are different things", () => {
    expect(providerNote("opencode-go")).toMatch(/Go plan limits.*local logs/);
    expect(providerNote("mistral")).toBeUndefined();
    expect(buildProviderRows([go()])[0]?.note).toBe(providerNote("opencode-go"));
  });

  it("reports what was really read after the click", () => {
    expect(localImportResultText("opencode-go", "OpenCode", { summary: "Go session 0% used" })).toBe(
      "Connected: Go session 0% used.",
    );
    expect(localImportResultText("mistral", "Mistral Vibe", { imported: ["Vibe", "Vibe 2"] })).toBe(
      "Imported Vibe, Vibe 2 from Mistral Vibe.",
    );
  });
});

describe("local source folder blocks", () => {
  it("always offers Claude Code and Mistral Vibe, and no agent nobody has", () => {
    expect(visibleSourceIds({}, [], null)).toEqual(["claude", "vibe"]);
  });

  it("adds an agent once it is detected, connected, or already has folders", () => {
    const detected = [{ ...provider("pi", "Pi", false), detected: true } as ProviderInfo];
    expect(visibleSourceIds({}, detected, null)).toContain("pi");
    expect(visibleSourceIds({}, [provider("muse", "Muse Code", true)], null)).toContain("muse");
    expect(visibleSourceIds({ pi: ["C:\\pi"] }, [], null)).toContain("pi");
  });

  it("renders the block a deep link points at even before the agent is detected", () => {
    expect(visibleSourceIds({}, [], "providers-sources-pi")).toContain("pi");
    expect(visibleSourceIds({}, [], "providers-sources-muse")).toContain("muse");
    expect(visibleSourceIds({}, [], "providers-sources-gemini")).toContain("gemini");
  });
});
