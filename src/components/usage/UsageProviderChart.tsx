import { ProviderInstanceIcon } from "~/t3-shims/ProviderInstanceIcon";
import type { UsageProviderKind } from "~/contracts";
import { T, useGT, useLocale, useMessages } from "~/t3-shims/gt-react";
import { useId, useLayoutEffect, useRef, useState } from "react";

import type { DailyTotals, HourlyTotals } from "~/shared/usageMerge";
import {
  formatDayShort,
  formatHourShort,
  formatTokens,
  formatUsd,
} from "~/shared/usageFormat";
import { formatRelativeHourShort } from "~/shared/usageFormatCopy";
import { cn } from "~/lib/utils";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";
import { observeResize } from "~/lib/observeResize";
import { MARK_CLASS, markStyle } from "./usageMarkColor";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;
const PLOT_BASE = VIEW_HEIGHT - 5;
const NONE_LOADING: ReadonlySet<UsageProviderKind> = new Set();
const WALL_HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}:00$/;

/**
 * Provider lines are always solid: the user wants every provider drawn the way it was before (a
 * dashed Codex / Antigravity line read as broken). A provider is told apart by its colour, the legend
 * label and the table alternative, never by a dash pattern.
 */
export function providerLinePattern(_provider: UsageProviderKind): string | undefined {
  return undefined;
}

export function formatUsageHour(hour: string, timeZone: string, hour12: boolean, locale: string) {
  // A wall-clock label is already in the report's zone. Use UTC to format it without shifting it.
  return WALL_HOUR.test(hour)
    ? formatHourShort(`${hour}Z`, "UTC", hour12, locale)
    : formatHourShort(hour, timeZone, hour12, locale);
}

function hourlyChartData(
  hours: readonly string[],
  totals: readonly HourlyTotals[],
  timeZone: string,
  referenceTime: string | undefined,
) {
  const byPeriod = new Map(totals.map((entry) => [entry.hourStart, entry]));
  if (!totals.some((entry) => WALL_HOUR.test(entry.hourStart))) return { periods: hours, byPeriod };

  // The Rust report groups by wall hour, including the partial hour at the end of the window.
  // Repeated hours share a single server bucket, so chart it only once.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const wallHours = new Set<string>();
  const candidates = referenceTime && !hours.includes(referenceTime) ? [...hours, referenceTime] : hours;
  const periods = candidates.filter((hour) => {
    const parts = formatter.formatToParts(new Date(hour));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    const wallHour = `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:00`;
    const bucket = byPeriod.get(wallHour);
    if (byPeriod.has(hour)) return true;
    if (wallHours.has(wallHour)) return false;
    wallHours.add(wallHour);
    if (bucket) byPeriod.set(hour, bucket);
    return true;
  });
  return { periods, byPeriod };
}

export type UsageChartMetric = "tokens" | "cost";

/**
 * The column a key moves the chart cursor to, or `undefined` when the key is not a chart key.
 * `null` clears the cursor (Escape). The cursor starts at the newest period.
 */
export function nextChartIndex(
  key: string,
  current: number | null,
  count: number,
): number | null | undefined {
  if (count === 0) return undefined;
  const last = count - 1;
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return current === null ? last : Math.max(0, current - 1);
    case "ArrowRight":
    case "ArrowUp":
      return current === null ? last : Math.min(last, current + 1);
    case "Home":
      return 0;
    case "End":
      return last;
    case "Escape":
      return current === null ? undefined : null;
    default:
      return undefined;
  }
}

/** Index of the highest total, for the text summary. -1 when every period is empty. */
export function peakColumnIndex(columns: readonly { readonly total: number }[]): number {
  let best = -1;
  let peak = 0;
  columns.forEach((column, index) => {
    if (column.total > peak) {
      peak = column.total;
      best = index;
    }
  });
  return best;
}

interface UsageProviderChartProps {
  readonly providers: readonly UsageProviderKind[];
  readonly loadingProviders?: ReadonlySet<UsageProviderKind>;
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly hours: readonly string[];
  readonly hourly: readonly HourlyTotals[];
  readonly metric: UsageChartMetric;
  readonly referenceTime: string | undefined;
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
  readonly hour12: boolean;
}

