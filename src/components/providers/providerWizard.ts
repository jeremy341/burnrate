import type { CatalogEntry, DefinitionInfo } from "~/api/catalog";
import type { ProviderInfo } from "~/contracts";
import { m, type MessageResolver } from "~/i18n";
import { catalogRedirect, providerHint, providerSearchTerms } from "~/providers/aliases";
import { providerFallbackColor } from "~/providers/presentation";

import { suggestAccountName, takenAccountNames } from "./addKeyDialog.logic";
import {
  CLAUDE_PROVIDER_ID,
  isProviderConnected,
  providerGroupId,
  providerLogin,
  type ProviderGroupId,
} from "./providersList";

/**
 * Pure rules for the "Add provider" wizard: which providers the picker offers, how the search
 * narrows them, and how the account name in step 2 is validated. Rendering and network calls
 * live in `AddProviderWizard.tsx`.
 */

export type WizardSource = "provider" | "definition" | "catalog" | "custom";

export interface WizardOption {
  /** Stable key for the command list. */
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly source: WizardSource;
  readonly auth?: ProviderInfo["auth"];
  readonly connected?: boolean;
  readonly accountCount?: number;
  readonly status?: DefinitionInfo["status"];
  readonly definitionSource?: DefinitionInfo["source"];
  readonly hasDefinition?: boolean;
  readonly docs?: string;
  readonly baseUrl?: string;
  readonly envVars?: readonly string[];
  readonly note?: string;
  /** One line saying what a live provider reads, when its label alone does not (ChatGPT, Go). */
  readonly hint?: string;
  /** Product names that should find this row in search but are not its id or label. */
  readonly aliases?: readonly string[];
  /** Set when the picker row cannot continue to the account steps. */
  readonly unavailableReason?: string;
  /** The live provider for rows that can be added. */
  readonly provider?: ProviderInfo;
  /** Which Providers-screen group a live provider belongs to (agents, API keys, advanced). */
  readonly group?: ProviderGroupId;
}

export interface WizardSources {
  readonly providers: readonly ProviderInfo[];
  readonly definitions?: readonly DefinitionInfo[];
  readonly catalog?: readonly CatalogEntry[];
}

const CUSTOM_ID = "__custom";

function sourceOrder(option: WizardOption): number {
  switch (option.source) {
    case "provider":
      return 0;
    case "definition":
      return 1;
    case "catalog":
      return 2;
    default:
      return 3;
  }
}

/**
 * Providers first (what the server can already read), then enabled definitions that are not
 * providers yet, then models.dev entries, then the "Custom provider" escape hatch. Duplicate ids
 * keep the strongest source so one provider never appears twice.
 */
