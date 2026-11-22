import {
  barValue,
  collectLimitPools,
  displayLimitWindows,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
  isLimitSnapshotStale,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
  toLimitAccounts,
} from "~/shared/usageLimits";
import { T, useGT, useMessages } from "~/i18n";
import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { AlertTriangleIcon, ClockIcon, ExternalLinkIcon, TicketIcon } from "lucide-react";
import {
  createContext,
  Fragment,
  type ReactNode,
  type RefObject,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { LimitsAccount } from "~/contracts";
import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useSettings } from "~/settings/store";
import { formatUpcomingTimestamp } from "~/timestampFormat";
import { ProviderInstanceIcon } from "~/t3-shims/ProviderInstanceIcon";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Alert, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { usageDriverLabel } from "./usageProviders";
import {
  COLLAPSE_ALL_PROVIDERS_EVENT,
  CollapseAllButton,
  ProviderSection,
  useCollapsedProviders,
} from "./UsageLimitsCollapse";
import { LimitsEmptyState } from "./UsageLimitsStates";
import { useLimitsClockNow } from "./LimitsClock";
import { accountLimitNotices, resetCreditLines } from "./usageLimitsAccountNotes";
import {
  PaceIcon,
  StaleBadge,
  barColor,
  paceLabel,
  usePaceMark,
} from "./UsageLimits";
import {
  barValueText,
  cursorUsageWindowDetails,
  formatResetsIn,
  limitFreshness,
  type LimitFreshness,
  provenanceDescription,
} from "~/shared/usageLimitsCopy";
import { normalizeProviderAccentColor } from "~/t3-shims/normalizeProviderAccentColor";
import { providerClients } from "~/t3-shims/providerClients";


function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

function accountHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

