/**
 * Font family picker, T3's `FontFamilyPicker.tsx` pattern: a select-style button that always shows
 * the font in use (the default's real name when nothing is chosen), opening a searchable list of
 * installed fonts. Picking a row applies it instantly. Listing installed fonts needs the Local Font
 * Access API; where it is unavailable or denied, typing an installed family name into the search box
 * still offers it as a "Use ..." row, so the picker never dead-ends.
 *
 * The list is windowed (fixed 32px rows, overscan): only rows near the viewport render in their own
 * typeface, so a few hundred installed families stay cheap.
 */
import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { CheckIcon } from "lucide-react";

import { Combobox, ComboboxEmpty, ComboboxItem, ComboboxListVirtualized, ComboboxPopup, ComboboxSearchInput, ComboboxTrigger } from "~/components/ui/combobox";
import { SelectButton } from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { appearanceFontStack, DEFAULT_SANS_FONT_STACK, displayFontFamily, isFontFamilyAvailable, isMonospaceFamily } from "~/appearanceFonts";
import { startInstalledFontsLoad, useInstalledFontFamilies, warmInstalledFonts } from "~/lib/installedFonts";
import { toast } from "~/lib/toast";
import { useGT } from "~/i18n";

/** Sentinel list value for "use the theme's default font". */
export const DEFAULT_FONT_VALUE = "__default__";

/** Fixed row height for the windowed list; keep in sync with item classes. */
export const FONT_ROW_HEIGHT = 32;

/** Rows rendered outside the viewport (above and below) while scrolling. */
const FONT_ROW_OVERSCAN = 4;

/** List viewport: max-h-72 = 18rem, the popup's internal scroll area. */
const LIST_VIEWPORT_HEIGHT = 288;

export interface FontFamilyPickerProps {
  /** Accessible name for the trigger button. */
  ariaLabel: string;
  /** Id of the settings row's description element; wired to the trigger's aria-describedby. */
  descriptionId?: string;
  /** Real family name of the default font, shown when nothing is chosen. */
  defaultFamily: string;
  /** Currently chosen family, or null for the default. */
  value: string | null;
  /** Reject non-monospace picks with an error toast and keep the old font. */
  requireMonospace?: boolean;
  /** Stack used for the default font's trigger label. */
  defaultStack?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  /** Called with the picked family, or null when the default row is picked. */
  onValueChange: (family: string | null) => void;
}

function supportsFontEnumeration(): boolean {
  return typeof window !== "undefined" && typeof (window as { queryLocalFonts?: unknown }).queryLocalFonts === "function";
}

/**
 * Build the picker's rows from the cached installed families and the search query.
 *
 * With an empty query the default sentinel is pinned first, followed by every family. While
 * searching, matching families are listed (case-insensitive substring) and the default row is
 * dropped. When the typed text is itself an installed family the list does not already contain,
 * it is offered as a trailing `typed` row ("Use ..."), so the picker keeps working when font
 * enumeration is unavailable or denied. The sentinel is never treated as a typed family.
 */
export function fontPickerItems(
  families: readonly string[],
  query: string,
  isAvailable: (family: string) => boolean,
): { items: string[]; typed: string | null } {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { items: [DEFAULT_FONT_VALUE, ...families], typed: null };
  }
  const needle = trimmed.toLowerCase();
  const matches = families.filter((family) => family.toLowerCase().includes(needle));
  const alreadyListed = families.some((family) => family.toLowerCase() === needle);
  const typed = trimmed !== DEFAULT_FONT_VALUE && !alreadyListed && isAvailable(trimmed) ? trimmed : null;
  return { items: typed === null ? matches : [...matches, typed], typed };
}

