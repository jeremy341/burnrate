import type { ProviderInfo } from "~/contracts";
import { m } from "~/i18n";
import { providerHint, providerSearchTerms } from "~/providers/aliases";
import { isHttpsUrl } from "~/providers/loginFlow";

import {
  isProviderConnected,
  providerCategory,
  providerGroupId,
  providerLogin,
  providerStatus,
  providerSubtitle,
  sortProviders,
  type ProviderStatus,
} from "./providersList";

/**
 * Pure rules behind the T3-style "Choose an agent" flow. The chooser is a grid of provider icon
 * tiles with an internal search; picking a tile opens one explicit connect panel. Nothing in here
 * starts a sign-in: actions are descriptors the React layer turns into clicks.
 *
 * Two honest distinctions the old flat list blurred:
 *  - an organization admin key is not an agent login. It is a "More providers" tile that opens
 *    provider setup, never a "Connect" button.
 *  - OpenCode Go is a key-based plan on an agent. It only connects when the user signs in or pastes
 *    a key in the panel; there is no auto-connect path.
 */

export const OPENCODE_GO_ID = "opencode-go";
export const CODEX_ID = "codex";
/**
 * Where an OpenCode account holder creates the Go key. The provider definition's `keyUrl`
 * (opencode.ai/auth) only redirects to the console login, which reads as a sign-in Burnrate cannot
 * perform; this page is where the key lives once the user is signed in on the website.
 */
export const OPENCODE_GO_KEY_URL = "https://opencode.ai/console/go";

export type AgentDotTone = "ready" | "neutral" | "warning" | "error" | "disabled";

/** Connection dot tone, mirroring T3's disabled/error/neutral/ready/warning set. */
export function agentDotTone(provider: ProviderInfo): AgentDotTone {
  switch (providerStatus(provider)) {
    case "connected":
      return "ready";
    case "needsSignIn":
      return "warning";
    case "notInstalled":
      return "disabled";
    default:
      return "neutral";
  }
}

/** "Added" = detected/connected with no saved account; "Already added" = has saved accounts. */
export type AgentAddedState = "none" | "added" | "alreadyAdded";

export function agentAddedState(provider: ProviderInfo): AgentAddedState {
  if (!isProviderConnected(provider)) return "none";
  return provider.accounts.length > 0 ? "alreadyAdded" : "added";
}

export function agentAddedLabel(state: AgentAddedState): string {
  if (state === "alreadyAdded") return m("Already added");
  if (state === "added") return m("Added");
  return "";
}

export type AgentTileGroup = "agents" | "keys" | "more";

export function agentTileGroup(provider: ProviderInfo): AgentTileGroup {
  const group = providerGroupId(provider);
  return group === "agents" ? "agents" : group === "advanced" ? "more" : "keys";
}

export function isAdminProvider(provider: ProviderInfo): boolean {
  return providerCategory(provider) === "admin";
}

/** OpenCode Go is key-based: the panel must show an explicit sign-in, never auto-connect. */
export function requiresExplicitConnect(provider: ProviderInfo): boolean {
  return provider.id === OPENCODE_GO_ID;
}

export interface AgentTile {
  /** Stable key for the grid and for React lists. */
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly color?: string | undefined;
  readonly group: AgentTileGroup;
  readonly dot: AgentDotTone;
  readonly status: ProviderStatus;
  readonly added: AgentAddedState;
  readonly note: string;
  readonly admin: boolean;
  /** Live provider, present for every tile the chooser can act on. */
  readonly provider?: ProviderInfo | undefined;
  readonly searchText: string;
}

