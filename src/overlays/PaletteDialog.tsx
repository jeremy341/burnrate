import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useGT } from "~/i18n";
import type { PaletteCommand } from "~/palette/types";
import type { groupCommands } from "~/palette/fuzzy";
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

export function PaletteDialog({ open, setOpen, query, setQuery, groups, itemValues, execute, triggerRef }: {
  readonly open: boolean;
  readonly setOpen: Dispatch<SetStateAction<boolean>>;
  readonly query: string;
  readonly setQuery: Dispatch<SetStateAction<string>>;
  readonly groups: ReturnType<typeof groupCommands>;
  readonly itemValues: string[];
  readonly execute: (command: PaletteCommand) => void;
  readonly triggerRef: RefObject<HTMLElement | null>;
}) {
  const gt = useGT();
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
