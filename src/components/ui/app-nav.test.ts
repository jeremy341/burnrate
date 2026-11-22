import { describe, expect, it, vi } from "vitest";

import {
  createNavShortcuts,
  hashAddressesView,
  HOME_VIEW,
  isNavKeyboardClaimed,
  NAV_CHORD_TIMEOUT_MS,
  navShortcutHint,
  parseViewFromHash,
  settingsGearTarget,
  SETTINGS_VIEW,
  shouldShowHomeClose,
  viewToHash,
  type NavShortcutContext,
} from "./app-nav";

const IDS = ["usage", "providers", "settings"] as const;

it("lets an active shortcut recorder handle Escape before app navigation", () => {
  class ShortcutRecorder {
    closest(selector: string) {
      return selector.includes("[data-keybinding-capture]") ? this : null;
    }
  }
  vi.stubGlobal("HTMLElement", ShortcutRecorder);
  try {
    expect(isNavKeyboardClaimed(new ShortcutRecorder() as unknown as HTMLElement, null)).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("parseViewFromHash", () => {
  it("treats an empty hash as the home view (Back to the first entry lands on Usage)", () => {
    expect(parseViewFromHash("", IDS)).toBe(HOME_VIEW);
    expect(parseViewFromHash("#", IDS)).toBe(HOME_VIEW);
    expect(parseViewFromHash("#usage", IDS)).toBe(HOME_VIEW);
  });

  it("resolves each registered view", () => {
    expect(parseViewFromHash("#providers", IDS)).toBe("providers");
    expect(parseViewFromHash("#settings", IDS)).toBe("settings");
  });

  it("maps Settings deep links to the settings view, whatever follows the slash", () => {
    expect(parseViewFromHash("#settings", IDS)).toBe("settings");
    expect(parseViewFromHash("#settings/appearance", IDS)).toBe("settings");
    expect(parseViewFromHash("#settings/providers", IDS)).toBe("settings");
  });

  it("ignores hashes that belong to nobody so the current view is kept", () => {
    expect(parseViewFromHash("#nope", IDS)).toBeNull();
    expect(parseViewFromHash("#section-3", IDS)).toBeNull();
  });
});

describe("settingsGearTarget", () => {
  it("opens Settings from any other screen and goes back to Usage from Settings", () => {
    expect(settingsGearTarget("usage")).toBe(SETTINGS_VIEW);
    expect(settingsGearTarget("providers")).toBe(SETTINGS_VIEW);
    expect(settingsGearTarget(SETTINGS_VIEW)).toBe(HOME_VIEW);
  });
});

describe("viewToHash / hashAddressesView", () => {
  it("round-trips every view", () => {
    for (const id of IDS) expect(parseViewFromHash(viewToHash(id), IDS)).toBe(id);
  });

  it("does not push a duplicate entry when the hash already addresses the view", () => {
    expect(hashAddressesView("#settings/appearance", "settings", IDS)).toBe(true);
    expect(hashAddressesView("#providers", "providers", IDS)).toBe(true);
    expect(hashAddressesView("", "usage", IDS)).toBe(true);
  });

  it("does push when the hash addresses a different view", () => {
    expect(hashAddressesView("#providers", "settings", IDS)).toBe(false);
    expect(hashAddressesView("", "providers", IDS)).toBe(false);
  });
});

describe("navigation shortcuts", () => {
  const ctx = (over: Partial<NavShortcutContext> = {}): NavShortcutContext => ({
    view: "usage",
    validIds: IDS,
    suppressed: false,
    mac: false,
    now: 1000,
    ...over,
  });

  it("opens Settings with Ctrl+, (Cmd+, on macOS), also while typing", () => {
    const nav = createNavShortcuts();
    expect(nav.resolve({ key: ",", ctrlKey: true }, ctx())).toEqual({ type: "navigate", viewId: "settings" });
    expect(nav.resolve({ key: ",", metaKey: true }, ctx({ mac: true }))).toEqual({
      type: "navigate",
      viewId: "settings",
    });
    expect(nav.resolve({ key: ",", ctrlKey: true }, ctx({ suppressed: true }))).toEqual({
      type: "navigate",
      viewId: "settings",
    });
    expect(nav.resolve({ key: ",", metaKey: true }, ctx({ mac: false }))).toBeNull();
    expect(nav.resolve({ key: ",", ctrlKey: true, shiftKey: true }, ctx())).toBeNull();
  });

  it("goes back to Usage on Esc, only from another screen and never over a text field or open menu", () => {
    const nav = createNavShortcuts();
    expect(nav.resolve({ key: "Escape" }, ctx({ view: "providers" }))).toEqual({ type: "back" });
    expect(nav.resolve({ key: "Escape" }, ctx({ view: "usage" }))).toBeNull();
    expect(nav.resolve({ key: "Escape" }, ctx({ view: "settings", suppressed: true }))).toBeNull();
    expect(nav.resolve({ key: "Escape", defaultPrevented: true }, ctx({ view: "settings" }))).toBeNull();
  });

  it("jumps with the g chord and expires it", () => {
    const nav = createNavShortcuts();
    expect(nav.resolve({ key: "g" }, ctx({ now: 1000 }))).toEqual({ type: "pending" });
    expect(nav.resolve({ key: "p" }, ctx({ now: 1500 }))).toEqual({ type: "navigate", viewId: "providers" });
    // The chord is consumed: a second letter alone does nothing.
    expect(nav.resolve({ key: "i" }, ctx({ now: 1600 }))).toBeNull();

    nav.resolve({ key: "g" }, ctx({ now: 2000 }));
    expect(nav.resolve({ key: "s" }, ctx({ now: 2000 + NAV_CHORD_TIMEOUT_MS + 1 }))).toBeNull();

    nav.resolve({ key: "g" }, ctx({ now: 5000 }));
    expect(nav.resolve({ key: "x" }, ctx({ now: 5100 }))).toBeNull();
    expect(nav.resolve({ key: "u" }, ctx({ now: 5200 }))).toBeNull();
  });

  it("does not start a chord while typing, with modifiers or on repeat, and ignores unknown screens", () => {
    const nav = createNavShortcuts();
    expect(nav.resolve({ key: "g" }, ctx({ suppressed: true }))).toBeNull();
    expect(nav.resolve({ key: "g", ctrlKey: true }, ctx())).toBeNull();
    expect(nav.resolve({ key: "g", repeat: true }, ctx())).toBeNull();
    nav.resolve({ key: "g" }, ctx({ now: 10 }));
    expect(nav.resolve({ key: "i" }, ctx({ now: 20, validIds: ["usage", "providers"] }))).toBeNull();
  });

  it("never collides with the Usage shortcuts (c, t, l, Ctrl+Shift+1..4)", () => {
    const nav = createNavShortcuts();
    for (const key of ["c", "t", "l"]) expect(nav.resolve({ key }, ctx())).toBeNull();
    for (const key of ["1", "2", "3", "4"]) {
      expect(nav.resolve({ key, ctrlKey: true, shiftKey: true }, ctx())).toBeNull();
    }
  });

  it("labels every screen with the shortcut that reaches it", () => {
    expect(navShortcutHint("settings", false)).toBe("Ctrl ,");
    expect(navShortcutHint("settings", true)).toBe("⌘,");
    expect(navShortcutHint("providers", false)).toBe("G P");
    expect(navShortcutHint("usage", false)).toBe("G U");
    expect(navShortcutHint("nope", false)).toBeUndefined();
  });
});

describe("keyboard ownership", () => {
  it("only draws a close button on Usage when the window has no native title bar", () => {
    expect(shouldShowHomeClose({})).toBe(true);
    expect(shouldShowHomeClose({ shell: "desktop" })).toBe(false);
    expect(shouldShowHomeClose({ shell: "desktop", titlebar: "custom" })).toBe(true);
  });
});
