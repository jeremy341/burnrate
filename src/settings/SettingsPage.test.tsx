import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectSections, SECTIONS } from "./registry";
import { normalizeGlobalShortcut } from "./shortcuts";
import { isDesktopShell } from "./environment";
import { scrollToSettingsTarget } from "./layout";
import { PAGE_RHYTHM, WIDTH_CLASS } from "~/components/WorkspacePageContainer";
import { auditMarkup } from "~/components/ui/a11yAudit";
import { parseBoundedNumber } from "~/components/settings/SettingsNumberField";

function stubWindow(hash: string) {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    location: { hash, pathname: "/", search: "" },
    history: { replaceState: () => {} },
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  });
}

beforeEach(() => stubWindow(""));
afterEach(() => vi.unstubAllGlobals());

describe("section registry", () => {
  it("registers every section once, grouped, with search keywords", () => {
    const ids = SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "general",
      "appearance",
      "providers",
      "usage",
      "notifications",
      "shortcuts",
      "data",
      "advanced",
      "about",
    ]);
    for (const section of SECTIONS) {
      expect(section.group, `${section.id} group`).toBeTruthy();
      expect(section.keywords?.length ?? 0, `${section.id} keywords`).toBeGreaterThan(0);
    }
  });

  it("folds a module's exported keywords into the section (they were ignored before)", () => {
    const Component = () => null;
    const sections = collectSections({
      "./b.tsx": { section: { id: "b", title: "B", order: 2, Component }, keywords: ["kb"] },
      "./a.tsx": { section: { id: "a", title: "A", order: 1, Component, keywords: ["own"] }, keywords: ["ignored"] },
      "./none.tsx": {},
    });
    expect(sections.map((section) => section.id)).toEqual(["a", "b"]);
    expect(sections[0]?.keywords).toEqual(["own"]);
    expect(sections[1]?.keywords).toEqual(["kb"]);
  });
});

