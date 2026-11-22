/**
 * Flat search index for the settings shell.
 *
 * Sections register themselves through the `SECTIONS` registry; individual rows opt in by passing an
 * `id` (and optional `keywords`) to `SettingsRow`, which registers its title through `SettingsSearchContext`.
 * Everything here is pure except the tiny registration context, so the index can be tested without a DOM.
 */
import { createContext } from "react";

import type { SectionDef } from "./types";

/** One entry of the flat search index. */
export interface SettingsSearchItem {
  /** Unique key (`<sectionId>` for a section, `<sectionId>/<rowId>` for a row). */
  readonly id: string;
  readonly title: string;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly keywords?: readonly string[];
  /** DOM id to scroll to and focus; defaults to `id`. */
  readonly targetId?: string;
  /** Row entries rank below whole-section entries for the same query. */
  readonly secondary?: boolean;
}

/** A row registered at render time by `SettingsRow`. */
export interface RegisteredSettingsRow {
  /** DOM id of the row (used as the deep-link target). */
  readonly id: string;
  readonly title: string;
  readonly sectionId: string;
  readonly keywords?: readonly string[];
}

/** Tiny external store shared by `SettingsPage` (owner) and `SettingsRow` (registrant). */
export interface SettingsRowIndex {
  register(row: RegisteredSettingsRow): void;
  unregister(id: string): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly RegisteredSettingsRow[];
}

export interface SettingsSearchContextValue {
  /** Section currently mounted in the content pane; stamped onto registered rows. */
  readonly sectionId: string;
  readonly index: SettingsRowIndex;
}

export const SettingsSearchContext = createContext<SettingsSearchContextValue | null>(null);

/** Same normalisation T3 uses: drop diacritics, lowercase, collapse whitespace. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function sameKeywords(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, i) => value === b[i]);
}

export function createSettingsRowIndex(): SettingsRowIndex {
  const listeners = new Set<() => void>();
  const rows = new Map<string, RegisteredSettingsRow>();
  let snapshot: readonly RegisteredSettingsRow[] = [];

  const rebuild = () => {
    snapshot = Array.from(rows.values()).sort((a, b) => a.id.localeCompare(b.id));
    listeners.forEach((listener) => listener());
  };

  return {
    register(row) {
      const previous = rows.get(row.id);
      if (
        previous &&
        previous.title === row.title &&
        previous.sectionId === row.sectionId &&
        sameKeywords(previous.keywords, row.keywords)
      ) {
        return;
      }
      rows.set(row.id, row);
      rebuild();
    },
    unregister(id) {
      if (rows.delete(id)) rebuild();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
  };
}

/** Flatten registered sections + row titles into one searchable list (registry order wins). */
export function buildSearchIndex(
  sections: readonly SectionDef[],
  rows: readonly RegisteredSettingsRow[] = [],
): readonly SettingsSearchItem[] {
  const items: SettingsSearchItem[] = sections.map((section) => ({
    id: section.id,
    title: section.title,
    sectionId: section.id,
    sectionTitle: section.title,
    keywords: section.keywords,
    targetId: section.id,
  }));

  const sectionTitles = new Map(sections.map((section) => [section.id, section.title]));
  for (const row of rows) {
    if (!row.id || !row.title) continue;
    items.push({
      id: `${row.sectionId}/${row.id}`,
      title: row.title,
      sectionId: row.sectionId,
      sectionTitle: sectionTitles.get(row.sectionId) ?? row.sectionId,
      keywords: row.keywords,
      targetId: row.id,
      secondary: true,
    });
  }
  return items;
}

/**
 * Token-and-rank search in the spirit of T3's `searchSettings`: every query token must match some field,
 * then results are ordered by exact/prefix/substring title hits before section and keyword hits.
 */
export function searchSettings(
  query: string,
  items: readonly SettingsSearchItem[] = [],
  translate: (message: string) => string = (message) => message,
): readonly SettingsSearchItem[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(" ");

  return items
    .flatMap((item, index) => {
      const title = normalizeSearchText(item.title);
      const fields = [
        title,
        normalizeSearchText(item.sectionTitle),
        normalizeSearchText(translate(item.title)),
        normalizeSearchText(translate(item.sectionTitle)),
        ...(item.keywords ?? []).map(normalizeSearchText),
      ];
      if (!tokens.every((token) => fields.some((field) => field.includes(token)))) return [];

      const rank =
        title === normalizedQuery
          ? 5
          : title.startsWith(normalizedQuery)
            ? 4
            : title.includes(normalizedQuery)
              ? 3
              : tokens.every((token) => title.includes(token))
                ? 2
                : fields.some((field) => field.includes(normalizedQuery))
                  ? 1
                  : 0;
      return [{ item, index, rank, secondary: item.secondary ? 1 : 0 }];
    })
    .sort(
      (left, right) =>
        right.rank - left.rank ||
        left.secondary - right.secondary ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

/** Group headings for the sidebar. Sections without a group land in "Preferences". */
export function groupSections(
  sections: readonly SectionDef[],
): ReadonlyArray<{ heading: string; sections: readonly SectionDef[] }> {
  const groups: Array<{ heading: string; sections: SectionDef[] }> = [];
  for (const section of sections) {
    const heading = section.group ?? "Preferences";
    let group = groups.find((candidate) => candidate.heading === heading);
    if (!group) {
      group = { heading, sections: [] };
      groups.push(group);
    }
    group.sections.push(section);
  }
  return groups;
}
