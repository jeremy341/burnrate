import type { ProviderCategory, ProviderInfo, ProviderLogin } from "~/contracts";
import { m, type MessageResolver } from "~/i18n";

/**
 * Pure list rules for the Providers view: which group a provider belongs to, what state it is in,
 * what its primary action is, search and ordering. Kept apart from the components so the
 * behaviour is unit-testable without rendering.
 *
 * The server says `category` and `login` per provider (docs/work/FLOW-BRIEF.md). When it does not
 * (an older server), everything here falls back to the provider id and `auth`.
 */

export const CLAUDE_PROVIDER_ID = "claudeAgent";

const CLAUDE_INSTALL_URL = "https://docs.claude.com/en/docs/claude-code/setup";

/** Ids that are agents even when only the `auth` is known (OpenCode Go is a key on an agent). */
const AGENT_IDS: ReadonlySet<string> = new Set([
  CLAUDE_PROVIDER_ID,
  "codex",
  "opencode",
  "opencode-go",
  "grok",
  "antigravity",
  "cursor",
  "pi",
  "muse",
]);

export type ProviderGroupId = "agents" | "apiKeys" | "advanced";

/** Where the provider sits when the server did not say. */
export function providerCategory(provider: ProviderInfo): ProviderCategory {
  if (provider.category) return provider.category;
  if (provider.id.endsWith("-admin")) return "admin";
  if (provider.auth === "localLogs") return "localLogs";
  if (provider.auth === "localLogin" || AGENT_IDS.has(provider.id)) return "agent";
  return "apiKey";
}

export function providerGroupId(provider: ProviderInfo): ProviderGroupId {
  switch (providerCategory(provider)) {
    case "agent":
    case "localLogs":
      return "agents";
    case "admin":
      return "advanced";
    default:
      return "apiKeys";
  }
}

/**
 * The CLI sign-in for this provider. An absent field on Claude means an old server: Claude was
 * always signed in through its CLI, so assume it is available. An explicit `null` means none.
 */
export function providerLogin(provider: ProviderInfo): ProviderLogin | null {
  if (provider.login !== undefined) return provider.login;
  if (provider.id === CLAUDE_PROVIDER_ID) {
    return { kind: "cli", command: "claude", installed: true, installUrl: CLAUDE_INSTALL_URL };
  }
  return null;
}

/** A provider counts as connected once the server reports a login or any saved account. */
export function isProviderConnected(provider: ProviderInfo): boolean {
  return provider.connected || provider.accounts.length > 0;
}

export type ProviderStatus =
  /** Reading data (login found, key saved, local files found). */
  | "connected"
  /** The CLI is installed but not signed in. */
  | "needsSignIn"
  /** The CLI that would sign it in is missing. */
  | "notInstalled"
  /** An agent without a login Burnrate can run, and nothing found on this computer. */
  | "notDetected"
  /** A key-based provider with no key yet. */
  | "available";

export function providerStatus(provider: ProviderInfo): ProviderStatus {
  if (isProviderConnected(provider)) return "connected";
  const login = providerLogin(provider);
  if (login) return login.installed ? "needsSignIn" : "notInstalled";
  if (provider.auth === "apiKey") return "available";
  return "notDetected";
}

export type PrimaryAction =
  | { readonly kind: "signIn" }
  | { readonly kind: "addKey" }
  | { readonly kind: "install"; readonly url: string; readonly command: string }
  | { readonly kind: "none" };

/** The one button a row leads with. Connected rows lead with nothing: they just work. */
export function primaryAction(provider: ProviderInfo): PrimaryAction {
  const status = providerStatus(provider);
  const login = providerLogin(provider);
  if (status === "needsSignIn") return { kind: "signIn" };
  if (status === "notInstalled" && login) {
    return { kind: "install", url: login.installUrl, command: login.command };
  }
  if (status === "available") return { kind: "addKey" };
  // A key-based agent (OpenCode Go) that is not connected still wants its key.
  if (status === "notDetected" && provider.auth === "apiKey") return { kind: "addKey" };
  return { kind: "none" };
}

/** Whether a connected row offers adding another account/key from its menu. */
export function canAddAccount(provider: ProviderInfo): "signIn" | "addKey" | null {
  if (provider.id === CLAUDE_PROVIDER_ID && providerLogin(provider)) return "signIn";
  if (provider.auth === "apiKey") return "addKey";
  return null;
}

/** Agents the app can offer to connect on first look: installed here, not connected yet. */
export function detectedAgentsToConnect(providers: readonly ProviderInfo[]): ProviderInfo[] {
  return sortProviders(
    providers.filter(
      (provider) =>
        providerGroupId(provider) === "agents" &&
        providerLogin(provider) !== null &&
        providerStatus(provider) === "needsSignIn",
    ),
  );
}