describe("SettingsPage", () => {
  async function render(hash: string): Promise<string> {
    stubWindow(hash);
    const { SettingsPage } = await import("./SettingsPage");
    return renderToStaticMarkup(<SettingsPage />);
  }

  it("renders every section in a visible, grouped sidebar plus a themed (non-native) mobile menu", async () => {
    const html = await render("");
    for (const heading of ["Preferences", "Desktop", "System"]) expect(html).toContain(heading);
    for (const section of SECTIONS) expect(html).toContain(`data-settings-section="${section.id}"`);
    // The narrow-screen picker is the themed Select; a native <select>/<optgroup> ignored the theme.
    expect(html).toContain('aria-label="Settings section"');
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<optgroup");
    expect(html).toContain('aria-current="page"');
    // The page rhythm and the form column are the shared container's, so read them from its exports.
    expect(html).toContain(PAGE_RHYTHM);
    expect(html).toContain(WIDTH_CLASS.form);
    expect(html).toContain("focus-visible:ring-inset focus-visible:ring-ring");
  });

  it("opens the section named by a #settings/<id> deep link, and by a row id", async () => {
    const linked = await render("#settings/shortcuts");
    expect(linked).toMatch(/data-settings-section="shortcuts"[^>]*aria-current="page"|aria-current="page"[^>]*data-settings-section="shortcuts"/);

    const row = await render("#settings/general-close-to-tray");
    expect(row).toMatch(/data-settings-section="general"[^>]*aria-current="page"|aria-current="page"[^>]*data-settings-section="general"/);

    const nested = await render("#settings/notifications/channels");
    expect(nested).toContain('id="notifications-channels"');
    expect(nested).toMatch(/data-settings-section="notifications"[^>]*aria-current="page"/);
  });

  it("exposes the setup tour from Advanced (the legacy setup-guide link is gone)", async () => {
    const html = await render("#settings/advanced-setup-tour");
    expect(html).toContain('id="advanced-setup-tour"');
    expect(html).toContain("Welcome tour");
    expect(html).toContain("Start tour");
    expect(html).not.toContain("Connect an agent");
  });

  it("passes the markup accessibility audit for every section", async () => {
    for (const section of SECTIONS) {
      const html = await render(`#settings/${section.id}`);
      expect(auditMarkup(html), `${section.id} violations`).toEqual([]);
    }
  });

  it("never renders a sub-24px icon button (WCAG 2.5.8) in a settings section", async () => {
    for (const section of SECTIONS) {
      const html = await render(`#settings/${section.id}`);
      // icon-micro is size-5 and icon-tiny is size-4: both are below the 24px minimum target.
      expect(html, section.id).not.toMatch(/data-slot="button"[^>]*class="[^"]*(?:size-4|size-5)(?! shrink)[^"]*"/);
    }
  });

  it("keeps every scrollable settings list reachable by keyboard (WCAG 2.1.1)", async () => {
    // Internal scroll regions are focusable and named, so a keyboard user can scroll them
    // with the arrow keys instead of depending on the mouse wheel.
    const focusable = (html: string, marker: string) =>
      expect(html, marker).toMatch(
        new RegExp(`${marker}[^>]*tabindex="0"|tabindex="0"[^>]*${marker}`),
      );

    // The providers list no longer scrolls on its own (the page does), so only long text regions remain.
    const about = await render("#settings/about");
    focusable(about, "overflow-y-auto");
  });

  it("names every settings row after its title and links its helper text", async () => {
    const html = await render("#settings/general");
    const row = /<div role="group" aria-labelledby="([^"]+)"( aria-describedby="([^"]+)")?[^>]*data-slot="settings-row"/.exec(html);
    expect(row, "row group").not.toBeNull();
    expect(html).toContain(`id="${row![1]}"`);
    if (row![3]) expect(html).toContain(`id="${row![3]}"`);
  });

  it("describes the language picker and switches with their visible helper text", async () => {
    const html = await render("#settings/general");
    for (const label of ["Language", "Launch at login"]) {
      const control = html.match(new RegExp(`<[^>]+aria-label="${label}"[^>]*>`))?.[0];
      const descriptionId = control?.match(/aria-describedby="([^"]+)"/)?.[1];
      expect(descriptionId, label).toBeTruthy();
      expect(html).toContain(`id="${descriptionId}"`);
    }
  });

  it("moves a disabled notification search target to the master switch and respects reduced motion", () => {
    const switchRow = {
      querySelector: () => null,
      matches: () => false,
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
      classList: { remove: vi.fn(), add: vi.fn() },
    };
    const target = {
      closest: (selector: string) => selector.includes("unavailable")
        ? { dataset: { settingsUnavailableTarget: "notifications-enabled" } }
        : null,
    };
    vi.stubGlobal("document", {
      documentElement: { dataset: { reduceMotion: "on" } },
      getElementById: (id: string) => id === "notifications-enabled" ? switchRow : target,
    });
    expect(scrollToSettingsTarget("notifications-channels")).toBe(true);
    expect(switchRow.scrollIntoView).toHaveBeenCalledOnce();
    expect(switchRow.focus).toHaveBeenCalledWith({ preventScroll: true });
    // Reduced motion: no pulse animation, a plain ring instead.
    expect(switchRow.classList.add).not.toHaveBeenCalledWith("settings-search-target-pulse");
    expect(switchRow.classList.add).toHaveBeenCalledWith("ring-2", "ring-inset", "ring-primary/70", "rounded-xl");
  });

  it("falls back to the first section for an unknown link", async () => {
    const html = await render("#settings/nope");
    expect(html).toMatch(/data-settings-section="general"[^>]*aria-current="page"|aria-current="page"[^>]*data-settings-section="general"/);
  });
});

describe("settings helpers", () => {
  it("parseBoundedNumber clamps and rejects without fighting typing", () => {
    expect(parseBoundedNumber("1", 30, 100)).toEqual({ ok: true, value: 30 });
    expect(parseBoundedNumber("120.4", 30, 86400)).toEqual({ ok: true, value: 120 });
    expect(parseBoundedNumber("999999", 30, 86400)).toEqual({ ok: true, value: 86400 });
    expect(parseBoundedNumber("0.5", 0, 1, { integer: false })).toEqual({ ok: true, value: 0.5 });
    expect(parseBoundedNumber("", 0, 10)).toEqual({ ok: false });
    expect(parseBoundedNumber("abc", 0, 10)).toEqual({ ok: false });
  });

  it("treats an empty global shortcut as none (L5)", () => {
    expect(normalizeGlobalShortcut("")).toBeNull();
    expect(normalizeGlobalShortcut("  ")).toBeNull();
    expect(normalizeGlobalShortcut(null)).toBeNull();
    expect(normalizeGlobalShortcut("mod+shift+b")).toBe("mod+shift+b");
  });

  it("detects the Tauri webview only when its globals exist", () => {
    expect(isDesktopShell({})).toBe(false);
    expect(isDesktopShell({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(isDesktopShell({ __TAURI__: {} })).toBe(true);
    expect(isDesktopShell(undefined)).toBe(false);
  });
});
