import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProviderInfo } from "~/contracts";

import { ProvidersPage } from "./ProvidersPage";

function provider(overrides: Partial<ProviderInfo> & Pick<ProviderInfo, "id" | "label">): ProviderInfo {
  return {
    color: "#000000",
    auth: "apiKey",
    connected: false,
    accounts: [],
    ...overrides,
  };
}

const loaded = (data: readonly ProviderInfo[]) => ({
  data,
  error: null,
  loading: false,
  reload: () => {},
});

describe("ProvidersPage", () => {
  it("gives Pi a panel with its measured sessions and working folder actions, not a dead grey line", () => {
    const markup = renderToStaticMarkup(
      <ProvidersPage
        providers={loaded([
          provider({
            id: "pi",
            label: "Pi",
            auth: "localLogs",
            stats: { sessions: 4, folder: "C:\\Users\\jane\\.pi\\agent\\sessions" },
          }),
        ])}
      />,
    );
    expect(markup).toContain('data-slot="local-logs-panel"');
    expect(markup).toContain("Tracking 4 sessions");
    expect(markup).toContain("Open data folder");
    expect(markup).toContain('href="#settings/providers-sources-pi"');
    expect(markup).toContain("Stop tracking");
    expect(markup).not.toContain("Nothing to connect.");
  });

  it("shows a retry instead of an empty catalog when the first load fails", () => {
    const markup = renderToStaticMarkup(
      <ProvidersPage providers={{ data: null, error: "Service unavailable", loading: false, reload: () => {} }} />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Try again");
    expect(markup).toContain("Service unavailable");
    expect(markup).not.toContain("No providers yet");
  });

  it("lists connected accounts in words with one actions menu, not an icon tile grid", () => {
    const markup = renderToStaticMarkup(
      <ProvidersPage
        providers={loaded([
          provider({
            id: "claudeAgent",
            label: "Claude Code",
            auth: "localLogin",
            connected: true,
            accounts: [
              { id: "claude-jerry", label: "Jerry" },
              { id: "claude-kernel", label: "Kernel" },
            ],
          }),
          provider({ id: "mistral", label: "Mistral" }),
        ])}
      />,
    );
    expect(markup).toContain("Add provider");
    expect(markup).toContain('data-slot="connected-accounts"');
    // Both Claude accounts are listed with status text, each with a single `…` menu.
    expect(markup).toContain("Jerry");
    expect(markup).toContain("Kernel");
    expect(markup).toContain("Signed in");
    expect(markup).toContain('aria-label="Actions for Jerry"');
    expect(markup).toContain('aria-label="Actions for Kernel"');
    // Mistral has no account yet, so it shows one honest action.
    expect(markup).toContain("Mistral");
    expect(markup).toContain("Add key");
    // No clutter from the old design.
    expect(markup).not.toContain('data-slot="connection-status-dot"');
    expect(markup).not.toContain("grid gap-3 sm:grid-cols-2");
    expect(markup).not.toContain('data-agent=');
    expect(markup).not.toContain("Already added");
    expect(markup).not.toContain("border-b last:border-b-0");
  });

  it("repeats no refresh control: the screen header owns refresh, the page keeps one Add provider", () => {
    const markup = renderToStaticMarkup(<ProvidersPage providers={loaded([])} />);
    expect(markup).not.toContain('data-slot="providers-refresh"');
    expect(markup).not.toContain('aria-label="Refresh providers"');
    expect(markup.match(/Add provider/g)).toHaveLength(1);
  });

  it("offers an empty state with a single Add provider entry when nothing is connected", () => {
    const markup = renderToStaticMarkup(<ProvidersPage providers={loaded([])} />);
    expect(markup).toContain("No providers yet");
    expect(markup).toContain("Add provider");
    expect(markup).not.toContain('data-slot="connected-accounts"');
  });

  describe("live status", () => {
    const claude = provider({
      id: "claudeAgent",
      label: "Claude Code",
      auth: "localLogin",
      connected: true,
      accounts: [
        { id: "claude", label: "Jerry" },
        { id: "claude-acc2", label: "Kernel" },
      ],
    });
    const codexAccount = (label: string) =>
      provider({
        id: "codex",
        label: "Codex (ChatGPT)",
        auth: "localLogin",
        connected: true,
        accounts: [{ id: "chatgpt-login", label }],
        login: { kind: "cli", command: "codex login", installed: true, installUrl: "https://example.com" },
      });
    const win = (label: string, usedPercent: number) => ({ id: label, kind: "weekly" as const, label, usedPercent });
    const report = (jerry: object) => ({
      data: {
        createdAt: "2026-11-21T12:00:00Z",
        notices: [],
        accounts: [
          { id: "claude-claude", driver: "claudeAgent", label: "Jerry", limits: { checkedAt: "2026-11-21T12:00:00Z", windows: [], ...jerry } },
          {
            id: "claude-claude-acc2",
            driver: "claudeAgent",
            label: "Kernel",
            limits: { checkedAt: "2026-11-21T12:00:00Z", windows: [win("Weekly", 45)] },
          },
        ],
      },
      error: null,
      loading: false,
      reload: () => {},
    });

    it("shows each account's live percent under its name", () => {
      const markup = renderToStaticMarkup(
        <ProvidersPage providers={loaded([claude])} limits={report({ windows: [win("Weekly", 94)] })} />,
      );
      expect(markup).toContain("Claude Code · Weekly 94% used");
      expect(markup).toContain("Claude Code · Weekly 45% used");
      expect(markup).not.toContain("Sign in again");
    });

    it("gives an expired login one clear action and an honest message", () => {
      const markup = renderToStaticMarkup(
        <ProvidersPage
          providers={loaded([claude])}
          limits={report({ unavailable: { reason: "probeFailed", message: "login-expired: sign in again" } })}
        />,
      );
      expect(markup).toContain("Sign-in expired");
      expect(markup).toContain('aria-label="Sign in again: Jerry"');
      // Only the expired account gets the button; Kernel keeps reading.
      expect(markup.match(/Sign in again:/g)).toHaveLength(1);
      expect(markup).toContain('data-health="expired"');
      expect(markup).toContain("Claude Code · Weekly 45% used");
    });

    it("falls back to plain words when no limits were read yet", () => {
      const markup = renderToStaticMarkup(<ProvidersPage providers={loaded([claude])} />);
      expect(markup).toContain("Claude Code · Signed in");
      expect(renderToStaticMarkup(<ProvidersPage providers={loaded([codexAccount("Work")])} />)).toContain(
        "Codex (ChatGPT) · Signed in",
      );
    });

    it("shows a connected provider without saved accounts (Codex) its live state and an expired-login action", () => {
      const expired = {
        data: {
          createdAt: "2026-11-21T12:00:00Z",
          notices: [],
          accounts: [
            {
              id: "chatgpt-login",
              driver: "codex",
              label: "ChatGPT login",
              limits: {
                checkedAt: "2026-11-21T12:00:00Z",
                windows: [],
                unavailable: { reason: "probeFailed" as const, message: "login-expired: ChatGPT login expired, sign in again" },
              },
            },
          ],
        },
        error: null,
        loading: false,
        reload: () => {},
      };
      const markup = renderToStaticMarkup(<ProvidersPage providers={loaded([codexAccount("ChatGPT login")])} limits={expired} />);
      // The ChatGPT login is an account row like a Claude login: one name, one actions menu,
      // an honest expired state and the one fix, not a bare provider status.
      expect(markup).toContain('data-account="chatgpt-login"');
      expect(markup).toContain("Sign-in expired");
      expect(markup).toContain('aria-label="Sign in again: ChatGPT login"');
      expect(markup).toContain('aria-label="Actions for ChatGPT login"');
    });
  });
  describe("every row has the actions that make sense", () => {
    const list = [
      provider({ id: "mistral", label: "Mistral", hint: "Mistral Vibe found. Import its key in one click", ...({ localImport: { source: "Mistral Vibe" } } as object) }),
      provider({ id: "deepseek", label: "DeepSeek" }),
      provider({
        id: "codex",
        label: "Codex (ChatGPT)",
        auth: "localLogin",
        connected: true,
        accounts: [{ id: "chatgpt-login", label: "Work" }],
        login: { kind: "cli", command: "codex login", installed: true, installUrl: "https://example.com" },
      }),
      provider({
        id: "antigravity",
        label: "Antigravity",
        auth: "localLogs",
        connected: true,
        login: { kind: "cli", command: "Antigravity", installed: true, installUrl: "https://antigravity.google/" },
      }),
      provider({ id: "muse", label: "Muse Code", auth: "localLogs" }),
      provider({
        id: "kimi",
        label: "Moonshot",
        connected: true,
        accounts: [{ id: "main", label: "main" }],
      }),
    ];
    const markup = renderToStaticMarkup(<ProvidersPage providers={loaded(list)} />);

    it("leads Mistral with the Vibe import and keeps Add key as the second button", () => {
      expect(markup).toContain("Import from Mistral Vibe");
      expect(markup.indexOf("Import from Mistral Vibe")).toBeGreaterThan(markup.indexOf("Add key") - 400);
      expect(markup).toContain("Mistral has no browser sign-in");
    });

    it("shows Codex and Antigravity as connected with a Disconnect, not just a status", () => {
      // The Codex ChatGPT login is one account row (nicknamed "Work") with the same one-menu and
      // Disconnect treatment a Claude login gets.
      expect(markup).toContain("Codex (ChatGPT) · Signed in");
      expect(markup).toContain('aria-label="Disconnect Work"');
      expect(markup).toContain('aria-label="Actions for Work"');
      // Antigravity keeps its own row: readable here, hidable again, sign-in in its `…` menu.
      expect(markup).toContain("Reading Antigravity on this computer");
      expect(markup).toContain('aria-label="Disconnect Antigravity"');
      expect(markup).toContain('aria-label="Actions for Antigravity"');
    });

    it("gives a saved key Disconnect as a visible button and logs-only agents their own files panel", () => {
      expect(markup).toContain('aria-label="Disconnect main"');
      // Pi and Muse rows say what their files contain and offer the actions that work, instead of
      // one grey line and no buttons.
      expect(markup).toContain('data-slot="local-logs-panel"');
      expect(markup).toContain("Not found on this computer");
      expect(markup).toContain("Add folder");
      expect(markup.match(/data-slot="disconnect-button"/g)?.length).toBe(3);
    });
  });

  describe("sections", () => {
    it("draws Connected before Available, and folds Not found closed but still in the page", () => {
      const markup = renderToStaticMarkup(
        <ProvidersPage
          providers={loaded([
            provider({ id: "deepseek", label: "DeepSeek" }),
            provider({
              id: "codex",
              label: "Codex (ChatGPT)",
              auth: "localLogin",
              connected: true,
              accounts: [{ id: "chatgpt-login", label: "Work" }],
              login: { kind: "cli", command: "codex login", installed: true, installUrl: "https://example.com" },
            }),
            provider({ id: "muse", label: "Muse Code", auth: "localLogs" }),
          ])}
        />,
      );
      const connected = markup.indexOf('data-section="connected"');
      const available = markup.indexOf('data-section="available"');
      const notFound = markup.indexOf('data-section="notFound"');
      expect(connected).toBeGreaterThanOrEqual(0);
      expect(available).toBeGreaterThan(connected);
      expect(notFound).toBeGreaterThan(available);
      expect(markup).toContain(">Connected</h2>");
      expect(markup).toContain(">Available</h2>");
      expect(markup).toContain(">Not found on this computer<span");
      expect(markup).not.toContain('data-section="hidden"');
      // Folded content stays in the page, so the row's own actions are still there to find.
      expect(markup).toContain('data-slot="local-logs-panel"');
    });

    it("says so in the Connected block when nothing is connected yet", () => {
      const markup = renderToStaticMarkup(<ProvidersPage providers={loaded([provider({ id: "deepseek", label: "DeepSeek" })])} />);
      expect(markup).toContain("Nothing connected yet.");
      expect(markup).toContain('data-section="available"');
      expect(markup).not.toContain('data-slot="connected-accounts"');
    });
  });
});