function AccountChip({ email }: { readonly email: string }) {
  const hue = accountHue(email);
  const gt = useGT();
  return (
    <span
      role="img"
      aria-label={gt("Account {initials}", { initials: accountInitials(email) })}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-3xs leading-none font-semibold"
      style={{ backgroundColor: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.1 ${hue})` }}
    >
      {accountInitials(email)}
    </span>
  );
}

function AccountAvatar({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (!account.email) {
    return (
      <ProviderInstanceIcon
        driverKind={account.driver}
        displayName={
          account.displayName ??
          usageDriverLabel(account.driver, providerClients.get(account.driver)?.label) ??
          String(account.driver)
        }
        accentColor={account.accentColor}
        className={cn("size-5", className)}
        iconClassName="size-4"
      />
    );
  }
  return <AccountChip email={account.email} />;
}

export function AccountName({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.displayName) return <span className={className}>{account.displayName}</span>;
  if (account.email) {
    return (
      <span className={cn("inline-flex min-w-0 items-center", className)}>
        <AccountChip email={account.email} />
      </span>
    );
  }
  return (
    <span className={className}>
      {usageDriverLabel(account.driver, providerClients.get(account.driver)?.label)}
    </span>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

/** The window as its usable quota comes back: its own reset, or the weekly reset while the week caps it. */
function restoreClock(window: LimitPoolMember["window"], restoresAt: string | undefined) {
  return { ...window, resetsAt: restoresAt };
}

function ResetTime({ window, fallbackNow }: { readonly window: LimitPoolMember["window"]; readonly fallbackNow: number }) {
  const now = useLimitsClockNow(fallbackNow);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const m = useMessages();
  const resetsIn = formatResetsIn(window, now, m, "in");
  if (!window.resetsAt) return null;
  return <>{formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m)}{resetsIn ? ` · ${resetsIn}` : ""}</>;
}

function RefillBadge({ window, restoresAt, credits, fallbackNow, compact = false }: {
  readonly window: LimitPoolMember["window"];
  readonly restoresAt: string | undefined;
  readonly credits: number;
  readonly fallbackNow: number;
  readonly compact?: boolean;
}) {
  const now = useLimitsClockNow(fallbackNow);
  const m = useMessages();
  const gt = useGT();
  const resetsIn = formatResetsIn(restoreClock(window, restoresAt), now, m, "refill");
  if (!resetsIn && !credits && !compact) return null;
  return (
    <span className={compact
      ? "ms-auto flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground tabular-nums"
      : "ms-auto flex min-w-0 items-center gap-1.5 overflow-hidden rounded-sm bg-background/85 px-1.5 py-0.5 text-2xs whitespace-nowrap text-foreground tabular-nums"}>
      {resetsIn ?? ""}
      {credits ? <>
        {resetsIn ? <span aria-hidden className={compact ? undefined : "text-muted-foreground"}>·</span> : null}
        <span aria-hidden className={cn("inline-flex items-center gap-0.5 font-semibold", compact && "text-foreground")}><TicketIcon className="size-3" aria-hidden />{credits}</span>
        {compact ? <span className="sr-only">{gt("{count, plural, one {{count} reset credit banked} other {{count} reset credits banked}}", { count: credits })}</span> : null}
      </> : null}
    </span>
  );
}

function SegmentPopover({
  account,
  window,
  reset,
  now,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const where = account.sourceLabel;
  const creditLines = resetCreditLines(account.limits, now, m);
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-xs">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AccountAvatar account={account} />
          <span className="min-w-0 wrap-anywhere">
            {account.displayName ??
              usageDriverLabel(account.driver, providerClients.get(account.driver)?.label)}
          </span>
        </span>
        {account.email ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel={gt("Toggle account email visibility")}
            revealTooltip={gt("Click to reveal email")}
            hideTooltip={gt("Click to hide email")}
            className="w-fit"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        {account.plan ? (
          <Row label={gt("Plan", { $context: "subscription plan" })}>{account.plan}</Row>
        ) : null}
        {where ? (
          <Row label={gt("Via", { $context: "signed in through a source" })}>{where}</Row>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        <Row label={gt("Left", { $context: "remaining usage" })}>{remaining}%</Row>
        {window.resetsAt ? (
          <Row label={gt("Resets", { $context: "when the usage window resets" })}>
            <ResetTime window={window} fallbackNow={now} />
          </Row>
        ) : null}
        {timeLeft !== null ? (
          <Row label={gt("Even pace")}>{gt("{timeLeft}% left by now", { timeLeft })}</Row>
        ) : null}
        {reset && reset.restoresPercent > 0 ? (
          <Row label={gt("Restores", { $context: "a reset credit restores part of the pool" })}>
            {gt("+{percent}% of pool", { percent: reset.restoresPercent })}
          </Row>
        ) : null}
        {creditLines.length > 0 ? (
          <Row label={gt("Credits", { $context: "banked reset credits" })}>
            <span className="flex flex-col gap-0.5">
              {creditLines.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </span>
          </Row>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Every segment on the page shares one popover, so hovering or clicking another
 * segment moves it instead of opening a second one. The payload is the segment
 * it currently describes.
 */
type SegmentPayload = Omit<Parameters<typeof SegmentPopover>[0], "now">;
const SegmentPopoverContext = createContext<ReturnType<
  typeof PopoverCreateHandle<SegmentPayload>
> | null>(null);

function ActiveSegmentPopover({
  handle,
  actions,
  payload,
  pools,
  now,
}: {
  readonly handle: ReturnType<typeof PopoverCreateHandle<SegmentPayload>>;
  readonly actions: RefObject<PopoverPrimitive.Root.Actions | null>;
  readonly payload: SegmentPayload;
  readonly pools: readonly LimitPool[];
  readonly now: number;
}) {
  const provider = pools.find((pool) => pool.driver === payload.account.driver);
  const window = provider && displayLimitWindows(provider).find((entry) =>
    entry.kind === payload.window.kind && entry.id === payload.window.id,
  );
  const member = window?.members.find((entry) => entry.account.key === payload.account.key);
  // The trigger is gone, so the popup has nothing to anchor to: an exit transition would
  // slide it to the viewport origin. Unmount it outright, which also clears Base UI's
  // active-trigger bookkeeping so the segment can open again when it comes back.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the popover handle and unmounts the Base UI popup before paint when its trigger is gone
  useLayoutEffect(() => {
    if (member) return;
    handle.close();
    actions.current?.unmount();
  }, [member, handle, actions]);
  if (!member) return null;
  return (
    <PopoverPopup side="top" sideOffset={6} className="max-h-(--available-height) overflow-y-auto overscroll-contain">
      <SegmentPopover
        account={member.account}
        window={member.window}
        reset={window?.resets.find((reset) => reset.member.account.key === member.account.key)}
        now={now}
      />
    </PopoverPopup>
  );
}

function PoolSegment({
  account,
  ...props
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly restoresAt: string | undefined;
  readonly refillPercent: number;
  readonly color: string;
  readonly now: number;
  readonly index: number;
  readonly showAccountName: boolean;
}) {
  return <SegmentTriggers account={account} {...props} />;
}

function SegmentTriggers({
  account,
  window,
  reset,
  restoresAt,
  refillPercent,
  color,
  now,
  index,
  showAccountName,
}: SegmentPayload & {
  readonly restoresAt: string | undefined;
  readonly refillPercent: number;
  readonly color: string;
  readonly now: number;
  readonly index: number;
  readonly showAccountName: boolean;
}) {
  const popover = use(SegmentPopoverContext) ?? undefined;
  // burnrate: the pooled bars honour the same barMode / showPaceTick settings as the single bars.
  const barMode = useSettings((settings) => settings.usage.barMode);
  const showPaceTick = useSettings((settings) => settings.usage.showPaceTick);
  const payload: SegmentPayload = { account, window, reset };
  const remaining = remainingPercent(window);
  const shown = barValue(window, barMode);
  const pace = paceOf(window, now);
  const timeLeft = paceRemainingPercent(window, now);
  const [segmentRef, paceMark] = usePaceMark(showPaceTick ? timeLeft : null);
  const m = useMessages();
  const refreshIntervalSec = useSettings((settings) => settings.usage.refreshIntervalSec);
  const freshness = limitFreshness(account.limits, now, refreshIntervalSec, m);
  const resetsIn = formatResetsIn(window, now, m);
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  const gt = useGT();
  const name =
    account.displayName ?? (account.email ? accountInitials(account.email) : account.driver);
  const valueText = barValueText(shown, barMode, gt);
  // burnrate: pace also has a text form, so a colour alone never carries meaning.
  const paceText = pace === null ? null : paceLabel(pace, gt);
  const segmentLabel = [
    gt("{name}: {valueText}", { name, valueText }),
    freshness?.description,
    paceText,
    resetsIn,
    timeLeft === null ? null : gt("{timeLeft}% of the window left", { timeLeft }),
    window.provenance ? provenanceDescription(window.provenance, m) : null,
    credits
      ? gt(
          "{count, plural, one {{count} reset credit banked} other {{count} reset credits banked}}",
          { count: credits },
        )
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <>
      <PopoverTrigger
        handle={popover}
        payload={payload}
        openOnHover
        render={
          <button
            ref={segmentRef}
            type="button"
            style={{ gridColumn: index, gridRow: 1, ...paceMark?.gappedTrack }}
            aria-label={segmentLabel}
            data-stale-member={freshness ? true : undefined}
            data-pace={pace ?? undefined}
            className="br-usage-meter relative h-6 min-w-0 cursor-pointer rounded-md bg-muted text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[popup-open]:ring-1 data-[popup-open]:ring-inset data-[popup-open]:ring-border @2xl/pool:h-8 pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-2.5 pointer-coarse:after:content-['']"
          />
        }
      >
        {/* burnrate: the button stays the popover trigger; this nested meter exposes the bar's value. */}
        <span
          role="meter"
          className="sr-only"
          aria-label={gt("{name}: {label}", { name, label: window.label })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={shown}
          aria-valuetext={segmentLabel}
        />
        <div aria-hidden className="absolute inset-0 overflow-hidden rounded-md">
          {/* Clipped inside the rounded clip so the bar's own corners keep their antialiasing. */}
          <div className="absolute inset-0" style={paceMark?.gap}>
            <div
              aria-hidden
              className="br-usage-meter__fill absolute inset-y-0 left-0 rounded-md opacity-35"
              style={{ width: `${shown}%`, backgroundColor: color }}
            />
            {remaining < 100 && reset && refillPercent > 0 ? (
              <div
                aria-hidden
                className="absolute inset-y-0 right-0 opacity-20"
                style={{
                  width: `${Math.min(100 - remaining, refillPercent)}%`,
                  backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 1px, transparent 1px 5px)`,
                }}
              />
            ) : null}
          </div>
        </div>
        {paceMark ? (
          <span
            aria-hidden
            className="br-usage-meter__tick absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
            style={paceMark.tick}
          />
        ) : null}
        {freshness ? (
          <span aria-hidden className="pointer-events-none absolute inset-0 rounded-md border border-dashed border-warning-foreground" />
        ) : null}
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center gap-1 overflow-hidden rounded-md text-3xs leading-none font-semibold text-foreground/80 tabular-nums @2xl/pool:hidden"
        >
          {index}
          {freshness ? <ClockIcon className="size-3 shrink-0 text-warning-foreground" /> : null}
        </span>
        <div className="relative hidden h-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-2 text-xs @2xl/pool:flex">
          {showAccountName ? (
            <AccountName
              account={account}
              className="min-w-0 truncate font-medium text-foreground"
            />
          ) : null}
          {/* A single-account bar repeats the headline percentage. */}
          {showAccountName ? (
            <span className="shrink-0 font-semibold text-foreground tabular-nums">
              {shown}%
            </span>
          ) : null}
          {freshness ? <SegmentAge freshness={freshness} /> : null}
          <RefillBadge window={window} restoresAt={restoresAt} credits={credits} fallbackNow={now} />
        </div>
      </PopoverTrigger>
      <LegendRow
        payload={payload}
        color={color}
        now={now}
        index={index}
        freshness={freshness}
        restoresAt={restoresAt}
      />
    </>
  );
}

