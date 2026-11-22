/**
 * Product names people search for versus the ids the server reports. Several first-class sources
 * answer to a name that is not their id or label: ChatGPT plans are read through the Codex login,
 * and OpenCode Go is a plan on the OpenCode login. Without these the Add-provider search for
 * "chatgpt" or "opencode go" finds nothing (or only a dead catalog row).
 *
 * Presentation only: nothing here decides what the server can read.
 */

/** Extra search words per provider id. Each entry is matched as plain text, case-insensitively. */
export const PROVIDER_SEARCH_TERMS: Readonly<Record<string, readonly string[]>> = {
  claudeAgent: ["claude", "anthropic", "claude code", "claude pro", "claude max"],
  codex: ["chatgpt", "chat gpt", "openai", "gpt", "chatgpt plus", "chatgpt pro", "codex cli"],
  opencode: ["opencode go", "opencode zen", "zen", "go plan"],
  "opencode-go": ["opencode", "opencode zen", "zen", "go plan"],
  "openai-admin": ["openai", "chatgpt", "api spend", "organization"],
  "anthropic-admin": ["anthropic", "claude", "api spend", "organization"],
};

/** One-line explanations for rows whose label alone does not say what they read. */
export const PROVIDER_HINTS: Readonly<Record<string, string>> = {
  codex: "ChatGPT Plus and Pro plans, read from the Codex login on this computer.",
  opencode: "OpenCode Zen and OpenCode Go, read from the OpenCode login on this computer.",
};

/**
 * Catalog rows that cannot be added directly because a better source already exists. The text
 * replaces the generic "No usage definition yet" so the dead end points somewhere useful.
 */
export const CATALOG_REDIRECTS: Readonly<Record<string, string>> = {
  openai:
    "ChatGPT plans are read through Codex. API spend needs an OpenAI Admin key (OpenAI Admin).",
  anthropic:
    "Claude plans are read through Claude Code. API spend needs an Anthropic Admin key (Anthropic Admin).",
};

export function providerSearchTerms(id: string): readonly string[] {
  return PROVIDER_SEARCH_TERMS[id] ?? [];
}

export function providerHint(id: string): string | undefined {
  return PROVIDER_HINTS[id];
}

export function catalogRedirect(id: string): string | undefined {
  return CATALOG_REDIRECTS[id];
}
