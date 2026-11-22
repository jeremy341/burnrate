// burnrate: T3's plain provider headings, with a quiet disclosure so a long list can be collapsed.
// A collapsed heading keeps a one-line summary; no preview card, no info button, no status chips.
import {
  ChevronDownIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  ClockIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useId,
  useSyncExternalStore,
} from "react";

import { useGT } from "~/i18n";
import { cn } from "~/lib/utils";
import { useSettings } from "~/settings/store";
import { barValueText, limitFreshness, type LimitFreshness } from "~/shared/usageLimitsCopy";
import type { LimitPool } from "~/shared/usageLimits";
import { barValue, displayLimitWindows, isLimitSnapshotStale } from "~/shared/usageLimits";
import { normalizeProviderAccentColor } from "~/t3-shims/normalizeProviderAccentColor";
import { ProviderInstanceIcon } from "~/t3-shims/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { AccountName } from "./UsageLimitsPooled";
import { barColor } from "./UsageLimits";
import {
  collapsedProvidersStore,
  withProviderCollapsed,
  withProvidersCollapsed,
} from "./usagePagePreferences";

const NO_PROVIDERS: ReadonlySet<string> = new Set();

/** Window event the command palette dispatches (`detail: { collapsed: boolean }`). */
export const COLLAPSE_ALL_PROVIDERS_EVENT = "burnrate:collapse-all-providers";

export function useCollapsedProviders() {
  const collapsed = useSyncExternalStore(
    collapsedProvidersStore.subscribe,
    collapsedProvidersStore.get,
    () => NO_PROVIDERS,
  );
  const setCollapsed = useCallback(
    (id: string, isCollapsed: boolean) =>
      collapsedProvidersStore.set(withProviderCollapsed(collapsedProvidersStore.get(), id, isCollapsed)),
    [],
  );
  const setAll = useCallback(
    (ids: readonly string[], isCollapsed: boolean) =>
      collapsedProvidersStore.set(withProvidersCollapsed(collapsedProvidersStore.get(), ids, isCollapsed)),
    [],
  );
  return { collapsed, setCollapsed, setAll };
}

function MiniBar({
  color,
  shown,
  label,
  valueText,
  freshness,
}: {
  readonly color: string;
  readonly shown: number;
  readonly label: string;
  readonly valueText: string;
  readonly freshness: LimitFreshness | null;
}) {
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={shown}
      aria-valuetext={freshness ? `${valueText}, ${freshness.description}` : valueText}
      data-stale-member={freshness ? true : undefined}
      className={cn(
        "br-usage-meter relative block h-1.5 min-w-0 overflow-hidden rounded-full bg-muted",
        freshness && "border border-dashed border-warning-foreground",
      )}
    >
      <span
        className="br-usage-meter__fill absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${shown}%`, backgroundColor: color }}
      />
    </span>
  );
}

/** The collapsed heading keeps only each window's label and value, plus the honest stale cue. */
function SummaryRow({
  pool,
  now,
  barMode,
}: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly barMode: "remaining" | "used";
}) {
  const gt = useGT();
  const refreshIntervalSec = useSettings((settings) => settings.usage.refreshIntervalSec);
  const windows = displayLimitWindows(pool).slice(0, 3);
  const stale = pool.accounts.some((account) =>
    isLimitSnapshotStale(account.limits, now, refreshIntervalSec),
  );
  return (
    <span
      aria-hidden
      className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs font-normal"
      data-slot="limits-summary"
    >
      {windows.map((window) => (
        <span key={`${window.kind}:${window.id}`} className="inline-flex items-center gap-1 tabular-nums">
          <span className="text-muted-foreground">{window.label}</span>
          <span className="font-medium text-foreground tabular-nums">
            {barValueText(barMode === "used" ? window.usedPercent : window.remainingPercent, barMode, gt)}
          </span>
        </span>
      ))}
      {stale ? (
        <span className="inline-flex items-center gap-1 text-warning-foreground">
          <ClockIcon className="size-3" aria-hidden />
          {gt("Includes old data")}
        </span>
      ) : null}
    </span>
  );
}

