import type { ViewDef } from "./types";

const modules = import.meta.glob<{ view?: ViewDef }>("./*.tsx", { eager: true });

/** Every `src/views/*.tsx` exporting `view`, sorted by `order`. The Usage view itself is built into App.tsx. */
export const VIEWS: readonly ViewDef[] = Object.values(modules)
  .map((m) => m.view)
  .filter((v): v is ViewDef => v !== undefined)
  .sort((a, b) => a.order - b.order);

/** Look up a registered view by id (the screen menu is built from `VIEWS`). */
export function getView(id: string): ViewDef | undefined {
  return VIEWS.find((view) => view.id === id);
}

/** Whether a screen's header carries the refresh button: only where a refresh changes what you see. */
export function viewHasRefresh(view: ViewDef): boolean {
  return view.refreshLimits ?? view.id === "providers";
}
