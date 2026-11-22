import { describe, expect, it } from "vitest";

import type { ProviderInfo } from "~/contracts";

import {
  accountDisconnectKind,
  claudeFolder,
  connectedStatus,
  disconnectCopy,
  extraSlots,
  importResultText,
  providerRowPlan,
} from "./rowPlan";

function provider(overrides: Partial<ProviderInfo> & Pick<ProviderInfo, "id" | "label">): ProviderInfo {
  return { color: "#000", auth: "apiKey", connected: false, accounts: [], ...overrides };
}

const mistralWithVibe = provider({
  id: "mistral",
  label: "Mistral",
  hint: "Mistral Vibe found. Import its key in one click",
  ...({ localImport: { source: "Mistral Vibe" } } as object),
});
const codex = provider({
  id: "codex",
  label: "Codex (ChatGPT)",
  auth: "localLogin",
  connected: true,
  login: { kind: "cli", command: "codex login", installed: false, installUrl: "https://example.com/codex" },
});
const antigravity = provider({ id: "antigravity", label: "Antigravity", auth: "localLogs", connected: true });
// The server offers Antigravity's sign-in as an app launch: `command` names the app, not a CLI.
const antigravityApp = provider({
  id: "antigravity",
  label: "Antigravity",
  auth: "localLogs",
  connected: true,
  login: { kind: "cli", command: "Antigravity", installed: true, installUrl: "https://antigravity.google/" },
});
const antigravityNotInstalled = {
  ...antigravityApp,
  login: { ...antigravityApp.login!, installed: false },
};
const muse = provider({ id: "muse", label: "Muse Code", auth: "localLogs", connected: false });
const goLocal = provider({
  id: "opencode-go",
  label: "OpenCode Go",
  connected: true,
  ...({ detected: true } as object),
});

describe("providerRowPlan", () => {
  it("leads Mistral with the one-click Vibe import and keeps Add key second", () => {
    const plan = providerRowPlan(mistralWithVibe);
    expect(plan.lead).toMatchObject({ kind: "importLocal", providerId: "mistral", label: "Import from Mistral Vibe" });
    expect(plan.secondary).toMatchObject({ kind: "addKey", label: "Add key" });
    // Says plainly there is no browser sign-in.
    expect(plan.note).toBe("Mistral has no browser sign-in: it works with an API key.");
  });

  it("offers only Add key when Vibe is not on the computer, and says Mistral has no browser sign-in", () => {
    const plan = providerRowPlan(provider({ id: "mistral", label: "Mistral" }));
    expect(plan.lead).toMatchObject({ kind: "addKey" });
    expect(plan.secondary).toBeNull();
    expect(plan.note).toContain("no browser sign-in");
  });

  it("offers 'Use my local OpenCode login' with 'Paste Go key' for OpenCode Go", () => {
    const plan = providerRowPlan(
      provider({ id: "opencode-go", label: "OpenCode Go", ...({ localImport: { source: "OpenCode" } } as object) }),
    );
    expect(plan.lead).toMatchObject({ kind: "importLocal", providerId: "opencode-go", label: "Use my local OpenCode login" });
    expect(plan.secondary).toMatchObject({ kind: "addKey", label: "Paste Go key" });
  });

  it("gives Codex a visible status, Install (CLI missing) and a Disconnect that names the file", () => {
    const plan = providerRowPlan(codex);
    expect(plan.mode).toBe("connected");
    expect(plan.menu).toEqual([expect.objectContaining({ kind: "install", url: "https://example.com/codex" })]);
    expect(plan.disconnect).toBe("codex");
    expect(connectedStatus(codex)).toBe("Signed in with ChatGPT");
  });

  it("offers Sign in again for Codex once the CLI exists, and leads with it when the login expired", () => {
    const installed = { ...codex, login: { ...codex.login!, installed: true } };
    expect(providerRowPlan(installed).menu).toEqual([expect.objectContaining({ kind: "signInAgain" })]);
    expect(providerRowPlan(installed, { expired: true }).lead).toMatchObject({ kind: "signInAgain" });
  });

  it("lets a local-only agent that was detected be disconnected (hidden), with a one-line explanation", () => {
    const plan = providerRowPlan(antigravity);
    expect(plan.disconnect).toBe("hide");
    expect(plan.note).toContain("Sign in inside Antigravity");
  });

  it("offers Sign in again on a connected Antigravity row and drops the 'no flow' explanation", () => {
    const plan = providerRowPlan(antigravityApp);
    expect(plan.menu).toEqual([expect.objectContaining({ kind: "signInAgain", label: "Sign in again" })]);
    // Antigravity is only read from its files: hiding it here is the whole disconnect.
    expect(plan.disconnect).toBe("hide");
    expect(plan.note).toBeNull();
    expect(connectedStatus(antigravityApp)).toBe("Reading Antigravity on this computer");
  });

  it("offers the Antigravity download page when the app is not installed", () => {
    const plan = providerRowPlan(antigravityNotInstalled);
    expect(plan.menu).toEqual([
      expect.objectContaining({ kind: "install", label: "Install Antigravity", url: "https://antigravity.google/" }),
    ]);
  });

  it("gives an undetected local-log agent a one-line explanation and no actions", () => {
    const plan = providerRowPlan(muse);
    expect(plan.lead).toBeNull();
    expect(plan.secondary).toBeNull();
    expect(plan.menu).toEqual([]);
    expect(plan.disconnect).toBeNull();
    expect(plan.note).toContain("Nothing to connect");
  });

  it("offers Paste Go key and Disconnect while OpenCode Go uses the local login", () => {
    const plan = providerRowPlan(goLocal);
    expect(plan.menu).toEqual([expect.objectContaining({ kind: "addKey", label: "Paste Go key" })]);
    expect(plan.disconnect).toBe("opencodeLocal");
    expect(connectedStatus(goLocal)).toBe("Using your OpenCode login");
  });

  it("shows a hidden provider with one way back", () => {
    const plan = providerRowPlan(antigravity, { hidden: true });
    expect(plan.mode).toBe("hidden");
    expect(plan.lead).toMatchObject({ kind: "track", label: "Track again" });
    expect(plan.disconnect).toBeNull();
  });

  it("adds a second row for another Vibe key or a local login next to saved keys", () => {
    const saved = { ...mistralWithVibe, connected: true, accounts: [{ id: "main", label: "main" }] };
    expect(extraSlots(saved)).toEqual(["import"]);
    expect(providerRowPlan(saved, { slot: "import" }).lead).toMatchObject({
      kind: "importLocal",
      label: "Import another key from Mistral Vibe",
    });
    const go = { ...goLocal, accounts: [{ id: "main", label: "main" }] };
    expect(extraSlots(go)).toEqual(["local"]);
    expect(providerRowPlan(go, { slot: "local" }).disconnect).toBe("opencodeLocal");
    expect(extraSlots(provider({ id: "deepseek", label: "DeepSeek" }))).toEqual([]);
  });
});