export function FontFamilyPicker({
  ariaLabel,
  descriptionId,
  defaultFamily,
  value,
  requireMonospace = false,
  defaultStack = DEFAULT_SANS_FONT_STACK,
  id,
  disabled = false,
  className,
  onValueChange,
}: FontFamilyPickerProps) {
  const gt = useGT();
  const { status, families } = useInstalledFontFamilies();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [windowStart, setWindowStart] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Warm the cache on mount (idle callback) so the first open is instant.
  useEffect(() => warmInstalledFonts(), []);

  const selectedValue = value === null || value.length === 0 ? DEFAULT_FONT_VALUE : value;

  const { items: filteredItems, typed } = useMemo(
    () => fontPickerItems(families, query, isFontFamilyAvailable),
    [families, query],
  );

  // With nothing typed, pin the current font directly below the default row.
  const items = useMemo(() => {
    if (query.trim().length > 0 || selectedValue === DEFAULT_FONT_VALUE) return filteredItems;
    const at = filteredItems.indexOf(selectedValue);
    if (at <= 1) return filteredItems;
    return [filteredItems[0]!, selectedValue, ...filteredItems.slice(1, at), ...filteredItems.slice(at + 1)];
  }, [filteredItems, query, selectedValue]);

  const viewportCount = Math.ceil(LIST_VIEWPORT_HEIGHT / FONT_ROW_HEIGHT); // max-h-72 = 18rem
  const windowEnd = Math.min(items.length, windowStart + viewportCount + FONT_ROW_OVERSCAN * 2);
  const visibleRows = items.slice(windowStart, windowEnd);

  // Reset the window (and scroll position) whenever the popup opens or the query changes, and on a
  // cold open bring the current font's row into view.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    setWindowStart(0);
    el?.scrollTo({ top: 0 });
    if (query.trim().length === 0) {
      const index = items.indexOf(selectedValue);
      // A row already inside the first viewport needs no scrolling (and scrolling there would hide
      // the default row pinned above it).
      if (index >= viewportCount) {
        setWindowStart(Math.max(0, index - viewportCount + 1));
        el?.scrollTo({ top: index * FONT_ROW_HEIGHT });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scroll positioning runs on open/query only
  }, [open, query]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setQuery("");
      // The open click is a user gesture: retry an enumeration that was denied or never started.
      startInstalledFontsLoad();
    }
  };

  const handlePick = (next: string) => {
    setOpen(false);
    if (next === DEFAULT_FONT_VALUE) {
      onValueChange(null);
      return;
    }
    if (requireMonospace && !isMonospaceFamily(next)) {
      toast.error(gt("Code and terminal need a fixed-width font, so the current font was kept."), {
        title: gt('"{font}" is not monospace', { font: next }),
      });
      return;
    }
    onValueChange(next);
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const first = Math.max(0, Math.floor(el.scrollTop / FONT_ROW_HEIGHT) - FONT_ROW_OVERSCAN);
    setWindowStart((current) => (current === first ? current : first));
  };

  // Keyboard highlight can move onto a row the window has not rendered yet; grow the window and
  // keep the highlighted row inside the viewport.
  const handleItemHighlighted = (index: number, reason: string) => {
    if (!open || index < 0 || reason !== "keyboard") return;
    if (index < windowStart || index >= windowEnd) {
      setWindowStart(Math.max(0, index - FONT_ROW_OVERSCAN));
    }
    const el = scrollRef.current;
    if (!el) return;
    const rowTop = index * FONT_ROW_HEIGHT - el.scrollTop;
    if (rowTop < 0) el.scrollTo({ top: index * FONT_ROW_HEIGHT });
    else if (rowTop + FONT_ROW_HEIGHT > el.clientHeight) {
      el.scrollTo({ top: index * FONT_ROW_HEIGHT + FONT_ROW_HEIGHT - el.clientHeight });
    }
  };

  // Skeleton rows only while the first enumeration is actually in flight. A denied permission
  // settles back to "idle" with an empty list; treating that as cold would leave skeletons up
  // forever and hide the default row and the typed-name fallback.
  const cold = status === "loading" && families.length === 0 && supportsFontEnumeration();

  const enumerationUnavailable = status === "unavailable" || !supportsFontEnumeration();
  const noFamilies = enumerationUnavailable || families.length === 0;

  const currentLabel = selectedValue === DEFAULT_FONT_VALUE ? defaultFamily : selectedValue;
  const currentStack =
    selectedValue === DEFAULT_FONT_VALUE ? defaultStack : appearanceFontStack(selectedValue, defaultStack);

  return (
    <div className={className ?? "w-full min-w-0"}>
      <Combobox
        items={items}
        filteredItems={items}
        autoHighlight
        virtualized
        open={open}
        onOpenChange={handleOpenChange}
        value={selectedValue}
        disabled={disabled}
        onValueChange={(next) => {
          if (typeof next === "string") handlePick(next);
        }}
        onItemHighlighted={(_highlighted, details) => handleItemHighlighted(details.index, details.reason)}
      >
        <ComboboxTrigger
          id={id}
          aria-label={ariaLabel}
          aria-describedby={descriptionId}
          className="w-full"
          render={<SelectButton size="sm" className="w-full" />}
        >
          <span style={{ fontFamily: currentStack }}>{currentLabel}</span>
        </ComboboxTrigger>
        <ComboboxPopup
          align="start"
          className="w-(--anchor-width) flex-col duration-150 ease-out motion-reduce:transition-none has-data-[starting-style]:scale-98 has-data-[starting-style]:opacity-0 has-data-[ending-style]:scale-98 has-data-[ending-style]:opacity-0"
        >
          <ComboboxSearchInput
            aria-label={gt("Search fonts…")}
            placeholder={gt("Search fonts…")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>
            {status === "loading" && families.length === 0
              ? gt("Loading fonts…")
              : noFamilies
                ? gt("Font list unavailable — type an installed font name.")
                : gt("No fonts found.")}
          </ComboboxEmpty>
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="max-h-72 min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {windowStart > 0 ? (
              <div aria-hidden="true" className="shrink-0" style={{ height: windowStart * FONT_ROW_HEIGHT }} />
            ) : null}
            <ComboboxListVirtualized className="min-w-0">
              {cold
                ? Array.from({ length: viewportCount }, (_, row) => (
                    <div key={row} className="flex items-center px-2" style={{ height: FONT_ROW_HEIGHT }}>
                      <Skeleton className="h-4 w-2/5" />
                    </div>
                  ))
                : visibleRows.map((item, offset) => {
                    const index = windowStart + offset;
                    const isDefault = item === DEFAULT_FONT_VALUE;
                    const isTyped = typed !== null && item === typed;
                    const family = isDefault ? defaultFamily : item;
                    return (
                      <ComboboxItem
                        key={item}
                        index={index}
                        value={item}
                        style={{ height: FONT_ROW_HEIGHT, minHeight: FONT_ROW_HEIGHT }}
                      >
                        <div className="flex w-full min-w-0 items-center justify-between gap-2">
                          <span className="min-w-0 truncate" style={{ fontFamily: displayFontFamily(family) }}>
                            {isTyped ? gt('Use "{font}"', { font: item }) : family}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {isDefault ? (
                              <span className="text-3xs text-muted-foreground/60">{gt("default")}</span>
                            ) : null}
                            {item === selectedValue ? (
                              <CheckIcon className="size-3.5 text-muted-foreground" />
                            ) : null}
                          </span>
                        </div>
                      </ComboboxItem>
                    );
                  })}
            </ComboboxListVirtualized>
            {windowEnd < items.length ? (
              <div
                aria-hidden="true"
                className="shrink-0"
                style={{ height: (items.length - windowEnd) * FONT_ROW_HEIGHT }}
              />
            ) : null}
          </div>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}
