import { ClockIcon, GaugeIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { msg, T, useGT, useMessages, type MFunctionType } from "~/i18n";
import { Fragment, useLayoutEffect, useState } from "react";

import type {
  LimitsAccount,
  UsageWindow as ServerProviderUsageWindow,
} from "~/contracts";
import { usePrimarySettings } from "~/hooks/useSettings";
import { observeResize } from "~/lib/observeResize";
import { providerColor } from "~/providers/registry";
import { useSettings } from "~/settings/store";
import { formatUpcomingTimestamp } from "~/timestampFormat";
import {
  barValue,
  type LimitPace,
  paceOf,
  paceRemainingPercent,
} from "~/shared/usageLimits";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import {
  barValueText,
  formatResetsIn,
  type LimitFreshness,
  provenanceDescription,
} from "~/shared/usageLimitsCopy";
import { normalizeProviderAccentColor } from "~/t3-shims/normalizeProviderAccentColor";

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

/**
 * T3 looks this up in `PROVIDER_PRESENTATION` then `LIMIT_SOURCE_PRESENTATION`. Our
 * server-driven registry carries both (including Mistral's amber), so it is the single adapter.
 */
export const barColor = providerColor;

// burnrate: pace is also expressed as text, so the icon/tick is never the only signal.
export function paceLabel(pace: LimitPace, resolve: MFunctionType = (value) => value): string {
  return resolve(PACE[pace].label);
}

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
            tabIndex={0}
            className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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

// burnrate: stale async data is announced politely rather than silently shown as current.
export function StaleBadge({ freshness }: { readonly freshness: LimitFreshness }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="br-usage-stale inline-flex min-h-6 min-w-0 items-center gap-1.5 rounded-sm bg-muted px-2 py-0.5 text-xs text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <ClockIcon className="size-3 shrink-0" aria-hidden />
        <span className="wrap-anywhere">{freshness.short}</span>
        <span className="sr-only">{freshness.description}</span>
      </TooltipTrigger>
      <TooltipPopup>{freshness.description}</TooltipPopup>
    </Tooltip>
  );
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
  // burnrate: barMode / showPaceTick come from the settings store (package 26 keeps these exports).
  const barMode = useSettings((settings) => settings.usage.barMode);
  const showPaceTick = useSettings((settings) => settings.usage.showPaceTick);
  const gt = useGT();
  const m = useMessages();
  const shown = barValue(window, barMode);
  const pace = paceOf(window, now);
  const timeLeft = paceRemainingPercent(window, now);
  const [barRef, paceMark] = usePaceMark(showPaceTick ? timeLeft : null);
  const resetsIn = formatResetsIn(window, now, m);
  const resetsAt = window.resetsAt
    ? formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m)
    : null;
  const label = window.label;
  const valueText = barValueText(shown, barMode, gt);
  // burnrate: an accessible name (the window) plus a value text (the number and its context).
  const summary = [
    gt("{label}: {valueText}", { label, valueText }),
    timeLeft === null ? null : gt("{timeLeft}% of the window left", { timeLeft }),
    resetsIn,
    // The provenance badge is gone; keep its meaning for screen readers.
    window.provenance ? provenanceDescription(window.provenance, m) : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            ref={barRef}
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={shown}
            aria-valuetext={summary}
            data-pace={pace ?? undefined}
            tabIndex={0}
            className="br-usage-meter relative h-6 cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
        }
      >
        {/* Clip both layers so the gap exposes even a translucent composer surface. */}
        <div className="absolute inset-0" style={paceMark?.gap}>
          <div className="absolute inset-x-0 inset-y-1.5 rounded-full bg-muted" />
          {shown > 0 ? (
            <div
              className="br-usage-meter__fill absolute inset-y-1.5 left-0 rounded-full"
              style={{ width: `${shown}%`, backgroundColor: color }}
            />
          ) : null}
        </div>
        {paceMark ? (
          <span
            aria-hidden
            className="br-usage-meter__tick absolute inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
            style={paceMark.tick}
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {timeLeft !== null
              ? gt("{valueText} · {timeLeft}% of the window left", { valueText, timeLeft })
              : valueText}
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
  const color = normalizeProviderAccentColor(accentColor) ?? barColor(driver);
  const barMode = useSettings((settings) => settings.usage.barMode);
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
                {barValueText(barValue(window, barMode), barMode, gt)}
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
