import { SearchIcon, SettingsIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import type { ProviderInfo } from "~/contracts";
import { T, useGT } from "~/i18n";
import { cn } from "~/lib/utils";
import { normalizeAccentColor } from "~/providers/presentation";
import { ProviderIcon } from "~/providers/ProviderIcon";

import {
  agentAddedLabel,
  buildAgentTiles,
  filterAgentTiles,
  groupAgentTiles,
  type AgentTile,
  type AgentTileSection,
} from "./agentTiles";
import { ConnectionStatusDot } from "./ConnectionStatusDot";

/** The icon tile. T3's chooser is a grid of these, not a list of rows. */
export function AgentTileButton({
  tile,
  onSelect,
  compact = false,
}: {
  readonly tile: AgentTile;
  readonly onSelect: (provider: ProviderInfo, trigger: HTMLButtonElement) => void;
  readonly compact?: boolean | undefined;
}) {
  const gt = useGT();
  const added = agentAddedLabel(tile.added);
  const accent = normalizeAccentColor(tile.color);
  const statusLabel = added
    ? `${tile.label} — ${added}`
    : tile.admin
      ? `${tile.label} — ${gt("Organization admin key")}`
      : `${tile.label} — ${gt("Not connected")}`;
  return (
    <button
      type="button"
      data-agent={tile.id}
      data-added={tile.added}
      data-admin={tile.admin || undefined}
      data-provider-accent-color={accent}
      aria-label={statusLabel}
      onClick={(event) => tile.provider && onSelect(tile.provider, event.currentTarget)}
      className={cn(
        "group relative flex min-h-18 min-w-0 items-center gap-3 rounded-lg border border-border/70 bg-card/40 px-3 text-start transition-colors hover:bg-muted/30 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        compact ? "py-2" : "py-3 sm:px-4",
        tile.added !== "none" && "border-border/60",
      )}
    >
      <ProviderIcon
        driver={tile.id}
        label={tile.label}
        className="size-8 shrink-0 rounded-md border border-border/70 bg-card p-1"
        accent={accent}
      />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{tile.label}</span>
          {added ? (
            <Badge size="sm" variant="secondary" className="shrink-0">
              {added}
            </Badge>
          ) : null}
        </span>
        <span className="truncate text-xs text-muted-foreground">{tile.note}</span>
      </span>
      <ConnectionStatusDot tone={tile.dot} label={statusLabel} />
    </button>
  );
}

/**
 * The chooser body, exported on its own so it can be rendered (and tested) without a dialog.
 * The search and the tile grid are the only ways in: there is no flat connection list behind it.
 */
export function AgentChooserContent({
  sections,
  query,
  onQueryChange,
  onSelect,
  onOpenSettings,
  onCustom,
  titleSlot,
  searchRef,
  loading = false,
}: {
  readonly sections: readonly AgentTileSection[];
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (provider: ProviderInfo) => void;
  readonly onOpenSettings: () => void;
  readonly onCustom?: (() => void) | undefined;
  readonly titleSlot?: ReactNode;
  readonly searchRef?: RefObject<HTMLInputElement | null>;
  readonly loading?: boolean | undefined;
}) {
  const gt = useGT();
  const id = useId();
  const empty = sections.every((section) => section.tiles.length === 0);
  return (
    <div className="flex min-h-0 flex-col gap-3 px-4 pb-4 sm:px-6" data-slot="agent-chooser">
      {titleSlot === undefined ? (
        <h2 className="text-sm font-medium" id={`${id}-title`}>
          <T>Choose an agent</T>
        </h2>
      ) : (
        titleSlot
      )}
      <div className="grid shrink-0 gap-1">
        <label className="sr-only" htmlFor={`${id}-search`}>
          {gt("Search agents…")}
        </label>
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 start-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={searchRef}
            id={`${id}-search`}
            type="search"
            name="agent-search"
            className="[&>input]:ps-8"
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder={gt("Search agents…")}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
      </div>

      <div className="min-h-0 max-h-[22rem] overflow-y-auto overscroll-contain rounded-md focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" data-slot="agent-chooser-scroll">
        <div className="grid gap-3 p-px">
          {empty ? (
            <p role="status" className="py-8 text-center text-sm text-muted-foreground">
              {loading ? gt("Looking for agents…") : gt("No agents match your search.")}
            </p>
          ) : (
            sections.map((section) => (
              <section key={section.id} aria-labelledby={`${id}-${section.id}`}>
                <h3
                  id={`${id}-${section.id}`}
                  className="pb-1.5 text-xs font-medium text-muted-foreground"
                >
                  {section.label}
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {section.tiles.map((tile) => (
                    <AgentTileButton key={tile.key} tile={tile} onSelect={onSelect} />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border/60 pt-3">
        <Button size="sm" variant="outline" onClick={onOpenSettings}>
          <SettingsIcon />
          <T>Open provider setup</T>
        </Button>
        {onCustom ? (
          <Button size="sm" variant="ghost-muted" onClick={onCustom}>
            <T>Custom definition</T>
          </Button>
        ) : null}
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          <T>
            Organization admin keys read API spend for a whole workspace. Personal usage connects
            with the agent&apos;s own sign-in instead.
          </T>
        </p>
      </div>
    </div>
  );
}

/** The "Add provider" / "Choose an agent" dialog used by the Providers page and Settings. */
export function AgentChooser({
  open,
  onOpenChange,
  providers,
  hidden = [],
  order = [],
  onSelect,
  onOpenSettings,
  onCustom,
  loading = false,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providers: readonly ProviderInfo[];
  readonly hidden?: readonly string[] | undefined;
  readonly order?: readonly string[] | undefined;
  readonly onSelect: (provider: ProviderInfo) => void;
  readonly onOpenSettings: () => void;
  readonly onCustom?: (() => void) | undefined;
  readonly loading?: boolean | undefined;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const tiles = useMemo(() => buildAgentTiles(providers, { hidden, order }), [providers, hidden, order]);
  const sections = useMemo(() => groupAgentTiles(filterAgentTiles(tiles, query)), [tiles, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-2xl" initialFocus={(type) => type === "touch" ? true : searchRef.current} data-provider-dialog>
        <DialogHeader>
          <DialogTitle>{gt("Choose an agent")}</DialogTitle>
          <DialogDescription>
            <T>Select a provider to connect or manage its accounts.</T>
          </DialogDescription>
        </DialogHeader>
          <AgentChooserContent
            sections={sections}
            titleSlot={null}
            searchRef={searchRef}
            query={query}
            onQueryChange={setQuery}
            onSelect={(provider) => {
              onOpenChange(false);
              onSelect(provider);
            }}
            onOpenSettings={() => {
              onOpenChange(false);
              onOpenSettings();
            }}
            {...(onCustom
              ? {
                  onCustom: () => {
                    onOpenChange(false);
                    onCustom();
                  },
                }
              : {})}
            loading={loading}
          />
      </DialogPopup>
    </Dialog>
  );
}
