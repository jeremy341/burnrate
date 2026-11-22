import {
  InfoIcon,
  LayoutDashboardIcon,
  PaletteIcon,
  SearchIcon,
  Settings2Icon,
  WrenchIcon,
  XIcon,
  BellIcon,
  KeyboardIcon,
  DatabaseIcon,
  BotIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type KeyboardEvent,
} from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Kbd } from "~/components/ui/kbd";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { useMessages } from "~/i18n";
import { cn } from "~/lib/utils";
import { OPEN_SETTINGS_EVENT } from "~/onboarding";
import { scrollToSettingsTarget, SettingsNoticeHostContext, SettingsSearchTargetProvider } from "./layout";
import {
  formatSettingsHash,
  parseSettingsHash,
  pickInitialSection,
  readRememberedSection,
  rememberSection,
  resolveSettingsTarget,
  type ResolvedSettingsTarget,
} from "./navigation";
import { getSection, SECTIONS } from "./registry";
import {
  buildSearchIndex,
  createSettingsRowIndex,
  groupSections,
  searchSettings,
  SettingsSearchContext,
  type SettingsRowIndex,
  type SettingsSearchItem,
} from "./search";
import { SETTINGS_SEARCH_ROWS } from "./searchRows";
import { useSettingsSaveStatus } from "./store";
import "./settings.css";

/** Icons for the sections that don't provide their own (T3 uses the same lucide glyphs). */
const SECTION_ICONS: Readonly<Record<string, ComponentType<{ className?: string }>>> = {
  general: Settings2Icon,
  appearance: PaletteIcon,
  usage: LayoutDashboardIcon,
  providers: BotIcon,
  notifications: BellIcon,
  shortcuts: KeyboardIcon,
  advanced: WrenchIcon,
  data: DatabaseIcon,
  about: InfoIcon,
};

/** Frames to keep looking for a deep-link row before giving up (sections can mount lazily). */
const MAX_SCROLL_FRAMES = 12;
const KNOWN_ROW_IDS = SETTINGS_SEARCH_ROWS.map((row) => row.id);

