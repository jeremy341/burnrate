import type { PaletteCommand } from "./types";

/**
 * Tiny external store for palette commands. Framework-free so any package (or a
 * non-React module) can register commands; the overlay subscribes with
 * `useSyncExternalStore` through `useCommands()`.
 */

interface Entry {
  readonly command: PaletteCommand;
  readonly seq: number;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let seq = 0;
let snapshot: readonly PaletteCommand[] = [];

function compare(a: Entry, b: Entry): number {
  return (
    (a.command.groupOrder ?? 100) - (b.command.groupOrder ?? 100) ||
    (b.command.priority ?? 0) - (a.command.priority ?? 0) ||
    a.seq - b.seq
  );
}

function recompute(): void {
  snapshot = [...entries.values()].sort(compare).map((entry) => entry.command);
  listeners.forEach((listener) => listener());
}

/** Register one command. Returns an unregister function scoped to this exact registration. */
export function registerCommand(command: PaletteCommand): () => void {
  const entry: Entry = { command, seq: seq++ };
  entries.set(command.id, entry);
  recompute();
  return () => unregisterCommand(command.id, command);
}

/** Register several commands; returns a function that removes all of them. */
export function registerCommands(commands: readonly PaletteCommand[]): () => void {
  const unregisters = commands.map(registerCommand);
  return () => unregisters.forEach((unregister) => unregister());
}

/**
 * Remove a command by id. When `command` is given, removal only happens if that
 * exact registration is still current (so an old cleanup cannot remove a newer
 * command that reused the id).
 */
export function unregisterCommand(id: string, command?: PaletteCommand): void {
  const current = entries.get(id);
  if (!current || (command !== undefined && current.command !== command)) return;
  entries.delete(id);
  recompute();
}

export function getCommands(): readonly PaletteCommand[] {
  return snapshot;
}

export function hasCommand(id: string): boolean {
  return entries.has(id);
}

/** Subscribe to registry changes. Also fires once on first value read by React. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test/teardown helper. */
export function clearCommands(): void {
  if (entries.size === 0) return;
  entries.clear();
  recompute();
}