export function buildWizardOptions(sources: WizardSources): WizardOption[] {
  const seen = new Set<string>();
  const options: WizardOption[] = [];

  const catalogById = new Map((sources.catalog ?? []).map((entry) => [entry.id, entry] as const));

  for (const provider of sources.providers) {
    seen.add(provider.id);
    const hint = providerHint(provider.id);
    const aliases = providerSearchTerms(provider.id);
    options.push({
      key: provider.id,
      id: provider.id,
      label: provider.label,
      color: provider.color || providerFallbackColor(provider.id) || "var(--foreground)",
      source: "provider",
      auth: provider.auth,
      connected: isProviderConnected(provider),
      accountCount: provider.accounts.length,
      group: providerGroupId(provider),
      ...(provider.hint || hint ? { hint: provider.hint ?? hint! } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      provider,
    });
  }

  for (const definition of sources.definitions ?? []) {
    if (seen.has(definition.id)) continue;
    seen.add(definition.id);
    const color = definition.color || providerFallbackColor(definition.id) || "var(--foreground)";
    // The catalog carries the base URL, key variable and note the definitions list does not.
    const fromCatalog = catalogById.get(definition.id);
    const aliases = providerSearchTerms(definition.id);
    const reason =
      definition.status === "disabled"
        ? "This provider is disabled: it has no per-key usage API. Track it with a budget instead."
        : "This provider definition is not loaded. Enable it in Settings → Providers.";
    const docs = definition.docs ?? fromCatalog?.docs;
    options.push({
      key: definition.id,
      id: definition.id,
      label: definition.label,
      color,
      source: "definition",
      status: definition.status,
      definitionSource: definition.source,
      hasDefinition: definition.hasDefinition ?? true,
      ...(docs ? { docs } : {}),
      ...(fromCatalog?.baseUrl ? { baseUrl: fromCatalog.baseUrl } : {}),
      ...(fromCatalog?.envVars ? { envVars: fromCatalog.envVars } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(definition.status === "experimental"
        ? { note: "Experimental: the provider does not document this endpoint." }
        : fromCatalog?.note
          ? { note: fromCatalog.note }
          : {}),
      unavailableReason: reason,
    });
  }

  for (const entry of sources.catalog ?? []) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const redirect = catalogRedirect(entry.id);
    const aliases = providerSearchTerms(entry.id);
    options.push({
      key: entry.id,
      id: entry.id,
      label: entry.label,
      color: providerFallbackColor(entry.id) ?? "var(--foreground)",
      source: "catalog",
      ...(aliases.length > 0 ? { aliases } : {}),
      hasDefinition: entry.hasDefinition ?? false,
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      ...(entry.docs ? { docs: entry.docs } : {}),
      ...(entry.envVars ? { envVars: entry.envVars } : {}),
      ...(entry.note ? { note: entry.note } : {}),
      unavailableReason:
        redirect ??
        (entry.hasDefinition === true
          ? "This provider has a definition but is not loaded. Enable it in Settings → Providers."
          : "No usage definition yet. Add a custom definition in Settings → Providers."),
    });
  }

  options.push({
    key: CUSTOM_ID,
    id: CUSTOM_ID,
    label: "Custom provider",
    color: "#64748b",
    source: "custom",
    note: "Write or paste a TOML definition, then test it with a saved key.",
  });

  return options.sort(
    (a, b) =>
      sourceOrder(a) - sourceOrder(b) ||
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

function searchText(option: WizardOption): string {
  return [
    option.id,
    option.label,
    option.source,
    option.auth ?? "",
    option.status ?? "",
    option.baseUrl ?? "",
    option.docs ?? "",
    option.note ?? "",
    option.hint ?? "",
    option.unavailableReason ?? "",
    ...(option.aliases ?? []),
    ...(option.envVars ?? []),
  ]
    .join(" ")
    .toLowerCase();
}

/** Every whitespace-separated token must match, so "claude code" finds "Claude Code". */
export function filterWizardOptions(
  options: readonly WizardOption[],
  query: string,
): WizardOption[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...options];
  return options.filter((option) => {
    const haystack = searchText(option);
    return tokens.every((token) => haystack.includes(token));
  });
}

export interface WizardGroup {
  readonly id: string;
  readonly label: string;
  readonly options: readonly WizardOption[];
}

export interface WizardGroupOptions {
  /** Organisation/admin keys stay out of the picker until asked for (or searched for). */
  readonly showAdvanced?: boolean;
}

function wizardGroupId(option: WizardOption): string {
  switch (option.source) {
    case "provider":
      return option.group === "agents" ? "agents" : option.group === "advanced" ? "advanced" : "apiKeys";
    case "definition":
      return "definitions";
    case "catalog":
      return "catalog";
    default:
      return "custom";
  }
}

/** Options the Advanced group holds: admin keys. */
export function isAdvancedOption(option: WizardOption): boolean {
  return wizardGroupId(option) === "advanced";
}

/** The picker's section headers, in the same words as the Providers screen; empty groups are omitted. */
export function wizardGroups(
  options: readonly WizardOption[],
  { showAdvanced = false }: WizardGroupOptions = {},
): WizardGroup[] {
  const groups: WizardGroup[] = [
    { id: "agents", label: "Agents you use", options: [] },
    { id: "apiKeys", label: "API keys", options: [] },
    { id: "definitions", label: "Provider definitions", options: [] },
    { id: "catalog", label: "More providers", options: [] },
    { id: "advanced", label: "Advanced: organisation keys", options: [] },
    { id: "custom", label: "Custom", options: [] },
  ];
  const collected = new Map<string, WizardOption[]>();
  for (const option of options) {
    const groupId = wizardGroupId(option);
    if (groupId === "advanced" && !showAdvanced) continue;
    const list = collected.get(groupId) ?? [];
    list.push(option);
    collected.set(groupId, list);
  }
  return groups
    .map((group) => ({ ...group, options: collected.get(group.id) ?? [] }))
    .filter((group) => group.options.length > 0);
}

/** Rows without a live provider only explain why they cannot be added. */
export function isActionableOption(option: WizardOption | undefined): boolean {
  return option?.provider !== undefined;
}

/** `login`: a CLI sign-in Burnrate can run. `key`: paste an API key. `none`: nothing to enter. */
export type WizardAuthKind = "login" | "key" | "none" | "unavailable";

export function wizardAuthKind(option: WizardOption | undefined): WizardAuthKind {
  if (!option?.provider) return "unavailable";
  if (providerLogin(option.provider)) return "login";
  return option.provider.auth === "apiKey" ? "key" : "none";
}

/** Only Claude keeps several named accounts; other agents sign in once. */
export function wizardNeedsName(option: WizardOption | undefined): boolean {
  const kind = wizardAuthKind(option);
  return kind === "key" || (kind === "login" && option?.provider?.id === CLAUDE_PROVIDER_ID);
}

function usedNames(provider: ProviderInfo): Set<string> {
  const used = new Set(takenAccountNames(provider));
  // Claude account ids are `claude-<name>`; the sign-in name is the part after the prefix.
  for (const account of provider.accounts) {
    if (account.id.startsWith("claude-")) used.add(account.id.slice("claude-".length).toLowerCase());
    used.add(account.id.toLowerCase());
  }
  return used;
}

/** Claude sign-in names already taken, as the dialog's `usedNames` expects them. */
export function claudeUsedNames(provider: ProviderInfo | undefined): string[] {
  if (!provider) return [];
  return provider.accounts.map((account) =>
    account.id.startsWith("claude-") ? account.id.slice("claude-".length) : account.id,
  );
}

/** "main", then "main-2" …, skipping names already used by the Claude sign-in. */
function suggestClaudeName(provider: ProviderInfo): string {
  const used = usedNames(provider);
  if (!used.has("main")) return "main";
  let n = 2;
  while (used.has(`main-${n}`)) n += 1;
  return `main-${n}`;
}

/** A readable, unused starting name for the selected provider. */
export function suggestWizardName(option: WizardOption): string {
  if (!option.provider) return option.id;
  if (option.provider.id === CLAUDE_PROVIDER_ID) return suggestClaudeName(option.provider);
  return suggestAccountName(option.provider);
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MAX_NAME_LENGTH = 64;

/** Validates the step-2 account name; only API-key and Claude providers need one. */
export function validateWizardName(
  option: WizardOption,
  value: string,
  resolve: MessageResolver = m,
): string | undefined {
  if (!wizardNeedsName(option)) return undefined;
  const name = value.trim();
  if (!option.provider) return undefined;
  if (name.length === 0) return resolve("Enter an account name.");
  if (name.length > MAX_NAME_LENGTH) return resolve("Use at most 64 characters for the account name.");
  if (!NAME_PATTERN.test(name) || !/[A-Za-z0-9]/.test(name)) {
    return resolve("Use only letters, digits, _ . and - in the account name.");
  }
  if (usedNames(option.provider).has(name.toLowerCase())) {
    return resolve("An account with this name already exists.");
  }
  return undefined;
}
