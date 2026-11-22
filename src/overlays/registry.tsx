import type { ComponentType } from "react";

const modules = import.meta.glob<{ Overlay?: ComponentType }>(["./*.tsx", "!./*.test.tsx", "!./PaletteDialog.tsx"], { eager: true });

/** Components rendered once at the app root (toasts, command palette, alert listener, ...).
 *  Drop a file `src/overlays/<id>.tsx` exporting `Overlay`; it is mounted by AppProviders. */
export const OVERLAYS: readonly { id: string; Overlay: ComponentType }[] = Object.entries(modules)
  .filter(([path, m]) => m.Overlay !== undefined && !path.endsWith("registry.tsx"))
  .map(([path, m]) => ({ id: path.replace("./", "").replace(".tsx", ""), Overlay: m.Overlay! }));
