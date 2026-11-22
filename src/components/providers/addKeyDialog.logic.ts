import type { ProviderInfo } from "~/contracts";
import { m, type MessageResolver } from "~/i18n";

/** Draft is held as typed; validation is applied when it is used. */
export interface AddKeyDraft {
  readonly name: string;
  readonly apiKey: string;
}

export interface AddKeyIssues {
  readonly name?: string;
  readonly apiKey?: string;
}

export type AddKeyValidation =
  | { readonly ok: true; readonly value: { readonly name: string; readonly apiKey: string } }
  | { readonly ok: false; readonly issues: AddKeyIssues };

const MAX_NAME_LENGTH = 64;
const MIN_KEY_LENGTH = 8;
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** Names and labels are both user-visible identifiers, so neither may be reused. */
export function takenAccountNames(provider: ProviderInfo): ReadonlySet<string> {
  const taken = new Set<string>();
  for (const account of provider.accounts) {
    if (account.id.trim()) taken.add(account.id.trim().toLowerCase());
    if (account.label.trim()) taken.add(account.label.trim().toLowerCase());
  }
  return taken;
}

/** A readable, unused starting name, e.g. `mistral-1`, `mistral-2`. */
export function suggestAccountName(provider: ProviderInfo): string {
  const base =
    provider.id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "") || "account";
  const taken = takenAccountNames(provider);
  let index = 1;
  let candidate = `${base}-${index}`;
  while (taken.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${base}-${index}`;
  }
  return candidate;
}

/** "main" for the first key, then a readable unused name ("main-2", ...). */
export function initialKeyName(provider: ProviderInfo): string {
  const taken = takenAccountNames(provider);
  if (!taken.has("main")) return "main";
  let index = 2;
  while (taken.has(`main-${index}`)) index += 1;
  return `main-${index}`;
}

/** Every field that blocks saving, one message each, or the trimmed values to send. */
export function validateAddKeyDraft(
  draft: AddKeyDraft,
  provider: ProviderInfo,
  resolve: MessageResolver = m,
): AddKeyValidation {
  const name = draft.name.trim();
  const apiKey = draft.apiKey.trim();
  const taken = takenAccountNames(provider);

  let nameIssue: string | undefined;
  if (name.length === 0) {
    nameIssue = resolve("Enter an account name.");
  } else if (name.length > MAX_NAME_LENGTH) {
    nameIssue = resolve("Use at most 64 characters for the account name.");
  } else if (!NAME_PATTERN.test(name) || !/[A-Za-z0-9]/.test(name)) {
    nameIssue = resolve("Use only letters, digits, _ . and - in the account name.");
  } else if (taken.has(name.toLowerCase())) {
    nameIssue = resolve("An account with this name already exists.");
  }

  let apiKeyIssue: string | undefined;
  if (apiKey.length === 0) {
    apiKeyIssue = resolve("Enter an API key.");
  } else if (apiKey.length < MIN_KEY_LENGTH) {
    apiKeyIssue = resolve("The API key must be at least 8 characters.");
  }

  if (nameIssue !== undefined || apiKeyIssue !== undefined) {
    return {
      ok: false,
      issues: {
        ...(nameIssue === undefined ? {} : { name: nameIssue }),
        ...(apiKeyIssue === undefined ? {} : { apiKey: apiKeyIssue }),
      },
    };
  }
  return { ok: true, value: { name, apiKey } };
}
