import { ChatGptUsageButton } from "~/t3-shims/chat-gpt-usage";
import { type UsageProviderKind, type UsageSummaryInput } from "~/contracts";
import { InfoIcon } from "lucide-react";
import { T, useGT, useLocale, useMessages, Var } from "~/i18n";
import { useState } from "react";
import { usageLoadingState } from "~/t3-shims/usage-progress";

import { isModelCostUnknown, type DailyTotals, type HourlyTotals, type MergedUsage } from "~/shared/usageMerge";

import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "~/t3-shims/ProviderInstanceIcon";
import { type EnvironmentUsageStatus } from "~/state/usage";
import { formatCount, formatDayShort, formatPercent, formatTokens, formatUsd } from "~/shared/usageFormat";
import { formatUsageContractMismatch, usageSourceMessages } from "~/shared/usageFormatCopy";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { UsageScanStatus } from "./UsageScanStatus";
import { type ScanProgress } from "~/api/usage";
import { formatUsageHour, UsageProviderChart } from "./UsageProviderChart";
import { SpeedPremium } from "./UsageModelDialog";
import { UsageShareBar } from "./UsageShareBar";
import { UsageTableRegion } from "./UsageTableRegion";
import { MARK_CLASS, markStyle } from "./usageMarkColor";
import { costTypeSegments, modelShare, sortModelsByTokens, speedCostSegments, tokenTypeSegments } from "./usageBreakdown";
import { PROVIDER_PRESENTATION, filterEmptyProviders, providersWithUsage, rankProvidersByMetric } from "./usageProviders";

function usageLoading(
  showingKept: boolean,
  selectedEnvironments: Parameters<typeof usageLoadingState>[0],
  refreshingUsage: boolean,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
) {
  if (showingKept) {
    return { partial: true, everyProvider: true, providers: new Set<UsageProviderKind>() };
  }
  const state = usageLoadingState(selectedEnvironments, refreshingUsage);
  const providers = new Set([...state.providers].filter((p) => !hiddenProviders.has(p)));
  return {
    partial: state.everyProvider || providers.size > 0,
    everyProvider: state.everyProvider,
    providers,
  };
}

