/**
 * Opt-in Open VSX theme search (docs/CONTRACTS.md section 3, package 23).
 *
 * The default theme flow (file or paste in `ThemeImportDialog`) never touches the
 * network. This section is the one network path, and it only works after the user
 * enables `advanced.experimental.openVsx`; until then the server answers 403 and this
 * component renders an "enable it in Settings > Advanced" state instead of searching.
 * The disclosure under the heading says what a search sends and where.
 */
import { LockIcon, PackagePlusIcon, PaletteIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { useCustomThemes } from "~/hooks/useCustomThemes";
import { useGT } from "~/i18n";
import { updateSettings, useSettings } from "~/settings/store";
import { OpenVsxDisabledError } from "~/api/themes";
import {
  createOpenVsxSearch,
  importOpenVsxThemeExtension,
  type OpenVsxThemeExtension,
} from "~/openVsxThemes";
import {
  getStoredCustomThemeCollection,
  replaceCustomThemeCollection,
  type ThemeDefinition,
} from "~/themePalette";

const DOWNLOAD_FORMAT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const OPENVSX_DISABLED_MESSAGE = new OpenVsxDisabledError().message;
const SUGGESTED_SEARCHES = ["Dracula", "Catppuccin", "Nord", "Tokyo Night"];

function errorMessage(cause: unknown, fallback: string, translate: (text: string) => string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return translate(fallback);
}

function ExtensionIcon({ extension }: { extension: OpenVsxThemeExtension }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
      {extension.iconUrl && !failed ? (
        <img
          alt=""
          className="size-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={extension.iconUrl}
          onError={() => setFailed(true)}
        />
      ) : (
        <PaletteIcon aria-hidden className="size-4" />
      )}
    </div>
  );
}

export interface ThemeSearchSectionProps {
  /** Aborted when the dialog closes; cancels searches and installs. */
  signal: AbortSignal;
  onInstalled?: (themes: ReadonlyArray<ThemeDefinition>, context: { updated: boolean }) => void;
}

