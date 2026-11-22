/**
 * Decoupled bridge between palette commands and the app shell. The palette
 * cannot import App.tsx (different package), so navigation/refresh requests go
 * through here. The shell may register a handler with `onPaletteAction` or
 * listen for the `burnrate:palette-action` window event; both are sent.
 */

export const PALETTE_ACTION_EVENT = "burnrate:palette-action";
export const OPEN_PALETTE_EVENT = "burnrate:open-palette";

export type PaletteAction =
  | { readonly type: "switchView"; readonly viewId: string }
  | { readonly type: "openSettings"; readonly sectionId: string }
  | { readonly type: "refreshLimits" }
  | { readonly type: "addProvider" }
  | { readonly type: "connectAgent" }
  | { readonly type: "usageMetric"; readonly metric: "cost" | "tokens" | "limits" }
  | { readonly type: "usagePeriod"; readonly days: number };

export type PaletteActionHandler = (action: PaletteAction) => boolean | void;

const handlers = new Set<PaletteActionHandler>();

/** Register a shell handler. Return `true` to mark the action as handled. */
export function onPaletteAction(handler: PaletteActionHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Dispatch an action to the shell. Returns true when a handler claimed it. */
export function dispatchPaletteAction(action: PaletteAction): boolean {
  let handled = false;
  for (const handler of [...handlers]) {
    if (handler(action) === true) handled = true;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<PaletteAction>(PALETTE_ACTION_EVENT, { detail: action }));
  }
  return handled;
}

export interface OpenPaletteDetail {
  /** Optional starting filter, e.g. when another feature sends the user to a command. */
  readonly query?: string;
  readonly trigger?: HTMLElement;
}

/** Open (or focus) the palette from anywhere, including overlays in other packages. */
export function openPalette(detail: OpenPaletteDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenPaletteDetail>(OPEN_PALETTE_EVENT, { detail }));
}

export function onOpenPalette(listener: (detail: OpenPaletteDetail) => void): () => void {
  const wrapped = (event: Event) => listener((event as CustomEvent<OpenPaletteDetail>).detail ?? {});
  if (typeof window === "undefined") return () => {};
  window.addEventListener(OPEN_PALETTE_EVENT, wrapped);
  return () => window.removeEventListener(OPEN_PALETTE_EVENT, wrapped);
}
