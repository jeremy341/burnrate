import { GaugeIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLimits, useProviders } from "~/api";
import {
  AppNavProvider,
  HeaderRefreshButton,
  ScreenHeader,
  UsageHeaderSlotsProvider,
  useUsageHeaderSlots,
  type AppNav,
  type AppScreen,
} from "~/components/AppHeader";
import {
  createNavShortcuts,
  HOME_VIEW,
  isNavKeyboardClaimed,
  navShortcutHint,
  SETTINGS_VIEW,
  shouldShowHomeClose,
  useViewRoute,
} from "~/components/ui/app-nav";
import { APP_CONTENT_ATTRIBUTE, AppMain, AppShell } from "~/components/ui/app-shell";
import { ScrollArea } from "~/components/ui/scroll-area";
import { TooltipProvider } from "~/components/ui/tooltip";
import { UsagePage } from "~/components/usage/UsagePage";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { useGT } from "~/i18n";
import { OPEN_ONBOARDING_EVENT, OPEN_SETTINGS_EVENT } from "~/onboarding";
import { onPaletteAction } from "~/palette";
import { useSettings } from "~/settings/store";
import { useLimitsPolling } from "~/state/usage";
import { VIEWS, viewHasRefresh } from "~/views/registry";
import type { ViewDef, ViewProps } from "~/views/types";

const VIEW_IDS: readonly string[] = [HOME_VIEW, ...VIEWS.map((view) => view.id)];
const RetainedUsagePage = memo(UsagePage, (previous, next) =>
  previous.active === next.active && (!next.active || (
    previous.limits === next.limits && previous.limitsLoading === next.limitsLoading &&
    previous.limitsError === next.limitsError && previous.onRefreshLimits === next.onRefreshLimits &&
    previous.onClose === next.onClose
  )),
);

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac/i.test(nav.userAgentData?.platform ?? nav.platform ?? "");
}

/** The open Settings section's name, read from the page's own navigation (no coupling to its state). */
export function readSettingsSectionName(root: Pick<ParentNode, "querySelector"> | null): string | null {
  const name = root?.querySelector('[data-settings-section][aria-current="page"]')?.textContent?.trim();
  return name || null;
}

function useSettingsSectionName(enabled: boolean): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const root = document.querySelector('[data-slot="app-shell"]');
    if (!root) return;
    const read = () => setName(readSettingsSectionName(root));
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-current"],
    });
    return () => observer.disconnect();
  }, [enabled]);
  return name;
}

/**
 * A polite status message after the screen changes ("Providers"), so a screen reader hears the move that
 * sighted users see. Empty on first render: the page load itself is announced by the document title.
 */
function useScreenAnnouncement(view: string, title: string): string {
  const [announcement, setAnnouncement] = useState("");
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    setAnnouncement(title);
  }, [view, title]);
  return announcement;
}

const SecondaryScreen = memo(function SecondaryScreen({
  def,
  active,
  props,
}: {
  readonly def: ViewDef;
  readonly active: boolean;
  readonly props: ViewProps;
}) {
  return (
    <div
      className={active ? "relative flex min-h-0 min-w-0 flex-1 flex-col outline-none" : "hidden"}
      inert={!active}
      data-screen-active={active ? "" : undefined}
      {...{ [APP_CONTENT_ATTRIBUTE]: "" }}
      tabIndex={-1}
    >
      {def.id === SETTINGS_VIEW ? (
        <def.Component {...props} />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            <def.Component {...props} />
          </WorkspacePageContainer>
        </ScrollArea>
      )}
    </div>
  );
}, (previous, next) =>
  previous.def === next.def && previous.active === next.active &&
  (!next.active || previous.props === next.props),
);

