import type { ComponentType } from "react";

/** Settings value types live in `schema.ts`; re-exported here for callers that import from `./types`. */
export type { AppSettings, SettingsPatch } from "./schema";

/** A settings section. Drop a file `src/settings/sections/<id>.tsx` exporting `section: SectionDef`. */
export interface SectionDef {
  readonly id: string;
  readonly title: string;
  /** Sidebar order, ascending. */
  readonly order: number;
  readonly Component: ComponentType;
  /** Extra search terms for this section (the settings-shell package builds a flat search index from them). */
  readonly keywords?: readonly string[];
  /** Optional sidebar icon; a known-id fallback is used when omitted. */
  readonly icon?: ComponentType<{ className?: string }>;
  /** Sidebar group heading. Unknown sections fall back to "Preferences". */
  readonly group?: string;
}

/** Sidebar group headings, in display order. Sections pick one through `SectionDef.group`. */
export const SECTION_GROUPS = {
  preferences: "Preferences",
  desktop: "Desktop",
  system: "System",
} as const;
