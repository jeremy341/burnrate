import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Top-level view routing for the app shell.
 *
 * The current view lives in the URL hash so the window's own Back/Forward (mouse buttons, Alt+Left,
 * WebView2/WKWebView history) step between views, and a reload or deep link lands where you were.
 *
 *   ""  "#"  "#usage"            -> usage (the home view)
 *   "#providers"                 -> providers
 *   "#settings"  "#settings/<x>" -> settings (the section after the slash belongs to the Settings page)
 *   anything else                -> ignored (keep the current view)
 */
export const HOME_VIEW = "usage";

/** Settings keeps the conventional "preferences" chord of desktop apps. */
export const SETTINGS_VIEW = "settings";

/** Where the Settings gear leads: Settings, or back to Usage when Settings is already the open screen. */
export function settingsGearTarget(view: string): string {
  return view === SETTINGS_VIEW ? HOME_VIEW : SETTINGS_VIEW;
}

/** The view a hash addresses, or `null` when the hash belongs to nobody (so it must be ignored). */
export function parseViewFromHash(hash: string, validIds: readonly string[]): string | null {
  const route = hash.replace(/^#\/?/, "");
  if (route === "") return HOME_VIEW;
  const id = route.split("/")[0] ?? "";
  return validIds.includes(id) ? id : null;
}

/** The hash that addresses a view. */
export function viewToHash(id: string): string {
  return `#${id}`;
}

/** True when `hash` already addresses `id`, so navigating there must not push a duplicate entry. */
export function hashAddressesView(hash: string, id: string, validIds: readonly string[]): boolean {
  return parseViewFromHash(hash, validIds) === id;
}

function readHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

export interface ViewRoute {
  readonly view: string;
  /** Switch view. Pushes a history entry (once) so Back returns to the previous view. */
  readonly navigate: (id: string) => void;
}

export function useViewRoute(validIds: readonly string[]): ViewRoute {
  const idsRef = useRef(validIds);
  idsRef.current = validIds;
  const [view, setView] = useState<string>(() => parseViewFromHash(readHash(), validIds) ?? HOME_VIEW);

  useEffect(() => {
    // Back/Forward and typed hashes. `hashchange` and `popstate` both fire for a history step;
    // setting the same value twice is a no-op.
    const sync = () => {
      const next = parseViewFromHash(readHash(), idsRef.current);
      if (next !== null) setView(next);
    };
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    sync();
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  const navigate = useCallback((id: string) => {
    if (!idsRef.current.includes(id)) return;
    setView(id);
    // Assigning `location.hash` pushes one history entry and fires `hashchange`; it is skipped
    // when the hash already addresses this view (e.g. `#settings/appearance`).
    if (!hashAddressesView(readHash(), id, idsRef.current)) window.location.hash = viewToHash(id);
  }, []);

  return { view, navigate };
}

/** Ctrl/Cmd+, Settings (even while typing), Esc back to Usage, `g` then u/p/i/s jumps to a screen. */
export const NAV_CHORD_KEY = "g";
export const NAV_CHORD_TIMEOUT_MS = 1200;
export const NAV_CHORD_TARGETS: Readonly<Record<string, string>> = {
  u: HOME_VIEW,
  p: "providers",
  s: SETTINGS_VIEW,
};

export interface NavKeyEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
  readonly defaultPrevented?: boolean;
}

export type NavShortcutResult =
  | { readonly type: "navigate"; readonly viewId: string }
  | { readonly type: "back" }
  | { readonly type: "pending" }
  | null;

export interface NavShortcutContext {
  /** The screen currently shown. */
  readonly view: string;
  /** Every navigable screen id; shortcuts to an unknown id are ignored. */
  readonly validIds: readonly string[];
  /** True while a text field, a menu or a dialog owns the keyboard (Esc and bare keys must not fire). */
  readonly suppressed: boolean;
  readonly mac: boolean;
  readonly now: number;
}

export interface NavShortcuts {
  resolve(event: NavKeyEvent, context: NavShortcutContext): NavShortcutResult;
  reset(): void;
}

export function createNavShortcuts(): NavShortcuts {
  let chordStartedAt: number | null = null;
  return {
    reset() {
      chordStartedAt = null;
    },
    resolve(event, context) {
      if (event.defaultPrevented || event.repeat || event.isComposing) return null;
      const chordOpen =
        chordStartedAt !== null && context.now - chordStartedAt <= NAV_CHORD_TIMEOUT_MS;
      chordStartedAt = null;

      const mod = context.mac ? event.metaKey === true : event.ctrlKey === true;
      const otherMod = context.mac ? event.ctrlKey === true : event.metaKey === true;
      if (event.key === "," && mod && !otherMod && !event.altKey && !event.shiftKey) {
        return context.validIds.includes(SETTINGS_VIEW)
          ? { type: "navigate", viewId: SETTINGS_VIEW }
          : null;
      }

      if (context.suppressed) return null;
      if (event.ctrlKey || event.metaKey || event.altKey) return null;

      if (event.key === "Escape") {
        return context.view === HOME_VIEW ? null : { type: "back" };
      }
      if (event.shiftKey) return null;
      const key = event.key.toLowerCase();
      if (chordOpen) {
        const target = NAV_CHORD_TARGETS[key];
        if (target !== undefined && context.validIds.includes(target)) {
          return { type: "navigate", viewId: target };
        }
        return null;
      }
      if (key === NAV_CHORD_KEY) {
        chordStartedAt = context.now;
        return { type: "pending" };
      }
      return null;
    },
  };
}

/** True when a text field, menu, listbox or non-app dialog is focused, so bare keys belong to it. */
export function isNavKeyboardClaimed(target: EventTarget | null, doc: Document | null): boolean {
  if (target instanceof HTMLElement) {
    if (
      target.isContentEditable ||
      target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [data-keybinding-capture]") !== null
    ) {
      return true;
    }
  }
  // An open Base UI popup (menu, select, popover, dialog) closes itself on Esc first.
  return (
    doc?.querySelector(
      '[data-slot$="popup"][data-open], [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]',
    ) != null
  );
}

/** The shortcut hint shown next to a screen in menus and the palette. */
export function navShortcutHint(viewId: string, mac: boolean): string | undefined {
  if (viewId === SETTINGS_VIEW) return mac ? "⌘," : "Ctrl ,";
  for (const [key, id] of Object.entries(NAV_CHORD_TARGETS)) {
    if (id === viewId) return `G ${key.toUpperCase()}`;
  }
  return undefined;
}

/** The native title bar already closes the window, so Usage draws no second X there unless the shell opts in. */
export function shouldShowHomeClose(dataset: Readonly<Record<string, string | undefined>>): boolean {
  return dataset.shell !== "desktop" || dataset.titlebar === "custom";
}