export function App() {
  const gt = useGT();
  const { view, navigate } = useViewRoute(VIEW_IDS);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set());
  const limits = useLimits();
  const providers = useProviders();

  const refreshIntervalSec = useSettings((s) => s.usage.refreshIntervalSec);
  const refreshOnFocus = useSettings((s) => s.usage.refreshOnFocus);
  const pollWhenHidden = useSettings((s) => s.usage.pollWhenHidden);
  const polling = useLimitsPolling(limits, {
    refreshIntervalSec,
    refreshOnFocus,
    pollWhenHidden,
    active: view === HOME_VIEW,
  });

  // Refresh (throttled to five minutes) when returning to the view that hosts Limits.
  const previousViewRef = useRef(view);
  useEffect(() => {
    if (previousViewRef.current !== view && view === HOME_VIEW) polling.onLimitsEnter();
    previousViewRef.current = view;
  }, [view, polling.onLimitsEnter]);

  // Keep every visited secondary view mounted; switching must not reset its state or scroll.
  useEffect(() => {
    if (view === HOME_VIEW) return;
    setVisited((current) => (current.has(view) ? current : new Set(current).add(view)));
  }, [view]);

  const refreshLimits = useCallback(() => polling.refresh(), [polling.refresh]);
  // Providers draws each row's percentage from the limits read, so its refresh re-reads both.
  const refreshProviders = useCallback(() => {
    void providers.reload();
    refreshLimits();
  }, [providers.reload, refreshLimits]);
  const activeViewDef = VIEWS.find((candidate) => candidate.id === view);
  const activeTitle = gt(activeViewDef?.title ?? "Usage");
  const settingsSection = useSettingsSectionName(view === SETTINGS_VIEW);
  const screenAnnouncement = useScreenAnnouncement(view, activeTitle);
  const { slots: usageHeaderSlots, refs: usageHeaderRefs } = useUsageHeaderSlots();

  // The window title follows the view, so history entries and the taskbar say where you are.
  useEffect(() => {
    document.title = `${activeTitle} · Burnrate`;
  }, [activeTitle]);

  // Commands from the palette and links from onboarding/settings arrive as events.
  const refreshRef = useRef(refreshLimits);
  refreshRef.current = refreshLimits;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    const openSettings = (sectionId?: string) => {
      if (sectionId) window.location.hash = `settings/${sectionId}`;
      navigateRef.current("settings");
    };
    const offPalette = onPaletteAction((action) => {
      switch (action.type) {
        case "switchView":
          navigateRef.current(action.viewId);
          return true;
        case "openSettings":
          openSettings(action.sectionId);
          return true;
        case "refreshLimits":
          refreshRef.current();
          return true;
        case "addProvider":
        case "connectAgent":
          navigateRef.current("providers");
          return true;
        default:
          return false;
      }
    });
    const onOpenSettings = (event: Event) =>
      openSettings((event as CustomEvent<{ section?: string }>).detail?.section);
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);
    // The welcome dialog is gone: "connect your agents" is the Providers screen.
    const onOpenConnect = () => navigateRef.current("providers");
    window.addEventListener(OPEN_ONBOARDING_EVENT, onOpenConnect);
    return () => {
      offPalette();
      window.removeEventListener(OPEN_ONBOARDING_EVENT, onOpenConnect);
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);
    };
  }, []);

  // Capture phase: an open menu or dialog is still in the DOM when Esc is judged, so it keeps its own Esc.
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const shortcuts = createNavShortcuts();
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]')) {
        shortcuts.reset();
        return;
      }
      const result = shortcuts.resolve(event, {
        view: viewRef.current,
        validIds: VIEW_IDS,
        suppressed: isNavKeyboardClaimed(event.target, document),
        mac: isMacPlatform(),
        now: Date.now(),
      });
      if (result === null || result.type === "pending") return;
      event.preventDefault();
      navigateRef.current(result.type === "back" ? HOME_VIEW : result.viewId);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const mac = isMacPlatform();
  const screens = useMemo<readonly AppScreen[]>(
    () => [
      { id: HOME_VIEW, title: gt("Usage"), icon: GaugeIcon, hint: navShortcutHint(HOME_VIEW, mac) },
      ...VIEWS.map((v) => ({
        id: v.id,
        title: gt(v.title),
        icon: v.icon,
        hint: navShortcutHint(v.id, mac),
      })),
    ],
    [gt, mac],
  );
  const homeClose = useMemo(() => shouldShowHomeClose(document.documentElement.dataset), []);
  const nav = useMemo<AppNav>(
    () => ({
      view,
      screens,
      navigate,
      homeClose,
      close: () => {
        if (viewRef.current === HOME_VIEW) window.close();
        else navigateRef.current(HOME_VIEW);
      },
    }),
    [view, screens, navigate, homeClose],
  );

  const closeSecondary = useCallback(() => navigate(HOME_VIEW), [navigate]);
  const viewProps = useMemo<ViewProps>(() => ({ providers, limits, close: closeSecondary }),
    [providers, limits, closeSecondary]);

  return (
    <TooltipProvider><AppNavProvider value={nav}>
      <UsageHeaderSlotsProvider slots={usageHeaderSlots}>
        <AppShell label={activeTitle}>
          {/* One T3 bar for every screen. On Usage the page portals its filters, metric toggle and refresh
              into it (UsageHeaderPortal); elsewhere it is `Usage v / <screen>` plus that screen's refresh:
              Providers re-reads its provider list and the limits behind its rows, any other screen re-reads the limits. */}
          <ScreenHeader
            screenId={view}
            title={activeTitle}
            section={view === SETTINGS_VIEW ? settingsSection : null}
            slots={view === HOME_VIEW ? usageHeaderRefs : undefined}
            actions={
              activeViewDef && viewHasRefresh(activeViewDef) ? (
                activeViewDef.id === "providers" ? (
                  <HeaderRefreshButton
                    label={gt("Refresh providers")}
                    busy={providers.loading || limits.loading}
                    onClick={refreshProviders}
                  />
                ) : (
                  <HeaderRefreshButton
                    label={gt("Refresh limits")}
                    busy={limits.loading}
                    onClick={refreshLimits}
                  />
                )
              ) : null
            }
          />
          <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {screenAnnouncement}
          </div>
          <AppMain label={activeTitle}>
          {/* Usage is the home screen and stays mounted (only hidden/inert), so switching screens never
              resets its period, selection or scroll. */}
          <div
            className={view === HOME_VIEW ? "flex min-h-0 min-w-0 flex-1 flex-col outline-none" : "hidden"}
            inert={view !== HOME_VIEW}
            data-screen-active={view === HOME_VIEW ? "" : undefined}
            {...{ [APP_CONTENT_ATTRIBUTE]: "" }}
            tabIndex={-1}
          >
            <RetainedUsagePage
              active={view === HOME_VIEW}
              limits={limits.data}
              limitsLoading={limits.loading}
              limitsError={limits.error}
              onRefreshLimits={refreshLimits}
            />
          </div>

          {/* Visited secondary screens are kept mounted the same way. */}
          {VIEWS.filter((v) => visited.has(v.id) || v.id === view).map((v) => (
            <SecondaryScreen
              key={v.id}
              def={v}
              active={view === v.id}
              props={viewProps}
            />
          ))}
          </AppMain>
        </AppShell>
      </UsageHeaderSlotsProvider>
    </AppNavProvider></TooltipProvider>
  );
}
