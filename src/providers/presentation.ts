import { useSyncExternalStore } from "react";

/**
 * Presentation details for providers that the server does not fully define: fallback brand
 * colours for definition ids that arrived with the defs engine, and an optional local accent
 * colour the user picks in the "Add provider" wizard.
 *
 * The accent is presentation-only data for this browser (`localStorage`), never settings or a
 * secret; the server stays the source of truth for provider labels and brand colours.
 */

const STORAGE_KEY = "burnrate.providerAccents";

/** Fallback colours for definition ids, used before/without a server answer. */
export const PROVIDER_COLORS: Readonly<Record<string, string>> = {
  claudeAgent: "#d97757",
  anthropic: "#d97757",
  "anthropic-admin": "#d97757",
  codex: "#111111",
  openai: "#10a37f",
  "openai-admin": "#10a37f",
  openrouter: "#6467f2",
  deepseek: "#4d6bfe",
  moonshot: "#161616",
  "kimi-code": "#00b3ff",
  xai: "#111111",
  zai: "#2d6ae3",
  groq: "#f55036",
  perplexity: "#20808d",
  together: "#0f6fff",
  gemini: "#4285f4",
  vertex: "#4285f4",
  "azure-openai": "#0078d4",
  bedrock: "#ff9900",
  copilot: "#24292f",
  kiro: "#7c3aed",
  windsurf: "#0ea5e9",
  ollama: "#111827",
  mistral: "#e8b923",
  cursor: "#8b8b8b",
  grok: "#8b8b8b",
  opencode: "#5b9bbd",
  "opencode-go": "#5b9bbd",
  antigravity: "#8c7bd1",
  pi: "#4d9f8a",
  muse: "#0866ff",
};

/** Swatches offered in the wizard's name-and-colour step (T3-style provider accent picker). */
export const ACCENT_SWATCHES: readonly string[] = [
  "#d97757",
  "#4d6bfe",
  "#10a37f",
  "#6467f2",
  "#0ea5e9",
  "#8b5cf6",
  "#f59e0b",
  "#ec4899",
];

const listeners = new Set<() => void>();
let overrides: Record<string, string> = readAccents();

function readAccents(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed)) {
      const color = normalizeAccentColor(typeof value === "string" ? value : null);
      if (id && color) out[id] = color;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* storage unavailable: the override still applies for this session */
  }
  listeners.forEach((listener) => listener());
}

/** `#abc` / `#aabbcc` -> lowercase `#aabbcc`; anything else is not an accent colour. */
export function normalizeAccentColor(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (short?.[1]) {
    const digits = short[1]
      .split("")
      .map((digit) => `${digit}${digit}`)
      .join("");
    return `#${digits}`.toLowerCase();
  }
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

/** The user's accent for a provider, or undefined to use the server's brand colour. */
export function providerAccentColor(id: string): string | undefined {
  return overrides[id];
}

/** Brand fallback for ids without a server answer. */
export function providerFallbackColor(id: string): string | undefined {
  return PROVIDER_COLORS[id];
}

export function setProviderAccentColor(id: string, color: string | null | undefined): void {
  const normalized = normalizeAccentColor(color);
  if (normalized) {
    if (overrides[id] === normalized) return;
    overrides = { ...overrides, [id]: normalized };
  } else {
    if (!(id in overrides)) return;
    const next = { ...overrides };
    delete next[id];
    overrides = next;
  }
  persist();
}

export function onProviderAccentsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding for the accent override. */
export function useProviderAccentColor(id: string): string | undefined {
  return useSyncExternalStore(
    onProviderAccentsChanged,
    () => overrides[id],
    () => overrides[id],
  );
}

/** Up to two uppercase letters for a provider without a brand mark: "Claude Code" -> "CC". */
export function providerInitials(label: string): string {
  const words = label
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const letters =
    words.length > 1 ? words.slice(0, 2).map((word) => word[0]) : [words[0]?.[0], words[0]?.[1]];
  return letters.filter(Boolean).join("").toUpperCase() || "?";
}
