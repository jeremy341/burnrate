/**
 * Adapts T3's `AppRouteModal` / `AppRouteModalClose` to Burnrate. The modal frame itself is owned by
 * `App.tsx` (it also wraps the Providers view), so the route-modal shim is a pass-through that only
 * carries the close callback to `AppRouteModalClose`.
 */

import { createContext, useContext, type ReactNode } from "react";

import { AppModalClose } from "~/components/AppModalFrame";

const CloseContext = createContext<() => void>(() => {});

export function AppRouteModal({
  label: _label,
  children,
  onClose,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly onClose?: () => void;
}) {
  return <CloseContext.Provider value={onClose ?? (() => {})}>{children}</CloseContext.Provider>;
}

export function AppRouteModalClose() {
  const onClose = useContext(CloseContext);
  return <AppModalClose onClose={onClose} />;
}
