import type { SectionDef } from "./types";

/** What a `sections/*.tsx` module may export: the section itself and, optionally, its search terms. */
export interface SectionModule {
  readonly section?: SectionDef;
  /** Search terms exported next to `section`; folded into `section.keywords` when it has none. */
  readonly keywords?: readonly string[];
}

/**
 * Build the ordered section list from the glob result. A module that exports `keywords` beside
 * `section` (the documented pattern) must reach the search index, so they are merged here; before
 * this the exports were never read and section keywords silently did nothing.
 */
export function collectSections(modules: Readonly<Record<string, SectionModule>>): readonly SectionDef[] {
  return Object.values(modules)
    .flatMap((module) =>
      module.section
        ? [{ ...module.section, keywords: module.section.keywords ?? module.keywords }]
        : [],
    )
    .sort((a, b) => a.order - b.order);
}

const modules = import.meta.glob<SectionModule>(["./sections/*.tsx", "!./sections/*.test.tsx"], { eager: true });

/**
 * T3's settings navigation order. This is the single source of truth for which tabs exist and the
 * order they appear in — section files only provide content. The old "Desktop shell" tab is gone:
 * its live options already live in General and Shortcuts, and its dead ones are removed.
 */
export const SETTINGS_NAV_ORDER: readonly string[] = [
  "general",
  "appearance",
  "providers",
  "usage",
  "notifications",
  "shortcuts",
  "data",
  "advanced",
  "about",
];

const NAV_RANK = new Map(SETTINGS_NAV_ORDER.map((id, index) => [id, index]));

export const SECTIONS: readonly SectionDef[] = collectSections(modules)
  .filter((section) => NAV_RANK.has(section.id))
  .sort((a, b) => NAV_RANK.get(a.id)! - NAV_RANK.get(b.id)!);

export function getSection(id: string): SectionDef | undefined {
  return SECTIONS.find((section) => section.id === id);
}
