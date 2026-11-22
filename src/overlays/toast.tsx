import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { Button } from "~/components/ui/button";
import { msg, useGT } from "~/i18n";
import { toast, useToasts, type ToastItem, type ToastType } from "~/lib/toast";
import { cn } from "~/lib/utils";

// Same glyphs as T3's ui/toast.tsx, without base-ui's toast manager.
const TOAST_ICONS: Record<ToastType, LucideIcon> = {
  error: CircleAlertIcon,
  info: InfoIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
};

const TOAST_ICON_TONES: Record<ToastType, string> = {
  error: "text-destructive",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
};

const TYPE_LABELS: Record<ToastType, string> = {
  error: msg("Error"),
  info: msg("Information"),
  success: msg("Success"),
  warning: msg("Warning"),
};

// T3's toast corner dismiss orb (verbatim class names, no T3 dependency).
const toastCornerDismissClass = "absolute z-20 -top-1.5 -right-1.5";
const toastCornerOrbClass = cn(
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-popover/92 text-muted-foreground shadow-sm outline-none backdrop-blur-sm",
  "transition-[color,background-color,box-shadow] hover:bg-popover hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
);

const SWIPE_DISMISS_PX = 80;
// T3's toast stack: 12px peek and a 10% scale step per card behind the front one.
const STACK_PEEK_PX = 12;
const STACK_SCALE_STEP = 0.1;
// The stack settle transition, in ms. Exiting cards are kept exactly this long.
const STACK_SETTLE_MS = 500;

interface ExitedToast {
  readonly item: ToastItem;
  readonly index: number;
}

/** Toasts that left the store snapshot, keeping the stack index they held when they disappeared. */
export function diffExitedToasts(
  previous: readonly ToastItem[],
  current: readonly ToastItem[],
): readonly ExitedToast[] {
  const currentIds = new Set(current.map((item) => item.id));
  return previous.flatMap((item, index) =>
    currentIds.has(item.id) ? [] : [{ item, index }],
  );
}

function ToastCard({
  item,
  index,
  labelDismiss,
  exiting = false,
}: {
  item: ToastItem;
  index: number;
  labelDismiss: string;
  readonly exiting?: boolean;
}) {
  const [swipeX, setSwipeX] = useState(0);
  const drag = useRef<{ pointerId: number; startX: number } | null>(null);
  const Icon = TOAST_ICONS[item.type];

  const onPointerDown = (event: ReactPointerEvent<HTMLLIElement>) => {
    // Let buttons handle their own clicks.
    if ((event.target as Element).closest("button")) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLLIElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setSwipeX(event.clientX - current.startX);
  };

  const endSwipe = (event: ReactPointerEvent<HTMLLIElement>, commit: boolean) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit && Math.abs(swipeX) >= SWIPE_DISMISS_PX) toast.dismiss(item.id);
    else setSwipeX(0);
  };

  const style: CSSProperties = {
    zIndex: 100 - index,
    transformOrigin: "top center",
    transform: `translate3d(${swipeX}px, ${index * STACK_PEEK_PX}px, 0) scale(${Math.max(0, 1 - index * STACK_SCALE_STEP)})`,
  };

  return (
    <li
      data-slot="toast"
      data-type={item.type}
      inert={exiting || undefined}
      className={cn(
        "dropdown-glass pointer-events-auto absolute inset-x-0 top-0 rounded-lg text-popover-foreground shadow-xl shadow-black/25 select-none",
        "transition-transform duration-500 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none",
        // A dragged card tracks the pointer 1:1; only the settle after release animates.
        swipeX !== 0 && "transition-none",
        exiting && "pointer-events-none",
      )}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endSwipe(event, true)}
      onPointerCancel={(event) => endSwipe(event, false)}
    >
      <div
        className={cn(
          "transition-[transform,opacity] duration-500 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none",
          !exiting && "starting:opacity-0",
          !exiting && "starting:translate-x-[calc(100%_+_var(--toast-inset))]",
          // The exit target matches the enter origin: off past the viewport inset.
          exiting && "translate-x-[calc(100%_+_var(--toast-inset))] opacity-0",
        )}
      >
      <div className={toastCornerDismissClass}>
        <button
          type="button"
          aria-label={labelDismiss}
          data-slot="toast-close"
          className={toastCornerOrbClass}
          onClick={() => toast.dismiss(item.id)}
        >
          <XIcon className="size-3" strokeWidth={2.25} aria-hidden />
        </button>
      </div>
      <div
        className="min-h-0 overflow-y-visible py-3 pr-6 pl-3.5 text-sm [overflow-x:clip]"
        data-slot="toast-content"
      >
        <div className="flex min-w-0 items-center justify-between gap-1.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 gap-2">
              <span
                className={cn("flex h-4 w-4 shrink-0 items-center justify-center", TOAST_ICON_TONES[item.type])}
                data-slot="toast-icon"
              >
                <span className="sr-only">{TYPE_LABELS[item.type]}</span>
                <Icon aria-hidden className="size-4 shrink-0" strokeWidth={2} />
              </span>
              {item.title ? (
                <span className="min-w-0 wrap-break-word font-medium" data-slot="toast-title">
                  {item.title}
                </span>
              ) : null}
            </div>
            <span
              className={cn(
                "min-w-0 select-text wrap-break-word text-muted-foreground",
                !item.title && "font-medium text-foreground",
              )}
              data-slot="toast-description"
            >
              {item.message}
            </span>
          </div>
          {item.action ? (
            <Button
              size="xs"
              data-slot="toast-action"
              className="shrink-0"
              onClick={() => {
                try {
                  item.action?.onClick();
                } finally {
                  toast.dismiss(item.id);
                }
              }}
            >
              {item.action.label}
            </Button>
          ) : null}
        </div>
      </div>
      </div>
    </li>
  );
}