export function UsageOverview({
  merged,
  configuredProviders,
  shownWindow,
  hideEmpty,
  hour12,
  days,
  hours,
  showingKept,
  metric,
  selectedEnvironments,
  hiddenProviders,
  refreshingUsage,
  showChatGptSharing,
  onSelectModel,
  scan,
  stale,
}: {
  readonly merged: MergedUsage;
  /** Only what the filter menu offers: connected, with logs, or with usage. */
  readonly configuredProviders: readonly UsageProviderKind[];
  readonly shownWindow: UsageSummaryInput;
  readonly hideEmpty: boolean;
  readonly hour12: boolean;
  readonly days: readonly string[];
  readonly hours: readonly string[];
  readonly showingKept: boolean;
  readonly metric: "tokens" | "cost";
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly refreshingUsage: boolean;
  readonly showChatGptSharing: boolean;
  readonly onSelectModel: (key: string, trigger: HTMLButtonElement) => void;
  readonly scan: ScanProgress | null;
  readonly stale: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const [breakdown, setBreakdown] = useState<"model" | "time">("model");
  const shownHourly = shownWindow.resolution === "hour";
  const loading = usageLoading(showingKept, selectedEnvironments, refreshingUsage, hiddenProviders);
  // Copy the primitive; JSX reads of loading.partial would merge all derivations into one compiler cache
  // scope.
  const loadingPartial = loading.partial === true;
  const loadingProviders = new Set(
    configuredProviders.filter(
      (provider) => loading.everyProvider || loading.providers.has(provider),
    ),
  );
  const providersWithData = new Set(providersWithUsage(merged.providers));
  // The ranking list and chart legend offer the same set as the filter menu (the order and the
  // loading pulse read the offered providers, never the static registered list).
  const activeProviders = filterEmptyProviders(
    configuredProviders.filter(
      (provider) => providersWithData.has(provider) || loading.providers.has(provider),
    ),
    providersWithData,
    hideEmpty,
  );
  const sourceMessages = usageSourceMessages(
    selectedEnvironments.flatMap(
      (environment) =>
        environment.summary?.sources.filter(
          (source) => !hiddenProviders.has(source.fingerprint.provider),
        ) ?? [],
    ),
    m,
  );
  const breakdownPeriods: readonly (DailyTotals | HourlyTotals)[] = (
    shownHourly ? merged.hourly : merged.daily
  ).toReversed();
  const breakdownModels =
    breakdown === "model" && metric === "tokens"
      ? sortModelsByTokens(merged.models)
      : merged.models;
  const breakdownPeak = breakdownModels.reduce(
    (peak, model) => Math.max(peak, metric === "tokens" ? model.totalTokens : model.costUsd),
    0,
  );
  const rankedProviders = rankProvidersByMetric(activeProviders, merged.providers, metric);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <UsageScanStatus scan={scan} stale={stale} hasData={merged.records > 0} />
      <UsageCoverageNotice
        environments={selectedEnvironments}
        duplicateSources={merged.duplicateSources}
        contractMismatches={merged.contractMismatches}
      />
      {sourceMessages.map((message) => (
        <p key={message} className="wrap-anywhere text-sm text-muted-foreground">
          {message}
        </p>
      ))}
      <section aria-busy={loadingPartial} className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-1">
            <p
              className={cn(
                "text-4xl font-semibold text-foreground tabular-nums",
                figureClass(loadingPartial),
              )}
            >
              {metric === "cost"
                ? formatUsd(merged.costUsd, locale)
                : formatTokens(merged.totalTokens)}
            </p>
            <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <span>
                <span className={figureClass(loadingPartial)}>
                  {gt("{count, plural, one {{formatted} session} other {{formatted} sessions}}", {
                    count: merged.sessions,
                    formatted: formatCount(merged.sessions, locale),
                  })}
                </span>
                {metric === "cost" && ` · ${gt("API estimate")}`}
              </span>
              {metric === "cost" && merged.costQuality.unpricedShare > 0 && (
                <Popover>
                  <PopoverTrigger
                    openOnHover
                    render={<Button variant="ghost-muted" size="icon-sm" />}
                    aria-label={gt("Unpriced usage details")}
                  >
                    <InfoIcon className="size-3" aria-hidden />
                  </PopoverTrigger>
                  <PopoverPopup side="top" tooltipStyle>
                    <T>
                      API estimate excludes{" "}
                      <Var>{formatPercent(merged.costQuality.unpricedShare)}</Var> unpriced records.
                    </T>
                  </PopoverPopup>
                </Popover>
              )}
            </p>
          </div>

          {showChatGptSharing ? (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                <T>ChatGPT shared usage</T>
              </span>
              <ChatGptUsageButton size="xs" />
            </div>
          ) : null}

          {/* Many providers scroll inside the list (about five rows fit) instead of stretching the page.
              It is focusable so keyboard users can scroll it with the arrow keys (WCAG 2.1.1). */}
          <ul
            aria-label={gt("Providers by usage")}
            tabIndex={0}
            className="flex max-h-[22rem] min-h-0 min-w-0 flex-col divide-y divide-border/60 overflow-y-auto overscroll-contain rounded-md pe-1 outline-none [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-ring"
          >
          {rankedProviders.map((provider) => {
            const totals = merged.providers.find((entry) => entry.provider === provider);
            const share = metric === "cost" ? (totals?.costShare ?? 0) : (totals?.tokenShare ?? 0);
            const providerSessions = totals?.sessions ?? 0;
            const sessionLabel = gt(
              "{count, plural, one {{formatted} session} other {{formatted} sessions}}",
              { count: providerSessions, formatted: formatCount(providerSessions, locale) },
            );
            const providerLoading = loadingProviders.has(provider);
            const awaitingData = providerLoading && !providersWithData.has(provider);
            return (
              <li key={provider} className="flex min-w-0 flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
                <dl className="flex items-baseline justify-between gap-4">
                  <dt className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                    <span
                      aria-hidden
                      className={cn("size-2 shrink-0 rounded-full", MARK_CLASS)}
                      style={{
                        ...markStyle(PROVIDER_PRESENTATION[provider].color),
                        backgroundColor: "var(--usage-mark)",
                      }}
                    />
                    <ProviderMark provider={provider} className="size-4" />
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                      <span className="truncate">
                        {PROVIDER_PRESENTATION[provider].label}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 whitespace-nowrap text-2xs text-muted-foreground tabular-nums",
                          figureClass(providerLoading),
                          awaitingData && "invisible",
                        )}
                      >
                        {sessionLabel}
                      </span>
                    </span>
                  </dt>
                  <dd
                    className={cn(
                      "shrink-0 text-sm font-medium text-foreground tabular-nums",
                      figureClass(providerLoading),
                    )}
                  >
                    {awaitingData
                      ? "-"
                      : metric === "cost"
                        ? formatUsd(totals?.costUsd ?? 0, locale)
                        : formatTokens(totals?.totalTokens ?? 0)}
                  </dd>
                </dl>
                <p
                  className={cn(
                    "text-xs text-muted-foreground tabular-nums",
                    figureClass(providerLoading),
                    awaitingData && "invisible",
                  )}
                >
                  {metric === "cost"
                    ? gt("{share} of cost · {tokens} tokens", {
                        share: formatPercent(share),
                        tokens: formatTokens(totals?.totalTokens ?? 0),
                      })
                    : gt("{share} of tokens · {cost}", {
                        share: formatPercent(share),
                        cost: formatUsd(totals?.costUsd ?? 0, locale),
                      })}
                </p>
              </li>
            );
          })}
          </ul>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <h2 className="text-sm font-medium text-foreground">
            {shownHourly
              ? metric === "tokens"
                ? gt("Hourly processed tokens")
                : gt("Hourly cost")
              : metric === "tokens"
                ? gt("Daily processed tokens")
                : gt("Daily cost")}
          </h2>
          <UsageProviderChart
            providers={activeProviders}
            loadingProviders={loadingProviders}
            days={days}
            daily={merged.daily}
            hours={hours}
            hourly={merged.hourly}
            metric={metric}
            referenceTime={shownWindow.untilTime}
            resolution={shownHourly ? "hour" : "day"}
            timeZone={shownWindow.timeZone}
            hour12={hour12}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">
          <T>Totals</T>
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          <Metric
            loading={loadingPartial}
            label={gt("Processed tokens")}
            value={formatTokens(merged.totalTokens)}
          />
          <Metric
            loading={loadingPartial}
            label={gt("Cached input")}
            value={formatTokens(merged.cachedInputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label={gt("Uncached input")}
            value={formatTokens(merged.uncachedInputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label={gt("Output", { $context: "output tokens" })}
            value={formatTokens(merged.outputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label={gt("Cache savings")}
            value={formatUsd(merged.costQuality.cacheSavingsUsd, locale)}
          />
        </dl>
      </section>

      {merged.totalTokens > 0 ? (
        <section
          className={cn("grid gap-x-12 gap-y-8 lg:grid-cols-2", figureClass(loadingPartial))}
        >
          {metric === "tokens" ? (
            <UsageShareBar
              label={gt("Tokens by type")}
              segments={tokenTypeSegments(merged)}
              format={formatTokens}
            />
          ) : (
            <>
              <UsageShareBar
                label={gt("Cost by type")}
                segments={costTypeSegments(merged.categoryCost)}
                format={(value: number) => formatUsd(value, locale)}
              />
              {merged.speedCost.fast + merged.speedCost.ultrafast > 0 ? (
                <UsageShareBar
                  label={gt("Cost by speed")}
                  segments={speedCostSegments(merged.speedCost)}
                  format={(value: number) => formatUsd(value, locale)}
                  aside={<SpeedPremium premiumUsd={merged.speedCost.premium} />}
                />
              ) : null}
            </>
          )}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">
            <T>Breakdown</T>
          </h2>
          <ToggleGroup
            aria-label={gt("Usage breakdown")}
            variant="segmented"
            value={[breakdown]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "model" || value === "time") setBreakdown(value);
            }}
          >
            {(
              [
                { value: "model", label: gt("Model") },
                { value: "time", label: shownHourly ? gt("Hour") : gt("Day") },
              ] as const
            ).map((option) => (
              <Toggle key={option.value} value={option.value} className="motion-reduce:transition-none">
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>

        {breakdown === "model" ? (
          <UsageTableRegion label={gt("Usage breakdown by model")}>
          <table className="w-full min-w-[28rem] text-sm">
            <caption className="sr-only">{gt("Usage breakdown by model")}</caption>
            <thead>
              <tr className="text-right text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 pl-2 text-left font-normal">
                  <span aria-hidden>#</span>
                  <span className="sr-only">{gt("Rank")}</span>
                </th>
                <th scope="col" className="w-full py-2 text-left font-normal">
                  <T>Model</T>
                </th>
                <th scope="col" className="py-2 pl-6 font-normal">
                  <T>Cost</T>
                </th>
                <th scope="col" className="hidden py-2 pl-6 font-normal sm:table-cell">
                  <T context="column heading, percentage share">Share</T>
                </th>
                <th scope="col" className="py-2 pr-2 pl-6 font-normal">
                  <T>Tokens</T>
                </th>
              </tr>
            </thead>
            <tbody>
              {breakdownModels.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-muted-foreground">
                    <T>No activity in this window.</T>
                  </td>
                </tr>
              ) : (
                breakdownModels.map((model, index) => {
                  const key = `${model.provider}:${model.model}`;
                  const value = metric === "tokens" ? model.totalTokens : model.costUsd;
                  const hasBar = value > 0 && breakdownPeak > 0;
                  const share = modelShare(model, metric === "tokens" ? "tokens" : "cost");
                  const rowFigures = figureClass(loadingProviders.has(model.provider));
                  return (
                    <tr
                      key={key}
                      className="relative border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums hover:bg-muted/50 has-focus-visible:bg-muted/50 motion-safe:transition-colors"
                    >
                      <td className="py-2.5 pr-3 pl-2 text-left text-xs">{index + 1}</td>
                      <td className="py-2.5 text-left whitespace-normal">
                        <button
                          type="button"
                          onClick={(event) => onSelectModel(key, event.currentTarget)}
                          className={cn(
                            "flex min-h-6 min-w-6 items-center gap-2 text-left text-foreground outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring",
                            !hasBar && "py-1",
                          )}
                        >
                          <ProviderMark provider={model.provider} className="size-3.5 shrink-0" />
                          <span className="min-w-0 break-all">
                            {model.model}
                          </span>
                        </button>
                        {hasBar ? (
                          <div aria-hidden className={cn("mt-1.5 h-0.5 max-w-48", rowFigures)}>
                            <div
                              className={cn("h-full rounded-full", MARK_CLASS)}
                              style={{
                                ...markStyle(PROVIDER_PRESENTATION[model.provider].color),
                                width: `max(0.5rem, ${(value / breakdownPeak) * 100}%)`,
                                backgroundColor: "var(--usage-mark)",
                              }}
                            />
                          </div>
                        ) : null}
                      </td>
                      <td className={cn("py-2.5 pl-6 text-foreground", rowFigures)}>
                        {isModelCostUnknown(model) ? (
                          <span className="text-muted-foreground">
                            <T>Unpriced</T>
                          </span>
                        ) : (
                          formatUsd(model.costUsd, locale)
                        )}
                      </td>
                      <td className={cn("hidden py-2.5 pl-6 sm:table-cell", rowFigures)}>
                        {share === null ? "" : formatPercent(share)}
                      </td>
                      <td className={cn("py-2.5 pr-2 pl-6", rowFigures)}>
                        {formatTokens(model.totalTokens)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          </UsageTableRegion>
        ) : (
          <UsageTableRegion label={gt("Usage breakdown by time")}>
            <table className="w-full text-sm whitespace-nowrap">
              <caption className="sr-only">{gt("Usage breakdown by time")}</caption>
              <colgroup>
                <col className="w-2/5" />
              </colgroup>
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pl-2 font-normal">
                    {shownHourly ? gt("Hour") : gt("Day")}
                  </th>
                  {activeProviders.map((provider) => (
                    <th key={provider} scope="col" className="py-2 pl-4 text-right font-normal">
                      {PROVIDER_PRESENTATION[provider].label}
                    </th>
                  ))}
                  <th scope="col" className="py-2 pl-4 text-right font-normal">
                    <T>Total</T>
                  </th>
                  <th scope="col" className="py-2 pr-2 pl-4 text-right font-normal">
                    <T>Tokens</T>
                  </th>
                </tr>
              </thead>
              <tbody>
                {breakdownPeriods.length === 0 ? (
                  <tr>
                    <td
                      colSpan={activeProviders.length + 3}
                      className="py-6 text-center text-muted-foreground"
                    >
                      <T>No activity in this window.</T>
                    </td>
                  </tr>
                ) : (
                  breakdownPeriods.map((period) => (
                    <tr
                      key={"hourStart" in period ? period.hourStart : period.day}
                      className="border-b border-border/50 hover:bg-muted/50 motion-safe:transition-colors"
                    >
                      <td className="py-2 pl-2 text-foreground">
                        {"hourStart" in period
                          ? formatUsageHour(period.hourStart, shownWindow.timeZone, hour12, locale)
                          : formatDayShort(period.day, locale)}
                      </td>
                      {activeProviders.map((provider) => (
                        <td
                          key={provider}
                          className={cn(
                            "py-2 pl-4 text-right text-muted-foreground tabular-nums",
                            figureClass(loadingProviders.has(provider)),
                          )}
                        >
                          {formatUsd(period.byProvider.get(provider)?.costUsd ?? 0, locale)}
                        </td>
                      ))}
                      <td
                        className={cn(
                          "py-2 pl-4 text-right text-foreground tabular-nums",
                          figureClass(loadingPartial),
                        )}
                      >
                        {formatUsd(period.costUsd, locale)}
                      </td>
                      <td
                        className={cn(
                          "py-2 pr-2 pl-4 text-right text-muted-foreground tabular-nums",
                          figureClass(loadingPartial),
                        )}
                      >
                        {formatTokens(period.totalTokens)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </UsageTableRegion>
        )}
      </section>
    </div>
  );
}

function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const presentation = PROVIDER_PRESENTATION[provider];
  return (
    <ProviderInstanceIcon
      driverKind={presentation.driverKind}
      displayName={presentation.label}
      iconClassName={className}
    />
  );
}

function figureClass(loading: boolean) {
  return loading ? "opacity-80" : "";
}

function Metric({
  label,
  value,
  loading,
}: {
  readonly label: string;
  readonly value: string;
  readonly loading: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn("text-base font-medium text-foreground tabular-nums", figureClass(loading))}
      >
        {value}
      </dd>
    </div>
  );
}

function UsageCoverageNotice({
  environments,
  duplicateSources,
  contractMismatches,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
}) {
  const gt = useGT();
  const m = useMessages();
  const failed = environments.filter((environment) => environment.error !== null);
  const mismatchByEnvironment = new Map(
    contractMismatches.map((mismatch) => [mismatch.environmentId, mismatch]),
  );
  const incompatible = environments.flatMap((environment) => {
    const mismatch = mismatchByEnvironment.get(environment.environmentId);
    return mismatch === undefined ? [] : [{ environment, mismatch }];
  });
  if (failed.length === 0 && incompatible.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div role="status" className="flex flex-col gap-1 text-sm text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>{environment.error}</span>
      ))}
      {incompatible.map(({ environment, mismatch }) => (
        <span key={environment.environmentId}>
          {formatUsageContractMismatch(environment.label, mismatch, m)}
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          {gt("Counted once across sources sharing a transcript directory: {sources}", {
            sources: duplicateSources.join(", "),
          })}
        </span>
      ) : null}
    </div>
  );
}

