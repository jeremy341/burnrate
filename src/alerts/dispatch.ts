/** Delivery pipeline shared by the overlay: snooze gate -> dedupe -> in-app toast -> desktop toast. */
import { canShowDesktop, showDesktopNotification } from "./desktop";
import { createDedupe, type Dedupe } from "./dedupe";
import { isSnoozed } from "./snooze";
import { alertToastLevel, alertToastText, getToastApi, publishFallback, type ToastLevel } from "./toast";
import type { AlertEvent } from "./types";

export interface AlertDispatchState {
  readonly snoozeUntil: string | null;
  readonly desktop: boolean;
}

export interface AlertDispatchOptions {
  /** Read fresh settings at delivery time. */
  readonly state: () => AlertDispatchState;
  readonly dedupe?: Dedupe;
  readonly now?: () => number;
  /** Test seams; production uses the real toast manager / Web Notification helpers. */
  readonly canShowDesktop?: (desktopEnabled: boolean) => boolean;
  readonly showToast?: (event: AlertEvent, level: ToastLevel, text: string) => void;
  readonly showDesktop?: (event: AlertEvent) => void;
}

export interface AlertDispatcher {
  handle(event: AlertEvent): void;
  readonly seen: Dedupe;
}

async function deliverToast(event: AlertEvent, level: ToastLevel, text: string): Promise<void> {
  const api = await getToastApi();
  if (!api) {
    publishFallback({ id: event.id, level, text });
    return;
  }
  // The optional toast manager might be an older build without every method.
  if (level === "error" && typeof api.error === "function") api.error(text);
  else if (level === "warning" && typeof api.warning === "function") api.warning(text);
  else if (typeof api.info === "function") api.info(text);
  else publishFallback({ id: event.id, level, text });
}

export function createAlertDispatcher(options: AlertDispatchOptions): AlertDispatcher {
  const dedupe = options.dedupe ?? createDedupe();
  const now = options.now ?? (() => Date.now());
  const showToast = options.showToast ?? ((event, level, text) => void deliverToast(event, level, text));
  const desktopAllowed = options.canShowDesktop ?? canShowDesktop;
  const showDesktop = options.showDesktop ?? showDesktopNotification;

  return {
    seen: dedupe,
    handle(event: AlertEvent): void {
      const state = options.state();
      // Snoozed alerts are dropped entirely: they must not reappear when the snooze ends.
      if (isSnoozed(state.snoozeUntil, now())) return;
      if (!dedupe.isNew(event.id)) return;

      showToast(event, alertToastLevel(event), alertToastText(event));
      if (desktopAllowed(state.desktop)) showDesktop(event);
    },
  };
}
