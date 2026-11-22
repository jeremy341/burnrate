/**
 * Alert overlay: listens to `/api/stream` `alert` events while notifications are enabled and the
 * page is visible, then dispatches an in-app toast and (opt-in) a Web Notification. The desktop
 * shell owns native toasts; this overlay only handles the browser.
 */
import { useEffect, useRef, useState } from "react";

import { createAlertDispatcher } from "~/alerts/dispatch";
import { createAlertStream } from "~/alerts/stream";
import { subscribeFallback, type ToastMessage } from "~/alerts/toast";
import { m } from "~/i18n";
import { cn } from "~/lib/utils";
import { useSettings } from "~/settings/store";

function useHidden(): boolean {
  const [hidden, setHidden] = useState(() => (typeof document === "undefined" ? false : document.hidden));
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = (): void => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
}

// Same semantic accents as T3's toast icons; the card itself is themed, not hard-coded per level.
const LEVEL_CLASS: Record<ToastMessage["level"], string> = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

export function Overlay() {
  const notifications = useSettings((s) => s.notifications);
  const enabled = notifications.enabled;
  const hidden = useHidden();
  const [fallbackToasts, setFallbackToasts] = useState<readonly ToastMessage[]>([]);
  const settingsRef = useRef(notifications);
  settingsRef.current = notifications;

  // The fallback queue is used only when the toast-system package is not present.
  useEffect(() => subscribeFallback(setFallbackToasts), []);

  useEffect(() => {
    // Read snooze/desktop flags fresh on every event so settings changes need no stream restart.
    const dispatcher = createAlertDispatcher({
      state: () => ({
        snoozeUntil: settingsRef.current.snoozeUntil,
        desktop: settingsRef.current.desktop,
      }),
    });
    const stream = createAlertStream({
      getState: () => ({ enabled, hidden }),
      onEvent: (event) => dispatcher.handle(event),
    });
    stream.update();
    return () => stream.dispose();
  }, [enabled, hidden]);

  if (!fallbackToasts.length) return null;

  return (
    <div
      className={cn(
        "burnrate-alert-fallback pointer-events-none fixed top-[calc(var(--toast-inset)+var(--workspace-topbar-height))] right-(--toast-inset) z-100",
        "flex w-[calc(100%-var(--toast-inset)*2)] max-w-90 flex-col gap-2 [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)]",
      )}
      aria-live="polite"
      aria-relevant="additions"
      aria-label={m("Alerts")}
    >
      {fallbackToasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={cn(
            "dropdown-glass pointer-events-auto flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-popover-foreground shadow-xl shadow-black/25",
            LEVEL_CLASS[toast.level],
          )}
        >
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-current" />
          <span className="min-w-0 wrap-break-word">{toast.text}</span>
        </div>
      ))}
    </div>
  );
}
