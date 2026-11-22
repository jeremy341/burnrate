import { ChatGptUsageButton } from "~/t3-shims/chat-gpt-usage";
import { RefreshIcon } from "../ui/refresh-icon";
import {
  type EnvironmentId,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "~/contracts";
import {
  ChevronDownIcon,
  EyeIcon,
  InfoIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { T, useGT, useLocale, useMessages, Var } from "~/i18n";
import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usageLoadingState } from "~/t3-shims/usage-progress";
import { AppRouteModal } from "~/t3-shims/app-route-modal";
import { defaultKeybindings, shortcutLabelForCommand } from "~/t3-shims/keybindings";
import { isCommandPaletteOpen, isModelPickerOpen } from "~/t3-shims/overlays";

import {
  isModelCostUnknown,
  type DailyTotals,
  type HourlyTotals,
  type MergedUsage,
} from "~/shared/usageMerge";

import { cn } from "~/lib/utils";
import { usePrimarySettings } from "~/hooks/useSettings";
import { getHideEmptyProviders, subscribeHideEmptyProviders } from "~/settings/usageDefaults";
import { resolveHour12 } from "~/timestampFormat";
import { ProviderInstanceIcon } from "~/t3-shims/ProviderInstanceIcon";
import { mergeAnsweredUsage, useUsage, type EnvironmentUsageStatus } from "~/state/usage";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
} from "~/shared/usageFormat";
import { formatUsageContractMismatch, usageSourceMessages } from "~/shared/usageFormatCopy";
import { HeaderPicker, UsageHeaderPortal } from "../AppHeader";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { LimitsErrorState, LimitsFooter } from "./UsageLimitsStates";
import { LimitsSkeleton } from "~/components/skeletons/LimitsSkeleton";
import { UsageScanStatus, UsageWaiting, useActiveFor } from "./UsageScanStatus";
import { prefetchUsage, type ScanProgress } from "~/api/usage";
import { useProviders } from "~/api";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { UsageLimitsSection } from "./UsageLimits";
import { UsagePriceOverrides } from "./UsagePriceOverrides";
import { formatUsageHour, UsageProviderChart } from "./UsageProviderChart";
import { SpeedPremium, UsageModelDialog } from "./UsageModelDialog";
import { UsageShareBar } from "./UsageShareBar";
import { UsageTableRegion } from "./UsageTableRegion";
import { MARK_CLASS, markStyle } from "./usageMarkColor";
import {
  costTypeSegments,
  modelShare,
  sortModelsByTokens,
  speedCostSegments,
  tokenTypeSegments,
} from "./usageBreakdown";
import {
  METRIC_OPTIONS,
  WINDOW_OPTIONS,
  resolveUsageShortcut,
  type UsageMetric,
  USAGE_SELECT_EVENT,
  type UsageSelectDetail,
} from "./usageShortcuts";
import {
  PROVIDER_ORDER,
  PROVIDER_PRESENTATION,
  configuredUsageProviders,
  filterEmptyProviders,
  providersWithUsage,
  rankProvidersByMetric,
  setUsageProvidersVisible,
} from "./usageProviders";
import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsagePagePreferences,
} from "./usagePagePreferences";
import type { LimitsReport } from "~/contracts";

function isUsageMetric(value: string | null | undefined): value is UsageMetric {
  return METRIC_OPTIONS.some((option) => option.value === value);
}

function isUsageWindowDays(value: number): value is UsagePagePreferences["windowDays"] {
  return WINDOW_OPTIONS.some((option) => option.days === value);
}

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

/** Keep dialog selection outside UsagePage so opening/closing rerenders only its host. */
function UsageModelDialogHost({
  models,
  selectedKey,
  onClose,
  onSetPrice,
  ...dialogProps
}: Omit<Parameters<typeof UsageModelDialog>[0], "model" | "onSetPrice" | "onClose"> & {
  readonly models: MergedUsage["models"];
  readonly selectedKey: string | null;
  readonly onClose: () => void;
  readonly onSetPrice: (model: string) => void;
}) {
  const model =
    selectedKey === null
      ? undefined
      : models.find((candidate) => `${candidate.provider}:${candidate.model}` === selectedKey);
  if (model === undefined) return null;
  return (
    <UsageModelDialog
      {...dialogProps}
      model={model}
      onSetPrice={() => {
        onClose();
        onSetPrice(model.model);
      }}
      onClose={onClose}
    />
  );
}

