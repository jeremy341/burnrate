/**
 * Web Notification helpers. Permission is *only* requested from `requestDesktopPermission()`,
 * which settings calls from a user gesture; this module never prompts on its own.
 */
import type { AlertEvent } from "./types";

function ctor(): typeof Notification | null {
  return typeof Notification !== "undefined" ? Notification : null;
}

export function isNotificationSupported(): boolean {
  return ctor() !== null;
}

export function getNotificationPermission(): NotificationPermission | null {
  const N = ctor();
  return N ? N.permission : null;
}

/** Call from a click handler in the notifications settings section. */
export async function requestDesktopPermission(): Promise<NotificationPermission | null> {
  const N = ctor();
  if (!N) return null;
  if (N.permission !== "default") return N.permission;
  try {
    return await N.requestPermission();
  } catch {
    return N.permission;
  }
}

export function canShowDesktop(desktopEnabled: boolean): boolean {
  return desktopEnabled && getNotificationPermission() === "granted";
}

const autoCloseTimers = new Set<ReturnType<typeof setTimeout>>();

/** Auto-close a shown notification without leaking timers (also used by tests to clean up). */
export function clearDesktopNotifications(): void {
  for (const t of autoCloseTimers) clearTimeout(t);
  autoCloseTimers.clear();
}

export function showDesktopNotification(event: AlertEvent): Notification | null {
  const N = ctor();
  if (!N || N.permission !== "granted") return null;
  try {
    const notification = new N(event.title, {
      body: event.body,
      tag: event.id,
      data: { alertId: event.id, accountId: event.accountId },
    });
    const timer = setTimeout(() => {
      autoCloseTimers.delete(timer);
      try {
        notification.close();
      } catch {
        /* already dismissed */
      }
    }, 8000);
    autoCloseTimers.add(timer);
    return notification;
  } catch {
    return null;
  }
}
