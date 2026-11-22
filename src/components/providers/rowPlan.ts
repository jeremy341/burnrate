import type { ProviderInfo } from "~/contracts";
import { m, type MessageResolver } from "~/i18n";

import { localImportOffer } from "./agentTiles";
import {
  CLAUDE_PROVIDER_ID,
  isProviderConnected,
  primaryAction,
  providerLogin,
  providerSubtitle,
} from "./providersList";

/**
 * What each row on the Providers screen offers, decided in one place so no provider is left with
 * a status and nothing to do. Pure and UI-free: the row components only draw the plan.
 *
 * Account rows (Claude logins, saved keys) have their own actions in `ProviderAccountRow`; this is
 * for the provider-level rows: a provider with no saved account, a login Burnrate only reads from
 * this computer (Codex, OpenCode, Antigravity), and the extra "import another" row.
 */

export type LocalImportId = "mistral" | "opencode-go";

export type PlanAction =
  /** One click that brings in a key/login another tool already holds. */
  | { readonly kind: "importLocal"; readonly providerId: LocalImportId; readonly source: string; readonly label: string }
  | { readonly kind: "signIn"; readonly label: string }
  | { readonly kind: "signInAgain"; readonly label: string }
  | { readonly kind: "addKey"; readonly label: string }
  | { readonly kind: "install"; readonly label: string; readonly url: string }
  /** Stop waiting for a sign-in that happens inside the provider's own app (Antigravity); the app stays open. */
  | { readonly kind: "cancelWait"; readonly label: string }
  /** Show a provider the user hid again. */
  | { readonly kind: "track"; readonly label: string };

/** What "Disconnect" does, which decides the wording of the confirmation and whether it can be undone. */
export type DisconnectKind =
  /** Deletes the saved key from Burnrate's store. */
  | "key"
  /** Deletes Claude's saved sign-in in its folder: the CLI is signed out too. */
  | "claude"
  /** Deletes the Codex CLI's `auth.json`: Codex is signed out too. */
  | "codex"
  /** Turns "use my OpenCode login" off; nothing is deleted. */
  | "opencodeLocal"
  /** Hides the provider in Burnrate; nothing on the computer changes. */
  | "hide";

export type PlanSlot = "main" | "import" | "local";

export interface ProviderRowPlan {
  /** `idle`: nothing connected here; `connected`: reading data; `hidden`: the user hid it. */
  readonly mode: "idle" | "connected" | "hidden";
  /** The button the row leads with, if any. */
  readonly lead: PlanAction | null;
  /** A quieter second button next to the lead (for example "Add key" beside "Import from Mistral Vibe"). */
  readonly secondary: PlanAction | null;
  /** Extra entries for the `…` menu of a connected row (Disconnect is separate). */
  readonly menu: readonly PlanAction[];
  readonly disconnect: DisconnectKind | null;
  /** One line that explains a row with nothing to click, or how a provider signs in. */
  readonly note: string | null;
}

export interface PlanOptions {
  /** The user hid this provider (`settings.providers.hidden`). */
  readonly hidden?: boolean;
  /** The last limits read says the login or key is no longer accepted. */
  readonly expired?: boolean;
  readonly slot?: PlanSlot;
}

const EMPTY: ProviderRowPlan = { mode: "idle", lead: null, secondary: null, menu: [], disconnect: null, note: null };

function localImportId(provider: ProviderInfo): LocalImportId | null {
  return provider.id === "mistral" || provider.id === "opencode-go" ? provider.id : null;
}

export function addKeyLabel(provider: ProviderInfo, resolve: MessageResolver = m): string {
  return provider.id === "opencode-go" ? resolve("Paste Go key") : resolve("Add key");
}

/** "Import from Mistral Vibe", "Use my local OpenCode login", or the "another key" variant. */
export function importLabel(provider: ProviderInfo, source: string, another: boolean, resolve: MessageResolver = m): string {
  if (provider.id === "opencode-go") return resolve("Use my local OpenCode login");
  return another
    ? resolve("Import another key from {source}", { source })
    : resolve("Import from {source}", { source });
}

function importAction(provider: ProviderInfo, another: boolean, resolve: MessageResolver): PlanAction | null {
  const offer = localImportOffer(provider);
  const providerId = localImportId(provider);
  if (!offer || !providerId) return null;
  return { kind: "importLocal", providerId, source: offer.source, label: importLabel(provider, offer.source, another, resolve) };
}

