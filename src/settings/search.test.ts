import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSearchIndex,
  groupSections,
  normalizeSearchText,
  searchSettings,
  type SettingsSearchItem,
} from "./search";
import { SETTINGS_SEARCH_ROWS } from "./searchRows";
import type { SectionDef } from "./types";

const Component = (): null => null;

const sections: readonly SectionDef[] = [
  {
    id: "general",
    title: "General",
    order: 1,
    Component,
    keywords: ["language", "currency"],
  },
  { id: "usage", title: "Usage", order: 2, Component, group: "Data" },
  { id: "appearance", title: "Appearance", order: 3, Component, group: "Data" },
  { id: "advanced", title: "Advanced", order: 4, Component },
];

function item(overrides: Partial<SettingsSearchItem> & Pick<SettingsSearchItem, "id" | "title">): SettingsSearchItem {
  return { sectionId: "test", sectionTitle: "Test", ...overrides };
}

describe("normalizeSearchText", () => {
  it("lowercases, drops diacritics and collapses whitespace", () => {
    expect(normalizeSearchText("  Café   Menu ")).toBe("cafe menu");
    expect(normalizeSearchText("ÉCOLE\t\nRéglage")).toBe("ecole reglage");
    expect(normalizeSearchText("Straße")).toBe("straße");
  });

  it("keeps already-normalised text and collapses empty input", () => {
    expect(normalizeSearchText("usage limits")).toBe("usage limits");
    expect(normalizeSearchText("   ")).toBe("");
  });
});

describe("buildSearchIndex", () => {
  it("adds one entry per section with its own title as target", () => {
    const index = buildSearchIndex(sections);
    expect(index).toHaveLength(4);
    expect(index[0]).toMatchObject({
      id: "general",
      title: "General",
      sectionId: "general",
      sectionTitle: "General",
      keywords: ["language", "currency"],
      targetId: "general",
    });
    expect(index.every((entry) => entry.secondary === undefined)).toBe(true);
  });

  it("flattens rows beneath their section and marks them secondary", () => {
    const index = buildSearchIndex(sections, [
      { id: "language", title: "Language", sectionId: "general", keywords: ["locale"] },
      { id: "currency", title: "Currency", sectionId: "general" },
    ]);
    expect(index).toHaveLength(6);
    expect(index[4]).toEqual({
      id: "general/language",
      title: "Language",
      sectionId: "general",
      sectionTitle: "General",
      keywords: ["locale"],
      targetId: "language",
      secondary: true,
    });
  });

  it("falls back to the section id when no section title is known", () => {
    const index = buildSearchIndex(sections, [{ id: "orphan", title: "Orphan", sectionId: "ghost" }]);
    expect(index.at(-1)).toMatchObject({ sectionTitle: "ghost", targetId: "orphan", secondary: true });
  });

  it("skips incomplete row registrations", () => {
    const index = buildSearchIndex(sections, [
      { id: "", title: "No id", sectionId: "general" },
      { id: "blank", title: "", sectionId: "general" },
    ]);
    expect(index).toHaveLength(4);
  });
});

