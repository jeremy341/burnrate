import { CircleAlertIcon, CircleCheckIcon, InfoIcon, Undo2Icon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { SettingsGroup } from "~/components/settings/SettingsGroup";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useGT } from "~/i18n";
import { cn } from "~/lib/utils";
import { isDesktopShell } from "./environment";
import { SettingsSearchContext } from "./search";

export { SettingsGroup } from "~/components/settings/SettingsGroup";

/* -------------------------------------------------------------------------------------------------
 * Search-target plumbing (T3's settingsLayout.tsx). A section or row with an `id` can be the target
 * of a hash deep link or a search result; the provider in SettingsPage drives the scroll/focus.
 * ----------------------------------------------------------------------------------------------- */

interface SettingsSearchTargetContextValue {
  readonly targetId: string | null;
  readonly onTargetHandled: () => void;
}

const SettingsSearchTargetContext = createContext<SettingsSearchTargetContextValue>({
  targetId: null,
  onTargetHandled: () => undefined,
});

export function SettingsSearchTargetProvider({
  targetId,
  onTargetHandled = () => undefined,
  children,
}: {
  targetId: string | null;
  onTargetHandled?: () => void;
  children: ReactNode;
}) {
  return (
    <SettingsSearchTargetContext value={{ targetId, onTargetHandled }}>
      {children}
    </SettingsSearchTargetContext>
  );
}

export function useSettingsSearchTargetId(): string | null {
  return useContext(SettingsSearchTargetContext).targetId;
}

