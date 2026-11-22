/**
 * Theme editor session store.
 *
 * T3 keeps its editor session in a zustand store; Burnrate has no zustand, so this is a tiny
 * `useSyncExternalStore` store with the same surface (`openThemeEditor`, `closeThemeEditor`,
 * `toggleThemeEditorForTheme`). The panel itself keeps its draft colors as local state and only
 * paints them through `applyThemeColorPreview`, so nothing reaches the settings store before Save.
 */
import { useSyncExternalStore } from "react";

import {
  getThemeDefinition,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreference,
} from "~/themePalette";

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

export type ThemeEditorSessionInput = {
  editingThemeId: string | null;
  seedThemeId: string | null;
  seedName: string | null;
  initialAppearance: ThemeAppearance;
};

export type ThemeEditorSession = ThemeEditorSessionInput & {
  id: number;
};

export type ThemeEditorState = {
  session: ThemeEditorSession | null;
};

let state: ThemeEditorState = { session: null };
const listeners = new Set<() => void>();
let nextSessionId = 0;
let editorOpener: HTMLElement | null = null;

function setState(next: ThemeEditorState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getThemeEditorState(): ThemeEditorState {
  return state;
}

export function subscribeThemeEditor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openThemeEditor(session: ThemeEditorSessionInput): void {
  if (state.session === null && typeof document !== "undefined") {
    const active = document.activeElement;
    editorOpener = active instanceof HTMLElement ? active : null;
  }
  nextSessionId += 1;
  setState({ session: { ...session, id: nextSessionId } });
}

export function closeThemeEditor(): void {
  if (state.session === null) return;
  const opener = editorOpener;
  editorOpener = null;
  setState({ session: null });
  if (opener) {
    requestAnimationFrame(() => {
      if (state.session === null && opener.isConnected) opener.focus();
    });
  }
}

/** React binding; `selector` must return a stable value (id, session object identity, boolean…). */
export function useThemeEditorStore<T = ThemeEditorState>(
  selector: (value: ThemeEditorState) => T = (value) => value as unknown as T,
): T {
  return selector(useSyncExternalStore(subscribeThemeEditor, getThemeEditorState, getThemeEditorState));
}

/** Open the editor for the theme currently shown, or close it when it is already open. */
export function toggleThemeEditorForTheme(input: {
  theme: ThemePreference;
  themeHalves: ThemeHalves | null;
  initialAppearance: ThemeAppearance;
}): void {
  if (state.session !== null) {
    closeThemeEditor();
    return;
  }

  const baseThemeId = getThemeDefinition(input.theme)?.id ?? null;
  const activeThemeId = input.themeHalves?.[input.initialAppearance] ?? baseThemeId;
  const seedThemeId = activeThemeId ? (getThemeDefinition(activeThemeId)?.id ?? null) : null;
  openThemeEditor({
    editingThemeId: null,
    seedThemeId,
    seedName: null,
    initialAppearance: input.initialAppearance,
  });
}
