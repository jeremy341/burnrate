import type { PaletteCommand } from "./types";

/** How many recently used commands the palette remembers (and floats to the top). */
export const MAX_RECENT_COMMANDS = 4;
export const RECENT_COMMANDS_KEY = "burnrate.palette.recent";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Command ids, most recent first. Never throws: a blocked or corrupt store just means "no recents". */
export function readRecentCommands(storage: StorageLike | null = defaultStorage()): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(RECENT_COMMANDS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string").slice(0, MAX_RECENT_COMMANDS)
      : [];
  } catch {
    return [];
  }
}

/** Remember that `id` was just used; returns the new list (most recent first, no duplicates). */
export function recordRecentCommand(id: string, storage: StorageLike | null = defaultStorage()): string[] {
  const next = [id, ...readRecentCommands(storage).filter((existing) => existing !== id)].slice(0, MAX_RECENT_COMMANDS);
  try {
    storage?.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next));
  } catch {
    // Private mode or a full quota: recents are a convenience only.
  }
  return next;
}

/**
 * With an empty query, lift the recently used commands (most recent first) into their own leading
 * group. Each command stays listed exactly once, so keyboard highlighting never sees duplicates.
 * With a query the order is the search ranking; `recentRank` below nudges ties.
 */
export function withRecentGroup(
  commands: readonly PaletteCommand[],
  recentIds: readonly string[],
  label: string,
): readonly PaletteCommand[] {
  const byId = new Map(commands.map((command) => [command.id, command]));
  const recent: PaletteCommand[] = [];
  for (const id of recentIds) {
    const command = byId.get(id);
    if (command) recent.push({ ...command, group: label, groupOrder: 0 });
  }
  if (recent.length === 0) return commands;
  const lifted = new Set(recent.map((command) => command.id));
  return [...recent, ...commands.filter((command) => !lifted.has(command.id))];
}

/** Small ranking bonus for a recently used command (0 when it is not recent). */
export function recentRank(recentIds: readonly string[], id: string): number {
  const index = recentIds.indexOf(id);
  return index < 0 ? 0 : (MAX_RECENT_COMMANDS - index) * 6;
}