function prefersReducedMotion(): boolean {
  const preference = document.documentElement.dataset.reduceMotion;
  if (preference === "on") return true;
  if (preference === "off") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Reduced-motion stand-in for the pulse: a plain ring on the row, removed after a moment. */
const STATIC_HIGHLIGHT_CLASSES = ["ring-2", "ring-inset", "ring-primary/70", "rounded-xl"] as const;

function scrollAndFocusSettingsTarget(target: HTMLElement, highlight = true): void {
  // A desktop-only control has an inert ancestor in the browser. Focus its section's visible
  // heading and badge so the user gets a keyboard destination and can tell why it is unavailable.
  const desktopOnly = target.closest("[data-desktop-only]");
  const desktopSection = desktopOnly?.closest<HTMLElement>("section");
  if (desktopSection) target = desktopSection;
  const unavailable = target.closest<HTMLElement>("[inert][data-settings-unavailable-target]");
  const fallbackId = unavailable?.dataset.settingsUnavailableTarget;
  if (fallbackId) target = document.getElementById(fallbackId) ?? target;
  const reduced = prefersReducedMotion();
  const marked = target.querySelector<HTMLElement>(":scope > [data-settings-scroll-target]");
  const scrollTarget = marked ?? target;
  scrollTarget.scrollIntoView({ block: "center", inline: "nearest" });
  target.focus({ preventScroll: true });
  target.classList.remove("settings-search-target-pulse");
  if (!highlight) return;
  if (reduced) {
    // No animation: hold a plain ring on the row for a moment so the destination is still obvious.
    const flash = target.matches("section") ? target.firstElementChild : target;
    if (!flash) return;
    flash.classList.add(...STATIC_HIGHLIGHT_CLASSES);
    setTimeout(() => flash.classList.remove(...STATIC_HIGHLIGHT_CLASSES), 1600);
    return;
  }
  // Restart the CSS pulse (the keyframes live in T3's verbatim index.css).
  void target.offsetWidth;
  target.classList.add("settings-search-target-pulse");
  target.addEventListener("blur", () => target.classList.remove("settings-search-target-pulse"), {
    once: true,
  });
}

export function useSettingsSearchTarget<T extends HTMLElement>(id?: string) {
  const { targetId, onTargetHandled } = useContext(SettingsSearchTargetContext);
  const isTarget = id !== undefined && targetId === id;
  return useCallback(
    (node: T | null) => {
      if (node && isTarget) {
        scrollAndFocusSettingsTarget(node);
        onTargetHandled();
      }
    },
    [isTarget, onTargetHandled],
  );
}

/** Scroll to a target by DOM id. Used when a target is in a section that has just been mounted. */
export function scrollToSettingsTarget(
  targetId: string,
  { highlight = true, root }: { highlight?: boolean; root?: HTMLElement | null } = {},
): boolean {
  const target = document.getElementById(targetId);
  if (!target || (root && !root.contains(target))) return false;
  scrollAndFocusSettingsTarget(target, highlight);
  return true;
}

/* -------------------------------------------------------------------------------------------------
 * Layout blocks (the API copied settings sections rely on).
 * ----------------------------------------------------------------------------------------------- */

/**
 * Settings that only mean something inside the packaged desktop app (launch at login, tray, global
 * shortcut). In a browser tab they used to look live and silently do nothing; now the whole group is
 * switched off and labelled, the same way everywhere. Inside the desktop app it renders its children as is.
 */
export function DesktopOnlyArea({ children }: { children: ReactNode }) {
  if (isDesktopShell()) return <>{children}</>;
  return (
    <div inert data-desktop-only="">
      {children}
    </div>
  );
}

/** "Desktop app only" pill shown beside a section title when the section is switched off in a browser. */
export function DesktopOnlyBadge() {
  const gt = useGT();
  if (isDesktopShell()) return null;
  return (
    <Badge variant="outline" size="sm" className="ms-1">
      {gt("Desktop app only")}
    </Badge>
  );
}

export function SettingsSection({
  title,
  description,
  hideTitle = false,
  icon,
  titleAction,
  headerAction,
  variant = "grouped",
  desktopOnly = false,
  children,
  className,
  id,
  ...sectionProps
}: Omit<ComponentPropsWithoutRef<"section">, "title"> & {
  title: string;
  description?: ReactNode;
  hideTitle?: boolean;
  icon?: ReactNode;
  titleAction?: ReactNode;
  headerAction?: ReactNode;
  variant?: "grouped" | "plain";
  /** Whole section only works in the desktop app: dim and disable it in a browser, with a badge. */
  desktopOnly?: boolean;
  children: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLElement>(id);
  return (
    <section
      {...sectionProps}
      id={id}
      ref={targetRef}
      tabIndex={id || desktopOnly ? -1 : sectionProps.tabIndex}
      className={cn("outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", !hideTitle && "space-y-3", className)}
    >
      {hideTitle ? (
        <h2 className="sr-only">{title}</h2>
      ) : (
        <div
          data-settings-scroll-target
          className="flex min-h-7 flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <h2 className="flex min-h-7 min-w-0 items-center gap-2 wrap-anywhere text-sm font-medium text-foreground">
              {icon}
              {title}
            </h2>
            {desktopOnly ? <DesktopOnlyBadge /> : null}
            {titleAction}
          </div>
          {headerAction ? (
            <div className="flex min-h-7 min-w-7 items-center justify-end">{headerAction}</div>
          ) : null}
          {description ? <p className="w-full text-xs text-muted-foreground">{description}</p> : null}
        </div>
      )}
      {desktopOnly ? (
        <DesktopOnlyArea>
          <SettingsGroup data-settings-scroll-target={hideTitle ? "" : undefined} variant={variant}>
            {children}
          </SettingsGroup>
        </DesktopOnlyArea>
      ) : (
        <SettingsGroup data-settings-scroll-target={hideTitle ? "" : undefined} variant={variant}>
          {children}
        </SettingsGroup>
      )}
    </section>
  );
}

export interface SettingsRowProps extends Omit<ComponentPropsWithoutRef<"div">, "title"> {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode | ((props: { "aria-describedby"?: string }) => ReactNode);
  /** Keep compact controls, such as a switch, beside the title on narrow panes. */
  inlineControl?: boolean;
  /** Extra search terms for the flat settings search index. */
  keywords?: readonly string[];
  children?: ReactNode;
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  inlineControl = false,
  keywords,
  children,
  className,
  id,
  ...rowProps
}: SettingsRowProps) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(id);
  const search = useContext(SettingsSearchContext);
  // Name the row after its title and describe it with its helper text, so a control (or a deep-link
  // focus landing on the row) is announced with context instead of a bare "switch" or "button".
  const titleId = useId();
  const descriptionId = useId();
  const descriptionReference = description ? descriptionId : undefined;
  // Arrays passed inline would otherwise re-register the row on every render.
  const keywordKey = keywords?.join("\u0000");
  useEffect(() => {
    if (!id || typeof title !== "string" || !search) return;
    search.index.register({
      id,
      title,
      sectionId: search.sectionId,
      keywords: keywordKey?.split("\u0000"),
    });
    return () => search.index.unregister(id);
  }, [id, title, keywordKey, search]);

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      aria-describedby={descriptionReference}
      {...rowProps}
      id={id}
      ref={targetRef}
      tabIndex={id ? -1 : rowProps.tabIndex}
      data-slot="settings-row"
      className={cn(
        "group/settings-row @container/settings-row min-w-0 rounded-xl px-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-disabled:opacity-64 aria-disabled:[&_*]:text-muted-foreground",
        // T3: a block row reserves its bottom padding for nested content; a plain row is py-3.
        children ? "pt-3 pb-1" : "py-3",
        className,
      )}
    >
      {/* T3's row grid: stacked with a 3-unit gap until 32rem, then title | control with an 8-unit gap.
          `inlineControl` only keeps a switch beside its title on the narrow side; wide rows are identical. */}
      <div className={cn(
        "flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_auto] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-6",
        inlineControl && "grid grid-cols-[minmax(0,1fr)_auto] items-center",
      )}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 id={titleId} className="min-w-0 wrap-anywhere text-sm text-foreground">{title}</h3>
            {resetAction}
          </div>
          {description ? (
            <div id={descriptionId} className="max-w-2xl text-pretty text-xs leading-normal text-muted-foreground">
              {description}
            </div>
          ) : null}
          {status ? <div className="pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end @min-[32rem]/settings-row:[&_[data-slot=select-trigger]]:min-w-40">
            {typeof control === "function" ? control({ "aria-describedby": descriptionReference }) : control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingsSwitchRow({
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  id,
  keywords,
  className,
  resetAction,
  status,
}: {
  title: string;
  description?: ReactNode;
  status?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  keywords?: readonly string[];
  className?: string;
  resetAction?: ReactNode;
}) {
  return (
    <SettingsRow
      id={id}
      keywords={keywords}
      className={className}
      title={title}
      description={description}
      status={status}
      resetAction={resetAction}
      inlineControl
      control={(descriptionProps) => (
        <Switch
          {...descriptionProps}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          aria-label={title}
        />
      )}
    />
  );
}

export function SettingResetButton({
  ariaLabel,
  tooltip,
  disabled = false,
  onClick,
}: {
  ariaLabel: string;
  tooltip?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={ariaLabel}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              event.currentTarget.closest<HTMLElement>("[data-slot=settings-row][tabindex]")?.focus();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">{tooltip ?? ariaLabel}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The reset affordance every settings row shares: a small icon button beside the row title that only
 * exists while the value differs from its default. Pass the result as `SettingsRow.resetAction`.
 */
export function resetWhenChanged(
  changed: boolean,
  ariaLabel: string,
  onReset: () => void,
): ReactNode {
  return changed ? <SettingResetButton ariaLabel={ariaLabel} onClick={onReset} /> : null;
}

/** A settings row whose content sits below the title instead of in the control column. */
export function SettingsBlock({
  id,
  title,
  description,
  resetAction,
  children,
  className,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  resetAction?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <SettingsRow id={id} title={title} description={description} resetAction={resetAction} className={cn("pb-3", className)}>
      <div className="pt-3">{children}</div>
    </SettingsRow>
  );
}

/** A quiet empty/informational line that sits inside a settings group with row padding. */
export function SettingsEmptyRow({ children }: { children: ReactNode }) {
  return (
    <p data-slot="settings-row" className="px-4 py-3 text-xs text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * Save / error / info feedback for a section. Render it at the top of the section so the result of an
 * action is visible without scrolling to the bottom of a long page. Errors use `role="alert"`; the
 * rest use a polite `role="status"`. Renders nothing for an empty message.
 */
export function SettingsNotice({
  kind = "info",
  children,
  className,
}: {
  kind?: "info" | "success" | "error";
  children?: ReactNode;
  className?: string;
}) {
  if (children === undefined || children === null || children === "" || children === false) return null;
  const Icon = kind === "error" ? CircleAlertIcon : kind === "success" ? CircleCheckIcon : InfoIcon;
  return (
    <Alert
      variant={kind}
      role={kind === "error" ? "alert" : "status"}
      className={cn("[&_[data-slot=alert-description]]:text-foreground", className)}
    >
      <Icon />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export const SettingsNoticeHostContext = createContext<HTMLElement | null>(null);

/** Keep feedback visible above the scroll pane so it never covers a focused control. */
export function SettingsNoticeStack({ children }: { children: ReactNode }) {
  const host = useContext(SettingsNoticeHostContext);
  const notices = <div className="flex flex-col gap-2 empty:hidden">{children}</div>;
  return host ? createPortal(notices, host) : notices;
}
