/**
 * Shortcut reference + recording helpers for the Shortcuts settings section.
 *
 * The read-only list is ported from T3's `usageShortcuts` defaults (the combos in
 * `apps/web/src/components/usage/usageShortcuts.ts` + `packages/shared/src/keybindings.ts`).
 * Burnrate only lets the user change one combo: `shell.globalShortcut` (see `schema.ts`),
 * which the desktop shell registers as a global hotkey. Everything here is pure so the
 * recording UI and the conflict warning stay predictable across platforms.
 */
import { msg } from "~/i18n";

/** Structural subset of a keyboard event: works with both native and React events. */
export interface ShortcutKeyEvent {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
}

export interface InAppShortcut {
  /** T3's command id, e.g. "usage.period.day". */
  readonly command: string;
  /** Human-readable command name (already localised through `msg`). */
  readonly label: string;
  /** T3's factory combo, e.g. "c" or "mod+shift+1". */
  readonly combo: string;
  readonly prefix?: string;
}

/** T3's built-in Usage shortcuts. Read-only in Burnrate: they are a reference, not editable. */
export const IN_APP_SHORTCUTS: readonly InAppShortcut[] = [
  { command: "navigate.settings", label: msg("Open Settings"), combo: "mod+," },
  { command: "showPalette", label: msg("Open command palette"), combo: "mod+k" },
  { command: "navigate.usage", label: msg("Go to Usage"), combo: "u", prefix: "g" },
  { command: "navigate.providers", label: msg("Go to Providers"), combo: "p", prefix: "g" },
  { command: "navigate.settings.sequence", label: msg("Go to Settings"), combo: "s", prefix: "g" },
  { command: "usage.cost", label: msg("Show cost"), combo: "c" },
  { command: "usage.tokens", label: msg("Show tokens"), combo: "t" },
  { command: "usage.limits", label: msg("Show limits"), combo: "l" },
  { command: "usage.period.day", label: msg("Period: Past 24h"), combo: "mod+shift+1" },
  { command: "usage.period.week", label: msg("Period: 7 days"), combo: "mod+shift+2" },
  { command: "usage.period.month", label: msg("Period: 30 days"), combo: "mod+shift+3" },
  { command: "usage.period.quarter", label: msg("Period: 90 days"), combo: "mod+shift+4" },
  { command: "navigate.back", label: msg("Close popup or return to Usage"), combo: "escape" },
] as const;

export function isMacPlatform(platform?: string): boolean {
  if (platform === undefined) {
    if (typeof navigator === "undefined") return false;
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    return /mac/i.test(nav.userAgentData?.platform ?? nav.platform ?? "");
  }
  return /mac/i.test(platform);
}

/** Best-effort current platform string, safe in tests/SSR. */
export function currentPlatform(): string {
  if (typeof navigator === "undefined") return "";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform ?? nav.platform ?? "";
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  " ": "Space",
  spacebar: "Space",
  space: "Space",
  escape: "Escape",
  esc: "Escape",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  pause: "Pause",
  printscreen: "PrintScreen",
};

/** The physical key token; null for modifier-only or unsupported keys. */
function keyToken(event: ShortcutKeyEvent): string | null {
  const code = event.code;
  if (code) {
    const letter = /^Key([A-Z])$/.exec(code);
    if (letter) return letter[1]!;
    const digit = /^Digit([0-9])$/.exec(code);
    if (digit) return digit[1]!;
    const fKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
    if (fKey) return `F${fKey[1]}`;
  }

  const key = event.key;
  const lower = key.toLowerCase();
  const named = NAMED_KEYS[lower];
  if (named) return named;
  if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return `F${lower.slice(1)}`;
  // A literal "+" would break the "+'-separated storage format; everything else printable is ok.
  if (key.length === 1 && key !== "+") return key;
  return null;
}

/**
 * Convert a keydown event to the stored combo format, e.g. "Ctrl+Shift+B" ("Cmd+..." on macOS).
 * Modifier-only presses and repeats return null so the recorder can keep waiting.
 */
