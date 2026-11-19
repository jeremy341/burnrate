import { GaugeIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "~/i18n";
import { Fragment, useLayoutEffect, useState } from "react";

import type { LimitsAccount, UsageWindow as ServerProviderUsageWindow } from "~/contracts";
import { usePrimarySettings } from "~/hooks/useSettings";
import { observeResize } from "~/lib/observeResize";
import { providerColor } from "~/providers/registry";
import { formatUpcomingTimestamp } from "~/timestampFormat";
import {
  type LimitPace,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
} from "~/shared/usageLimits";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import { formatResetsIn } from "~/shared/usageLimitsCopy";

const PACE: Record<LimitPace, { readonly label: string; readonly icon: typeof GaugeIcon }> = {
  ahead: {
    label: msg("Ahead of pace: spending faster than the window elapses"),
    icon: TrendingUpIcon,
  },
  on: { label: msg("On pace with the window"), icon: GaugeIcon },
  under: {
    label: msg("Under pace: headroom left for the rest of the window"),
    icon: TrendingDownIcon,
  },
};

export const barColor = providerColor;

export function PaceIcon({ pace }: { readonly pace: LimitPace }) {
  const Icon = PACE[pace].icon;
  const m = useMessages();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={m(PACE[pace].label)}
            className="inline-flex text-muted-foreground"
          />
        }
      >
        <Icon className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="top">{m(PACE[pace].label)}</TooltipPopup>
    </Tooltip>
  );
}

// The tick sits in a transparent gap cut from the bar, clamped so it stays inside at 0% and 100%.
// The gap is a clip-path slot rather than a mask: a mask composites its layer and re-antialiases
// the bar's rounded ends, and the polygon reaches 1px past the box so only the slot edges clip.
function paceMarkStyles(timeLeft: number | null) {
  if (timeLeft === null) return null;
  const at = `clamp(3px, ${timeLeft}%, calc(100% - 3px))`;
  const [left, right] = [`calc(${at} - 3px)`, `calc(${at} + 3px)`];
  const [near, far] = ["-1px", "calc(100% + 1px)"];
  return {
    tick: { left: at },
    gap: {
      clipPath: `polygon(${near} ${near}, ${left} ${near}, ${left} ${far}, ${right} ${far}, ${right} ${near}, ${far} ${near}, ${far} ${far}, ${near} ${far})`,
    },
    // For a track painted on an element that also draws focus rings, which a clip would cut.
    gappedTrack: {
      backgroundColor: "transparent",
      backgroundImage: `linear-gradient(to right, var(--color-muted) ${left}, transparent ${left}, transparent ${right}, var(--color-muted) ${right})`,
    },
  };
}

/**
 * Pace mark styles for the bar given the returned ref. Below 6px there is no room for the gap
 * and tick, so the bar draws neither, as the mobile bars do.
 */
export function usePaceMark(timeLeft: number | null) {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const [roomy, setRoomy] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the bar DOM width before paint and remeasures through a ResizeObserver
  useLayoutEffect(() => {
    if (!bar) return;
    const measure = () => setRoomy(bar.getBoundingClientRect().width >= 6);
    measure();
    return observeResize(bar, measure);
  }, [bar]);
  return [setBar, roomy ? paceMarkStyles(timeLeft) : null] as const;
}

function WindowBar({
  color,
  window,
  now,
}: {
  readonly color: string;
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const gt = useGT();
  const m = useMessages();
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const [barRef, paceMark] = usePaceMark(timeLeft);
  const resetsIn = formatResetsIn(window, now, m);
  const resetsAt = window.resetsAt
    ? formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m)
    : null;
  const label = window.label;
  const summary =
    timeLeft === null
      ? resetsIn
        ? gt("{label}: {remaining}% left, {resetsIn}", { label, remaining, resetsIn })
        : gt("{label}: {remaining}% left", { label, remaining })
      : resetsIn
        ? gt("{label}: {remaining}% left, {timeLeft}% of the window left, {resetsIn}", {
            label,
            remaining,
            timeLeft,
            resetsIn,
          })
        : gt("{label}: {remaining}% left, {timeLeft}% of the window left", {
            label,
            remaining,
            timeLeft,
          });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            ref={barRef}
            role="img"
            aria-label={summary}
            tabIndex={0}
            className="relative h-6 cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
        }
      >
        {/* Clip both layers so the gap exposes even a translucent composer surface. */}
        <div className="absolute inset-0" style={paceMark?.gap}>
          <div className="absolute inset-x-0 inset-y-1.5 rounded-full bg-muted" />
          {remaining > 0 ? (
            <div
              className="absolute inset-y-1.5 left-0 rounded-full"
              style={{ width: `${remaining}%`, backgroundColor: color }}
            />
          ) : null}
        </div>
        {paceMark ? (
          <span
            aria-hidden
            className="absolute inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
            style={paceMark.tick}
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {timeLeft !== null
              ? gt("{remaining}% left · {timeLeft}% of the window left", { remaining, timeLeft })
              : gt("{remaining}% left", { remaining })}
          </span>
          {timeLeft !== null ? (
            <span className="text-muted-foreground">
              <T>The line is where even spending would be.</T>
            </span>
          ) : null}
          {resetsAt ? (
            <span className="text-muted-foreground">
              {resetsIn
                ? gt("Resets {resetsAt} · {resetsIn}", { resetsAt, resetsIn })
                : gt("Resets {resetsAt}", { resetsAt })}
            </span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

export function LimitWindows({
  driver,
  accentColor,
  windows,
  now,
  compact = false,
}: {
  readonly driver: string;
  readonly accentColor?: string | undefined;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly now: number;
  readonly compact?: boolean;
}) {
  const color = accentColor ?? barColor(driver);
  const gt = useGT();
  const m = useMessages();
  return (
    <div
      className={
        compact
          ? "grid grid-cols-[minmax(0,9rem)_minmax(3rem,1fr)_auto] gap-x-3 gap-y-0.5"
          : "grid grid-cols-[11rem_minmax(0,1fr)_7rem] gap-x-4 gap-y-1"
      }
    >
      {windows.map((window) => {
        const pace = paceOf(window, now);
        const resetsIn = formatResetsIn(window, now, m);
        return (
          <Fragment key={window.id}>
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <span className="truncate text-muted-foreground">{window.label}</span>
              <span className="ms-auto shrink-0 font-medium text-foreground tabular-nums">
                {gt("{remaining}% left", { remaining: remainingPercent(window) })}
              </span>
            </span>
            <WindowBar color={color} window={window} now={now} />
            <span className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {pace ? <PaceIcon pace={pace} /> : null}
              <span className="ms-auto shrink-0">{resetsIn ?? ""}</span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}


/** Advance `now` only on explicit refresh to avoid page repaints from ticking. */
export function UsageLimitsSection({
  accounts,
  notices,
  hiddenProviders,
  now,
  hostLabel,
}: {
  readonly accounts: readonly LimitsAccount[];
  readonly notices: readonly string[];
  readonly hiddenProviders: ReadonlySet<string>;
  readonly now: number;
  readonly hostLabel?: string | undefined;
}) {
  const visible = accounts.filter((account) => !hiddenProviders.has(account.driver));
  return <UsageLimitsPooled accounts={visible} notices={notices} now={now} {...(hostLabel ? { hostLabel } : {})} />;
}