function tileSearchText(provider: ProviderInfo, note: string): string {
  const login = providerLogin(provider);
  return [
    provider.id,
    provider.label,
    provider.hint ?? "",
    note,
    provider.auth,
    login ? `${login.command} sign in login` : "",
    provider.auth === "apiKey" ? "api key" : "",
    provider.auth === "localLogin" ? "local sign in" : "",
    provider.auth === "localLogs" ? "local session files logs" : "",
    isAdminProvider(provider) ? "admin organization organisation api spend" : "",
    requiresExplicitConnect(provider) ? "opencode go zen plan" : "",
    ...providerSearchTerms(provider.id),
    ...(providerHint(provider.id) ? [providerHint(provider.id)!] : []),
    ...provider.accounts.flatMap((account) => [account.id, account.label]),
  ]
    .join(" ")
    .toLowerCase();
}

export interface AgentTileOptions {
  readonly hidden?: readonly string[] | undefined;
  /** Ids the user hid are still built so the settings grid can offer "Show". */
  readonly includeHidden?: boolean | undefined;
  readonly order?: readonly string[] | undefined;
}

/** All tiles for a provider list, ordered connected-first and grouped for the chooser. */
export function buildAgentTiles(
  providers: readonly ProviderInfo[],
  options: AgentTileOptions = {},
): AgentTile[] {
  const hidden = new Set(options.hidden ?? []);
  const visible = providers.filter(
    (provider) => options.includeHidden === true || !hidden.has(provider.id),
  );
  const rank = (provider: ProviderInfo): number => {
    if (isProviderConnected(provider)) return 0;
    if (providerStatus(provider) === "needsSignIn") return 1;
    if (provider.auth === "apiKey") return 2;
    return 3;
  };
  return sortProviders(visible, options.order)
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .map((provider) => {
      const note = providerSubtitle(provider);
      return {
        key: provider.id,
        id: provider.id,
        label: provider.label,
        ...(provider.color ? { color: provider.color } : {}),
        group: agentTileGroup(provider),
        dot: agentDotTone(provider),
        status: providerStatus(provider),
        added: agentAddedState(provider),
        note,
        admin: isAdminProvider(provider),
        provider,
        searchText: tileSearchText(provider, note),
      };
    });
}

/** Every whitespace-separated token must appear somewhere in the tile's search text. */
export function filterAgentTiles(tiles: readonly AgentTile[], query: string): AgentTile[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...tiles];
  return tiles.filter((tile) => tokens.every((token) => tile.searchText.includes(token)));
}

export interface AgentTileSection {
  readonly id: AgentTileGroup;
  readonly label: string;
  readonly tiles: readonly AgentTile[];
}

/** The chooser's two visual sections: agents first, everything else under "More providers". */
export function groupAgentTiles(tiles: readonly AgentTile[]): AgentTileSection[] {
  const byGroup = (group: AgentTileGroup): AgentTile[] => tiles.filter((tile) => tile.group === group);
  return [
    { id: "agents" as const, label: m("Agents you use"), tiles: byGroup("agents") },
    { id: "keys" as const, label: m("API keys"), tiles: byGroup("keys") },
    { id: "more" as const, label: m("More providers"), tiles: byGroup("more") },
  ].filter((section) => section.tiles.length > 0);
}

/**
 * The server found a credential another tool already holds (today: Mistral Vibe's key) and offers to
 * copy it on an explicit click. The listing only says it exists; the secret is read by the import route.
 */
export interface LocalImportOffer {
  readonly source: string;
}

export function localImportOffer(provider: ProviderInfo): LocalImportOffer | null {
  const raw = (provider as ProviderInfo & { readonly localImport?: unknown }).localImport;
  if (typeof raw !== "object" || raw === null) return null;
  const source = (raw as { readonly source?: unknown }).source;
  return typeof source === "string" && source.trim() ? { source: source.trim() } : null;
}

export type AgentAction =
  | { readonly kind: "importLocal"; readonly label: string; readonly source: string }
  | { readonly kind: "signIn"; readonly label: string; readonly command: string }
  | { readonly kind: "addKey"; readonly label: string }
  | { readonly kind: "install"; readonly label: string; readonly url: string }
  | { readonly kind: "providerLink"; readonly label: string; readonly url: string }
  | { readonly kind: "manage"; readonly label: string }
  | { readonly kind: "none"; readonly label: string };