export function comboFromKeyboardEvent(event: ShortcutKeyEvent): string | null {
  if (event.repeat === true || event.isComposing === true) return null;
  const key = keyToken(event);
  if (key === null) return null;

  const mac = isMacPlatform();
  const parts: string[] = [];
  // Primary modifier first (Cmd on macOS, Ctrl elsewhere), matching T3's "mod" order.
  if (mac ? event.metaKey === true : event.ctrlKey === true) parts.push(mac ? "Cmd" : "Ctrl");
  if (mac ? event.ctrlKey === true : event.metaKey === true) parts.push(mac ? "Ctrl" : "Meta");
  if (event.altKey === true) parts.push("Alt");
  if (event.shiftKey === true) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/**
 * Canonical comparison form. Makes T3's "mod" and the recorded "Ctrl"/"Cmd" collide correctly:
 * "mod+shift+1" == "Ctrl+Shift+1" on Windows/Linux, "Cmd+Shift+1" on macOS.
 */
export function normalizeCombo(combo: string, platform?: string): string {
  const mac = isMacPlatform(platform);
  const modifiers = new Set<string>();
  let key = "";
  for (const raw of combo.split("+")) {
    const token = raw.trim().toLowerCase();
    if (token.length === 0) continue;
    if (token === "mod") modifiers.add(mac ? "meta" : "ctrl");
    else if (token === "ctrl" || token === "control") modifiers.add("ctrl");
    else if (token === "alt" || token === "option") modifiers.add("alt");
    else if (token === "shift") modifiers.add("shift");
    else if (token === "meta" || token === "cmd" || token === "command") modifiers.add("meta");
    else key = token;
  }
  if (key.length === 0) return "";
  const ordered = ["ctrl", "meta", "alt", "shift"].filter((m) => modifiers.has(m));
  return [...ordered, key].join("+");
}

/** A global hotkey needs a real modifier; Shift alone would steal normal typing. */
export function isSuitableGlobalShortcut(combo: string, platform?: string): boolean {
  const normalized = normalizeCombo(combo, platform);
  if (normalized.length === 0) return false;
  return ["ctrl", "alt", "meta"].some((modifier) =>
    normalized.split("+").slice(0, -1).includes(modifier),
  );
}

/** T3 shortcuts that would fire on the same chord as the recorded global hotkey. */
export function conflictingInAppShortcuts(combo: string, platform?: string): InAppShortcut[] {
  const normalized = normalizeCombo(combo, platform);
  if (normalized.length === 0) return [];
  return IN_APP_SHORTCUTS.filter(
    (shortcut) => shortcut.prefix === undefined && normalizeCombo(shortcut.combo, platform) === normalized,
  );
}

/** Readable label for tooltips / aria ("Ctrl+Shift+B", "Cmd+Shift+1"). */
export function comboLabel(combo: string, platform?: string): string {
  const mac = isMacPlatform(platform);
  return combo
    .split("+")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "mod") return mac ? "Cmd" : "Ctrl";
      if (lower === "ctrl" || lower === "control") return "Ctrl";
      if (lower === "shift") return "Shift";
      if (lower === "alt" || lower === "option") return "Alt";
      if (lower === "meta" || lower === "cmd" || lower === "command") return mac ? "Cmd" : "Win";
      if (lower === "space" || lower === " ") return "Space";
      if (lower === "escape" || lower === "esc") return "Esc";
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join("+");
}

/** Compact key caps for the T3-style `<Kbd>` row. */
export function shortcutKeyParts(combo: string, platform?: string): string[] {
  const mac = isMacPlatform(platform);
  return combo
    .split("+")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "mod" || lower === "meta" || lower === "cmd" || lower === "command") {
        return mac ? "⌘" : lower === "mod" ? "Ctrl" : "Win";
      }
      if (lower === "ctrl" || lower === "control") return mac ? "⌃" : "Ctrl";
      if (lower === "shift") return mac ? "⇧" : "Shift";
      if (lower === "alt" || lower === "option") return mac ? "⌥" : "Alt";
      if (lower === "space" || lower === " ") return "Space";
      if (lower === "escape" || lower === "esc") return "Esc";
      return part.length === 1 ? part.toUpperCase() : part;
    });
}

/** A stored global shortcut that is empty or whitespace means "none". */
export function normalizeGlobalShortcut(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
