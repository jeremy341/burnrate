import { recentRank } from "./recent";
import type { PaletteCommand, PaletteCommandGroup } from "./types";

/** Case-insensitive, accent-insensitive comparison key. */
export function foldText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/**
 * Subsequence score for `query` inside `text`, or null when it does not match.
 * Exact and prefix matches rank highest; consecutive hits and word boundaries
 * get smaller bonuses so "rfl" prefers "Refresh limits" over unrelated rows.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = foldText(query);
  if (q.length === 0) return 0;
  const t = foldText(text);
  if (t.length === 0) return null;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - (t.length - q.length) * 0.5;

  let queryIndex = 0;
  let score = 0;
  let streak = 0;
  let previousIndex = -2;
  for (let textIndex = 0; textIndex < t.length && queryIndex < q.length; textIndex++) {
    if (t[textIndex] !== q[queryIndex]) continue;
    streak = textIndex === previousIndex + 1 ? streak + 1 : 0;
    score += 10 + streak * 6;
    if (textIndex === 0 || /[\s\-_/.:]/.test(t[textIndex - 1]!)) score += 12;
    previousIndex = textIndex;
    queryIndex++;
  }
  if (queryIndex < q.length) return null;
  // Prefer tight matches over the same letters spread across a long label.
  return score - (t.length - q.length) * 0.2;
}

/** Score one command against a query, or null if it does not match. */
export function scoreCommand(command: PaletteCommand, query: string): number | null {
  if (command.enabled?.() === false) return null;
  if (foldText(query).length === 0) return command.priority ?? 0;

  const candidates: readonly (readonly [number | null, number])[] = [
    [fuzzyScore(query, command.title), 120],
    ...(command.keywords ?? []).map((word) => [fuzzyScore(query, word), 60] as const),
    [command.description ? fuzzyScore(query, command.description) : null, 25],
    [fuzzyScore(query, command.group), 10],
  ];
  let best: number | null = null;
  for (const [score, bonus] of candidates) {
    if (score === null) continue;
    const total = score + bonus;
    if (best === null || total > best) best = total;
  }
  return best === null ? null : best + (command.priority ?? 0);
}

/** Filter and rank commands for a query. An empty query keeps registry order. */
export function filterCommands(
  commands: readonly PaletteCommand[],
  query: string,
  recentIds: readonly string[] = [],
): readonly PaletteCommand[] {
  if (foldText(query).length === 0) {
    return commands.filter((command) => command.enabled?.() !== false);
  }
  return commands
    .map((command, index) => {
      const score = scoreCommand(command, query);
      return { command, index, score: score === null ? null : score + recentRank(recentIds, command.id) };
    })
    .filter((entry): entry is { command: PaletteCommand; index: number; score: number } =>
      entry.score !== null,
    )
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command);
}

/** Group an already-filtered command list for display, preserving rank inside each group. */
export function groupCommands(commands: readonly PaletteCommand[]): PaletteCommandGroup[] {
  const byLabel = new Map<string, PaletteCommandGroup>();
  for (const command of commands) {
    const group = byLabel.get(command.group);
    if (group) group.commands.push(command);
    else
      byLabel.set(command.group, {
        label: command.group,
        order: command.groupOrder ?? 100,
        commands: [command],
      });
  }
  return [...byLabel.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}