/** A key provider that is also read through a login another tool holds (OpenCode Go). */
export function usesLocalLogin(provider: ProviderInfo): boolean {
  // `detected` is not in the shared contract yet: for a key provider the server sets it only while
  // the login another tool holds is in use.
  return provider.auth === "apiKey" && (provider as ProviderInfo & { readonly detected?: boolean }).detected === true;
}

/** Whether a provider with saved accounts still needs a second row: import another, or the local login. */
export function extraSlots(provider: ProviderInfo): readonly PlanSlot[] {
  if (provider.accounts.length === 0) return [];
  const slots: PlanSlot[] = [];
  if (localImportOffer(provider) && localImportId(provider)) slots.push("import");
  if (usesLocalLogin(provider)) slots.push("local");
  return slots;
}

function disconnectKindFor(provider: ProviderInfo): DisconnectKind {
  if (provider.id === "codex") return "codex";
  if (provider.id === "opencode-go") return "opencodeLocal";
  return "hide";
}

export function providerRowPlan(
  provider: ProviderInfo,
  options: PlanOptions = {},
  resolve: MessageResolver = m,
): ProviderRowPlan {
  const slot = options.slot ?? "main";
  const connected = isProviderConnected(provider);

  if (slot === "import") {
    const lead = importAction(provider, true, resolve);
    return lead ? { ...EMPTY, lead } : EMPTY;
  }

  if (slot === "local") {
    return {
      ...EMPTY,
      mode: "connected",
      menu: [{ kind: "addKey", label: addKeyLabel(provider, resolve) }],
      disconnect: disconnectKindFor(provider),
    };
  }

  if (options.hidden) {
    return { ...EMPTY, mode: "hidden", lead: { kind: "track", label: resolve("Track again") } };
  }

  const login = providerLogin(provider);

  if (!connected) {
    const imported = importAction(provider, false, resolve);
    if (imported) {
      return {
        ...EMPTY,
        lead: imported,
        secondary: { kind: "addKey", label: addKeyLabel(provider, resolve) },
        note: provider.id === "mistral" ? resolve("Mistral has no browser sign-in: it works with an API key.") : null,
      };
    }
    const primary = primaryAction(provider);
    switch (primary.kind) {
      case "signIn":
        return { ...EMPTY, lead: { kind: "signIn", label: resolve("Sign in") } };
      case "addKey":
        return {
          ...EMPTY,
          lead: { kind: "addKey", label: addKeyLabel(provider, resolve) },
          note: provider.id === "mistral" ? resolve("Mistral has no browser sign-in: it works with an API key.") : null,
        };
      case "install":
        return { ...EMPTY, lead: { kind: "install", label: resolve("Install"), url: primary.url } };
      default:
        return {
          ...EMPTY,
          note:
            provider.auth === "localLogs"
              ? resolve("Nothing to connect. Usage appears here once you use it on this computer.")
              : null,
        };
    }
  }

  // Connected without a saved account: a login another tool holds, or local files Burnrate reads.
  const menu: PlanAction[] = [];
  let lead: PlanAction | null = null;
  if (provider.auth === "apiKey") {
    menu.push({ kind: "addKey", label: addKeyLabel(provider, resolve) });
  } else if (login) {
    const again: PlanAction = login.installed
      ? { kind: "signInAgain", label: resolve("Sign in again") }
      : { kind: "install", label: resolve("Install {command}", { command: login.command.split(" ")[0] ?? login.command }), url: login.installUrl };
    if (options.expired && login.installed) lead = again;
    else menu.push(again);
  }
  return {
    mode: "connected",
    lead,
    secondary: null,
    menu,
    disconnect: disconnectKindFor(provider),
    note:
      // A provider whose sign-in Burnrate can start (Antigravity) shows that action instead.
      provider.auth === "localLogs" && !login
        ? resolve("Burnrate reads {provider}'s own files. Sign in inside {provider} to refresh them.", { provider: provider.label })
        : null,
  };
}

/** The status words under the name of a provider-level row that is connected. */
export function connectedStatus(provider: ProviderInfo, resolve: MessageResolver = m): string {
  if (provider.id === "codex") return resolve("Signed in with ChatGPT");
  if (provider.id === "opencode-go") return resolve("Using your OpenCode login");
  if (provider.auth === "localLogs") return resolve("Reading {provider} on this computer", { provider: provider.label });
  return providerSubtitle(provider, resolve);
}

export interface DisconnectCopy {
  readonly title: string;
  readonly description: string;
  readonly confirm: string;
  /** Names the file or setting that changes, for the second paragraph of a risky confirmation. */
  readonly warning: string | null;
  /** True when an Undo toast can put things back; false when the user has to reconnect by hand. */
  readonly undoable: boolean;
  /** The toast after it worked. */
  readonly done: string;
}

