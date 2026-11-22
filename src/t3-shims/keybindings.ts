/**
 * Adapter for the keybinding helpers the upstream T3 Usage page uses. Burnrate has no
 * configurable keybinding store, so we resolve T3's built-in usage shortcuts directly.
 */

export type KeybindingCommand = string;
export type ResolvedKeybindingsConfig = Readonly<Record<string, string>>;

export interface ShortcutEventLike {
  readonly key: string;
  readonly code?: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
}

export interface ShortcutMatchOptions {
  readonly context?: { readonly usagePageOpen?: boolean };
}

/** T3's factory defaults for the usage page (packages/shared/src/keybindings.ts). */
const USAGE_SHORTCUTS: Readonly<Record<string, string>> = {
  "usage.cost": "c",
  "usage.tokens": "t",
  "usage.limits": "l",
  "usage.period.day": "mod+shift+1",
  "usage.period.week": "mod+shift+2",
  "usage.period.month": "mod+shift+3",
  "usage.period.quarter": "mod+shift+4",
};

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac/i.test(platform);
}

function normalizedKey(key: string): string {
  if (key === " ") return "space";
  if (key === "Esc") return "escape";
  return key.toLowerCase();
}

function matches(combo: string, event: ShortcutEventLike): boolean {
  const mod = isMac() ? event.metaKey === true : event.ctrlKey === true;
  const otherMod = isMac() ? event.ctrlKey === true : event.metaKey === true;
  const tokens = combo.split("+").map((token) => token.trim());
  let shift = false;
  let alt = false;
  let wantMod = false;
  let wantOtherMod = false;
  let key: string | undefined;
  for (const token of tokens) {
    if (token === "mod") wantMod = true;
    else if (token === "shift") shift = true;
    else if (token === "alt") alt = true;
    else if (token === "meta") wantOtherMod = true;
    else if (token === "ctrl") wantOtherMod = true;
    else key = token;
  }
  if (mod !== wantMod || otherMod !== wantOtherMod) return false;
  if ((event.shiftKey === true) !== shift || (event.altKey === true) !== alt) return false;
  return key !== undefined && normalizedKey(event.key) === normalizedKey(key);
}

/** Resolves a keyboard event to one of T3's usage commands. */
export function resolveShortcutCommand(
  event: ShortcutEventLike,
  _keybindings: ResolvedKeybindingsConfig,
  _options?: ShortcutMatchOptions,
): KeybindingCommand | null {
  if (event.repeat || event.isComposing) return null;
  for (const [command, combo] of Object.entries(USAGE_SHORTCUTS)) {
    if (matches(combo, event)) return command;
  }
  return null;
}

/** Human-readable label used in T3's period/metric toggle tooltips. */
export function shortcutLabelForCommand(
  _keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand | null,
  _options?: ShortcutMatchOptions,
): string | null {
  if (command === null) return null;
  const combo = USAGE_SHORTCUTS[command];
  if (combo === undefined) return null;
  if (isMac()) {
    return combo.startsWith("mod+")
      ? `\u2318\u21e7${combo.slice("mod+shift+".length)}`
      : combo.toUpperCase();
  }
  return combo.startsWith("mod+")
    ? `Ctrl+Shift+${combo.slice("mod+shift+".length)}`
    : combo.toUpperCase();
}

/** Stand-in for T3's resolved keybindings atom value. */
export const defaultKeybindings: ResolvedKeybindingsConfig = {};
