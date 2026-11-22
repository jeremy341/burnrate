import { ArrowLeftIcon, ChevronDownIcon, SearchIcon, SettingsIcon, XIcon } from "lucide-react";
import {
  createContext,
  use,
  useMemo,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { hasDesktopWindowControls } from "~/api/desktopWindow";
import { HOME_VIEW, SETTINGS_VIEW, settingsGearTarget } from "~/components/ui/app-nav";
import { T, useGT } from "~/i18n";
import { cn } from "~/lib/utils";
import { openPalette } from "~/palette/actions";

import { Button, InlineButton } from "./ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuShortcut, MenuTrigger } from "./ui/menu";
import { RefreshIcon } from "./ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { WindowControls } from "./ui/window-controls";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "./WorkspaceBreadcrumb";

export interface AppScreen {
  readonly id: string;
  readonly title: string;
  readonly icon: ComponentType<{ className?: string }>;
  /** Shortcut hint shown in the switcher, e.g. "G P" or "Ctrl ,". */
  readonly hint?: string;
}

export interface AppNav {
  readonly view: string;
  readonly screens: readonly AppScreen[];
  readonly navigate: (id: string) => void;
  /** Whether the browser close button is drawn on the home screen. */
  readonly homeClose: boolean;
  /** Back to Usage; on Usage itself, closes the window. */
  readonly close: () => void;
}

const AppNavContext = createContext<AppNav | null>(null);

export function AppNavProvider({ value, children }: { value: AppNav; children: ReactNode }) {
  return <AppNavContext value={value}>{children}</AppNavContext>;
}

export function useAppNav(): AppNav | null {
  return use(AppNavContext);
}

/**
 * T3's window header: one row at `--workspace-topbar-height`, bottom border, full width. Border only:
 * no card, no rounded corner, no shadow. The safe-area-aware gutters are the same tokens T3's
 * `WorkspacePageHeader` uses, so the breadcrumb lines up with every screen's first column.
 */
export function AppHeader({ children }: { children: ReactNode }) {
  const desktop = hasDesktopWindowControls();
  return (
    <header
      className={cn(
        "@container/usage-header flex min-h-(--workspace-topbar-height) shrink-0 items-center gap-3 border-b ps-(--workspace-gutter-start) pe-(--workspace-gutter-end)",
        desktop && "select-none",
      )}
      data-tauri-drag-region={desktop ? "deep" : undefined}
    >
      {children}
    </header>
  );
}

/**
 * A breadcrumb picker in the header: the primitive's picker tone (muted for context in front of another
 * crumb), at least 24px square on a pointer and 44px on touch, and truncating its label rather than growing the bar.
 * The side padding gives the inset focus ring room, so it never lands on the first letter.
 */
export function HeaderPicker({ tone = "picker", className, ...props }: ComponentProps<typeof InlineButton>) {
  return (
    <InlineButton tone={tone} touchTarget="padded" className={cn("min-h-6 min-w-6 max-w-full px-1", className)} {...props} />
  );
}

/**
 * The breadcrumb's first segment doubles as a screen menu, with a persistent disclosure chevron.
 * The trigger reads the CURRENT screen's title (it opens the same menu on every screen), so a
 * screen never repeats its own name in a second crumb. `emphasized` marks the page's own heading
 * (nothing follows it); as context in front of a picker the title stays muted, as in T3's Usage header.
 */
export function AppScreenSwitcher({
  current = HOME_VIEW,
  emphasized = false,
}: {
  current?: string;
  emphasized?: boolean;
}) {
  const gt = useGT();
  const nav = useAppNav();
  const fallback = gt("Usage");
  if (!nav) return <WorkspaceBreadcrumbText>{fallback}</WorkspaceBreadcrumbText>;
  const title = nav.screens.find(({ id }) => id === current)?.title ?? fallback;
  return (
    <Menu>
      <MenuTrigger
        render={<HeaderPicker tone={emphasized ? "picker" : "muted"} />}
        aria-label={gt("{screen}, switch screen", { screen: title })}
      >
        <WorkspaceBreadcrumbText>{title}</WorkspaceBreadcrumbText>
        <ChevronDownIcon
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup value={current} onValueChange={(next) => nav.navigate(String(next))}>
          {nav.screens.map((screen) => (
            <MenuRadioItem key={screen.id} value={screen.id}>
              <span className="flex min-w-0 items-center gap-2">
                <screen.icon className="text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{screen.title}</span>
                {screen.hint ? <MenuShortcut className="ps-4">{screen.hint}</MenuShortcut> : null}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** T3's `AppRouteModalClose`, minus the dialog: a ghost icon button with a tooltip. */
export function AppModalClose({
  onClose,
  escToClose = false,
  backToUsage = false,
}: {
  onClose: () => void;
  /** Only advertise the Esc shortcut where Esc actually closes the surface. */
  escToClose?: boolean;
  backToUsage?: boolean;
}) {
  const gt = useGT();
  const label = backToUsage ? gt("Back to Usage") : gt("Close");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            onClick={onClose}
            size="icon-sm"
            variant="ghost"
            data-slot="app-close"
          />
        }
      >
        {backToUsage ? <ArrowLeftIcon /> : <XIcon />}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {backToUsage ? <T>Back to Usage (Esc)</T> : escToClose ? <T>Close (Esc)</T> : label}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * On a secondary screen this control goes back to Usage, so it is named and drawn as that in every
 * client. On Usage it closes the window, and the desktop title bar already has that button.
 */
export function AppHeaderClose() {
  const nav = useAppNav();
  if (!nav) return null;
  const onHome = nav.view === HOME_VIEW;
  const desktop = hasDesktopWindowControls();
  if (onHome && (desktop || !nav.homeClose)) return null;
  return <AppModalClose onClose={nav.close} escToClose={!onHome} backToUsage={!onHome} />;
}

/**
 * Right end of every header: the close X (browser) or, in the desktop shell, back-to-Usage plus the
 * native window commands. The Settings gear sits at the LEFT end of the header (`HeaderSettingsButton`,
 * drawn by `ScreenHeader`); Settings is also an entry of the "Usage" breadcrumb menu, the command palette,
 * Ctrl/Cmd+, and `G S`.
 */
export function AppHeaderEnd({ screenId }: { screenId?: string }) {
  const nav = useAppNav();
  const desktop = hasDesktopWindowControls();
  if (!desktop) return <AppHeaderClose />;
  return (
    <>
      <AppHeaderClose />
      <WindowControls active={!screenId || nav?.view === screenId} />
    </>
  );
}

/**
 * The Settings gear. A first-time user does not know that the breadcrumb is a menu or that Ctrl+, exists,
 * so Settings is also a plain icon button at the left of the header. It has a name for
 * assistive tech, a tooltip that includes the shortcut, and `aria-current="page"` plus an underline while
 * Settings is the open screen (no `box-shadow`, so the focus ring is never overridden). Pressed again
 * while Settings is open it goes back to Usage; the button stays mounted, so focus stays on it.
 */
export function HeaderSettingsButton() {
  const gt = useGT();
  const nav = useAppNav();
  if (!nav) return null;
  const open = nav.view === SETTINGS_VIEW;
  const hint = nav.screens.find((screen) => screen.id === SETTINGS_VIEW)?.hint;
  const label = gt("Settings");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-current={open ? "page" : undefined}
            onClick={() => nav.navigate(settingsGearTarget(nav.view))}
            size="icon-sm"
            variant="ghost"
            data-slot="app-settings"
            data-state={open ? "open" : "closed"}
          />
        }
      >
        <SettingsIcon aria-hidden />
        {/* A child, not ::after: Button's ::after is the 44px touch hit area. */}
        {open ? <span aria-hidden className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-primary" /> : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {open ? <T>Back to Usage (Esc)</T> : hint ? `${label} (${hint})` : label}
      </TooltipPopup>
    </Tooltip>
  );
}

function HeaderPaletteButton() {
  const gt = useGT();
  const label = gt("Command palette");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-keyshortcuts="Control+K Meta+K"
            aria-haspopup="dialog"
            onClick={(event) => openPalette({ trigger: event.currentTarget })}
            size="icon-sm"
            variant="ghost"
            data-slot="app-palette"
          />
        }
      >
        <SearchIcon aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{gt("Command palette (Ctrl+K / ⌘K)")}</TooltipPopup>
    </Tooltip>
  );
}

/** A refresh icon button with a tooltip; the caller owns what refreshing means. */
export function HeaderRefreshButton({
  label,
  busy,
  disabled = false,
  onClick,
}: {
  label: string;
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            onClick={onClick}
            aria-label={label}
            aria-busy={busy}
            disabled={busy || disabled}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <RefreshIcon size="sm" refreshing={busy} />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The Usage page owns the metric, the provider filter and the refresh, but T3 draws
 * them in the window header: `Usage / All providers v      [Cost|Tokens|Limits] R X`. There is no
 * environment picker: the app always reads this PC.
 * The header therefore exposes two slots that the page fills with `UsageHeaderPortal`:
 *
 *   provider               breadcrumb picker (the portal adds the leading "/")
 *   actions                right cluster: period toggle, metric toggle, refresh
 */
export type UsageHeaderSlotName = "provider" | "actions";
export type UsageHeaderSlots = Readonly<Record<UsageHeaderSlotName, HTMLElement | null>>;
export type UsageHeaderSlotRefs = Readonly<
  Record<UsageHeaderSlotName, (element: HTMLElement | null) => void>
>;

const NO_SLOTS: UsageHeaderSlots = { provider: null, actions: null };
const UsageHeaderSlotsContext = createContext<UsageHeaderSlots>(NO_SLOTS);

/** Owns the slot elements: give `refs` to `ScreenHeader` and `slots` to `UsageHeaderSlotsProvider`. */
export function useUsageHeaderSlots(): { slots: UsageHeaderSlots; refs: UsageHeaderSlotRefs } {
  const [provider, setProvider] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const slots = useMemo(() => ({ provider, actions }), [provider, actions]);
  const refs = useMemo(
    () => ({ provider: setProvider, actions: setActions }),
    [],
  );
  return { slots, refs };
}

export function UsageHeaderSlotsProvider({
  slots,
  children,
}: {
  slots: UsageHeaderSlots;
  children: ReactNode;
}) {
  return <UsageHeaderSlotsContext value={slots}>{children}</UsageHeaderSlotsContext>;
}

/**
 * Renders `children` into the Usage header. Renders nothing while the header is not showing Usage
 * (the slot element is gone), so a hidden-but-mounted Usage page never leaks controls onto other screens.
 */
export function UsageHeaderPortal({ slot, children }: { slot: UsageHeaderSlotName; children: ReactNode }) {
  const element = use(UsageHeaderSlotsContext)[slot];
  if (!element) return null;
  return createPortal(
    slot === "actions" ? (
      children
    ) : (
      <>
        <span aria-hidden="true" className="flex shrink-0 items-center text-icon-muted">
          /
        </span>
        {children}
      </>
    ),
    element,
  );
}

/**
 * The header of every screen: breadcrumb on the left, actions on the right, then search and close.
 * The switcher trigger carries the current screen's title (the screen menu). On Usage (`slots` given)
 * the breadcrumb is `Usage / <provider>`; on a secondary screen it is `<Screen> v`, with the Settings
 * section as the only extra segment: `Settings v / Appearance`.
 *
 * It is one row from T3's `@4xl` container width. Below that, Usage's toolbar (period, metric, refresh)
 * drops to a row of its own while search and close stay on the first row. The toolbar wraps instead of
 * scrolling, so no control is ever out of reach, and nothing else in the bar changes height with it.
 */
export function ScreenHeader({
  screenId,
  title,
  section,
  actions,
  slots,
}: {
  screenId: string;
  title: string;
  /** Optional third segment (the Settings section). */
  section?: string | null;
  /** Right-side actions of a secondary screen (for example refresh). */
  actions?: ReactNode;
  /** Slot refs, passed on Usage only: they make the breadcrumb the provider picker. */
  slots?: UsageHeaderSlotRefs;
}) {
  const gt = useGT();
  const slotItem = "flex min-w-10 shrink items-center gap-2 font-medium text-foreground empty:hidden sm:gap-3";
  // The title is the page's own heading only when nothing follows it: Usage has a provider picker, Settings a section.
  const trailing = Boolean(slots) || Boolean(section) || screenId === SETTINGS_VIEW;
  return (
    <AppHeader>
      <div
        className={cn(
          "grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1",
          slots && "@4xl/usage-header:grid-cols-[auto_minmax(0,1fr)_auto_auto]",
        )}
      >
        {/* Settings gear: first item on the LEFT of the header (the right side holds the actions and window controls). */}
        <HeaderSettingsButton />
        <WorkspaceBreadcrumb
          ariaLabel={gt("{screen} breadcrumb", { screen: title })}
          className="min-w-0 max-w-full"
        >
          <WorkspaceBreadcrumbItem current={!trailing}>
            {/* The switcher IS the page heading: the screen title is never repeated as a second crumb. */}
            <h1 className="min-w-0">
              <AppScreenSwitcher current={screenId} emphasized={!trailing} />
            </h1>
          </WorkspaceBreadcrumbItem>
          {slots ? (
            <li ref={slots.provider} aria-current="page" className={slotItem} />
          ) : section ? (
            <>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current className="min-w-10">
                <WorkspaceBreadcrumbText>{section}</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbItem>
            </>
          ) : null}
        </WorkspaceBreadcrumb>
        {/* Usage's toolbar, filled by `UsageHeaderPortal`. It follows the breadcrumb and precedes search and close
            in the DOM, so the tab order is the reading order on a wide bar. */}
        {slots ? (
          <div
            ref={slots.actions}
            data-slot="header-toolbar"
            className="col-span-full row-start-2 flex min-w-0 flex-wrap items-center justify-end gap-2 empty:hidden @4xl/usage-header:col-span-1 @4xl/usage-header:col-start-3 @4xl/usage-header:row-start-1"
          />
        ) : null}
        <div
          className={cn(
            "col-start-3 row-start-1 flex min-w-0 items-center justify-end gap-2",
            slots && "@4xl/usage-header:col-start-4",
          )}
        >
          {actions}
          <HeaderPaletteButton />
          <AppHeaderEnd screenId={screenId} />
        </div>
      </div>
    </AppHeader>
  );
}