/** Mounted once by AppProviders through the overlay registry. */
export function Overlay() {
  const items = useToasts();
  const gt = useGT();
  const labelNotifications = gt("Notifications");
  const labelDismiss = gt("Dismiss notification");
  // Dismissed cards stay mounted until their exit transition finishes; the store has already dropped them.
  const [exiting, setExiting] = useState<readonly ExitedToast[]>([]);
  const itemsRef = useRef(items);
  const exitTimers = useRef<Set<number>>(new Set());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dismissed cards stay mounted until their exit transition finishes, then drop out of the list
  useEffect(() => {
    const removed = diffExitedToasts(itemsRef.current, items);
    itemsRef.current = items;
    if (removed.length === 0) return;
    setExiting((current) => [...current, ...removed]);
    const timerId = window.setTimeout(() => {
      exitTimers.current.delete(timerId);
      const removedIds = new Set(removed.map((entry) => entry.item.id));
      setExiting((current) => current.filter((entry) => !removedIds.has(entry.item.id)));
    }, STACK_SETTLE_MS);
    exitTimers.current.add(timerId);
  }, [items]);

  useEffect(
    () => () => {
      for (const timerId of exitTimers.current) window.clearTimeout(timerId);
      exitTimers.current.clear();
    },
    [],
  );

  // Esc dismisses the frontmost toast; the listener exists only while toasts are visible.
  useEffect(() => {
    if (items.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const frontmost = items[items.length - 1];
      if (!frontmost) return;
      event.preventDefault();
      toast.dismiss(frontmost.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items]);

  if (items.length === 0 && exiting.length === 0) return null;

  return (
    <div
      aria-label={labelNotifications}
      aria-live="polite"
      aria-relevant="additions text"
      className={cn(
        "pointer-events-none fixed z-100 mx-auto w-[calc(100%-var(--toast-inset)*2)] max-w-90",
        "[--toast-inset:--spacing(4)] [--toast-header-offset:var(--workspace-topbar-height)] sm:[--toast-inset:--spacing(8)]",
        "top-[calc(var(--toast-inset)+var(--toast-header-offset))] right-(--toast-inset)",
      )}
      data-position="top-right"
      data-slot="toast-viewport"
      role="region"
    >
      <ol className="relative m-0 list-none p-0">
        {items
          .map((item, index) => (
            <ToastCard item={item} index={index} key={item.id} labelDismiss={labelDismiss} />
          ))
          .concat(
            // One flat list, so a card that starts exiting keeps its DOM node and its exit transition plays instead of remounting.
            exiting.map((entry) => (
              <ToastCard
                exiting
                item={entry.item}
                index={entry.index}
                key={entry.item.id}
                labelDismiss={labelDismiss}
              />
            )),
          )}
      </ol>
    </div>
  );
}
