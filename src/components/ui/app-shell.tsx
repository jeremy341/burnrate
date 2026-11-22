import { useEffect, type ReactNode } from "react";

import { useGT } from "~/i18n";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !== null;
}

/** Marks the visible screen's content region: the target of the skip link. */
export const APP_CONTENT_ATTRIBUTE = "data-app-content";

/**
 * Moves keyboard focus to the visible screen's content (the active screen, never an inert hidden one).
 * Hash routing owns `#`, so the skip link is a button that focuses, not an anchor that navigates.
 */
export function focusAppContent(root: Pick<ParentNode, "querySelector"> = document): boolean {
  const target = root.querySelector<HTMLElement>(`[${APP_CONTENT_ATTRIBUTE}]:not([inert])`);
  if (!target) return false;
  target.focus({ preventScroll: false });
  return true;
}

/** First tab stop in the window: invisible until focused, then a pinned, readable pill (WCAG 2.4.1). */
export function SkipToContent() {
  const gt = useGT();
  return (
    <button
      type="button"
      data-slot="skip-link"
      onClick={() => focusAppContent()}
      className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:start-3 focus-visible:top-2 focus-visible:z-50 focus-visible:rounded-md focus-visible:border focus-visible:bg-popover focus-visible:px-3 focus-visible:py-1.5 focus-visible:text-sm focus-visible:font-medium focus-visible:text-foreground focus-visible:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {gt("Skip to content")}
    </button>
  );
}

/**
 * The full-window frame: the active screen fills the window edge to edge. No backdrop, no floating
 * card, no rounded outer border and no page scroll (each screen scrolls inside its own frame), and no
 * "Reload / Inspect" browser menu on the chrome (it stays in text fields and over selected text).
 *
 * Landmarks: the shell is a plain frame. The screen header is the page `banner`; the screen body is the
 * one `<main>` (see `AppMain`), so a screen reader can jump straight past the toolbar.
 */
export function AppShell({ children }: { readonly label?: string; readonly children: ReactNode }) {
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (isEditable(event.target)) return;
      if ((window.getSelection()?.toString() ?? "") !== "") return;
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  return (
    <div
      data-slot="app-shell"
      className="relative flex h-dvh min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background text-foreground outline-none"
    >
      <SkipToContent />
      {children}
    </div>
  );
}

/** The one `main` landmark, named after the active screen. Holds every screen; inactive ones are inert. */
export function AppMain({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <main aria-label={label} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {children}
    </main>
  );
}