function SegmentAge({ freshness }: { readonly freshness: LimitFreshness }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-warning-foreground tabular-nums">
      <ClockIcon className="size-3" aria-hidden />
      {freshness.short}
    </span>
  );
}

function LegendRow({
  payload,
  color,
  now,
  index,
  freshness,
  restoresAt,
}: {
  readonly payload: SegmentPayload;
  readonly color: string;
  readonly now: number;
  readonly index: number;
  readonly freshness: LimitFreshness | null;
  readonly restoresAt: string | undefined;
}) {
  const popover = use(SegmentPopoverContext) ?? undefined;
  const { account, window } = payload;
  const remaining = remainingPercent(window);
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  const gt = useGT();
  return (
    <PopoverTrigger
      handle={popover}
      payload={payload}
      style={{ gridColumn: "1 / -1", gridRow: index + 1 }}
      render={<Button variant="ghost" size="compact" />}
      className="min-w-0 @2xl/pool:hidden"
    >
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-3xs leading-none font-semibold text-foreground/80 tabular-nums">
        <span
          aria-hidden
          className="absolute inset-0 rounded-sm opacity-35"
          style={{ backgroundColor: color }}
        />
        <span className="sr-only">{`${gt("Segment")} `}</span>
        <span className="relative">{index}</span>
      </span>
      <AccountName account={account} className="min-w-0 truncate font-medium text-foreground" />
      <span className="shrink-0 font-semibold text-foreground tabular-nums">{remaining}%</span>
      {freshness ? <SegmentAge freshness={freshness} /> : null}
      <RefillBadge window={window} restoresAt={restoresAt} credits={credits} fallbackNow={now} compact />
    </PopoverTrigger>
  );
}

