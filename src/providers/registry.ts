import type { ProviderInfo } from "~/contracts";

import {
  PROVIDER_COLORS,
  providerAccentColor,
  providerFallbackColor,
} from "./presentation";

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
  claudeAgent: { label: "Claude Code", color: PROVIDER_COLORS.claudeAgent! },
  codex: { label: "Codex", color: "var(--contrast-foreground)" },
  opencode: { label: "OpenCode", color: PROVIDER_COLORS.opencode! },
  "opencode-go": { label: "OpenCode Go", color: PROVIDER_COLORS["opencode-go"]! },
  mistral: { label: "Mistral", color: PROVIDER_COLORS.mistral! },
  cursor: { label: "Cursor", color: PROVIDER_COLORS.cursor! },
  antigravity: { label: "Antigravity", color: PROVIDER_COLORS.antigravity! },
  grok: { label: "Grok", color: PROVIDER_COLORS.grok! },
  pi: { label: "Pi", color: PROVIDER_COLORS.pi! },
  muse: { label: "Muse Code", color: PROVIDER_COLORS.muse! },
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

/** The user's local accent wins, then the server's brand colour, then the definition default. */
export function providerColor(id: string): string {
  return providerAccentColor(id) ?? lookup(id)?.color ?? providerFallbackColor(id) ?? "var(--foreground)";
}
