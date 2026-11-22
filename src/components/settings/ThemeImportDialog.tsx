/**
 * "Add a theme" dialog (ported from T3 Code's `ThemeImportDialog.tsx`, MIT, T3 Tools Inc.).
 *
 * Default flow: a local file (T3/Burnrate theme JSON v1, a VS Code color theme, or a
 * `.vsix` package) or pasted JSON. Nothing here touches the network. The opt-in Open VSX
 * search at the top lives in its own section.
 */
import { DownloadIcon, PlusIcon } from "lucide-react";
import { type ChangeEvent, type DragEvent, type UIEvent, useEffect, useRef, useState } from "react";

import { Alert } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { useGT } from "~/i18n";
import {
  parseVsixThemes,
  MAX_VSIX_BYTES,
} from "~/openVsxThemes";
import {
  humanizeThemeName,
  pairVsCodeThemes,
  parseThemeImport,
  resolveThemeLabelCollisions,
} from "~/vscodeThemeImport";
import {
  getCustomThemes,
  installCustomTheme,
  removeCustomTheme,
  renameTheme,
  updateCustomTheme,
  type ThemeDefinition,
} from "~/themePalette";
import { cn } from "~/lib/utils";

import { ThemeSearchSection } from "./ThemeSearchSection";

/**
 * The guard runs on the size before the bytes are ever read: a large file
 * would otherwise be pulled into memory, highlighted, and rendered, which
 * locks the UI for as long as that takes.
 */
const MAX_THEME_FILE_BYTES = 256 * 1024;

/** Highlighting rebuilds markup per keystroke; fall back to plain text for oversized pastes. */
const MAX_HIGHLIGHTED_JSON_LENGTH = 20_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeOversizedThemeFile(bytes: number, translate: (text: string, values?: Record<string, unknown>) => string): string | null {
  if (bytes <= MAX_THEME_FILE_BYTES) return null;
  return translate(
    "That file is {size}. Theme files are only a few KB, so this one was not read (limit {limit}).",
    { size: formatBytes(bytes), limit: formatBytes(MAX_THEME_FILE_BYTES) },
  );
}

function isVsixName(name: string): boolean {
  return /\.vsix$/i.test(name);
}

function isThemeIdTaken(themeId: string): boolean {
  return getCustomThemes().some((existing) => existing.id === themeId);
}

function errorMessage(cause: unknown, fallback: string, translate: (text: string) => string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return translate(fallback);
}

function escapeJsonHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function highlightJson(value: string): string {
  const tokenPattern =
    /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
  let highlighted = "";
  let cursor = 0;

  for (const match of value.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    highlighted += escapeJsonHtml(value.slice(cursor, index));

    let tokenClass = "text-[var(--app-theme-secondary-foreground,var(--color-amber-600))]";
    if (token.startsWith('"')) {
      tokenClass = /^\s*:/.test(value.slice(index + token.length))
        ? "text-[var(--app-theme-accent,var(--color-blue-600))]"
        : "text-[var(--app-theme-message-action,var(--color-emerald-600))]";
    } else if (token === "true" || token === "false" || token === "null") {
      tokenClass = "text-[var(--app-theme-accent-surface-foreground,var(--color-violet-600))]";
    }
    highlighted += `<span class="${tokenClass}">${escapeJsonHtml(token)}</span>`;
    cursor = index + token.length;
  }

  return highlighted + escapeJsonHtml(value.slice(cursor));
}