/** The whole provider in compact form: one mini bar per account, with its recorded age. */
export function ProviderDetail({
  pool,
  label,
  now,
}: {
  readonly pool: LimitPool;
  readonly label: string;
  readonly now: number;
}) {
  const gt = useGT();
  const barMode = useSettings((settings) => settings.usage.barMode);
  const refreshIntervalSec = useSettings((settings) => settings.usage.refreshIntervalSec);
  const color = barColor(pool.driver);
  const windows = displayLimitWindows(pool);
  const containsOldData = pool.accounts.some((account) =>
    isLimitSnapshotStale(account.limits, now, refreshIntervalSec),
  );
  return (
    <div
      className="flex w-[min(24rem,calc(100vw-3rem))] min-w-0 flex-col gap-3 p-3 text-xs"
      data-slot="limits-detail"
    >
      <span className="min-w-0 truncate text-sm font-medium text-foreground">{label}</span>
      {containsOldData ? (
        <span className="inline-flex items-center gap-1 text-warning-foreground">
          <ClockIcon className="size-3 shrink-0" aria-hidden />
          {gt("Includes old data")}
        </span>
      ) : null}
      {windows.map((window) => {
        const multiple = window.columns.length > 1;
        const shown = barMode === "used" ? window.usedPercent : window.remainingPercent;
        return (
          <div key={`${window.kind}:${window.id}`} className="flex flex-col gap-1.5" data-slot="limits-detail-window">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className="font-medium text-foreground">{window.label}</span>
              <span className="font-semibold text-foreground tabular-nums">
                {barValueText(shown, barMode, gt)}
              </span>
            </div>
            {window.columns.map((member) => {
              if (!member.window) return null;
              const value = barValue(member.window, barMode);
              const freshness = limitFreshness(member.account.limits, now, refreshIntervalSec, gt);
              const memberColor = normalizeProviderAccentColor(member.account.accentColor) ?? color;
              return (
                <div
                  key={member.account.key}
                  className={cn(
                    "grid items-center gap-x-2",
                    multiple
                      ? "grid-cols-[minmax(0,6.5rem)_minmax(2rem,1fr)_auto]"
                      : "grid-cols-[minmax(2rem,1fr)_auto]",
                  )}
                >
                  {multiple ? (
                    <AccountName
                      account={member.account}
                      className="min-w-0 truncate text-muted-foreground"
                    />
                  ) : null}
                  <MiniBar
                    color={memberColor}
                    shown={value}
                    label={member.account.displayName ?? window.label}
                    valueText={barValueText(value, barMode, gt)}
                    freshness={freshness}
                  />
                  <span className="text-end whitespace-nowrap text-muted-foreground tabular-nums">
                    {multiple ? <span className="font-medium text-foreground">{value}%</span> : null}
                  </span>
                  {freshness ? (
                    <span
                      className="col-span-full inline-flex items-center gap-1 text-warning-foreground tabular-nums"
                    >
                      <ClockIcon className="size-3 shrink-0" aria-hidden />
                      {freshness.short}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The provider heading. Not a link and not a tab: a button that reveals the cards below.
 */
export function ProviderSection({
  pool,
  label,
  collapsed,
  onCollapsedChange,
  now,
  headerAction,
  children,
}: {
  readonly pool: LimitPool;
  readonly label: string;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly now: number;
  /** Sits at the end of the heading row (the page puts "Collapse all" here on the first provider). */
  readonly headerAction?: ReactNode;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  const barMode = useSettings((settings) => settings.usage.barMode);
  const describedBy = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const key =
      event.key === "ArrowLeft"
        ? rtl ? "open" : "close"
        : event.key === "ArrowRight"
          ? rtl ? "close" : "open"
          : null;
    if (key === null) return;
    event.preventDefault();
    if ((key === "close") !== collapsed) onCollapsedChange(key === "close");
  };
  return (
    <section
      className="flex flex-col"
      data-slot="limits-provider"
      data-provider={pool.driver}
      data-collapsed={collapsed || undefined}
    >
      <Collapsible open={!collapsed} onOpenChange={(open) => onCollapsedChange(!open)}>
        <div className="group/heading flex items-start gap-1">
          <h2 className="min-w-0 flex-1 text-sm font-medium text-foreground">
            <CollapsibleTrigger
              render={
                <Button
                  variant="ghost"
                  size="multiline"
                  aria-describedby={collapsed ? describedBy : undefined}
                  onKeyDown={onKeyDown}
                />
              }
              className="-ms-2.75 w-[calc(100%+0.6875rem)] flex-wrap justify-start gap-x-3 gap-y-1 text-start text-sm"
            >
              <span className="inline-flex shrink-0 items-center gap-2">
                <ProviderInstanceIcon
                  driverKind={pool.driver}
                  displayName={label}
                  indicatorBackground="var(--background)"
                  className="size-5"
                  iconClassName="size-4 text-foreground/80"
                />
                {label}
                <ChevronDownIcon
                  aria-hidden
                  data-slot="limits-chevron"
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-[transform,opacity] duration-150 motion-reduce:transition-none",
                    collapsed
                      ? "-rotate-90"
                      : "opacity-0 group-focus-within/heading:opacity-100 group-hover/heading:opacity-100 pointer-coarse:opacity-100 max-sm:opacity-100",
                  )}
                />
              </span>
              {collapsed ? <SummaryRow pool={pool} now={now} barMode={barMode} /> : null}
              {collapsed ? (
                <span id={describedBy} className="sr-only">
                  {gt("Collapsed {provider} limits", { provider: label })}
                </span>
              ) : null}
            </CollapsibleTrigger>
          </h2>
          {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
        </div>
        <CollapsiblePanel>
          <div className="flex flex-col gap-3 pt-3">{children}</div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

/** "Collapse all" / "Expand all", one button that names what a press will do. */
export function CollapseAllButton({
  ids,
  collapsed,
  onSetAll,
}: {
  readonly ids: readonly string[];
  readonly collapsed: ReadonlySet<string>;
  readonly onSetAll: (ids: readonly string[], collapsed: boolean) => void;
}) {
  const gt = useGT();
  const allCollapsed = ids.length > 0 && ids.every((id) => collapsed.has(id));
  const Icon = allCollapsed ? ChevronsUpDownIcon : ChevronsDownUpIcon;
  return (
    <Button variant="ghost-muted" size="xs" onClick={() => onSetAll(ids, !allCollapsed)}>
      <Icon aria-hidden />
      {allCollapsed ? gt("Expand all") : gt("Collapse all")}
    </Button>
  );
}
