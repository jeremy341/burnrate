import type { ProviderInfo } from "~/contracts";

/**
 * Every provider the UI can draw, keyed by id. There is no fixed list: the server reports the
 * providers it can read (`registerProviders`), and these entries only give well-known ids a
 * friendlier name and color before the server answers.
 */
interface Presentation {
  readonly label: string;
  readonly color: string;
}

const DEFAULTS: Record<string, Presentation> = {
  claudeAgent: { label: "Claude Code", color: "#d97757" },
  codex: { label: "Codex", color: "var(--contrast-foreground)" },
  opencode: { label: "OpenCode", color: "#5b9bbd" },
  mistral: { label: "Mistral", color: "#fa520f" },
  cursor: { label: "Cursor", color: "#8b8b8b" },
  antigravity: { label: "Antigravity", color: "#8c7bd1" },
  grok: { label: "Grok", color: "#8b8b8b" },
  pi: { label: "Pi", color: "#4d9f8a" },
  muse: { label: "Muse Code", color: "#0866ff" },
};

const fromServer = new Map<string, Presentation>();
const listeners = new Set<() => void>();

export function registerProviders(list: readonly ProviderInfo[]): void {
  fromServer.clear();
  for (const p of list) fromServer.set(p.id, { label: p.label, color: p.color });
  listeners.forEach((l) => l());
}

export function onProvidersChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function lookup(id: string): Presentation | undefined {
  return fromServer.get(id) ?? DEFAULTS[id];
}

export function providerLabel(id: string): string {
  return lookup(id)?.label ?? id;
}

export function providerColor(id: string): string {
  return lookup(id)?.color ?? "var(--foreground)";
}