export interface DayColumn {
  readonly bands: readonly {
    readonly provider: UsageProviderKind;
    readonly value: number;
  }[];
  readonly total: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function valueFor(
  totals: DailyTotals | HourlyTotals | undefined,
  provider: UsageProviderKind,
  metric: UsageChartMetric,
): number {
  const entry = totals?.byProvider.get(provider);
  if (entry === undefined) return 0;
  return metric === "tokens" ? entry.totalTokens : entry.costUsd;
}

export function buildPeriodColumns(
  periods: readonly string[],
  byPeriod: ReadonlyMap<string, DailyTotals | HourlyTotals>,
  metric: UsageChartMetric,
): readonly DayColumn[] {
  return periods.map((period) => {
    const entry = byPeriod.get(period);
    const bands = PROVIDER_ORDER.map((provider) => ({
      provider,
      value: valueFor(entry, provider, metric),
    }));
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
}

function monotoneTangents(points: readonly Point[]): readonly number[] {
  const count = points.length;
  if (count < 2) return [0];

  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const dx = (points[index + 1]?.x ?? 0) - (points[index]?.x ?? 0);
    const dy = (points[index + 1]?.y ?? 0) - (points[index]?.y ?? 0);
    slopes.push(dx === 0 ? 0 : dy / dx);
  }

  const tangents: number[] = Array.from({ length: count }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let index = 1; index < count - 1; index += 1) {
    const previous = slopes[index - 1] ?? 0;
    const next = slopes[index] ?? 0;
    tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }

  for (let index = 0; index < count - 1; index += 1) {
    const slope = slopes[index] ?? 0;
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const a = (tangents[index] ?? 0) / slope;
    const b = (tangents[index + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * a * slope;
      tangents[index + 1] = scale * b * slope;
    }
  }

  return tangents;
}

interface CurveSegment {
  readonly from: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly to: Point;
}

function smoothCurve(points: readonly Point[]): readonly CurveSegment[] {
  if (points.length < 2) return [];
  const tangents = monotoneTangents(points);
  const segments: CurveSegment[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (from === undefined || to === undefined) continue;
    const dx = to.x - from.x;
    segments.push({
      from,
      c1: { x: from.x + dx / 3, y: from.y + ((tangents[index] ?? 0) * dx) / 3 },
      c2: { x: to.x - dx / 3, y: to.y - ((tangents[index + 1] ?? 0) * dx) / 3 },
      to,
    });
  }
  return segments;
}

function curvePath(segments: readonly CurveSegment[]): string {
  const first = segments[0];
  if (first === undefined) return "";
  let path = `M${first.from.x.toFixed(2)},${first.from.y.toFixed(2)}`;
  for (const segment of segments) {
    path += ` C${segment.c1.x.toFixed(2)},${segment.c1.y.toFixed(2)} ${segment.c2.x.toFixed(2)},${segment.c2.y.toFixed(2)} ${segment.to.x.toFixed(2)},${segment.to.y.toFixed(2)}`;
  }
  return path;
}

function areaPath(line: string) {
  return line === "" ? "" : `${line} L${VIEW_WIDTH},${PLOT_BASE} L0,${PLOT_BASE} Z`;
}

function niceScale(peak: number, count: number): { max: number; ticks: readonly number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };

  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;

  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

const PLACEHOLDER_TICKS = Array.from({ length: TICK_COUNT + 1 }, (_, index) => index);

function chartScale(
  columns: readonly DayColumn[],
  loadingProviders: ReadonlySet<UsageProviderKind>,
) {
  // Layered series each start at zero; summing peaks would waste plot height.
  const peak = columns.reduce(
    (max, column) => column.bands.reduce((inner, band) => Math.max(inner, band.value), max),
    0,
  );
  return peak === 0 && loadingProviders.size > 0
    ? { max: TICK_COUNT, ticks: PLACEHOLDER_TICKS, labeled: false }
    : { ...niceScale(peak, TICK_COUNT), labeled: true };
}

function valueToY(value: number, max: number) {
  return max === 0 ? PLOT_BASE : PLOT_BASE - (value / max) * (PLOT_BASE - PLOT_TOP);
}

function buildChart(
  periods: readonly string[],
  byPeriod: ReadonlyMap<string, DailyTotals | HourlyTotals>,
  metric: UsageChartMetric,
  providers: readonly UsageProviderKind[],
  loadingProviders: ReadonlySet<UsageProviderKind>,
) {
  const visibleProviders = new Set(providers);
  const columns = buildPeriodColumns(periods, byPeriod, metric).map((column) => {
    const bands = column.bands.filter((band) => visibleProviders.has(band.provider));
    return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
  const scale = chartScale(columns, loadingProviders);
  const stepX = periods.length < 2 ? 0 : VIEW_WIDTH / (periods.length - 1);
  const paths = providers.map((provider) => {
    const values = columns.map((column) => column.bands.find((band) => band.provider === provider)!.value);
    const points = values.map((value, periodIndex) => ({
      x: periods.length === 1 ? VIEW_WIDTH / 2 : periodIndex * stepX,
      y: valueToY(value, scale.max),
    }));
    const line = curvePath(smoothCurve(points));
    return {
      provider,
      total: values.reduce((sum, value) => sum + value, 0),
      line,
      area: areaPath(line),
      point: points.length === 1 ? points[0] : undefined,
    };
  });

  return { columns, scale, stepX, paths: paths.toSorted((a, b) => b.total - a.total) };
}

function UsageChartTooltip({
  tooltipRef,
  label,
  column,
  providers,
  loadingProviders,
  format,
}: {
  readonly tooltipRef: React.Ref<HTMLDivElement>;
  readonly label: string;
  readonly column: DayColumn | undefined;
  readonly providers: readonly UsageProviderKind[];
  readonly loadingProviders: ReadonlySet<UsageProviderKind>;
  readonly format: (value: number) => string;
}) {
  const partial = providers.some((provider) => loadingProviders.has(provider));
  return (
    <div
      ref={tooltipRef}
      aria-hidden
      className="surface-glass absolute z-10 max-h-full w-max max-w-full overflow-y-auto overscroll-contain rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
      onPointerMove={(event) => event.stopPropagation()}
      style={{
        left: "var(--usage-tooltip-left, 0px)",
        top: "var(--usage-tooltip-top, 0px)",
      }}
    >
      <div className="mb-1 text-muted-foreground">{label}</div>
      {providers.map((provider) => {
        const { label: providerLabel, driverKind } = PROVIDER_PRESENTATION[provider];
        return (
          <div key={provider} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <ProviderInstanceIcon
                driverKind={driverKind}
                displayName={providerLabel}
                iconClassName="size-3"
              />
              <span className="wrap-anywhere">{providerLabel}</span>
            </span>
            <span
              className={cn(
                "shrink-0 tabular-nums",
                loadingProviders.has(provider) ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {format(column?.bands.find((band) => band.provider === provider)?.value ?? 0)}
            </span>
          </div>
        );
      })}
      <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
        <span className="text-muted-foreground">
          <T>Total</T>
        </span>
        <span className={cn("tabular-nums", partial ? "text-muted-foreground" : "text-foreground")}>
          {format(column?.total ?? 0)}
        </span>
      </div>
    </div>
  );
}

function UsageChartPlot({
  periods,
  columns,
  stepX,
  providers,
  loadingProviders,
  format,
  formatTooltipPeriod,
  label,
  describedBy,
  dots,
  children,
}: {
  /** Single readings, drawn as HTML so the stretched plot cannot squash them. */
  readonly dots: readonly {
    readonly provider: UsageProviderKind;
    readonly x: number;
    readonly y: number;
  }[];
  /** Accessible name of the plot (the chart's title). */
  readonly label: string;
  /** Ids of the text summary and keyboard hint. */
  readonly describedBy: string;
  readonly periods: readonly string[];
  readonly columns: readonly DayColumn[];
  readonly stepX: number;
  readonly providers: readonly UsageProviderKind[];
  readonly loadingProviders: ReadonlySet<UsageProviderKind>;
  readonly format: (value: number) => string;
  readonly formatTooltipPeriod: (period: string) => string;
  readonly children: React.ReactNode;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // Keyboard focus drives the same tooltip as the pointer, and is announced (the pointer's is visual only).
  const [keyboardActive, setKeyboardActive] = useState(false);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);

  const positionTooltip = () => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const hoverPosition = hoverPositionRef.current;
    if (plot === null || tooltip === null || hoverPosition === null) return;

    const gap = 12;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const plotWidth = plot.clientWidth;
    const plotHeight = plot.clientHeight;
    const preferredLeft =
      hoverPosition.x + gap + tooltipWidth <= plotWidth
        ? hoverPosition.x + gap
        : hoverPosition.x - gap - tooltipWidth;
    const preferredTop =
      hoverPosition.y + gap + tooltipHeight <= plotHeight
        ? hoverPosition.y + gap
        : hoverPosition.y - gap - tooltipHeight;
    const left = Math.min(Math.max(0, preferredLeft), Math.max(0, plotWidth - tooltipWidth));
    const top = Math.min(Math.max(0, preferredTop), Math.max(0, plotHeight - tooltipHeight));
    plot.style.setProperty("--usage-tooltip-left", `${left}px`);
    plot.style.setProperty("--usage-tooltip-top", `${top}px`);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions the hover tooltip through plot CSS variables before paint and on ResizeObserver
  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    positionTooltip();

    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null) return;

    return observeResize([plot, tooltip], positionTooltip);
  }, [hoverIndex, positionTooltip]);

  const handleMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const plot = plotRef.current;
    if (plot === null || periods.length === 0) return;
    const bounds = plot.getBoundingClientRect();
    if (bounds.width === 0) return;
    const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
    const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
    const fraction = localX / bounds.width;
    const index = Math.round(fraction * (periods.length - 1));
    hoverPositionRef.current = { x: localX, y: localY };
    positionTooltip();
    setKeyboardActive(false);
    setHoverIndex(Math.min(periods.length - 1, Math.max(0, index)));
  };

  const moveCursor = (index: number | null) => {
    const plot = plotRef.current;
    if (index === null || plot === null) {
      hoverPositionRef.current = null;
      setHoverIndex(null);
      return;
    }
    const span = Math.max(1, periods.length - 1);
    hoverPositionRef.current = {
      x: periods.length === 1 ? plot.clientWidth / 2 : (index / span) * plot.clientWidth,
      y: plot.clientHeight / 3,
    };
    positionTooltip();
    setKeyboardActive(true);
    setHoverIndex(index);
  };

  const hoveredPeriod = hoverIndex === null ? undefined : periods[hoverIndex];
  const hoveredColumn = hoverIndex === null ? undefined : columns[hoverIndex];

  return (
    <div
      ref={plotRef}
      role="group"
      tabIndex={0}
      aria-label={label}
      aria-describedby={describedBy}
      className="relative h-56 min-w-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onPointerMove={handleMove}
      onPointerLeave={() => {
        // A finger lifting also leaves: keep the keyboard cursor, drop only the pointer's.
        if (keyboardActive) return;
        hoverPositionRef.current = null;
        setHoverIndex(null);
      }}
      onFocus={(event) => {
        // Pointer clicks focus too; only a keyboard arrival shows the newest period at once.
        if (event.currentTarget.matches(":focus-visible")) moveCursor(periods.length - 1);
      }}
      onBlur={() => {
        setKeyboardActive(false);
        hoverPositionRef.current = null;
        setHoverIndex(null);
      }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (tooltipRef.current && (event.key === "PageUp" || event.key === "PageDown")) {
          event.preventDefault();
          const tooltip = tooltipRef.current;
          tooltip.scrollTop += event.key === "PageUp" ? -tooltip.clientHeight : tooltip.clientHeight;
          return;
        }
        const next = nextChartIndex(event.key, hoverIndex, periods.length);
        if (next === undefined) return;
        event.preventDefault();
        // Escape only clears the tooltip; it must not also close a dialog that holds the chart.
        if (next === null) event.stopPropagation();
        moveCursor(next);
      }}
    >
      <svg
        className="h-full w-full"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        {children}
        {hoverIndex === null ? null : (
          <line
            x1={periods.length === 1 ? VIEW_WIDTH / 2 : hoverIndex * stepX}
            x2={periods.length === 1 ? VIEW_WIDTH / 2 : hoverIndex * stepX}
            y1={PLOT_TOP}
            y2={VIEW_HEIGHT}
            stroke="currentColor"
            strokeWidth={1}
            className="text-muted-foreground"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {dots.map(({ provider, x, y }) => (
        <span
          key={provider}
          aria-hidden
          data-point={provider}
          className={cn(
            "pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full forced-colors:[background-color:CanvasText]!",
            MARK_CLASS,
          )}
          style={{
            ...markStyle(PROVIDER_PRESENTATION[provider].color),
            backgroundColor: "var(--usage-mark)",
            left: `${(x / VIEW_WIDTH) * 100}%`,
            top: `${(y / VIEW_HEIGHT) * 100}%`,
          }}
        />
      ))}

      <p role="status" className="sr-only">
        {keyboardActive && hoveredPeriod !== undefined && hoveredColumn !== undefined ? <>
          {formatTooltipPeriod(hoveredPeriod)}
          {": "}
          {providers
            .map(
              (provider) =>
                `${PROVIDER_PRESENTATION[provider].label} ${format(
                  hoveredColumn.bands.find((band) => band.provider === provider)?.value ?? 0,
                )}`,
            )
            .join(", ")}
          {providers.length > 1 ? `, ${format(hoveredColumn.total)}` : ""}
        </> : null}
      </p>

      {hoverIndex === null || hoveredPeriod === undefined ? null : (
        <UsageChartTooltip
          tooltipRef={tooltipRef}
          label={formatTooltipPeriod(hoveredPeriod)}
          column={columns[hoverIndex]}
          providers={providers}
          loadingProviders={loadingProviders}
          format={format}
        />
      )}
    </div>
  );
}

export function UsageProviderChart({
  providers,
  loadingProviders = NONE_LOADING,
  days,
  daily,
  hours,
  hourly,
  metric,
  referenceTime,
  resolution,
  timeZone,
  hour12,
}: UsageProviderChartProps) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const baseId = useId();
  const { periods, byPeriod } = resolution === "hour"
    ? hourlyChartData(hours, hourly, timeZone, referenceTime)
    : { periods: days, byPeriod: new Map(daily.map((entry) => [entry.day, entry])) };
  const { columns, scale, paths, stepX } = buildChart(
    periods,
    byPeriod,
    metric,
    providers,
    loadingProviders,
  );

  const toY = (value: number) => valueToY(value, scale.max);
  const format = metric === "tokens" ? formatTokens : (value: number) => formatUsd(value, locale);
  const formatPeriod = (period: string) =>
    resolution === "hour"
      ? formatHourShort(period, timeZone, hour12, locale)
      : formatDayShort(period, locale);
  const formatTooltipPeriod = (period: string) =>
    resolution === "hour" && referenceTime !== undefined
      ? formatRelativeHourShort(period, referenceTime, timeZone, hour12, m, locale)
      : formatPeriod(period);
  const chartName =
    resolution === "hour"
      ? metric === "tokens"
        ? gt("Hourly processed tokens by provider")
        : gt("Hourly cost by provider")
      : metric === "tokens"
        ? gt("Daily processed tokens by provider")
        : gt("Daily cost by provider");
  const grandTotal = columns.reduce((sum, column) => sum + column.total, 0);
  const peakIndex = peakColumnIndex(columns);
  const peakPeriod = peakIndex < 0 ? undefined : periods[peakIndex];
  const summaryId = `${baseId}-summary`;
  const hintId = `${baseId}-hint`;
  const legend = [...providers].sort(
    (a, b) => PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b),
  );

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p id={summaryId} className="sr-only">
        {peakPeriod === undefined
          ? gt("{name}: no usage in this period.", { name: chartName })
          : gt("{name}: {total} in total. Highest at {period}: {peak}.", {
              name: chartName,
              total: format(grandTotal),
              period: formatTooltipPeriod(peakPeriod),
              peak: format(columns[peakIndex]?.total ?? 0),
            })}
      </p>
      <p id={hintId} className="sr-only">
        {gt("Use arrow keys to move between periods, Home and End to jump, Page Up and Page Down to scroll details, and Escape to hide them.")}
      </p>
      <div className="flex gap-2">
        <div aria-hidden className="relative h-56 w-14 shrink-0">
          {scale.labeled
            ? scale.ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
                  style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
                >
                  {tick === 0 ? "0" : format(tick)}
                </span>
              ))
            : null}
        </div>