/** The one line under a provider's name: what Burnrate sees, never "No accounts yet". */
export function providerSubtitle(provider: ProviderInfo, resolve: MessageResolver = m): string {
  const status = providerStatus(provider);
  const login = providerLogin(provider);
  switch (status) {
    case "connected": {
      const count = provider.accounts.length;
      if (count === 0) return provider.hint ?? resolve("Detected on this computer");
      if (provider.auth === "apiKey") {
        return resolve("{count, plural, one {1 key} other {{count} keys}}", { count });
      }
      const labels = provider.accounts.map((account) => account.label);
      return count <= 2 ? labels.join(", ") : resolve("{count} accounts", { count });
    }
    case "needsSignIn":
      return resolve("Installed on this computer. Sign in to connect it.");
    case "notInstalled":
      return resolve("{command} is not installed on this computer.", { command: login?.command.split(" ")[0] ?? provider.label });
    case "available":
      return provider.hint ?? resolve("Add an API key to track usage.");
    default:
      return provider.hint ?? resolve("Not found on this computer.");
  }
}

/**
 * Whether a first-look surface should offer "Connect an agent": something detected is waiting to
 * be connected, or nothing is connected at all. False when everything detected already works.
 */
export function shouldOfferConnect(providers: readonly ProviderInfo[]): boolean {
  return detectedAgentsToConnect(providers).length > 0 || !providers.some(isProviderConnected);
}

export interface ProviderListOptions {
  /** Case-insensitive search text. Empty shows everything. */
  readonly query?: string;
  /** Ids hidden from every view (`settings.providers.hidden`). */
  readonly hidden?: readonly string[];
  /** Display order (`settings.providers.order`); unknown ids sort after by label. */
  readonly order?: readonly string[];
}

export interface ProviderGroups {
  /** Agents that are connected or can be connected from here (sign in, add key, install). */
  readonly agents: readonly ProviderInfo[];
  /** Agents with nothing found on this computer and nothing to do: kept out of the main list. */
  readonly notFound: readonly ProviderInfo[];
  readonly apiKeys: readonly ProviderInfo[];
  readonly advanced: readonly ProviderInfo[];
  /** Providers the user hid, so they can be shown again. Search applies; they are not in `total`. */
  readonly hidden: readonly ProviderInfo[];
  /** Number of providers after search and hidden filtering. */
  readonly total: number;
}

function searchableText(provider: ProviderInfo): string {
  const login = providerLogin(provider);
  return [
    provider.id,
    provider.label,
    provider.auth,
    provider.hint ?? "",
    login ? `sign in login ${login.command}` : "",
    provider.auth === "apiKey" ? "api key" : "",
    provider.auth === "localLogin" ? "local login sign in" : "",
    provider.auth === "localLogs" ? "local logs session files" : "",
    providerGroupId(provider) === "advanced" ? "advanced admin organization organisation" : "",
    ...provider.accounts.flatMap((account) => [account.id, account.label]),
  ]
    .join(" ")
    .toLowerCase();
}

/** Every whitespace-separated token must appear somewhere in the provider's searchable text. */
export function providerMatches(provider: ProviderInfo, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = searchableText(provider);
  return tokens.every((token) => haystack.includes(token));
}

function compareProviders(
  orderIndex: ReadonlyMap<string, number>,
  a: ProviderInfo,
  b: ProviderInfo,
): number {
  const ai = orderIndex.get(a.id);
  const bi = orderIndex.get(b.id);
  if (ai !== undefined || bi !== undefined) {
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    if (ai !== bi) return ai - bi;
  }
  return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
}

export function sortProviders(
  providers: readonly ProviderInfo[],
  order: readonly string[] = [],
): ProviderInfo[] {
  const orderIndex = new Map(order.map((id, index) => [id, index] as const));
  return [...providers].sort((a, b) => compareProviders(orderIndex, a, b));
}

/** Rows that can be acted on first: needs sign-in, then connected, then the rest. */
function statusRank(provider: ProviderInfo): number {
  switch (providerStatus(provider)) {
    case "connected":
      return 0;
    case "needsSignIn":
      return 1;
    case "available":
      return 2;
    case "notInstalled":
      return 3;
    default:
      return 4;
  }
}

/** Search, hide, then split into the groups the page draws, connected rows first. */
export function groupProviders(
  providers: readonly ProviderInfo[],
  options: ProviderListOptions = {},
): ProviderGroups {
  const hiddenIds = new Set(options.hidden ?? []);
  const query = options.query ?? "";
  const matching = sortProviders(
    providers.filter((provider) => providerMatches(provider, query)),
    options.order,
  );
  const visible = matching.filter((provider) => !hiddenIds.has(provider.id));
  // `sort` is stable, so the user's order/label order survives inside each rank.
  const ranked = [...visible].sort((a, b) => statusRank(a) - statusRank(b));
  const agents: ProviderInfo[] = [];
  const notFound: ProviderInfo[] = [];
  const apiKeys: ProviderInfo[] = [];
  const advanced: ProviderInfo[] = [];
  for (const provider of ranked) {
    const group = providerGroupId(provider);
    if (group === "agents") {
      (primaryAction(provider).kind === "none" && !isProviderConnected(provider) ? notFound : agents).push(provider);
    } else {
      (group === "advanced" ? advanced : apiKeys).push(provider);
    }
  }
  return {
    agents,
    notFound,
    apiKeys,
    advanced,
    hidden: matching.filter((provider) => hiddenIds.has(provider.id)),
    total: visible.length,
  };
}

/** Ids present on the page, in display order. */
export function listedProviderIds(groups: ProviderGroups): string[] {
  return [...groups.agents, ...groups.notFound, ...groups.apiKeys, ...groups.advanced].map((provider) => provider.id);
}