/** `~/.claude` for the main login, `~/.claude-acc2` for `claude-acc2`. */
export function claudeFolder(accountId: string): string {
  return accountId === "claude" ? "~/.claude" : `~/.${accountId}`;
}

/**
 * The exact words of each confirmation: what Burnrate stops doing, and what else changes. The Claude
 * and Codex ones say plainly that the command-line tool is signed out too, because their logins are
 * the tool's own files.
 */
export function disconnectCopy(
  kind: DisconnectKind,
  target: { readonly providerLabel: string; readonly name: string; readonly accountId?: string },
  resolve: MessageResolver = m,
): DisconnectCopy {
  const { providerLabel, name } = target;
  switch (kind) {
    case "claude": {
      const folder = claudeFolder(target.accountId ?? "claude");
      return {
        title: resolve("Disconnect {name}?", { name }),
        description: resolve(
          "Burnrate will stop tracking {name}. This also signs Claude Code out of it: the sign-in saved in {folder} is deleted. Your usage history stays. You can sign in again any time.",
          { name, folder },
        ),
        confirm: resolve("Disconnect"),
        warning:
          target.accountId === "claude"
            ? resolve("This is the main Claude Code login: the claude command stops working until you sign in again.")
            : null,
        undoable: false,
        done: resolve("Disconnected {name}.", { name }),
      };
    }
    case "key":
      return {
        title: resolve("Disconnect {provider} ({name})?", { provider: providerLabel, name }),
        description: resolve(
          "Burnrate will stop tracking {provider} ({name}). The saved key is deleted from this computer, so you will need to paste it again to reconnect. The key itself still works on {provider}'s side: revoke it there if you want it gone for good.",
          { provider: providerLabel, name },
        ),
        confirm: resolve("Disconnect"),
        warning: null,
        undoable: false,
        done: resolve("Disconnected {name}.", { name }),
      };
    case "codex":
      return {
        title: resolve("Disconnect {provider}?", { provider: providerLabel }),
        description: resolve(
          "Burnrate will stop tracking {provider}. This also signs the Codex CLI out: it deletes ~/.codex/auth.json (or the CODEX_HOME folder), the login Codex itself uses. Codex asks you to sign in again the next time you use it.",
          { provider: providerLabel },
        ),
        confirm: resolve("Disconnect and sign Codex out"),
        warning: resolve("Other tools that read that file lose their login too."),
        undoable: false,
        done: resolve("Signed Codex out."),
      };
    case "opencodeLocal":
      return {
        title: resolve("Stop using your OpenCode login?"),
        description: resolve(
          "Burnrate will stop reading the Go key OpenCode holds. OpenCode itself is not changed, and a Go key you pasted into Burnrate stays.",
        ),
        confirm: resolve("Stop using it"),
        warning: null,
        undoable: true,
        done: resolve("Stopped using your OpenCode login."),
      };
    case "hide":
      return {
        title: resolve("Disconnect {provider}?", { provider: providerLabel }),
        description: resolve(
          "Burnrate will stop showing {provider}. Nothing on your computer changes, and you can track it again from this screen.",
          { provider: providerLabel },
        ),
        confirm: resolve("Disconnect"),
        warning: null,
        undoable: true,
        done: resolve("Stopped tracking {provider}.", { provider: providerLabel }),
      };
  }
}

/** Which disconnect applies to a saved account row. */
export function accountDisconnectKind(providerId: string): DisconnectKind {
  if (providerId === CLAUDE_PROVIDER_ID) return "claude";
  // The ChatGPT login lives in the Codex CLI's `auth.json`: signing it out is the Codex disconnect.
  if (providerId === "codex") return "codex";
  return "key";
}

/**
 * What to tell the user after a one-click import worked, from what the server really answered.
 * Names only, never a key: Mistral lists the accounts it saved, OpenCode reports the usage it read.
 */
export function importResultText(
  providerId: LocalImportId,
  source: string,
  result: { readonly imported?: readonly string[] | undefined; readonly summary?: string | undefined },
  resolve: MessageResolver = m,
): string {
  if (providerId === "opencode-go") {
    return result.summary
      ? resolve("Using your OpenCode login: {summary}.", { summary: result.summary })
      : resolve("Using your OpenCode login.");
  }
  const count = result.imported?.length ?? 0;
  if (count > 1) return resolve("Imported {count} keys from {source}.", { count, source });
  return resolve("Imported the key from {source}.", { source });
}