        <UsageChartPlot
          periods={periods}
          columns={columns}
          stepX={stepX}
          providers={providers}
          loadingProviders={loadingProviders}
          format={format}
          formatTooltipPeriod={formatTooltipPeriod}
          label={chartName}
          describedBy={`${summaryId} ${hintId}`}
          dots={paths.flatMap(({ provider, point }) =>
            point ? [{ provider, x: point.x, y: point.y }] : [],
          )}
        >
          {scale.ticks.map((tick) => {
            const y = toY(tick);
            return (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {paths.filter(({ area }) => area !== "").map(({ provider, area }) => (
            <path
              key={provider}
              d={area}
              className={cn(MARK_CLASS, "forced-colors:hidden")}
              style={{ ...markStyle(PROVIDER_PRESENTATION[provider].color), fill: "var(--usage-mark)" }}
              fillOpacity={0.04}
            />
          ))}
          {paths.map(({ provider, line, point }) => point ? null : (
            <path
              key={provider}
              d={line}
              className={cn(MARK_CLASS, "forced-colors:[stroke:CanvasText]!")}
              style={{ ...markStyle(PROVIDER_PRESENTATION[provider].color), stroke: "var(--usage-mark)" }}
              fill="none"
              strokeWidth={2}
              strokeDasharray={providerLinePattern(provider)}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* A single reading is a dot. It is an HTML element, not an SVG circle: the plot stretches
              (preserveAspectRatio="none") and would turn a circle into an ellipse. */}
        </UsageChartPlot>
      </div>

      <div
        aria-hidden
        className="flex justify-between pl-16 text-3xs text-muted-foreground uppercase"
      >
        <span>{periods[0] === undefined ? "" : formatPeriod(periods[0])}</span>
        <span>
          {periods[Math.floor(periods.length / 2)] === undefined
            ? ""
            : formatPeriod(periods[Math.floor(periods.length / 2)] ?? "")}
        </span>
        <span>
          {periods[periods.length - 1] === undefined
            ? ""
            : formatPeriod(periods[periods.length - 1] ?? "")}
        </span>
      </div>

      {legend.length > 1 ? (
        <ul aria-label={gt("Providers")} className="flex flex-wrap gap-x-4 gap-y-1 pl-16 text-xs text-muted-foreground">
          {legend.map((provider) => (
            <li key={provider} className="flex min-w-0 items-center gap-1.5">
              <svg aria-hidden className={cn("h-2 w-7 shrink-0", MARK_CLASS)} viewBox="0 0 28 8" style={markStyle(PROVIDER_PRESENTATION[provider].color)}>
                <line x1={0} x2={28} y1={4} y2={4} strokeWidth={2} strokeDasharray={providerLinePattern(provider)} className="[stroke:var(--usage-mark)] forced-colors:[stroke:CanvasText]" />
              </svg>
              <span className="truncate">
                {PROVIDER_PRESENTATION[provider].label}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* The plot and its axes are hover-only; this carries the same figures for screen readers.
          sr-only sits on a wrapper: Firefox does not clip a table's caption by the table's own box. */}
      <div className="sr-only">
        <table>
          <caption>{chartName}</caption>
          <thead>
            <tr>
              <th scope="col">{resolution === "hour" ? gt("Hour") : gt("Day")}</th>
              {providers.map((provider) => (
                <th key={provider} scope="col">
                  {PROVIDER_PRESENTATION[provider].label}
                </th>
              ))}
              {providers.length > 1 ? (
                <th scope="col">
                  <T>Total</T>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {periods.map((period, index) => {
              const column = columns[index];
              return (
                <tr key={period}>
                  <th scope="row">{formatTooltipPeriod(period)}</th>
                  {providers.map((provider) => (
                    <td key={provider}>
                      {format(column?.bands.find((band) => band.provider === provider)?.value ?? 0)}
                    </td>
                  ))}
                  {providers.length > 1 ? <td>{format(column?.total ?? 0)}</td> : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
