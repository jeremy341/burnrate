import { RefreshIcon } from "../ui/refresh-icon";
import { type EnvironmentId, type UsageProviderKind, type UsageSummaryInput } from "~/contracts";
import { ChevronDownIcon, EyeIcon, TriangleAlertIcon } from "lucide-react";
import { T, useGT, useMessages } from "~/i18n";
import { lazy, Suspense, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppRouteModal } from "~/t3-shims/app-route-modal";
import { defaultKeybindings, shortcutLabelForCommand } from "~/t3-shims/keybindings";
import { isCommandPaletteOpen, isModelPickerOpen } from "~/t3-shims/overlays";

import { type MergedUsage } from "~/shared/usageMerge";

import { usePrimarySettings } from "~/hooks/useSettings";
import { getHideEmptyProviders, subscribeHideEmptyProviders } from "~/settings/usageDefaults";
import { resolveHour12 } from "~/timestampFormat";
import { ProviderInstanceIcon } from "~/t3-shims/ProviderInstanceIcon";
import { mergeAnsweredUsage, useUsage } from "~/state/usage";
import { enumerateDays, enumerateHourStarts, makeWindow } from "~/shared/usageFormat";
import { HeaderPicker, UsageHeaderPortal } from "../AppHeader";
import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { LimitsErrorState, LimitsFooter } from "./UsageLimitsStates";
import { LimitsSkeleton } from "~/components/skeletons/LimitsSkeleton";
import { UsageWaiting, useActiveFor } from "./UsageScanStatus";
import { prefetchUsage } from "~/api/usage";
import { useProviders } from "~/api";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { UsageLimitsSection } from "./UsageLimits";
import { LimitsClock, useLimitsClockNow } from "./LimitsClock";


import type { UsageModelDialog as UsageModelDialogComponent } from "./UsageModelDialog";
import { METRIC_OPTIONS, WINDOW_OPTIONS, resolveUsageShortcut, type UsageMetric, USAGE_SELECT_EVENT, type UsageSelectDetail } from "./usageShortcuts";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION, configuredUsageProviders, filterEmptyProviders, providersWithUsage, setUsageProvidersVisible } from "./usageProviders";
import { readUsagePagePreferences, saveUsagePagePreferences, type UsagePagePreferences } from "./usagePagePreferences";
import type { LimitsReport } from "~/contracts";

const UsageOverview = lazy(() => import("./UsageOverview").then((module) => ({ default: module.UsageOverview })));
const UsageModelDialog = lazy(() => import("./UsageModelDialog").then((module) => ({ default: module.UsageModelDialog })));
const UsagePriceOverrides = lazy(() => import("./UsagePriceOverrides").then((module) => ({ default: module.UsagePriceOverrides })));

function isUsageMetric(value: string | null | undefined): value is UsageMetric {
  return METRIC_OPTIONS.some((option) => option.value === value);
}

function isUsageWindowDays(value: number): value is UsagePagePreferences["windowDays"] {
  return WINDOW_OPTIONS.some((option) => option.days === value);
}

/** Keep dialog selection outside UsagePage so opening/closing rerenders only its host. */
function UsageModelDialogHost({
  models,
  selectedKey,
  onClose,
  onSetPrice,
  ...dialogProps
}: Omit<Parameters<typeof UsageModelDialogComponent>[0], "model" | "onSetPrice" | "onClose"> & {
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
  limitsLoading,
  limitsError = null,
  onRefreshLimits,
  onClose,
  active = true,
}: {
  readonly limits: LimitsReport | null;
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

  const days = useMemo(() => enumerateDays(shownWindow.sinceDay, shownWindow.untilDay),
    [shownWindow.sinceDay, shownWindow.untilDay]);
  const hours = useMemo(() =>
    shownWindow.sinceTime === undefined || shownWindow.untilTime === undefined
      ? []
      : enumerateHourStarts(shownWindow.sinceTime, shownWindow.untilTime),
    [shownWindow.sinceTime, shownWindow.untilTime]);
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
                <LimitsClock enabled={active}>
                  <UsageLimitsSection
                    accounts={limits.accounts}
                    notices={limits.notices}
                    hiddenProviders={hiddenProviders}
                    now={Math.max(Date.now(), enteredLimitsAt)}
                    hostLabel={limits.hostLabel}
                  />
                  {limits.accounts.length > 0 ? (
                    <TimedLimitsFooter
                      checkedAt={limits.createdAt}
                      error={limitsError}
                      refreshing={limitsLoading}
                      onRefresh={onRefreshLimits}
                    />
                  ) : null}
                </LimitsClock>
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
                <Suspense fallback={<UsageSkeleton />}>
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
                </Suspense>
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {showingLimits || selectedModelKey === null ? null : (
        <Suspense fallback={<p role="status" className="fixed top-4 right-4 z-50 rounded-lg border bg-background px-4 py-3 text-sm shadow-lg">{gt("Loading model details…")}</p>}><UsageModelDialogHost
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
        /></Suspense>
      )}
      {priceDialog ? (
        <Suspense fallback={<p role="status" className="fixed top-4 right-4 z-50 rounded-lg border bg-background px-4 py-3 text-sm shadow-lg">{gt("Loading price settings…")}</p>}><UsagePriceOverrides
          usage={environments}
          initialSelectedEnvironmentIds={selectedEnvironmentIds}
          initialModel={priceDialog.model}
          returnFocusRef={modelTriggerRef}
          onOpenChange={(open) => {
            if (!open) setPriceDialog(null);
          }}
        /></Suspense>
      ) : null}
      </AppRouteModal>
    </>
  );
}

function TimedLimitsFooter(props: Omit<Parameters<typeof LimitsFooter>[0], "now">) {
  const now = useLimitsClockNow(Date.now());
  return <LimitsFooter {...props} now={now} />;
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
