import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { useGT } from "~/i18n";
import { toast } from "~/lib/toast";
import { onOpenPalette } from "~/palette/actions";
import { registerBuiltinCommands } from "~/palette/commands";
import { filterCommands, groupCommands } from "~/palette/fuzzy";
import { readRecentCommands, recordRecentCommand, withRecentGroup } from "~/palette/recent";
import type { PaletteCommand } from "~/palette/types";
import { useCommands } from "~/palette/useCommands";

const PaletteDialog = lazy(() => import("./PaletteDialog").then((module) => ({ default: module.PaletteDialog })));

/** Root overlay: Ctrl/Cmd+K opens a fuzzy-searchable list of registered commands. */
export function Overlay() {
  const gt = useGT();
  const triggerRef = useRef<HTMLElement | null>(null);
  const theme = usePrimarySettings((s) => s.theme);
  const commands = useCommands();
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [query, setQuery] = useState("");
  // Re-read on every open so a command used from another window or tab is already on top.
  const [recent, setRecent] = useState<readonly string[]>(() => readRecentCommands());
  useEffect(() => {
    if (open) setRecent(readRecentCommands());
  }, [open]);

  useEffect(() => registerBuiltinCommands({ gt, theme }), [gt, theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.querySelector("[data-command-palette-loading]")) {
        event.preventDefault();
        setQuery("");
        setOpen(false);
        return;
      }
      if (
        !event.defaultPrevented &&
        !event.repeat &&
        !event.isComposing &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        const dialog = document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]');
        if (dialog && !dialog.hasAttribute("data-command-palette")) return;
        event.preventDefault();
        if (dialog) {
          setOpen(false);
          setQuery("");
        } else {
          triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setHasOpened(true);
          setOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(
    () =>
      onOpenPalette((detail) => {
        if (!document.querySelector("[data-command-palette][data-open]")) {
          triggerRef.current = detail.trigger ??
            (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        }
        setQuery(detail.query ?? "");
        setHasOpened(true);
        setOpen(true);
      }),
    [],
  );

  const groups = useMemo(() => {
    const matches = filterCommands(commands, query, recent);
    return groupCommands(query.trim() ? matches : withRecentGroup(matches, recent, gt("Recent")));
  }, [commands, query, recent, gt]);
  const itemValues = useMemo(
    () => groups.flatMap((group) => group.commands.map((command) => command.id)),
    [groups],
  );

  const execute = useCallback(
    (command: PaletteCommand) => {
      setOpen(false);
      setQuery("");
      setRecent(recordRecentCommand(command.id));
      // A failure is reported through the normal toast system; a returned string is a result message.
      Promise.resolve()
        .then(() => command.run())
        .then((message) => {
          if (typeof message === "string" && message) toast.success(message);
        })
        .catch((error: unknown) => toast.error(error instanceof Error ? error.message : gt("Command failed.")));
    },
    [gt],
  );

  return hasOpened ? (
    <Suspense fallback={open ? <div role="dialog" aria-label={gt("Command palette")} data-open data-command-palette data-command-palette-loading className="fixed top-4 right-4 z-50 rounded-lg border bg-background px-4 py-3 text-sm shadow-lg">{gt("Loading command palette…")}</div> : null}>
      <PaletteDialog open={open} setOpen={setOpen} query={query} setQuery={setQuery} groups={groups} itemValues={itemValues} execute={execute} triggerRef={triggerRef} />
    </Suspense>
  ) : null;
}
