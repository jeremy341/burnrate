import type { ReactNode } from "react";

import { OVERLAYS } from "~/overlays/registry";

/** Wraps the app and mounts every registered overlay. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      {OVERLAYS.map(({ id, Overlay }) => (
        <Overlay key={id} />
      ))}
    </>
  );
}