/**
 * The single leading action of the per-agent panel. Explicit by construction: it never opens a
 * flow without a user click, and admin keys are routed to setup instead of a login.
 */
export function explicitAgentAction(provider: ProviderInfo): AgentAction {
  if (isAdminProvider(provider)) {
    return { kind: "manage", label: m("Open provider setup") };
  }
  const login = providerLogin(provider);
  const status = providerStatus(provider);
  // The server only sends `localImport` while a local key is not saved yet, so it stays offered after
  // a first key is imported: that is how a second Vibe profile gets in.
  const offer = localImportOffer(provider);
  if (offer) {
    const label = isProviderConnected(provider)
      ? m("Import another key from {source}", { source: offer.source })
      : m("Import from {source}", { source: offer.source });
    return { kind: "importLocal", label, source: offer.source };
  }
  if (requiresExplicitConnect(provider)) {
    // A saved key is the whole connection: nothing left to get, only keys to manage.
    if (isProviderConnected(provider)) return { kind: "none", label: m("Connected") };
    // Burnrate cannot sign in to OpenCode Go; it opens the website. Say so instead of "Sign in".
    if (isHttpsUrl(provider.keyUrl)) {
      return { kind: "providerLink", label: m("Get your Go key"), url: OPENCODE_GO_KEY_URL };
    }
  }
  if (status === "needsSignIn") {
    return { kind: "signIn", label: m("Sign in"), command: login?.command ?? provider.label };
  }
  if (status === "notInstalled" && login && isHttpsUrl(login.installUrl)) {
    return { kind: "install", label: m("Install"), url: login.installUrl };
  }
  if (status === "available" || (status === "notDetected" && provider.auth === "apiKey")) {
    return { kind: "addKey", label: m("Add key") };
  }
  if (requiresExplicitConnect(provider)) {
    return { kind: "addKey", label: m("Add key") };
  }
  return { kind: "none", label: m("Connected") };
}

/** Secondary, still explicit: the link row T3 shows below a sign-in method. */
export interface AgentSignInLinks {
  readonly openBrowserUrl?: string | undefined;
  readonly providerSignInUrl?: string | undefined;
}

/**
 * At most one link per URL. When the leading action already opens a page (`providerLink`, `install`)
 * the footer row would only repeat it, so it is empty; and the provider's own sign-in link is only
 * offered when it differs from the "Open browser" one.
 */
export function agentSignInLinks(
  provider: ProviderInfo,
  action: AgentAction = explicitAgentAction(provider),
): AgentSignInLinks {
  if (!isHttpsUrl(provider.keyUrl)) return {};
  if (action.kind === "providerLink" || action.kind === "install") return {};
  return { openBrowserUrl: provider.keyUrl };
}

/** The account picker T3 shows for ChatGPT/Codex, only when accounts actually exist. */
export function hasAccountPicker(provider: ProviderInfo): boolean {
  return isProviderConnected(provider) && provider.accounts.length > 0 && !isAdminProvider(provider);
}

/**
 * A key-based provider (Mistral, OpenCode Go) has no sign-in to run for a second account: the
 * picker's add button opens the key dialog instead of a login flow.
 */
export function accountPickerAddsKey(provider: ProviderInfo): boolean {
  return provider.auth === "apiKey";
}

export function accountPickerLabels(provider: ProviderInfo): {
  readonly heading: string;
  readonly add: string;
  readonly help: string;
} {
  if (accountPickerAddsKey(provider)) {
    return {
      heading: m("Saved keys"),
      add: m("Add another key"),
      help: m("Each key is read as its own account. Add a second key to track another profile."),
    };
  }
  if (provider.id === CODEX_ID) {
    return {
      heading: m("ChatGPT account to connect"),
      add: m("Add ChatGPT account"),
      help: m("Each account has its own Codex instance and sign-in. Choose the other account on the sign-in page."),
    };
  }
  return {
    heading: m("Account to connect"),
    add: m("Add another account"),
    help: m("Add another account for this agent from its own sign-in."),
  };
}
