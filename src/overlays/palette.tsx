import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "~/components/ui/command";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { usePrimarySettings } from "~/hooks/useSettings";
import { useGT } from "~/i18n";
import { toast } from "~/lib/toast";
import { onOpenPalette } from "~/palette/actions";
import { registerBuiltinCommands } from "~/palette/commands";
import { filterCommands, groupCommands } from "~/palette/fuzzy";
import { readRecentCommands, recordRecentCommand, withRecentGroup } from "~/palette/recent";
import type { PaletteCommand } from "~/palette/types";
import { useCommands } from "~/palette/useCommands";

/** Root overlay: Ctrl/Cmd+K opens a fuzzy-searchable list of registered commands. */
export function Overlay() {
  const gt = useGT();
  const triggerRef = useRef<HTMLElement | null>(null);
  const theme = usePrimarySettings((s) => s.theme);
  const commands = useCommands();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Re-read on every open so a command used from another window or tab is already on top.
  const [recent, setRecent] = useState<readonly string[]>(() => readRecentCommands());
  useEffect(() => {
    if (open) setRecent(readRecentCommands());
  }, [open]);

  // useGT() returns a fresh closure every render; keep the registration effect stable.
  const translateRef = useRef(gt);
  translateRef.current = gt;
  const stableGt = useCallback(
    (message: string, values?: Record<string, unknown>) => translateRef.current(message, values),
    [],
  );

  useEffect(() => registerBuiltinCommands({ gt: stableGt, theme }), [stableGt, theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next, details) => {
        // Esc backs out one level: first it clears what was typed, the next one closes the palette.
        if (!next && details?.reason === "escape-key" && query) {
          details.cancel();
          setQuery("");
          return;
        }
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <CommandDialogPopup
        aria-label={gt("Command palette")}
        data-command-palette="true"
        finalFocus={() => {
          const trigger = triggerRef.current;
          return trigger?.isConnected && !trigger.closest("[inert]")
            ? trigger
            : document.querySelector<HTMLElement>('[data-slot="app-palette"]') ?? true;
        }}
      >
        <Command
          aria-label={gt("Command palette")}
          items={itemValues}
          mode="none"
          onValueChange={(value) => setQuery(value)}
          value={query}
        >
          <CommandInput aria-label={gt("Search commands")} placeholder={gt("Search commands...")} />
          <CommandPanel className="max-h-[min(28rem,70dvh)]">
            {groups.length === 0 ? (
              <div role="status" className="px-3 py-8 text-center text-sm text-muted-foreground">
                {gt("No matching commands.")}
              </div>
            ) : (
              <CommandList>
                {groups.map((group) => (
                  <CommandGroup key={group.label} items={group.commands}>
                    <CommandGroupLabel>{group.label}</CommandGroupLabel>
                    <CommandCollection>
                      {(command) => (
                        <CommandItem
                          key={command.id}
                          className="group"
                          onClick={() => execute(command)}
                          onMouseDown={(event) => event.preventDefault()}
                          value={command.id}
                        >
                          {command.icon ? <command.icon className="size-4 text-icon-muted" /> : null}
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-sm text-foreground">{command.title}</span>
                            {command.description ? (
                              <span className="truncate text-xs text-muted-foreground group-data-highlighted:text-foreground">
                                {command.description}
                              </span>
                            ) : null}
                          </span>
                          {command.value ? (
                            <span className="shrink-0 text-xs text-muted-foreground">{command.value}</span>
                          ) : null}
                          {command.shortcut ? <CommandShortcut>{command.shortcut}</CommandShortcut> : null}
                        </CommandItem>
                      )}
                    </CommandCollection>
                  </CommandGroup>
                ))}
              </CommandList>
            )}
          </CommandPanel>
          <CommandFooter>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
              <KbdGroup>
                <Kbd>
                  <ArrowUpIcon />
                </Kbd>
                <Kbd>
                  <ArrowDownIcon />
                </Kbd>
                <span>{gt("Navigate")}</span>
              </KbdGroup>
              <KbdGroup>
                <Kbd>Enter</Kbd>
                <span>{gt("Run")}</span>
              </KbdGroup>
              <KbdGroup>
                <Kbd>Esc</Kbd>
                <span>{gt("Close")}</span>
              </KbdGroup>
            </div>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