function ThemeJsonEditor({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const gt = useGT();
  const highlightRef = useRef<HTMLPreElement>(null);
  const isPlainText = value.length > MAX_HIGHLIGHTED_JSON_LENGTH;
  const highlightedJson = isPlainText ? "" : highlightJson(value);

  const syncScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const highlightElement = highlightRef.current;
    if (!highlightElement) return;
    highlightElement.scrollTop = event.currentTarget.scrollTop;
    highlightElement.scrollLeft = event.currentTarget.scrollLeft;
  };

  return (
    <div className="relative overflow-hidden rounded-xl border border-input bg-background focus-within:border-ring focus-within:ring-3 focus-within:ring-inset focus-within:ring-ring/24">
      {isPlainText ? null : (
        <pre
          ref={highlightRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-foreground"
        >
          <code dangerouslySetInnerHTML={{ __html: highlightedJson }} />
        </pre>
      )}
      <textarea
        aria-label={gt("Theme JSON")}
        className={cn(
          "relative z-10 block min-h-28 w-full resize-y overflow-auto bg-transparent p-3 font-mono text-xs leading-5 caret-foreground outline-none placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
          isPlainText ? "text-foreground" : "text-transparent",
        )}
        id={id}
        onChange={(event) => onChange(event.currentTarget.value)}
        onScroll={syncScroll}
        placeholder={
          '{\n  "version": 1,\n  "name": "Aurora",\n  "appearance": "light",\n  "colors": { ... }\n}'
        }
        spellCheck={false}
        value={value}
      />
    </div>
  );
}

type ImportableThemeFile = {
  name: string;
  size: number;
  text?: () => Promise<string>;
  bytes?: () => Promise<Uint8Array>;
};

interface ThemeImportCallbacks {
  /** Return false when the installed theme could not be selected; the dialog then rolls back. */
  onImported?: (theme: ThemeDefinition) => boolean | void;
  onImportedMany?: (
    themes: ReadonlyArray<ThemeDefinition>,
    context: { updated: boolean },
  ) => void;
}

export function ThemeImportDialog({
  open,
  onOpenChange,
  onImported,
  onImportedMany,
  finalFocus,
}: ThemeImportCallbacks & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus?: React.ComponentProps<typeof DialogPopup>["finalFocus"];
}) {
  const gt = useGT();
  // Each opening is a fresh session: its body remounts with clean state, and
  // closing aborts every read, search, and install the session started.
  const [session, setSession] = useState(() => ({
    open,
    id: 0,
    controller: new AbortController(),
  }));
  if (session.open !== open) {
    setSession(
      open ? { open, id: session.id + 1, controller: new AbortController() } : { ...session, open },
    );
  }
  const close = () => {
    session.controller.abort();
    onOpenChange(false);
  };
  // Leaving the page ends the session as closing does. The abort waits a microtask
  // so StrictMode's replayed cleanup, undone by its replayed setup, keeps it alive.
  const { controller } = session;
  const mountedController = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedController.current = controller;
    return () => {
      mountedController.current = null;
      queueMicrotask(() => {
        if (mountedController.current !== controller) controller.abort();
      });
    };
  }, [controller]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true);
        else close();
      }}
    >
      <DialogPopup className="max-w-3xl overflow-hidden" finalFocus={finalFocus} data-settings-overlay="">
        <DialogHeader>
          <DialogTitle className="pe-9">{gt("Add a theme")}</DialogTitle>
        </DialogHeader>
        <ThemeImportBody
          key={session.id}
          session={session.controller}
          onClose={close}
          onImported={onImported}
          onImportedMany={onImportedMany}
        />
      </DialogPopup>
    </Dialog>
  );
}

