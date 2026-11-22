/**
 * Theme library (package 28), ported from T3 Code's `ThemeSettings.tsx` (MIT, T3 Tools Inc.) and
 * trimmed to Burnrate's appearance contract.
 *
 * The library shows one card per theme: the stock palette, the built-in themes from
 * `~/themes/registry` and the user's themes from `settings.appearance.customThemes`. Each card can
 * be applied to both halves at once or to a single light/dark half through `ThemePreviewCircles`.
 * "Create theme" opens the package 22 editor; "Edit"/"Duplicate"/"Export"/"Remove" work on the
 * theme library.
 *
 * Burnrate stores the active ids explicitly (`appearance.lightThemeId` / `darkThemeId`, `null` =
 * stock palette), so this file never needs T3's base-theme/mix bookkeeping. `ThemeImportButtonSlot`
 * below opens the real import dialog (lazy-loaded on first use).
 */
import {
  CopyIcon,
  PaintbrushIcon,
  PenLineIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { useCustomThemes } from "~/hooks/useCustomThemes";
import { useTheme } from "~/hooks/useTheme";
import { useGT } from "~/i18n";
import { toast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { SettingsSection } from "~/settings/layout";
import { DEFAULT_SETTINGS } from "~/settings/schema";
import { useSettings } from "~/settings/store";
import { BUILTIN_THEMES } from "~/themes/registry";
import {
  getThemeDefinition,
  getThemeModes,
  installCustomTheme,
  removeCustomThemes,
  type ThemeAppearance,
  type ThemeDefinition,
} from "~/themePalette";
import { downloadThemeFile } from "~/vscodeThemeImport";

import { openThemeEditor } from "./themeEditorStore";
import {
  getThemeCardDefinition,
  STANDARD_THEME_CARDS,
  ThemePreviewCircles,
  type ThemeCardDefinition,
  type ThemeMode,
} from "./ThemePreviewCircles";

/** The theme ids each appearance half currently uses (`null` = the stock palette). */
export type ThemeHalfOwners = Readonly<{ light: string | null; dark: string | null }>;

export function themeHalfOwners(appearance: {
  lightThemeId?: string | null;
  darkThemeId?: string | null;
}): ThemeHalfOwners {
  // The settings store's local merge deletes a key assigned `null`, so a just-cleared half can be
  // `undefined` until the server echoes the full settings back. Treat both as the stock palette.
  // (A settings object that is missing the keys altogether cannot reach here: `DEFAULT_SETTINGS`
  // always carries `lightThemeId`/`darkThemeId` and the server fills them on every read.)
  return { light: appearance.lightThemeId ?? null, dark: appearance.darkThemeId ?? null };
}

/** Which light/dark halves a card currently owns. `null` is the stock palette card. */
export function activeThemeModes(
  themeId: string | null,
  owners: ThemeHalfOwners,
): ReadonlyArray<ThemeMode> {
  const modes: ThemeMode[] = [];
  if (owners.light === themeId) modes.push("light");
  if (owners.dark === themeId) modes.push("dark");
  return modes;
}

/**
 * How a card's primary action applies it: a two-appearance theme replaces both halves, a
 * single-appearance theme only claims its own half, and a theme with no colors does nothing.
 */
export function themeActivationModes(
  modes: ReadonlyArray<ThemeAppearance>,
): ThemeAppearance | "both" | null {
  if (modes.length === 0) return null;
  return modes.length > 1 ? "both" : modes[0]!;
}

/** The card tooltip T3 shows: what clicking the card applies, from its preview modes. */
export function themeCardUseTarget(
  modes: ReadonlyArray<ThemeAppearance>,
): "both" | "light" | "dark" | "none" {
  if (modes.length > 1) return "both";
  if (modes[0] === "light") return "light";
  if (modes[0] === "dark") return "dark";
  return "none";
}

/**
 * The built-in cards to list. "Burnrate Light" is the stock palette's light half under another name,
 * so it only appears when a person already pinned it (otherwise the library shows two identical cards).
 */
export function visibleBuiltinThemes(
  themes: ReadonlyArray<ThemeDefinition>,
  owners: ThemeHalfOwners,
): ReadonlyArray<ThemeDefinition> {
  return themes.filter(
    (theme) => theme.id !== "burnrate-light" || owners.light === theme.id || owners.dark === theme.id,
  );
}

/** The import dialog installs themes into the library itself; its chunk loads on first use. */
const ThemeImportDialog = lazy(() =>
  import("./ThemeImportDialog").then((m) => ({ default: m.ThemeImportDialog })),
);

export function ThemeImportButtonSlot(): ReactNode {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The dialog installs imported themes into the library itself; it is loaded on first use.
  return (
    <>
      <Button ref={triggerRef} size="xs" variant="outline" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <PlusIcon aria-hidden className="size-3.5" />
        {gt("Add theme")}
      </Button>
      {open ? (
        <Suspense
          fallback={
            // A slow chunk used to leave the click with no feedback at all.
            <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              {gt("Loading importer…")}
            </span>
          }
        >
          <ThemeImportDialog open={open} onOpenChange={setOpen} finalFocus={triggerRef} />
        </Suspense>
      ) : null}
    </>
  );
}

function CardAction({
  label,
  tooltip,
  destructive = false,
  onClick,
  children,
}: {
  label: string;
  tooltip: string;
  destructive?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            size="icon-xs"
            variant={destructive ? "ghost-destructive" : "ghost"}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function ThemeLibraryCard({
  card,
  activeModes,
  onUse,
  onUseMode,
  onEdit,
  onDuplicate,
  onDownload,
  onRemove,
}: {
  card: ThemeCardDefinition;
  activeModes: ReadonlyArray<ThemeMode>;
  onUse: () => void;
  onUseMode: (mode: ThemeMode) => void;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDownload?: () => void;
  onRemove?: () => void;
}) {
  const gt = useGT();
  const isActive = activeModes.length > 0;
  const useTarget = themeCardUseTarget(card.previews.map((preview) => preview.mode));
  const hint =
    useTarget === "both"
      ? gt("Use for both light and dark")
      : useTarget === "light"
        ? gt("Use for light mode only")
        : useTarget === "dark"
          ? gt("Use for dark mode only")
          : gt("Use theme");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "cursor-pointer overflow-hidden rounded-xl border border-border bg-card transition-colors hover:bg-accent/10",
              // Forced colors drop box-shadow, so the active card also gets a system-colour outline.
              isActive &&
                "bg-accent/30 ring-1 ring-inset ring-ring forced-colors:outline-2 forced-colors:outline-solid forced-colors:-outline-offset-2 forced-colors:outline-[Highlight]",
            )}
            data-active={isActive ? "" : undefined}
            data-theme-library-card={card.id}
            onClick={onUse}
          >
            <ThemePreviewCircles
              activeModes={activeModes}
              label={card.label}
              onSelectMode={onUseMode}
              previews={card.previews}
            />
            <div className="flex items-center gap-2 px-3 pb-3 pt-2">
              <button
                aria-label={
                  isActive
                    ? gt("Use {label}, currently active", { label: card.label })
                    : gt("Use {label}", { label: card.label })
                }
                aria-pressed={isActive}
                className="min-h-6 min-w-0 flex-1 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                onClick={(event) => {
                  event.stopPropagation();
                  onUse();
                }}
                type="button"
              >
                {card.label}
              </button>
              {onEdit || onDuplicate || onDownload || onRemove ? (
                <div className="flex shrink-0 items-center gap-1">
                  {onDuplicate ? (
                    <CardAction
                      label={gt("Duplicate {label}", { label: card.label })}
                      tooltip={gt("Duplicate theme")}
                      onClick={onDuplicate}
                    >
                      <CopyIcon />
                    </CardAction>
                  ) : null}
                  {onEdit ? (
                    <CardAction
                      label={gt("Edit {label}", { label: card.label })}
                      tooltip={gt("Edit theme")}
                      onClick={onEdit}
                    >
                      <PenLineIcon />
                    </CardAction>
                  ) : null}
                  {onDownload ? (
                    <CardAction
                      label={gt("Export {label}", { label: card.label })}
                      tooltip={gt("Export theme file")}
                      onClick={onDownload}
                    >
                      <UploadIcon />
                    </CardAction>
                  ) : null}
                  {onRemove ? (
                    <CardAction
                      destructive
                      label={gt("Remove {label}", { label: card.label })}
                      tooltip={gt("Remove theme")}
                      onClick={onRemove}
                    >
                      <Trash2Icon />
                    </CardAction>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        }
      />
      <TooltipPopup>{hint}</TooltipPopup>
    </Tooltip>
  );
}

export function ThemeSettings() {
  const gt = useGT();
  const { resolvedTheme, setTheme, setThemeHalf, clearThemeHalves } = useTheme();
  const appearance = useSettings((settings) => settings.appearance);
  const customThemes = useCustomThemes();
  const [removal, setRemoval] = useState<ThemeDefinition | null>(null);
  const [status, setStatus] = useState("");
  const [statusFailed, setStatusFailed] = useState(false);

  const owners = themeHalfOwners(appearance);
  const stockCard = STANDARD_THEME_CARDS[0]!;
  // "Create theme" starts from what you are looking at now: the theme in use for the current mode.
  const activeThemeId = resolvedTheme === "dark" ? owners.dark : owners.light;

  function announce(message: string, failed = false): void {
    setStatus(message);
    setStatusFailed(failed);
  }

  function activate(theme: ThemeDefinition): void {
    const target = themeActivationModes(getThemeModes(theme));
    if (target === null) {
      announce(gt("This theme has no colors for the current mode."), true);
      return;
    }
    const saved = target === "both" ? setTheme(theme.id) : setThemeHalf(target, theme.id);
    announce(
      saved
        ? gt("Now using {label}.", { label: theme.label })
        : gt("Could not apply {label}.", { label: theme.label }),
      !saved,
    );
  }

  function activateStock(): void {
    const saved = clearThemeHalves();
    announce(
      saved ? gt("Now using the default theme.") : gt("Could not apply the default theme."),
      !saved,
    );
  }

  function assignMode(themeId: string | null, mode: ThemeMode): void {
    if (mode === "system") return;
    const saved = setThemeHalf(mode, themeId);
    const label =
      themeId === null
        ? gt("the default theme")
        : (getThemeDefinition(themeId)?.label ?? themeId);
    announce(
      saved
        ? gt("Using {label} for {mode} mode.", {
            label,
            mode: mode === "light" ? gt("light") : gt("dark"),
          })
        : gt("Could not save the theme selection."),
      !saved,
    );
  }

  function createTheme(): void {
    openThemeEditor({
      editingThemeId: null,
      seedThemeId: activeThemeId,
      seedName: null,
      initialAppearance: resolvedTheme,
    });
  }

  function editTheme(theme: ThemeDefinition): void {
    openThemeEditor({
      editingThemeId: theme.id,
      seedThemeId: null,
      seedName: null,
      initialAppearance: resolvedTheme,
    });
  }

  function duplicateTheme(theme: ThemeDefinition): void {
    openThemeEditor({
      editingThemeId: null,
      seedThemeId: theme.id,
      seedName: gt("{label} copy", { label: theme.label }),
      initialAppearance: resolvedTheme,
    });
  }

  function confirmRemoval(): void {
    if (removal === null) return;
    const removed = removal;
    const wasLight = owners.light === removed.id;
    const wasDark = owners.dark === removed.id;
    removeCustomThemes([removed.id]);
    // A removed theme falls back to the built-in default for that mode, not to the stock palette.
    if (wasLight) setThemeHalf("light", DEFAULT_SETTINGS.appearance.lightThemeId);
    if (wasDark) setThemeHalf("dark", DEFAULT_SETTINGS.appearance.darkThemeId);
    setRemoval(null);
    announce(gt("Removed {label}.", { label: removed.label }));
    toast.success(gt("Removed {label}.", { label: removed.label }), {
      action: {
        label: gt("Undo"),
        onClick: () => {
          installCustomTheme(removed);
          if (wasLight) setThemeHalf("light", removed.id);
          if (wasDark) setThemeHalf("dark", removed.id);
        },
      },
    });
  }

  return (
    <SettingsSection
      headerAction={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button onClick={createTheme} size="xs" variant="outline">
            <PaintbrushIcon />
            {gt("Create theme")}
          </Button>
          <ThemeImportButtonSlot />
        </div>
      }
      className="@container"
      id="appearance-theme-library"
      title={gt("Theme library")}
      variant="plain"
    >
      <TooltipProvider>
        <div
          aria-label={gt("Themes")}
          className="grid w-full grid-cols-1 items-start gap-3 @[24rem]:grid-cols-2 @[44rem]:grid-cols-3"
          role="group"
        >
          <ThemeLibraryCard
            activeModes={activeThemeModes(null, owners)}
            card={{ ...stockCard, label: gt("Default") }}
            onDuplicate={() =>
              openThemeEditor({
                editingThemeId: null,
                seedThemeId: null,
                seedName: gt("Default copy"),
                initialAppearance: resolvedTheme,
              })
            }
            onUse={activateStock}
            onUseMode={(mode) => assignMode(null, mode)}
          />
          {visibleBuiltinThemes(BUILTIN_THEMES, owners).map((theme) => (
            <ThemeLibraryCard
              activeModes={activeThemeModes(theme.id, owners)}
              card={getThemeCardDefinition(theme)}
              key={theme.id}
              onDuplicate={() => duplicateTheme(theme)}
              onUse={() => activate(theme)}
              onUseMode={(mode) => assignMode(theme.id, mode)}
            />
          ))}
          {customThemes.map((theme) => (
            <ThemeLibraryCard
              activeModes={activeThemeModes(theme.id, owners)}
              card={getThemeCardDefinition(theme)}
              key={theme.id}
              onDownload={() => downloadThemeFile(theme)}
              onDuplicate={() => duplicateTheme(theme)}
              onEdit={() => editTheme(theme)}
              onRemove={() => setRemoval(theme)}
              onUse={() => activate(theme)}
              onUseMode={(mode) => assignMode(theme.id, mode)}
            />
          ))}
        </div>
      </TooltipProvider>

      <p
        aria-live="polite"
        className={cn("px-1 text-xs", statusFailed ? "text-destructive" : "sr-only")}
        role="status"
      >
        {status}
      </p>

      <AlertDialog
        open={removal !== null}
        onOpenChange={(open) => {
          if (!open) setRemoval(null);
        }}
      >
        <AlertDialogPopup data-settings-overlay="">
          <AlertDialogHeader className="overflow-y-auto overscroll-contain scroll-py-3">
            <AlertDialogTitle>
              {gt('Remove "{label}"?', { label: removal?.label ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {gt(
                "The theme is deleted from this device. You can add it again by creating or importing it.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{gt("Cancel")}</AlertDialogClose>
            <Button variant="destructive" onClick={confirmRemoval}>
              {gt("Remove theme")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
