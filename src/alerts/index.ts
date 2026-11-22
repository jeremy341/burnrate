/** Public client API for alerts (the notifications settings section imports `requestDesktopPermission`). */
export type { AlertEvent, AlertKind, AlertSeverity, AlertClientState } from "./types";
export { parseAlertEvent, fallbackCopy } from "./parse";
export { createDedupe } from "./dedupe";
export type { Dedupe } from "./dedupe";
export { isSnoozed } from "./snooze";
export {
  requestDesktopPermission,
  getNotificationPermission,
  isNotificationSupported,
  canShowDesktop,
} from "./desktop";
export { createAlertStream } from "./stream";
export type { AlertStreamOptions, AlertStreamController, EventSourceLike, EventSourceFactory } from "./stream";
export { createAlertDispatcher } from "./dispatch";
export type { AlertDispatchOptions, AlertDispatchState, AlertDispatcher } from "./dispatch";