function PoolBar({
  pool,
  color,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  const restores = new Map(pool.resets.map((reset) => [reset.member.account.key, reset]));
  const gt = useGT();
  return (
    <div className="@container/pool min-w-0">
      <div
        className="grid gap-x-1 gap-y-1"
        style={{ gridTemplateColumns: `repeat(${pool.columns.length}, minmax(0, 1fr))` }}
      >
        {pool.columns.map((member, position) =>
          member.window ? (
            <PoolSegment
              key={member.account.key}
              account={member.account}
              window={member.window}
              reset={restores.get(member.account.key)}
              restoresAt={member.restoresAt}
              refillPercent={member.refillPercent}
              color={normalizeProviderAccentColor(member.account.accentColor) ?? color}
              now={now}
              index={position + 1}
              showAccountName={pool.columns.length > 1}
            />
          ) : pool.kind === "monthly" && member.account.limits.zeroSpendCap ? (
            <div
              key={member.account.key}
              style={{ gridColumn: position + 1, gridRow: 1 }}
              className="flex h-5 min-w-0 items-center justify-center gap-1.5 overflow-hidden rounded-md border border-dashed border-border text-3xs whitespace-nowrap text-muted-foreground @2xl/pool:h-8 @2xl/pool:justify-start @2xl/pool:px-2 @2xl/pool:text-xs"
            >
              <AccountName
                account={member.account}
                className="hidden min-w-0 truncate @2xl/pool:inline-flex"
              />
              {gt("$0 cap")}
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}

function PoolWindowCard({
  pool,
  color,
  now,
  label,
  description,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly label?: string | null | undefined;
  readonly description?: string | undefined;
}) {
  const nextRefill = pool.resets.find((reset) => reset.restoresPercent > 0);
  const barMode = useSettings((settings) => settings.usage.barMode);
  const refreshIntervalSec = useSettings((settings) => settings.usage.refreshIntervalSec);
  const containsOldData = pool.members.some(({ account }) => isLimitSnapshotStale(account.limits, now, refreshIntervalSec));
  const oldDataId = useId();
  const shown = barMode === "used" ? pool.usedPercent : pool.remainingPercent;
  const gt = useGT();
  return (
    <div className="@container/card grid items-center gap-x-6 gap-y-3 rounded-lg border border-border/60 p-4 @[30rem]/card:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-1">
        {label !== null ? (
          <span className="text-sm font-medium text-foreground">{label ?? pool.label}</span>
        ) : null}
        <span role="group" className="flex items-baseline gap-2" aria-describedby={containsOldData ? oldDataId : undefined}>
          <span className="text-3xl font-semibold text-foreground tabular-nums">{shown}%</span>
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <span>
              {barMode === "used" ? (
                gt("used")
              ) : (
                <T context="remaining usage percentage">left</T>
              )}
            </span>
            {pool.pace ? <PaceIcon pace={pool.pace} /> : null}
          </span>
        </span>
        {containsOldData ? (
          <span id={oldDataId} className="flex items-center gap-1 text-xs text-warning-foreground">
            <ClockIcon className="size-3 shrink-0" aria-hidden />
            {gt("Includes old data")}
          </span>
        ) : null}
        {nextRefill && pool.columns.length > 1 ? (
          <span className="text-xs font-medium text-foreground tabular-nums">
            ↻ +{nextRefill.restoresPercent}%
          </span>
        ) : null}
      </div>
      <PoolBar pool={pool} color={color} now={now} />
      {description ? (
        <p className="text-xs text-muted-foreground @[30rem]/card:col-span-2">{description}</p>
      ) : null}
    </div>
  );
}

function PoolSection({
  pool,
  now,
  collapsed,
  onCollapsedChange,
  headerAction,
}: {
  readonly pool: LimitPool;
  readonly now: number;
  /** Shown at the end of the provider's heading row. */
  readonly headerAction?: React.ReactNode;
  // burnrate: a provider section can be collapsed; its heading then summarises it.
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
}) {
  const color = barColor(pool.driver);
  const label = usageDriverLabel(pool.driver, providerClients.get(pool.driver)?.label);
  const windows = displayLimitWindows(pool);
  const m = useMessages();
  return (
    <ProviderSection
      pool={pool}
      label={label}
      now={now}
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
      headerAction={headerAction}
    >
      {windows.map((window) => {
        const details =
          pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool, m) : undefined;
        return (
          <PoolWindowCard
            key={`${window.kind}:${window.id}`}
            pool={window}
            color={color}
            now={now}
            label={details?.label}
            description={details?.description}
          />
        );
      })}
    </ProviderSection>
  );
}

/**
 * ChatGPT/Codex reports native session and weekly windows, so the old "open ChatGPT usage" card
 * (still sent by older servers) would only duplicate them. Never render it.
 */
const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";

/** Providers that cannot show their limits here link to their own usage page. */
export function collectExternalLinks(accounts: readonly LimitsAccount[], host: string) {
  const links = new Map<string, { label: string; url: string; message: string | undefined; accounts: string[] }>();
  for (const account of accounts) {
    const external = account.limits.externalUsage;
    if (!external || external.url === CHATGPT_USAGE_URL) continue;
    const name = `${account.displayName ?? account.label} on ${host}`;
    const held = links.get(external.url);
    links.set(external.url, {
      ...external,
      message: account.limits.unavailable?.message,
      accounts: [...new Set([...(held?.accounts ?? []), name])],
    });
  }
  return [...links.values()];
}

export function UsageLimitsPooled({
  accounts,
  notices,
  now,
  hostLabel = "this computer",
}: {
  readonly accounts: readonly LimitsAccount[];
  readonly notices: readonly string[];
  readonly now: number;
  readonly hostLabel?: string;
}) {
  const gt = useGT();
  const externalLinks = collectExternalLinks(accounts, hostLabel);
  const [segmentPopover] = useState(() => PopoverCreateHandle<SegmentPayload>());
  const segmentPopoverActions = useRef<PopoverPrimitive.Root.Actions | null>(null);
  const m = useMessages();
  // burnrate: a snapshot we could not refresh is still the last known truth. Keep it in the pool so
  // an exhausted account cannot silently vanish, and name it separately with its age.
  const refreshIntervalSec = useSettings((settings) => settings.usage.refreshIntervalSec);
  const allAccounts = toLimitAccounts(accounts);
  const staleAccounts = allAccounts.flatMap((account) => {
    const freshness = limitFreshness(account.limits, now, refreshIntervalSec, m);
    return freshness === null ? [] : [{ account, freshness }];
  });
  const pools = collectLimitPools(allAccounts, now);
  const accountNotices = accountLimitNotices(accounts, m);
  const { collapsed, setCollapsed, setAll } = useCollapsedProviders();
  // burnrate: the command palette asks for "collapse/expand all" through a window event.
  const poolIds = pools.map((pool) => pool.driver).join("\u0000");
  useEffect(() => {
    const onRequest = (event: Event) => {
      const next = (event as CustomEvent<{ collapsed: boolean }>).detail?.collapsed === true;
      setAll(poolIds === "" ? [] : poolIds.split("\u0000"), next);
    };
    window.addEventListener(COLLAPSE_ALL_PROVIDERS_EVENT, onRequest);
    return () => window.removeEventListener(COLLAPSE_ALL_PROVIDERS_EVENT, onRequest);
  }, [poolIds, setAll]);
  // burnrate: name the accounts whose limits could not be refreshed so the gap is visible.
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {staleAccounts.length > 0 ? (
        <div role="status" className="flex flex-col items-start gap-1">
          {staleAccounts.map(({ account, freshness }) => (
            <div key={account.key} className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
              <AccountName account={account} className="min-w-0 font-medium" />
              <span className="text-muted-foreground">{gt("Limits unavailable")}</span>
              <StaleBadge freshness={freshness} />
            </div>
          ))}
        </div>
      ) : null}
      {pools.length === 0 &&
      staleAccounts.length === 0 &&
      notices.length === 0 &&
      externalLinks.length === 0 &&
      accountNotices.length === 0 ? (
        <LimitsEmptyState />
      ) : null}
      <SegmentPopoverContext value={segmentPopover}>
        <div className="flex min-w-0 flex-col gap-8">
          {pools.map((pool, index) => (
            <Fragment key={pool.driver}>
              <PoolSection
                pool={pool}
                now={now}
                collapsed={collapsed.has(pool.driver)}
                onCollapsedChange={(next) => setCollapsed(pool.driver, next)}
                // "Collapse all" lives on the first provider's heading row (no row of its own), and only
                // once there is more than one provider.
                headerAction={
                  index === 0 && pools.length > 1 ? (
                    <CollapseAllButton
                      ids={pools.map((entry) => entry.driver)}
                      collapsed={collapsed}
                      onSetAll={setAll}
                    />
                  ) : undefined
                }
              />
            </Fragment>
          ))}
        </div>
      </SegmentPopoverContext>
      <Popover handle={segmentPopover} actionsRef={segmentPopoverActions}>
        {({ payload }) =>
          payload ? (
            <ActiveSegmentPopover
              handle={segmentPopover}
              actions={segmentPopoverActions}
              payload={payload}
              pools={pools}
              now={now}
            />
          ) : null
        }
      </Popover>
      {externalLinks.map((link) => (
        <section key={link.url} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium">{link.label}</h2>
              <p className="text-xs break-words text-muted-foreground">{link.accounts.join(", ")}</p>
              {link.message ? (
                <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
              ) : null}
            </div>
          </div>
          <Button variant="ghost-muted" size="xs" onClick={() => window.open(link.url, "_blank", "noopener")}>
            {gt("Manage usage")}
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </section>
      ))}
      <AccountLimitNotes notices={accountNotices} />
      <LimitNotices notices={notices} />
    </div>
  );
}

/** Accounts without a bar still say why, in T3's words, rather than vanishing from the page. */
function AccountLimitNotes({
  notices,
}: {
  readonly notices: ReturnType<typeof accountLimitNotices>;
}) {
  const gt = useGT();
  if (notices.length === 0) return null;
  return (
    <ul
      aria-label={gt("Accounts without limits")}
      className="flex flex-col gap-1 text-xs text-muted-foreground"
    >
      {notices.map((notice) => (
        <li key={notice.key} className="flex min-w-0 flex-wrap gap-x-2">
          <span className="font-medium text-foreground">{notice.name}</span>
          <span>{notice.message}</span>
        </li>
      ))}
    </ul>
  );
}

function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <AlertTriangleIcon />
      {notices.map((notice) => (
        <AlertTitle key={notice} className="break-words">
          {notice}
        </AlertTitle>
      ))}
    </Alert>
  );
}