function ThemeImportBody({
  session,
  onClose,
  onImported,
  onImportedMany,
}: ThemeImportCallbacks & {
  session: AbortController;
  onClose: () => void;
}) {
  const gt = useGT();
  const { signal } = session;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [json, setJson] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [conflicts, setConflicts] = useState<ReadonlyArray<ThemeDefinition> | null>(null);
  // A newer read supersedes an older one still in flight.
  const importRequestRef = useRef(0);
  const isCurrentRequest = (requestId: number) =>
    requestId === importRequestRef.current && !signal.aborted;

  const readThemeFile = async (file: ImportableThemeFile) => {
    const oversized = describeOversizedThemeFile(file.size, gt);
    if (oversized) {
      setError(oversized);
      return;
    }

    const requestId = ++importRequestRef.current;
    setIsReading(true);
    let fileText: string;
    try {
      fileText = file.text ? await file.text() : "";
    } catch {
      if (isCurrentRequest(requestId)) {
        setIsReading(false);
        setError(gt("Could not read that file. Paste the JSON below instead."));
      }
      return;
    }
    if (!isCurrentRequest(requestId)) return;
    setIsReading(false);
    setJson(fileText);
    setFileName(file.name);
    setError(null);
  };

  const readThemeBatch = (files: ReadonlyArray<ImportableThemeFile>) => {
    const requestId = ++importRequestRef.current;
    setIsReading(true);
    return installThemeBatch(files, requestId).finally(() => {
      if (isCurrentRequest(requestId)) setIsReading(false);
    });
  };

  const themesFromFile = async (
    file: ImportableThemeFile,
    failures: string[],
  ): Promise<Array<{ theme: ThemeDefinition; sourceName: string }>> => {
    if (isVsixName(file.name)) {
      if (file.size > MAX_VSIX_BYTES) {
        failures.push(gt("{name}: too large (limit 5 MB)", { name: file.name }));
        return [];
      }
      if (!file.bytes) {
        failures.push(gt("{name}: could not be read", { name: file.name }));
        return [];
      }
      try {
        const result = await parseVsixThemes(await file.bytes(), { signal });
        for (const failure of result.failures) {
          failures.push(`${file.name}: ${failure}`);
        }
        return result.themes.map(({ theme, sourceName }) => ({ theme, sourceName }));
      } catch (cause) {
        if (signal.aborted) return [];
        failures.push(`${file.name}: ${errorMessage(cause, "not a theme package", gt)}`);
        return [];
      }
    }

    const oversized = describeOversizedThemeFile(file.size, gt);
    if (oversized) {
      failures.push(`${file.name}: ${oversized}`);
      return [];
    }
    try {
      if (!file.text) throw new Error(gt("Could not read that file."));
      return [{ theme: parseThemeImport(await file.text()), sourceName: file.name }];
    } catch (cause) {
      if (signal.aborted) return [];
      failures.push(`${file.name}: ${errorMessage(cause, "not a theme file", gt)}`);
      return [];
    }
  };

  const installThemeBatch = async (
    files: ReadonlyArray<ImportableThemeFile>,
    requestId: number,
  ) => {
    const failures: string[] = [];
    const parsed: Array<{ theme: ThemeDefinition; sourceName: string }> = [];
    for (const file of files) {
      parsed.push(...(await themesFromFile(file, failures)));
      if (!isCurrentRequest(requestId)) return;
    }
    const installed: ThemeDefinition[] = [];
    const conflicting: ThemeDefinition[] = [];
    for (const theme of pairVsCodeThemes(resolveThemeLabelCollisions(parsed))) {
      if (isThemeIdTaken(theme.id)) {
        conflicting.push(theme);
        continue;
      }
      try {
        installed.push(installCustomTheme(theme));
      } catch (cause) {
        failures.push(`${theme.label}: ${errorMessage(cause, "could not install", gt)}`);
      }
    }
    if (!isCurrentRequest(requestId)) return;
    if (installed.length > 0) onImportedMany?.(installed, { updated: false });
    setError(failures.length > 0 ? failures.join("; ") : null);
    if (conflicting.length > 0) {
      setConflicts(conflicting);
    } else if (installed.length > 0 && failures.length === 0) {
      onClose();
    }
  };

  const readThemeFiles = (files: ReadonlyArray<ImportableThemeFile>) => {
    if (files.length === 0) return;
    if (files.length === 1 && !isVsixName(files[0]!.name)) void readThemeFile(files[0]!);
    else void readThemeBatch(files);
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const fromFile = (file: File): ImportableThemeFile => ({
    name: file.name,
    size: file.size,
    text: () => file.text(),
    // Read lazily: a VSIX is only read when the user actually imports one.
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
  });

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    readThemeFiles(files.map(fromFile));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropTarget(false);
    readThemeFiles([...event.dataTransfer.files].map(fromFile));
  };

  const versionedCopy = (
    theme: ThemeDefinition,
    preferredName?: string | null,
  ): ThemeDefinition => {
    // renameTheme leaves the collection behind: updating a collection replaces every theme in it.
    if (preferredName && preferredName.toLowerCase() !== theme.label.toLowerCase()) {
      const candidate = renameTheme(theme, preferredName.slice(0, 48));
      if (!isThemeIdTaken(candidate.id)) return candidate;
    }
    for (let copy = 1; copy < 100; copy += 1) {
      const candidate = renameTheme(
        theme,
        `${theme.label.slice(0, 48 - ` (${copy})`.length)} (${copy})`,
      );
      if (!isThemeIdTaken(candidate.id)) return candidate;
    }
    throw new Error(gt('Too many copies of "{label}".', { label: theme.label }));
  };

  const resolveConflicts = (mode: "update" | "copy") => {
    if (!conflicts) return;
    const resolved: ThemeDefinition[] = [];
    const failures: string[] = [];
    const preferredName =
      conflicts.length === 1 && fileName
        ? humanizeThemeName(fileName.replace(/\.[^.]+$/, ""))
        : null;
    for (const theme of conflicts) {
      try {
        const existingTheme =
          mode === "update"
            ? getCustomThemes().find((candidate) => candidate.id === theme.id)
            : undefined;
        const themeToUpdate = existingTheme?.collection
          ? { ...theme, collection: existingTheme.collection }
          : theme;
        resolved.push(
          mode === "update"
            ? updateCustomTheme(themeToUpdate)
            : installCustomTheme(versionedCopy(theme, preferredName)),
        );
      } catch (cause) {
        failures.push(`${theme.label}: ${errorMessage(cause, "could not install", gt)}`);
      }
    }
    if (resolved.length > 0) onImportedMany?.(resolved, { updated: mode === "update" });
    setConflicts(null);
    if (failures.length > 0) setError([error, ...failures].filter(Boolean).join("; "));
    else if (!error) onClose();
  };

  const handleSubmit = () => {
    const oversized = describeOversizedThemeFile(json.length, gt);
    if (oversized) {
      setError(oversized);
      return;
    }
    try {
      const theme = parseThemeImport(json);
      if (isThemeIdTaken(theme.id)) {
        setError(null);
        setConflicts([theme]);
        return;
      }
      const installedTheme = installCustomTheme(theme);
      if (onImported && onImported(installedTheme) === false) {
        try {
          removeCustomTheme(installedTheme.id);
        } catch {
          // The rollback is best effort; the error below is what matters.
        }
        setError(gt("Theme added, but it could not be selected. Try again."));
        return;
      }
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "That theme file is invalid.", gt));
    }
  };

  return (
    <DialogPanel>
      <ThemeSearchSection
        signal={signal}
        onInstalled={(themes, context) => {
          onImportedMany?.(themes, context);
          onClose();
        }}
      />

      <div className="flex items-center gap-3" aria-hidden>
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">
          {gt("or import a file")}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>

      {error ? (
        <Alert aria-live="polite" role="alert" variant="error">
          {error}
        </Alert>
      ) : null}

      {conflicts ? (
        <div className="space-y-3">
          <Alert role="status" variant="info">
            <p className="text-sm font-medium text-foreground">{gt("Already installed")}</p>
            <p className="text-xs text-muted-foreground">
              {conflicts.map((theme) => theme.label).join(", ")}
            </p>
          </Alert>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => resolveConflicts("update")}>
              {gt("Update existing")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => resolveConflicts("copy")}>
              {gt("Keep both")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConflicts(null)}>
              {gt("Back")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onClose()}>
              {gt("Cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-4 py-3 transition-colors",
              isDropTarget ? "border-ring bg-accent/20" : "border-border bg-muted",
            )}
            onDragEnter={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault();
              setIsDropTarget(true);
            }}
            onDragOver={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault();
              setIsDropTarget(true);
            }}
            onDragLeave={(event: DragEvent<HTMLDivElement>) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setIsDropTarget(false);
            }}
            onDrop={handleDrop}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{gt("Theme file")}</p>
              <p className="truncate text-xs text-muted-foreground">
                {fileName ?? gt("Drop a Burnrate, VS Code or Open VSX theme file (.json, .vsix)")}
              </p>
            </div>
            <Button disabled={isReading} size="sm" variant="outline" onClick={openFilePicker}>
              <DownloadIcon />
              {isReading ? gt("Reading…") : gt("Choose files")}
            </Button>
            <input
              ref={fileInputRef}
              accept=".json,.vsix,application/json,application/octet-stream"
              className="sr-only"
              onChange={handleFileChange}
              multiple
              type="file"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <label className="text-sm text-foreground" htmlFor="theme-json-editor">
                {gt("Theme JSON")}
              </label>
            </div>
            <ThemeJsonEditor
              id="theme-json-editor"
              onChange={(next) => {
                setJson(next);
                // Editing the JSON invalidates the previous failure message.
                setError(null);
              }}
              value={json}
            />
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => onClose()}>
              {gt("Cancel")}
            </Button>
            <Button disabled={!json.trim() || isReading} onClick={handleSubmit}>
              <PlusIcon />
              {gt("Add theme")}
            </Button>
          </div>
        </div>
      )}

    </DialogPanel>
  );
}