function readHashTarget(): string | null {
  if (typeof window === "undefined") return null;
  return parseSettingsHash(window.location.hash);
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The page stays mounted (hidden and `inert`) while another view is shown, so its global shortcuts
 * must only react while it is actually on screen.
 */
function isPageVisible(root: HTMLElement | null): boolean {
  if (!root) return false;
  if (root.closest("[inert]") !== null) return false;
  return root.getClientRects().length > 0;
}

function scrollSearchResult(row: HTMLElement | null) {
  row?.scrollIntoView({ block: "nearest" });
}

/** T3-style settings shell: searchable sidebar, hash deep links and one registered section at a time. */
export function SettingsPage() {
  const gt = useMessages();
  const [initial] = useState(() => {
    const linked = resolveSettingsTarget(readHashTarget(), SECTIONS, KNOWN_ROW_IDS);
    return {
      linked,
      sectionId: pickInitialSection(linked, readRememberedSection(safeSessionStorage()), SECTIONS),
    };
  });
  const [activeId, setActiveId] = useState(initial.sectionId);
  const [rowTarget, setRowTarget] = useState<string | null>(initial.linked?.rowId ?? null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const [noticeHost, setNoticeHost] = useState<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sectionContentRef = useRef<HTMLDivElement>(null);

  const rowsIndexRef = useRef<SettingsRowIndex | null>(null);
  if (!rowsIndexRef.current) rowsIndexRef.current = createSettingsRowIndex();
  const rowIndex = rowsIndexRef.current;
  const registeredRows = useSyncExternalStore(rowIndex.subscribe, rowIndex.getSnapshot, rowIndex.getSnapshot);
  const searchContext = useMemo(() => ({ sectionId: activeId, index: rowIndex }), [activeId, rowIndex]);

  const searchIndex = useMemo(() => {
    const rows = new Map(SETTINGS_SEARCH_ROWS.map((row) => [row.id, row]));
    for (const row of registeredRows) rows.set(row.id, row);
    return buildSearchIndex(SECTIONS, [...rows.values()]);
  }, [registeredRows]);
  const groups = useMemo(() => groupSections(SECTIONS), []);
  const results = useMemo(() => searchSettings(query, searchIndex, gt), [query, searchIndex, gt]);
  const isSearching = query.trim().length > 0;
  const section = getSection(activeId);
  const selectedResultIndex = Math.min(activeResultIndex, Math.max(0, results.length - 1));
  const selectedResult = results[selectedResultIndex];
  const saveStatus = useSettingsSaveStatus();

  /** Show a section (and optionally a row inside it). The single entry point for every navigation. */
  const navigate = useCallback((target: ResolvedSettingsTarget, push = false) => {
    setActiveId(target.sectionId);
    setRowTarget(target.rowId);
    setQuery("");
    setActiveResultIndex(0);
    rememberSection(safeSessionStorage(), target.sectionId);
    if (push) {
      const rowId = target.rowId;
      const route = rowId && !resolveSettingsTarget(rowId, SECTIONS) ? `${target.sectionId}/${rowId}` : rowId ?? target.sectionId;
      const hash = formatSettingsHash(route);
      if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    }
    if (!target.rowId) {
      contentRef.current?.querySelector('[data-slot="scroll-area-viewport"]')?.scrollTo({ top: 0 });
    }
  }, []);

  // Follow hash deep links typed, pasted or set by the app (command palette, onboarding, provider cards)
  // and the explicit open-settings event, which also covers re-opening the link that is already current.
  useEffect(() => {
    const follow = (target: string | null, push = false) => {
      const resolved = resolveSettingsTarget(target, SECTIONS, KNOWN_ROW_IDS);
      if (!resolved) return;
      navigate(resolved, push);
    };
    const onHashChange = () => follow(readHashTarget());
    const onOpen = (event: Event) => {
      const section = (event as CustomEvent<{ section?: string }>).detail?.section;
      if (section) follow(section, true);
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
    };
  }, [navigate]);

  // Scroll to the linked row once its section has rendered; give up quietly after a few frames.
  useEffect(() => {
    if (!rowTarget) return;
    let frame = 0;
    let attempts = 0;
    const tick = () => {
      if (scrollToSettingsTarget(rowTarget, { root: contentRef.current })) {
        setRowTarget(null);
        return;
      }
      if (++attempts >= MAX_SCROLL_FRAMES) {
        setRowTarget(null);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [rowTarget, activeId]);

  const handleTargetHandled = useCallback(() => setRowTarget(null), []);

  const activate = useCallback(
    (id: string) => navigate({ sectionId: id, rowId: null }, true),
    [navigate],
  );

  const chooseResult = useCallback(
    (item: SettingsSearchItem) => {
      const targetId = item.targetId ?? item.id;
      const rowId = targetId === item.sectionId ? null : targetId;
      navigate(
        { sectionId: item.sectionId, rowId },
        true,
      );
      if (!rowId) requestAnimationFrame(() => sectionContentRef.current?.focus());
    },
    [navigate],
  );

  // `/` and Ctrl/Cmd+F focus the search box, exactly like T3's settings navigation.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const isSlash =
        event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey;
      const isFind =
        (event.key === "f" || event.key === "F") &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey;
      if (!isSlash && !isFind) return;
      // Never swallow `/` or Ctrl+F while another view is in front of this (kept-mounted) page.
      if (!isPageVisible(rootRef.current)) return;

      const target = event.target;
      if (target instanceof HTMLElement) {
        if (
          isSlash &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT" ||
            target.isContentEditable)
        ) {
          return;
        }
        if (
          target.closest(
            '[role="dialog"]:not([data-app-modal]), [aria-modal="true"]:not([data-app-modal]), [data-slot$="popup"]:not([data-app-modal]), [data-keybinding-capture]',
          ) !== null
        ) {
          return;
        }
      }
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && isSearching) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      setActiveResultIndex(0);
      return;
    }
    if (!isSearching || results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResultIndex((selectedResultIndex + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResultIndex((selectedResultIndex - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (selectedResult) chooseResult(selectedResult);
    }
  };

  return (
    <SettingsSearchTargetProvider targetId={rowTarget} onTargetHandled={handleTargetHandled}>
      <SettingsSearchContext value={searchContext}>
        <div
          ref={rootRef}
          className="absolute inset-0 flex min-h-0 flex-col bg-background sm:flex-row"
          data-settings-page-scroll
        >
          <nav
            aria-label={gt("Settings sections")}
            className="flex max-h-[50%] min-w-0 w-full shrink-0 flex-col gap-3 border-b border-sidebar-border bg-sidebar px-3 py-3 text-sidebar-foreground sm:h-full sm:max-h-none sm:w-60 sm:border-b-0 sm:border-e"
          >
            <InputGroup className="shrink-0">
              <InputGroupAddon>
                <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground" aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                ref={searchInputRef}
                nativeInput
                size="sm"
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setActiveResultIndex(0);
                }}
                onKeyDown={onSearchKeyDown}
                placeholder={gt("Search settings")}
                aria-label={gt("Search settings")}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={isSearching && results.length > 0}
                aria-controls={isSearching && results.length > 0 ? "settings-search-results" : undefined}
                aria-activedescendant={
                  isSearching && selectedResult
                    ? `settings-search-result-${selectedResult.id}`
                    : undefined
                }
                className="min-w-0 flex-1"
              />
              <InputGroupAddon align="inline-end">
                {isSearching ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost-muted"
                          className="shrink-0"
                          aria-label={gt("Clear settings search")}
                          onClick={() => {
                            setQuery("");
                            setActiveResultIndex(0);
                            searchInputRef.current?.focus();
                          }}
                        >
                          <XIcon aria-hidden className="size-3.5" />
                        </Button>
                      }
                    />
                    <TooltipPopup>{gt("Clear settings search")}</TooltipPopup>
                  </Tooltip>
                ) : (
                  <Kbd aria-hidden className="text-foreground">/</Kbd>
                )}
              </InputGroupAddon>
            </InputGroup>

            {isSearching ? (
              results.length === 0 ? (
                <div role="status" className="min-h-0 overflow-y-auto px-2 py-3">
                  <p className="text-sm font-medium text-sidebar-foreground">{gt("No settings found")}</p>
                  <p className="mt-1 text-xs text-sidebar-muted-foreground">
                    {gt("Try a different word, or clear the search to browse every section.")}
                  </p>
                </div>
              ) : (
                <>
                  <p role="status" className="sr-only">
                    {gt("{count, plural, one {{count} result.} other {{count} results.}}", { count: results.length })}
                  </p>
                  <div
                    id="settings-search-results"
                    role="listbox"
                    aria-label={gt("Settings search results")}
                    className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain scroll-py-1 py-1"
                  >
                    {results.map((item, index) => (
                      <button
                        key={item.id}
                        id={`settings-search-result-${item.id}`}
                        type="button"
                        role="option"
                        aria-selected={index === selectedResultIndex}
                        ref={index === selectedResultIndex ? scrollSearchResult : undefined}
                        tabIndex={-1}
                        onClick={() => chooseResult(item)}
                        className={cn(
                          "flex min-h-10 shrink-0 items-start gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          index === selectedResultIndex
                            ? "bg-sidebar-row-selected text-sidebar-foreground"
                            : "hover:bg-sidebar-row-hover",
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block wrap-anywhere text-sidebar-foreground">
                            {gt(item.title)}
                          </span>
                          {item.title !== item.sectionTitle ? (
                            <span className="block wrap-anywhere text-2xs text-sidebar-muted-foreground">
                              {gt(item.sectionTitle)}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )
            ) : (
              <>
                <div className="sm:hidden">
                  <Select
                    value={activeId}
                    onValueChange={(next) => {
                      if (typeof next === "string" && next) activate(next);
                    }}
                  >
                    <SelectTrigger aria-label={gt("Settings section")} className="w-full min-w-0">
                      <SelectValue>{gt(section?.title ?? activeId)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="start" alignItemWithTrigger={false} data-settings-overlay="">
                      {groups.map((group) => (
                        <SelectGroup key={group.heading}>
                          <SelectGroupLabel>{gt(group.heading)}</SelectGroupLabel>
                          {group.sections.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {gt(item.title)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div
                  data-settings-navigation-list
                  className="hidden min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain scroll-py-1 py-1 sm:flex"
                >
                  {groups.map((group, index) => (
                    <div key={group.heading} className="flex flex-col gap-1">
                      <h3
                        id={`settings-nav-group-${index}`}
                        className="px-2 text-2xs font-medium text-sidebar-muted-foreground"
                      >
                        {gt(group.heading)}
                      </h3>
                      <div role="group" aria-labelledby={`settings-nav-group-${index}`} className="flex flex-col gap-0.5">
                        {group.sections.map((item) => {
                          const isActive = item.id === activeId;
                          const Icon = item.icon ?? SECTION_ICONS[item.id] ?? Settings2Icon;
                          return (
                            <a
                              key={item.id}
                              href={formatSettingsHash(item.id)}
                              data-settings-section={item.id}
                              aria-current={isActive ? "page" : undefined}
                              onClick={(event) => {
                                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                                event.preventDefault();
                                activate(item.id);
                              }}
                              className={cn(
                                "relative flex min-h-8 items-center gap-2 rounded-md px-2 py-1 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                isActive
                                  ? "bg-sidebar-row-selected font-medium text-sidebar-foreground before:absolute before:inset-y-1.5 before:start-0 before:w-0.5 before:rounded-full before:bg-primary"
                                  : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                              )}
                            >
                              <Icon aria-hidden className="size-4 shrink-0" />
                              <span className="min-w-0 wrap-anywhere">{gt(item.title)}</span>
                            </a>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </nav>

          <div ref={contentRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div role="status" aria-live="polite" className="sr-only">
              {saveStatus === "saving" ? gt("Saving settings…") : saveStatus === "saved" ? gt("Settings saved.") : ""}
            </div>
            <div className="mx-3 flex max-h-[35%] min-h-0 flex-col gap-2 overflow-y-auto has-[[role]]:py-2 sm:mx-5">
              <div ref={setNoticeHost} className="empty:hidden" />
            </div>
            <SettingsNoticeHostContext value={noticeHost}>
              <ScrollArea
                data-settings-content
                className="flex-1 [&>[data-slot=scroll-area-viewport]]:scroll-py-3 [&>[data-slot=scroll-area-viewport]]:[scrollbar-gutter:stable_both-edges]"
              >
                <WorkspacePageContainer width="form">
                  {section ? (
                    <div
                      ref={sectionContentRef}
                      role="region"
                      aria-label={gt(section.title)}
                      tabIndex={-1}
                      className="min-w-0 rounded-md focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <section.Component key={section.id} />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {gt("No settings sections registered.")}
                    </p>
                  )}
                </WorkspacePageContainer>
              </ScrollArea>
            </SettingsNoticeHostContext>
          </div>
        </div>
      </SettingsSearchContext>
    </SettingsSearchTargetProvider>
  );
}
