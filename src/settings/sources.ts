/**
 * Local source folders (`providers.sources`): extra folders Burnrate reads an agent's files from, in
 * addition to the places it finds on its own. The server is the authority (it validates every patch and
 * resolves `~`); these helpers only keep the editor honest before a request is sent, and they mirror the
 * server rules in `server-rs/src/readers/sources.rs`.
 */

/** Every agent whose local folders can be configured; must stay in sync with the server. */
export const SOURCE_IDS = [
  "claude",
  "vibe",
  "codex",
  "opencode",
  "antigravity",
  "gemini",
  "qwen",
  "goose",
  "crush",
  "copilot",
  "grok",
  "pi",
  "muse",
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** Same caps as the server. */
export const MAX_SOURCE_PATHS = 20;
export const MAX_SOURCE_PATH_CHARS = 1024;

export type SourcePathProblem = "empty" | "relative" | "long" | "control" | "duplicate" | "limit";

/** Provider id (as the server lists it) -> the `providers.sources` key that feeds it. */
export const SOURCE_FOR_PROVIDER: Readonly<Record<string, SourceId>> = {
  claudeAgent: "claude",
  mistral: "vibe",
  // The OpenCode Go definition folds the `opencode` reader in when it is enabled.
  "opencode-go": "opencode",
  // The file-based agents: provider id equals reader id (see `SOURCE_IDS` on the server).
  codex: "codex",
  opencode: "opencode",
  antigravity: "antigravity",
  gemini: "gemini",
  copilot: "copilot",
  grok: "grok",
  pi: "pi",
  muse: "muse",
  // `qwen`, `goose` and `crush` have no provider entry to attach to: their blocks read and save
  // through `providers.sources` like the rest, but the server reports no per-provider status for them.
};

/**
 * How one agent's block in Settings > Providers > Local sources is titled and described. One entry
 * per element of `SOURCE_IDS`, in the same order, so the section renders from data alone.
 */
export interface SourcePresentation {
  readonly id: SourceId;
  /** The block title and the editor label, e.g. "Codex folders". */
  readonly title: string;
  /** One line saying what is read from folders listed under this source. */
  readonly helper: string;
  /** The add-folder input's placeholder. */
  readonly placeholder: string;
}

/** Presentation of every source, in `SOURCE_IDS` order. */
export const SOURCE_PRESENTATIONS: readonly SourcePresentation[] = [
  {
    id: "claude",
    title: "Claude Code folders",
    helper: "Folders with projects and .credentials.json, read alongside ~/.claude* and CLAUDE_CONFIG_DIR.",
    placeholder: "Full path to the folder",
  },
  {
    id: "vibe",
    title: "Mistral Vibe folders",
    helper: "Folders with logs and a key file, read alongside ~/.vibe* and VIBE_HOME.",
    placeholder: "Full path to the folder",
  },
  {
    id: "codex",
    title: "Codex folders",
    helper: "Folders with sessions and archived_sessions, read alongside CODEX_HOME and ~/.codex.",
    placeholder: "Full path to the folder",
  },
  {
    id: "opencode",
    title: "OpenCode folders",
    helper: "Folders with opencode.db, auth.json or storage, read alongside ~/.local/share/opencode.",
    placeholder: "Full path to the folder",
  },
  {
    id: "antigravity",
    title: "Antigravity folders",
    helper: "Folders with conversations databases, read alongside ~/.gemini/antigravity*.",
    placeholder: "Full path to the folder",
  },
  {
    id: "gemini",
    title: "Gemini CLI folders",
    helper: "Folders with tmp chats, read alongside GEMINI_CLI_HOME and ~/.gemini.",
    placeholder: "Full path to the folder",
  },
  {
    id: "qwen",
    title: "Qwen Code folders",
    helper: "Folders with projects and logs/sessions, read alongside QWEN_DATA_DIR and ~/.qwen.",
    placeholder: "Full path to the folder",
  },
  {
    id: "goose",
    title: "Goose folders",
    helper: "Folders with sessions/sessions.db, read alongside GOOSE_PATH_ROOT and Block/goose.",
    placeholder: "Full path to the folder",
  },
  {
    id: "crush",
    title: "Crush folders",
    helper: "Folders with projects.json, read alongside CRUSH_GLOBAL_DATA.",
    placeholder: "Full path to the folder",
  },
  {
    id: "copilot",
    title: "GitHub Copilot folders",
    helper: "Folders with session-store.db or session-state, read alongside COPILOT_HOME and ~/.copilot.",
    placeholder: "Full path to the folder",
  },
  {
    id: "grok",
    title: "Grok folders",
    helper: "Folders with sessions/updates.jsonl, read alongside GROK_HOME and ~/.grok.",
    placeholder: "Full path to the folder",
  },
  {
    id: "pi",
    title: "Pi folders",
    helper: "Agent or sessions folders, read alongside PI_CODING_AGENT_DIR and ~/.pi/agent.",
    placeholder: "Full path to the folder",
  },
  {
    id: "muse",
    title: "Muse Code folders",
    helper: "Folders with session.jsonl files, read alongside MUSE_HOME and ~/.muse.",
    placeholder: "Full path to the folder",
  },
];

/** One entry of `ProviderInfo.sources`: a configured folder and whether the server can see it. */
export interface SourceStatus {
  readonly path: string;
  readonly found: boolean;
}

/** Trim, and drop the quotes Explorer's "Copy as path" puts around a path. */
export function normalizeSourcePath(raw: string): string {
  let text = raw.trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** `C:\x`, `C:/x`, `\\server\share`, `/x`, `~`, `~/x`, `~\x`. */
function isAbsoluteLike(path: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\") ||
    path.startsWith("/") ||
    path === "~" ||
    path.startsWith("~/") ||
    path.startsWith("~\\")
  );
}

/** Whether two spellings name the same folder. Drive-letter and UNC paths compare case-insensitively. */
export function sameSourcePath(a: string, b: string): boolean {
  const key = (value: string) => {
    const trimmed = normalizeSourcePath(value).replace(/[\\/]+$/, "");
    return /^[A-Za-z]:|^\\\\/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  };
  return key(a) === key(b);
}

/** Why `raw` cannot be added to `existing`, or null when it can. */
export function sourcePathProblem(raw: string, existing: readonly string[] = []): SourcePathProblem | null {
  const text = normalizeSourcePath(raw);
  if (!text) return "empty";
  if (text.length > MAX_SOURCE_PATH_CHARS) return "long";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return "control";
  if (!isAbsoluteLike(text)) return "relative";
  if (existing.some((path) => sameSourcePath(path, text))) return "duplicate";
  if (existing.length >= MAX_SOURCE_PATHS) return "limit";
  return null;
}

export type AddSourceResult =
  | { readonly ok: true; readonly paths: string[] }
  | { readonly ok: false; readonly problem: SourcePathProblem };

/** The list after adding `raw` (normalized), or why it cannot be added. */
export function addSourcePath(existing: readonly string[], raw: string): AddSourceResult {
  const problem = sourcePathProblem(raw, existing);
  if (problem) return { ok: false, problem };
  return { ok: true, paths: [...existing, normalizeSourcePath(raw)] };
}

export function removeSourcePath(existing: readonly string[], path: string): string[] {
  return existing.filter((entry) => entry !== path);
}

/** The folders configured for one agent, tolerating a settings object that predates the field. */
export function sourcePathsFor(
  sources: Readonly<Partial<Record<SourceId, readonly string[]>>> | undefined,
  id: SourceId,
): readonly string[] {
  return sources?.[id] ?? [];
}

/** The plain-English message for a problem. */
export function describeSourceProblem(
  problem: SourcePathProblem,
  gt: (message: string, values?: Record<string, string | number>) => string,
): string {
  switch (problem) {
    case "empty":
      return gt("Enter a folder path.");
    case "relative":
      return gt("Use the full path, for example C:\\Users\\you\\.vibe2 or /home/you/.vibe2. A path starting with ~ also works.");
    case "long":
      return gt("That path is too long.");
    case "control":
      return gt("That path contains characters a folder name cannot have.");
    case "duplicate":
      return gt("That folder is already in the list.");
    case "limit":
      return gt("The list is full ({count} folders).", { count: MAX_SOURCE_PATHS });
  }
}