describe("disconnectCopy", () => {
  it("says a Claude disconnect signs the CLI out and names the folder", () => {
    const copy = disconnectCopy("claude", { providerLabel: "Claude Code", name: "Kernel", accountId: "claude-acc2" });
    expect(copy.description).toContain("signs Claude Code out");
    expect(copy.description).toContain("~/.claude-acc2");
    expect(copy.warning).toBeNull();
    expect(copy.undoable).toBe(false);
    expect(disconnectCopy("claude", { providerLabel: "Claude Code", name: "Jerry", accountId: "claude" }).warning).toContain(
      "main Claude Code login",
    );
    expect(claudeFolder("claude")).toBe("~/.claude");
  });

  it("says a key disconnect deletes only the saved key and cannot be undone", () => {
    const copy = disconnectCopy("key", { providerLabel: "Mistral", name: "main" });
    expect(copy.description).toContain("Burnrate will stop tracking Mistral (main)");
    expect(copy.description).toContain("paste it again");
    expect(copy.description).not.toContain("signs");
    expect(copy.undoable).toBe(false);
  });

  it("names auth.json and the Codex CLI sign-out before deleting it", () => {
    const copy = disconnectCopy("codex", { providerLabel: "Codex (ChatGPT)", name: "Codex (ChatGPT)" });
    expect(copy.description).toContain("~/.codex/auth.json");
    expect(copy.description).toContain("signs the Codex CLI out");
    expect(copy.confirm).toBe("Disconnect and sign Codex out");
    expect(copy.undoable).toBe(false);
  });

  it("promises nothing is deleted for the reversible disconnects, and offers undo", () => {
    expect(disconnectCopy("opencodeLocal", { providerLabel: "OpenCode Go", name: "x" })).toMatchObject({ undoable: true });
    const hide = disconnectCopy("hide", { providerLabel: "Antigravity", name: "Antigravity" });
    expect(hide.description).toContain("Nothing on your computer changes");
    expect(hide.undoable).toBe(true);
  });

  it("picks the Claude wording only for Claude accounts", () => {
    expect(accountDisconnectKind("claudeAgent")).toBe("claude");
    expect(accountDisconnectKind("mistral")).toBe("key");
    // The Codex row is a ChatGPT login: its disconnect signs the CLI out like the provider row.
    expect(accountDisconnectKind("codex")).toBe("codex");
  });
});

describe("importResultText", () => {
  it("reports what the server really did", () => {
    expect(importResultText("mistral", "Mistral Vibe", { imported: ["Vibe"] })).toBe("Imported the key from Mistral Vibe.");
    expect(importResultText("mistral", "Mistral Vibe", { imported: ["Vibe", "Vibe 2"] })).toBe(
      "Imported 2 keys from Mistral Vibe.",
    );
    expect(importResultText("opencode-go", "OpenCode", { summary: "Go session 0% used" })).toBe(
      "Using your OpenCode login: Go session 0% used.",
    );
  });
});