describe("searchSettings", () => {
  it("finds polling rows before those sections have mounted", () => {
    const index = buildSearchIndex([...sections], SETTINGS_SEARCH_ROWS);
    expect(searchSettings("refresh interval", index)[0]?.targetId).toBe("usage-refresh-interval");
  });

  const ranked: readonly SettingsSearchItem[] = [
    item({ id: "usage", title: "Usage" }),
    item({ id: "limits", title: "Usage limits" }),
    item({ id: "tokens", title: "Token usage" }),
    item({ id: "cost", title: "Cost", sectionId: "billing", sectionTitle: "Billing", keywords: ["usage"] }),
  ];

  it("returns nothing for an empty or whitespace-only query", () => {
    expect(searchSettings("", ranked)).toEqual([]);
    expect(searchSettings("   ", ranked)).toEqual([]);
  });

  it("ranks exact, prefix, substring and keyword/section hits in that order", () => {
    expect(searchSettings("usage", ranked).map((entry) => entry.id)).toEqual([
      "usage",
      "limits",
      "tokens",
      "cost",
    ]);
  });

  it("requires every query token to match somewhere", () => {
    expect(searchSettings("token usage", ranked).map((entry) => entry.id)).toEqual(["tokens"]);
    expect(searchSettings("token cost", ranked)).toEqual([]);
  });

  it("matches keywords, section titles and translations, not just row titles", () => {
    const items = [
      item({ id: "alerts", title: "Alerts", keywords: ["budget", "spend"] }),
      item({ id: "language", title: "Language", sectionTitle: "General" }),
      item({ id: "sprache", title: "Sprache" }),
    ];
    const translate = (message: string): string => (message === "Sprache" ? "Language" : message);

    expect(searchSettings("budget", items, translate).map((entry) => entry.id)).toEqual(["alerts"]);
    expect(searchSettings("general", items, translate).map((entry) => entry.id)).toEqual(["language"]);
    expect(searchSettings("language", items, translate).map((entry) => entry.id)).toEqual([
      "language",
      "sprache",
    ]);
  });

  it("is case- and diacritic-insensitive", () => {
    const items = [item({ id: "cafe", title: "Café" })];
    expect(searchSettings("CAFE", items)).toEqual(items);
    expect(searchSettings("café", items)).toEqual(items);
  });

  it("prefers an exact row title to a section keyword", () => {
    const items = [
      item({ id: "general/language", title: "Language", sectionId: "general", secondary: true }),
      item({ id: "general", title: "General", keywords: ["language"] }),
    ];
    expect(searchSettings("language", items).map((entry) => entry.id)).toEqual([
      "general/language",
      "general",
    ]);
  });

  it("preserves index order for equally ranked results", () => {
    const items = [
      item({ id: "a", title: "Usage A" }),
      item({ id: "b", title: "Usage B" }),
    ];
    expect(searchSettings("usage", items).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("works against the built index", () => {
    const index = buildSearchIndex(sections, [
      { id: "language", title: "Language", sectionId: "general" },
    ]);
    const results = searchSettings("language", index).map((entry) => entry.id);
    expect(results).toEqual(["general/language", "general"]);
  });
});

describe("static search rows", () => {
  it("only lists rows whose DOM id exists in a section or settings component", () => {
    const root = path.resolve(__dirname, "..");
    const files = [
      ...fs.readdirSync(path.join(root, "settings/sections")).map((name) => path.join(root, "settings/sections", name)),
      ...fs.readdirSync(path.join(root, "components/settings")).map((name) => path.join(root, "components/settings", name)),
      // Shared blocks that render rows from data (for example one folder block per agent) live next to the page.
      ...fs.readdirSync(path.join(root, "settings")).map((name) => path.join(root, "settings", name)),
    ].filter((file) => /\.tsx$/.test(file) && !/\.test\./.test(file));
    const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    // `providers-sources-<agent>` ids are generated from the agent list, so the template counts as the id.
    const generated = (id: string) => id.startsWith("providers-sources-") && source.includes("id={`providers-sources-${");
    const missing = SETTINGS_SEARCH_ROWS.filter((row) => !source.includes(`id="${row.id}"`) && !generated(row.id)).map(
      (row) => row.id,
    );
    expect(missing).toEqual([]);
  });

  it("omits removed settings (Corner radius, Density) and the hidden shell tab", () => {
    const ids = SETTINGS_SEARCH_ROWS.map((row) => row.id);
    expect(ids).not.toContain("setting-appearance-radius");
    expect(ids).not.toContain("setting-appearance-density");
    expect(ids.some((id) => id.startsWith("shell-"))).toBe(false);
  });
});

describe("groupSections", () => {
  it("groups by heading in first-seen order and defaults to Preferences", () => {
    const groups = groupSections(sections);
    expect(groups.map((group) => group.heading)).toEqual(["Preferences", "Data"]);
    expect(groups[0]!.sections.map((section) => section.id)).toEqual(["general", "advanced"]);
    expect(groups[1]!.sections.map((section) => section.id)).toEqual(["usage", "appearance"]);
  });

  it("returns no groups for no sections", () => {
    expect(groupSections([])).toEqual([]);
  });
});
