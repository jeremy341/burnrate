import type { ComponentType } from "react";

/** A row in the command palette. Register your own with `registerCommand` from `~/palette/registry`. */
export interface PaletteCommand {
  /** Stable, unique id. Re-registering the same id replaces the earlier command. */
  readonly id: string;
  /** Localised row title (pass strings through `useGT()` / `msg()`). */
  readonly title: string;
  /** Localised group label; commands sharing a label are listed together. */
  readonly group: string;
  /** Sort key for groups (ascending). Built-ins: Views 10, Settings 20, Actions 30. */
  readonly groupOrder?: number;
  /** Secondary text shown under the title, also searchable. */
  readonly description?: string;
  /** Extra search terms (ids, synonyms, keywords). */
  readonly keywords?: readonly string[];
  /** Lucide-style icon component; receives `className`. */
  readonly icon?: ComponentType<{ className?: string }>;
  /** The current state this command acts on, shown muted before the shortcut (e.g. "Dark", "On"). */
  readonly value?: string;
  /** Keyboard hint rendered on the right of the row, e.g. "Ctrl K". */
  readonly shortcut?: string;
  /** Tie-breaker inside a group (descending). */
  readonly priority?: number;
  /** Hide the command when this returns false (evaluated on every open). */
  readonly enabled?: () => boolean;
  /** Runs when the row is picked. A returned string is shown as a status message. */
  readonly run: () => void | string | Promise<void | string>;
}

/** A group of commands as shown in the palette. */
export interface PaletteCommandGroup {
  readonly label: string;
  readonly order: number;
  commands: PaletteCommand[];
}