export function ThemeSearchSection({ signal, onInstalled }: ThemeSearchSectionProps) {
  const gt = useGT();
  const customThemes = useCustomThemes();
  const openVsxEnabled = useSettings(
    (settings) => settings.advanced?.experimental?.openVsx === true,
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<OpenVsxThemeExtension> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<OpenVsxThemeExtension | null>(null);
  // The settings mirror may lag behind the server (or the stream); a 403 means the
  // proxy is still off, so show the same enable state without guessing.
  const [disabledByServer, setDisabledByServer] = useState(false);
  const [themeSearch] = useState(() =>
    createOpenVsxSearch(
      {
        setResults,
        // A 403 while searching means the proxy is off: show the "Turn on" state, not the raw error.
        setError: (message) => {
          if (message !== null && message === OPENVSX_DISABLED_MESSAGE) {
            setDisabledByServer(true);
            setError(null);
          } else {
            setError(message);
          }
        },
        setIsSearching,
      },
      signal,
    ),
  );

  const disabled = !openVsxEnabled || disabledByServer;
  const [enabling, setEnabling] = useState(false);

  // Turning the opt-in on is one click here instead of a trip to Settings > Advanced. It applies
  // right away: the server is told first, so the search box never shows up while the proxy is off.
  const enableSearch = async () => {
    setEnabling(true);
    setError(null);
    try {
      await updateSettings({ advanced: { experimental: { openVsx: true } } });
      setDisabledByServer(false);
    } catch (cause) {
      setError(errorMessage(cause, "Could not turn on Open VSX search.", gt));
    } finally {
      setEnabling(false);
    }
  };
  const installing = installingId !== null;

  const changeQuery = (nextQuery: string) => {
    setQuery(nextQuery);
    themeSearch.setQuery(nextQuery);
  };

  const installedCollection = (extension: OpenVsxThemeExtension) =>
    customThemes.filter((theme) => theme.collection?.id === extension.collectionId);

  const handleInstall = async (extension: OpenVsxThemeExtension, allowUpdate: boolean) => {
    setError(null);
    let alreadyInstalled: ReadonlyArray<ThemeDefinition>;
    try {
      alreadyInstalled = getStoredCustomThemeCollection(extension.collectionId);
    } catch (cause) {
      setError(errorMessage(cause, "Installed themes could not be read.", gt));
      return;
    }
    const updated = alreadyInstalled.length > 0;
    if (updated && !allowUpdate) {
      setPendingUpdate(extension);
      return;
    }

    const installSignal = themeSearch.beginInstall();
    setInstallingId(extension.id);
    try {
      const themes = await importOpenVsxThemeExtension(extension, installSignal);
      if (!installSignal.aborted) {
        const installed = replaceCustomThemeCollection(extension.collectionId, themes, {
          expectedCollection: alreadyInstalled,
        });
        onInstalled?.(installed, { updated });
      }
    } catch (cause) {
      if (!installSignal.aborted) {
        if (cause instanceof OpenVsxDisabledError) setDisabledByServer(true);
        setError(errorMessage(cause, "That theme could not be added.", gt));
      }
    }
    if (themeSearch.endInstall(installSignal)) setInstallingId(null);
  };

  if (disabled) {
    return (
      <section className="space-y-3" aria-labelledby="theme-search-heading">
        <div>
          <h3 className="text-sm font-medium" id="theme-search-heading">
            {gt("Search community themes")}
          </h3>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {gt("Find open-source themes from Open VSX.")}
          </p>
        </div>
        <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border bg-muted p-3 sm:flex-row sm:items-center">
          <LockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{gt("Open VSX search is off")}</p>
            <p className="mt-0.5 text-muted-foreground text-xs">
              {gt("Turning it on sends what you type to open-vsx.org.")}
            </p>
          </div>
          <Button
            className="shrink-0"
            disabled={enabling}
            size="sm"
            variant="outline"
            onClick={() => void enableSearch()}
          >
            {enabling ? <Spinner /> : null}
            {gt("Turn on")}
          </Button>
        </div>
        {error ? (
          <Alert role="alert" variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </section>
    );
  }

  return (
    <section className="space-y-3" aria-labelledby="theme-search-heading">
      <div>
        <h3 className="text-sm font-medium" id="theme-search-heading">
          {gt("Search community themes")}
        </h3>
        <p className="mt-0.5 text-muted-foreground text-xs">
          {gt("Find open-source themes from Open VSX.")}
        </p>
      </div>

      <InputGroup>
        <InputGroupAddon>
          {isSearching ? <Spinner aria-hidden /> : <SearchIcon aria-hidden />}
        </InputGroupAddon>
        <InputGroupInput
          aria-label={gt("Search Open VSX themes")}
          autoFocus
          maxLength={128}
          onChange={(event) => changeQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && !isSearching && !installing) themeSearch.searchNow();
          }}
          placeholder={gt("Search themes...")}
          size="lg"
          type="search"
          value={query}
        />
      </InputGroup>

      {!isSearching || results !== null ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className="text-muted-foreground text-xs">{gt("Popular")}</p>
          {SUGGESTED_SEARCHES.map((suggestion) => (
            <Button
              key={suggestion}
              disabled={installing}
              size="xs"
              variant="ghost"
              onClick={() => {
                if (query.trim() === suggestion) themeSearch.searchNow();
                else changeQuery(suggestion);
              }}
            >
              {suggestion}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="sr-only" role="status" aria-live="polite">
        {isSearching
          ? gt("Searching themes...")
          : results
            ? gt(
                "{count, plural, one {{count} supported theme found.} other {{count} supported themes found.}}",
                { count: results.length },
              )
            : ""}
      </div>

      {error ? (
        <Alert role="alert" variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {isSearching && results === null ? (
        <div className="flex min-h-20 items-center justify-center gap-2 text-muted-foreground text-sm">
          <Spinner /> {gt("Searching themes...")}
        </div>
      ) : null}

      {results ? (
        results.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed text-center">
            <p className="text-sm font-medium">{gt("No supported open-source themes found")}</p>
            <p className="mt-1 text-muted-foreground text-xs">{gt("Try a broader search.")}</p>
          </div>
        ) : (
          <div
            aria-label={gt("Theme results")}
            className="grid max-h-[min(36rem,70dvh)] items-start gap-2 overflow-y-auto overscroll-contain scroll-py-2 p-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-2"
            tabIndex={0}
          >
            {results.map((extension) => {
              const isInstalling = installingId === extension.id;
              const installed = installedCollection(extension).length > 0;
              const action = installed ? gt("Update") : gt("Install");
              return (
                <article
                  className="group flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent/20"
                  key={extension.id}
                >
                  <div className="flex min-w-0 gap-3">
                    <ExtensionIcon key={extension.iconUrl ?? extension.id} extension={extension} />
                    <div className="min-w-0 flex-1">
                      <h4 className="truncate text-sm font-medium">{extension.name}</h4>
                      <p className="truncate text-muted-foreground text-xs">
                        {extension.publisher} ·{" "}
                        {DOWNLOAD_FORMAT.format(extension.downloadCount)} {gt("downloads")}
                      </p>
                    </div>
                  </div>
                  <p className="line-clamp-2 min-h-8 text-muted-foreground text-xs leading-4">
                    {extension.description ||
                      gt("A community color theme for your editor.")}
                  </p>
                  <div className="mt-auto flex items-center justify-end gap-2">
                    <Button
                      aria-label={
                        installed
                          ? isInstalling
                            ? gt("Updating {name}", { name: extension.name })
                            : gt("Update {name}", { name: extension.name })
                          : isInstalling
                            ? gt("Installing {name}", { name: extension.name })
                            : gt("Install {name}", { name: extension.name })
                      }
                      disabled={installing}
                      size="xs"
                      variant="outline"
                      onClick={() => void handleInstall(extension, false)}
                    >
                      {isInstalling ? (
                        <Spinner />
                      ) : installed ? (
                        <RefreshIcon />
                      ) : (
                        <PackagePlusIcon />
                      )}
                      {isInstalling
                        ? installed
                          ? gt("Updating...")
                          : gt("Installing...")
                        : action}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )
      ) : null}

      <AlertDialog
        open={pendingUpdate !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingUpdate(null);
        }}
      >
        <AlertDialogPopup data-settings-overlay="">
          <AlertDialogHeader className="overflow-y-auto overscroll-contain scroll-py-3">
            <AlertDialogTitle>
              {gt("Update {name}?", { name: pendingUpdate?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {gt(
                "This replaces its installed variants, including any local edits. Variants no longer in the extension will be removed.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {gt("Cancel")}
            </AlertDialogClose>
            <Button
              onClick={() => {
                const extension = pendingUpdate;
                setPendingUpdate(null);
                if (extension) void handleInstall(extension, true);
              }}
            >
              {gt("Update theme")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
