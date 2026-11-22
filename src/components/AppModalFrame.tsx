/**
 * The floating T3 card and its backdrop are gone: Burnrate's window is the frame, full-bleed (see
 * `AppShell`). The close control lives with the header in `AppHeader.tsx`; it is re-exported here for
 * the `AppRouteModalClose` shim.
 */
export { AppModalClose } from "./AppHeader";