export function UsagePage({
  limits,
  limitsNow,
  limitsLoading,
  limitsError = null,
  onRefreshLimits,
  onClose,
  active = true,
}: {
  readonly limits: LimitsReport | null;
  readonly limitsNow: number;
  readonly limitsLoading: boolean;
  /** Last limits read failure, shown in place of the limits when there is nothing to show yet. */
  readonly limitsError?: string | null;
  readonly onRefreshLimits: () => void;
  readonly onClose?: () => void;
  /** False while another screen is shown (this page stays mounted): its shortcuts must not fire. */
  readonly active?: boolean;
}) {
  const [preferences, setPreferences] = useState(readUsagePagePreferences);
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const shortcutOf = (option: (typeof METRIC_OPTIONS)[number] | (typeof WINDOW_OPTIONS)[number]) =>
    shortcutLabelForCommand(defaultKeybindings, option.command, { context: { usagePageOpen: true } });
  const shortcutTitle = (
    option: (typeof METRIC_OPTIONS)[number] | (typeof WINDOW_OPTIONS)[number],
  ) => {
    const shortcut = shortcutOf(option);
    return shortcut
      ? gt("{label} ({shortcut})", { label: m(option.label), shortcut })
      : m(option.label);
  };
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: preferences.windowDays,
    window: makeWindow(
      preferences.windowDays,
      undefined,
      preferences.windowDays === 1 ? "hour" : "day",
    ),
  }));
  const metric = preferences.metric;
  const showingLimits = metric === "limits";
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [enteredLimitsAt, setEnteredLimitsAt] = useState(0);
  const refreshingRef = useRef(false);
  const [priceDialog, setPriceDialog] = useState<{ readonly model?: string } | null>(null);
  // This app always reads usage from this PC, so there is no environment picker: every environment is selected.
  const selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null;
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Memoised: `useUsage` compares this set by identity during render, so a fresh Set every render loops forever.
  const hiddenProviders = useMemo(() => new Set(preferences.hiddenProviders), [preferences.hiddenProviders]);
  // Settings > Usage writes this directly to storage; subscribing applies the toggle instantly,
  // with no Save/Apply step.
  const hideEmpty = useSyncExternalStore(subscribeHideEmptyProviders, getHideEmptyProviders, getHideEmptyProviders);
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const {
    merged: answeredUsage,
    environments,
    selectedEnvironments,
    shown,
    scan,
    stale,
    error: usageError,
    refresh,
  } = useUsage(window, selectedEnvironmentIds, hiddenProviders);
  // Skeletons only for the first moments; after that say what is happening (or what went wrong).
  const slowFirstLoad = useActiveFor(shown === null, 300);
  // Once this window is on screen, warm the other windows so switching 24h / 7 / 30 / 90 days is instant.
  const hasShown = shown !== null;
  const scanning = scan?.state === "scanning";
  useEffect(() => {
    if (!hasShown || scanning || showingLimits) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        prefetchUsage(
          [30, 7, 1, 90]
            .filter((days) => days !== windowDays)
            .map((days) => makeWindow(days, undefined, days === 1 ? "hour" : "day")),
          controller.signal,
        ),
      400,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [hasShown, scanning, showingLimits, windowDays]);
  const merged = shown?.merged ?? answeredUsage;
  const shownWindow: UsageSummaryInput = shown?.window ?? window;
  const shownHourly = shownWindow.resolution === "hour";
  const refreshingUsage = isRefreshing && !showingLimits;
  const showingKept = shown !== null && shown.window !== window;
  const usageReadFailed = usageError !== null &&
    !showingKept &&
    selectedEnvironments.every((environment) => environment.summary === null);
  const canReadDiagnostics = selectedEnvironments.some(
    (environment) => environment.canReadDiagnostics,
  );

  const updatePreferences = (patch: Partial<UsagePagePreferences>) => {
    const nextPreferences = { ...preferences, ...patch };
    setPreferences(nextPreferences);
    saveUsagePagePreferences(nextPreferences);
  };
  const selectWindow = (days: number) => {
    if (!isUsageWindowDays(days)) return;
    updatePreferences({ windowDays: days });
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const selectMetric = (nextMetric: UsageMetric) => {
    if (nextMetric === "limits") setEnteredLimitsAt(Date.now());
    updatePreferences({ metric: nextMetric });
  };

  const onUsageKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      !active ||
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      isCommandPaletteOpen() ||
      isModelPickerOpen()
    )
      return;

    const command = resolveUsageShortcut(event, defaultKeybindings);
    const metricOption = METRIC_OPTIONS.find((option) => option.command === command);
    const periodOption = WINDOW_OPTIONS.find((option) => option.command === command);
    if (!metricOption && !periodOption) return;

    event.preventDefault();
    event.stopPropagation();
    if (metricOption) selectMetric(metricOption.value);
    if (periodOption && !showingLimits) selectWindow(periodOption.days);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window capture keydown listener for usage metric and period shortcuts
  useEffect(() => {
    globalThis.window.addEventListener("keydown", onUsageKeyDown, true);
    return () => globalThis.window.removeEventListener("keydown", onUsageKeyDown, true);
  }, []);

  const onUsageSelect = useEffectEvent((event: Event) => {
    const detail = (event as CustomEvent<UsageSelectDetail>).detail;
    if (detail.type === "usageMetric") selectMetric(detail.metric);
    else if (WINDOW_OPTIONS.some((option) => option.days === detail.days)) selectWindow(detail.days);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window event from the command palette
  useEffect(() => {
    globalThis.window.addEventListener(USAGE_SELECT_EVENT, onUsageSelect);
    return () => globalThis.window.removeEventListener(USAGE_SELECT_EVENT, onUsageSelect);
  }, []);

  const refreshWindow = () => {
    if (refreshingRef.current) return;

    if (showingLimits) {
      refreshingRef.current = true;
      setIsRefreshing(true);
      onRefreshLimits();
      // T3 awaits its atom refresh; here App.tsx owns the request, so `limitsLoading` drives the
      // spinner and this local flag is released in the same batch.
      refreshingRef.current = false;
      setIsRefreshing(false);
      return;
    }
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay !== window.sinceDay ||
      nextWindow.untilDay !== window.untilDay ||
      nextWindow.sinceTime !== window.sinceTime ||
      nextWindow.untilTime !== window.untilTime
    ) {
      setWindowSelection({ days: windowDays, window: nextWindow });
    }
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refresh(nextWindow).finally(() => {
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };

  const days = enumerateDays(shownWindow.sinceDay, shownWindow.untilDay);
  const hours =
    shownWindow.sinceTime === undefined || shownWindow.untilTime === undefined
      ? []
      : enumerateHourStarts(shownWindow.sinceTime, shownWindow.untilTime);
  // Burnrate has no ChatGPT sharing flow; keep the T3 row but never show it here.
  const showChatGptSharing = false;

  const { data: providerInfo } = useProviders();
  // Connected or detected on this computer, per /api/providers — not the catalogue of every reader
  // the server could scan, so a provider the person does not use is not a checkbox.
  const connectedProviders = useMemo(
    () =>
      new Set(
        (providerInfo ?? [])
          .filter((provider) => provider.connected || provider.detected)
          .map((provider) => provider.id),
      ),
    [providerInfo],
  );
  const configuredProviders = useMemo(() => {
    if (showingLimits && limits !== null) {
      return configuredUsageProviders([], [], limits.accounts.map((account) => account.driver));
    }
    return configuredUsageProviders(
      selectedEnvironments.flatMap((environment) => environment.summary?.sources ?? []),
      merged.providers,
      connectedProviders,
    );
  }, [showingLimits, limits, selectedEnvironments, merged.providers, connectedProviders]);
  // "Hide empty providers" must agree with the ranking list and the chart legend: both are built from
  // providersWithUsage, so the filter menu offers the same set.
  const menuProviders = useMemo(() => {
    if (showingLimits || !hideEmpty) return configuredProviders;
    // Use the raw summaries, not `merged`: hidden providers are removed from `merged`, and a hidden
    // provider with data must stay in the menu so it can be shown again. A saved hidden provider that
    // still exists (connected, logs found, or usage) stays listed too.
    const withData = new Set([
      ...configuredProviders.filter((provider) => hiddenProviders.has(provider)),
      ...providersWithUsage(mergeAnsweredUsage(selectedEnvironments).providers),
    ]);
    return filterEmptyProviders(configuredProviders, withData, true);
  }, [showingLimits, hideEmpty, configuredProviders, selectedEnvironments, hiddenProviders]);
  const allProvidersHidden = menuProviders.length > 0 &&
    menuProviders.every((provider) => hiddenProviders.has(provider));
  const refreshBusy = isRefreshing || (showingLimits && limitsLoading);
  const refreshButton = (
    <Button
      onClick={refreshWindow}
      aria-label={showingLimits ? gt("Refresh limits") : gt("Refresh usage")}
      aria-busy={refreshBusy}
      disabled={refreshBusy || (!showingLimits && !canReadDiagnostics)}
      size="icon-sm"
      variant="ghost"
    >
      <RefreshIcon size="sm" refreshing={refreshBusy} />
    </Button>
  );
  // T3 draws these controls in the window header: `Usage / All providers v      [Cost|Tokens|Limits] R`. The header exposes slots; the page fills them via portals so it
  // still owns the filter/metric state. The header hides the slots on other screens (and the portal
  // renders nothing then), so a hidden-but-mounted Usage page never leaks controls into other views.
  const metricToggle = (
    <ToggleGroup
      aria-label={gt("Usage metric")}
      variant="segmented"
      value={[metric]}
      onValueChange={(next) => {
        const value = next[0];
        if (isUsageMetric(value)) selectMetric(value);
      }}
    >
      {METRIC_OPTIONS.map((option) => (
        <Tooltip key={option.value}>
          <TooltipTrigger render={<Toggle value={option.value} className="motion-reduce:transition-none" />}>
            {m(option.label)}
          </TooltipTrigger>
          <TooltipPopup>{shortcutTitle(option)}</TooltipPopup>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
  // The segmented period needs room (the bar's `@xl` container width, 36rem); narrower than that the same four
  // choices sit behind one menu, so the toolbar fits on a phone-width bar without scrolling.
  const periodLabel = m(
    (WINDOW_OPTIONS.find((option) => option.days === windowDays) ?? WINDOW_OPTIONS[0]).label,
  );
  const periodMenu = showingLimits ? null : (
    <Menu>
      <MenuTrigger
        render={<Button size="compact" variant="ghost" className="@xl/usage-header:hidden" />}
        aria-label={gt("Usage period: {period}", { period: periodLabel })}
      >
        {periodLabel}
        <ChevronDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          aria-label={gt("Usage period")}
          value={String(windowDays)}
          onValueChange={(value) => selectWindow(Number(value))}
        >
          {WINDOW_OPTIONS.map((option) => {
            const shortcut = shortcutOf(option);
            return (
              <MenuRadioItem key={option.days} value={String(option.days)}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{m(option.label)}</span>
                  {shortcut ? <MenuShortcut className="ps-4">{shortcut}</MenuShortcut> : null}
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
  const periodToggle = showingLimits ? null : (
    <ToggleGroup
      aria-label={gt("Usage period")}
      variant="segmented"
      className="hidden max-w-full flex-wrap @xl/usage-header:flex"
      value={[String(windowDays)]}
      onValueChange={(next) => {
        const value = next[0];
        if (value) selectWindow(Number(value));
      }}
    >
      {WINDOW_OPTIONS.map((option) => (
        <Tooltip key={option.days}>
          <TooltipTrigger render={<Toggle value={String(option.days)} className="motion-reduce:transition-none" />}>
            {m(option.label)}
          </TooltipTrigger>
          <TooltipPopup>{shortcutTitle(option)}</TooltipPopup>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
  const providerFilter = (
    <UsageProviderFilter
      providers={menuProviders}
      hiddenProviders={hiddenProviders}
      onChange={(next) => updatePreferences({ hiddenProviders: next })}
    />
  );

  return (
    <>
      <UsageHeaderPortal slot="provider">{providerFilter}</UsageHeaderPortal>
      <UsageHeaderPortal slot="actions">
        {periodToggle}
        {periodMenu}
        {metricToggle}
        {refreshButton}
      </UsageHeaderPortal>
      <AppRouteModal label={gt("Usage")} onClose={onClose}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="usage">
            {selectedEnvironments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {showingLimits
                  ? gt("Limits aren't available on this PC yet.")
                  : gt("Usage isn't available on this PC yet.")}
              </p>
            ) : allProvidersHidden ? (
              <Empty size="compact">
                <EmptyHeader>
                  <EmptyTitle>
                    <T>Every provider is hidden</T>
                  </EmptyTitle>
                  <EmptyDescription>
                    {showingLimits
                      ? gt("Show at least one provider to see limits.")
                      : gt("Show at least one provider to see usage.")}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => updatePreferences({ hiddenProviders: [] })}
                  >
                    <EyeIcon aria-hidden />
                    {gt("Show all providers")}
                  </Button>
                </EmptyContent>
              </Empty>
            ) : showingLimits ? (
              limits === null ? (
                limitsError !== null ? (
                  <LimitsErrorState error={limitsError} onRetry={onRefreshLimits} />
                ) : (
                  <LimitsSkeleton />
                )
              ) : (
                <>
                  <UsageLimitsSection
                    accounts={limits.accounts}
                    notices={limits.notices}
                    hiddenProviders={hiddenProviders}
                    now={Math.max(limitsNow, enteredLimitsAt)}
                    hostLabel={limits.hostLabel}
                  />
                  {limits.accounts.length > 0 ? (
                    <LimitsFooter
                      checkedAt={limits.createdAt}
                      now={limitsNow}
                      error={limitsError}
                      refreshing={limitsLoading}
                      onRefresh={onRefreshLimits}
                    />
                  ) : null}
                </>
              )
            ) : usageReadFailed ? (
              <UsageWaiting scan={scan} error={usageError} onRetry={() => void refresh()} />
            ) : shown === null ? (
              slowFirstLoad || usageError !== null ? (
                <UsageWaiting scan={scan} error={usageError} onRetry={() => void refresh()} />
              ) : (
                <UsageSkeleton />
              )
            ) : scanning && usageError === null && shown.merged.records === 0 ? (
              <UsageWaiting scan={scan} error={null} onRetry={() => void refresh()} />
            ) : !canReadDiagnostics ? (
              <Alert variant="error" role="alert">
                <TriangleAlertIcon />
                <AlertTitle>
                  <T>Couldn't read usage</T>
                </AlertTitle>
                <AlertDescription>
                  {selectedEnvironments.map((environment) => (
                    <p key={environment.environmentId}>
                      {selectedEnvironments.length > 1
                        ? gt("{environment}: {error}", {
                            environment: environment.label,
                            error: environment.error,
                          })
                        : environment.error}
                    </p>
                  ))}
                </AlertDescription>
              </Alert>
            ) : (
              <>
                {usageError !== null ? (
                  <Alert variant="warning" role="status">
                    <AlertDescription>{gt("Couldn't refresh usage. Showing the last available data.")}</AlertDescription>
                    <AlertAction>
                      <Button size="xs" variant="outline" onClick={refreshWindow} disabled={refreshBusy}>
                        <T>Try again</T>
                      </Button>
                    </AlertAction>
                  </Alert>
                ) : null}
                <UsageOverview
                  merged={merged}
                  configuredProviders={configuredProviders}
                  shownWindow={shownWindow}
                  hideEmpty={hideEmpty}
                  hour12={hour12}
                  days={days}
                  hours={hours}
                  showingKept={showingKept && usageError === null}
                  metric={metric === "tokens" ? "tokens" : "cost"}
                  selectedEnvironments={selectedEnvironments}
                  hiddenProviders={hiddenProviders}
                  refreshingUsage={refreshingUsage}
                  showChatGptSharing={showChatGptSharing}
                  onSelectModel={(key, trigger) => {
                    modelTriggerRef.current = trigger;
                    setSelectedModelKey(key);
                  }}
                  scan={scan}
                  stale={stale && usageError === null}
                />
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {showingLimits ? null : (
        <UsageModelDialogHost
          models={merged.models}
          selectedKey={selectedModelKey}
          onClose={() => setSelectedModelKey(null)}
          returnFocusRef={modelTriggerRef}
          environments={selectedEnvironments}
          metric={metric === "tokens" ? "tokens" : "cost"}
          chartWindow={{
            days,
            hours,
            resolution: shownHourly ? "hour" : "day",
            timeZone: shownWindow.timeZone,
            referenceTime: shownWindow.untilTime,
            hour12,
          }}
          onSetPrice={(model) => setPriceDialog({ model })}
        />
      )}
      {priceDialog ? (
        <UsagePriceOverrides
          usage={environments}
          initialSelectedEnvironmentIds={selectedEnvironmentIds}
          initialModel={priceDialog.model}
          returnFocusRef={modelTriggerRef}
          onOpenChange={(open) => {
            if (!open) setPriceDialog(null);
          }}
        />
      ) : null}
      </AppRouteModal>
    </>
  );
}

function UsageOverview({
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
  return cn("motion-safe:transition-opacity", loading && "opacity-80 motion-safe:delay-150");
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

function UsageProviderFilter({
  providers,
  hiddenProviders,
  onChange,
}: {
  /** Only what this person has set up; the menu scrolls inside the window if the list is long. */
  readonly providers: readonly UsageProviderKind[];
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly onChange: (hiddenProviders: readonly UsageProviderKind[]) => void;
}) {
  const gt = useGT();
  const visible = providers.filter((provider) => !hiddenProviders.has(provider));
  const label =
    visible.length === providers.length
      ? gt("All providers")
      : visible.length === 0
        ? gt("No providers")
        : visible.length === 1
          ? PROVIDER_PRESENTATION[visible[0]!].label
          : gt("{count, plural, one {{count} providers} other {{count} providers}}", {
              count: visible.length,
            });

  return (
    <Menu>
      <MenuTrigger render={<HeaderPicker />} aria-label={gt("Provider filter: {selection}", { selection: label })}>
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </MenuTrigger>
      <MenuPopup align="start" aria-label={gt("Filter by provider")} className="[&>div]:overscroll-contain motion-reduce:transition-none">
        <MenuCheckboxItem
          checked={visible.length === providers.length}
          closeOnClick={false}
          disabled={providers.length === 0}
          onCheckedChange={(checked) => onChange(setUsageProvidersVisible(hiddenProviders, providers, checked))}
        >
          <T>All providers</T>
        </MenuCheckboxItem>
        <MenuSeparator />
        {providers.map((provider) => (
          <MenuCheckboxItem
            key={provider}
            checked={!hiddenProviders.has(provider)}
            closeOnClick={false}
            onCheckedChange={(checked) => onChange(setUsageProvidersVisible(hiddenProviders, [provider], checked))}
          >
            <span className="flex min-w-0 items-center gap-2">
              <ProviderMark provider={provider} className="size-3.5" />
              <span className="truncate">{PROVIDER_PRESENTATION[provider].label}</span>
            </span>
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function UsageSkeleton() {
  const gt = useGT();
  return (
    <div className="flex flex-col gap-6">
      <p role="status" className="sr-only">
        {gt("Loading usage…")}
      </p>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-10 w-36" />
            <Skeleton className="h-4 w-32" />
          </div>
          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <Skeleton shape="pill" className="size-2 shrink-0" />
                  <Skeleton shape="pill" className="size-4 shrink-0" />
                  <Skeleton className="h-3.5 w-20" />
                </span>
                <Skeleton className="h-3.5 w-14" />
              </div>
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-24" />
          <div className="flex flex-col gap-1">
            <Skeleton className="ml-16 h-56" />
            <Skeleton className="ml-16 h-4" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">
          <T>Totals</T>
        </h2>
        <MetricSkeletons
          labels={[
            gt("Processed tokens"),
            gt("Cached input"),
            gt("Uncached input"),
            gt("Output", { $context: "output tokens" }),
            gt("Cache savings"),
          ]}
        />
      </section>

      <section className="grid gap-x-12 gap-y-8 lg:grid-cols-2">
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-2" />
          <Skeleton className="h-4 w-72" />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">
            <T>Breakdown</T>
          </h2>
          <Skeleton shape="card" className="h-7 w-28" />
        </div>
        <Skeleton className="h-44" />
      </section>
    </div>
  );
}

function MetricSkeletons({ labels }: { readonly labels: readonly string[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
      {labels.map((label) => (
        <div key={label} className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Skeleton className="h-6 w-16" />
        </div>
      ))}
    </div>
  );
}
