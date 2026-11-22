/**
 * Pure navigation helpers for the settings shell: the `#settings/<target>` deep-link format, how a
 * target maps onto a section (+ optional row), and the remembered section. Kept free of React and
 * of `window` (every function takes its inputs) so the rules can be unit tested in a node environment.
 */
import type { SectionDef } from "./types";

export const SETTINGS_SECTION_STORAGE_KEY = "burnrate.settings.section";

/** Row ids that are not prefixed with their section id, mapped to the section that owns them. */
const ROW_SECTION_ALIASES: Readonly<Record<string, string>> = {
  typography: "appearance",
  "interface-font": "appearance",
  "mono-font": "appearance",
  "setting-theme-mode": "appearance",
};

export interface ResolvedSettingsTarget {
  readonly sectionId: string;
  /** DOM id of the row/section block to scroll to, or null when the target is a whole section. */
  readonly rowId: string | null;
}

/** `#settings/<target>` -> `<target>` (URL-decoded); null for any other hash. */
export function parseSettingsHash(hash: string): string | null {
  const match = /^#settings\/(.+)$/.exec(hash);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function formatSettingsHash(target: string): string {
  return `#settings/${encodeURIComponent(target)}`;
}

/**
 * Resolve a deep-link target. Accepts a section id (`providers`), a row id carrying its section as a
 * prefix (`appearance-theme-library`, `usage.refreshIntervalSec`, `notifications/channels`) or one of
 * the known unprefixed row ids. Unknown targets resolve to `null` so a stale or mistyped link leaves
 * the current section alone instead of jumping to the first one.
 */
export function resolveSettingsTarget(
  target: string | null,
  sections: readonly Pick<SectionDef, "id">[],
  knownRowIds: readonly string[] = [],
): ResolvedSettingsTarget | null {
  if (!target) return null;
  const ids = new Set(sections.map((section) => section.id));
  if (ids.has(target)) return { sectionId: target, rowId: null };

  for (const id of ids) {
    if (target.startsWith(`${id}.`) || target.startsWith(`${id}/`)) {
      const rest = target.slice(id.length + 1);
      const prefixed = `${id}-${rest}`;
      const rowId = rest && !knownRowIds.includes(rest) && knownRowIds.includes(prefixed) ? prefixed : rest;
      return { sectionId: id, rowId: rowId || null };
    }
    if (target.startsWith(`${id}-`) || target.startsWith(`setting-${id}-`)) {
      return { sectionId: id, rowId: target };
    }
  }
  const aliased = ROW_SECTION_ALIASES[target];
  if (aliased && ids.has(aliased)) return { sectionId: aliased, rowId: target };
  return null;
}

/** The section to show first: a valid deep link wins, then the remembered section, then the first. */
export function pickInitialSection(
  linked: ResolvedSettingsTarget | null,
  remembered: string | null,
  sections: readonly Pick<SectionDef, "id">[],
): string {
  if (linked) return linked.sectionId;
  if (remembered && sections.some((section) => section.id === remembered)) return remembered;
  return sections[0]?.id ?? "";
}

export function readRememberedSection(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  try {
    return storage?.getItem(SETTINGS_SECTION_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function rememberSection(storage: Pick<Storage, "setItem"> | null | undefined, id: string): void {
  try {
    storage?.setItem(SETTINGS_SECTION_STORAGE_KEY, id);
  } catch {
    /* private windows and blocked storage just forget the choice */
  }
}
