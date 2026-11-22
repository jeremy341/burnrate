import { afterEach, describe, expect, it, vi } from "vitest";

import {
  comboFromKeyboardEvent,
  comboLabel,
  conflictingInAppShortcuts,
  isSuitableGlobalShortcut,
  normalizeCombo,
} from "./shortcuts";

/** `comboFromKeyboardEvent` has no platform argument, so pin the platform through `navigator`. */
function usePlatform(platform: string): void {
  vi.stubGlobal("navigator", { platform });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeCombo", () => {
  it("maps mod to Ctrl off macOS and to Meta on macOS", () => {
    expect(normalizeCombo("mod+shift+1", "Win32")).toBe("ctrl+shift+1");
    expect(normalizeCombo("mod+shift+1", "Linux x86_64")).toBe("ctrl+shift+1");
    expect(normalizeCombo("mod+shift+1", "MacIntel")).toBe("meta+shift+1");
  });

  it("treats recorded Ctrl/Cmd/Meta spellings by what they mean, not by platform", () => {
    expect(normalizeCombo("Ctrl+Shift+B", "Win32")).toBe("ctrl+shift+b");
    expect(normalizeCombo("Cmd+Shift+B", "MacIntel")).toBe("meta+shift+b");
    // A Windows user can record Meta; a Mac user can record Ctrl.
    expect(normalizeCombo("Cmd+Shift+B", "Win32")).toBe("meta+shift+b");
    expect(normalizeCombo("Ctrl+Shift+B", "MacIntel")).toBe("ctrl+shift+b");
  });

  it("accepts aliases and ignores token order, case and surrounding whitespace", () => {
    expect(normalizeCombo("  Shift + Mod + b  ", "Win32")).toBe("ctrl+shift+b");
    expect(normalizeCombo("Command+Option+Control+K", "MacIntel")).toBe("ctrl+meta+alt+k");
    expect(normalizeCombo("CONTROL+Shift+F5", "Win32")).toBe("ctrl+shift+f5");
  });

  it("collapses duplicate modifiers", () => {
    expect(normalizeCombo("ctrl+control+Ctrl+B", "Win32")).toBe("ctrl+b");
  });

  it("returns an empty string when there is no key token", () => {
    expect(normalizeCombo("", "Win32")).toBe("");
    expect(normalizeCombo("Shift", "Win32")).toBe("");
    expect(normalizeCombo("mod+alt", "MacIntel")).toBe("");
  });
});

describe("isSuitableGlobalShortcut", () => {
  it("requires a real modifier beyond Shift", () => {
    expect(isSuitableGlobalShortcut("mod+shift+b", "Win32")).toBe(true);
    expect(isSuitableGlobalShortcut("mod+shift+b", "MacIntel")).toBe(true);
    expect(isSuitableGlobalShortcut("Alt+F4", "Win32")).toBe(true);
    expect(isSuitableGlobalShortcut("Meta+K", "Win32")).toBe(true);

    expect(isSuitableGlobalShortcut("Shift+B", "Win32")).toBe(false);
    expect(isSuitableGlobalShortcut("shift+1", "MacIntel")).toBe(false);
  });

  it("rejects modifier-only and empty combos", () => {
    expect(isSuitableGlobalShortcut("", "Win32")).toBe(false);
    expect(isSuitableGlobalShortcut("Ctrl", "Win32")).toBe(false);
    expect(isSuitableGlobalShortcut("mod+shift", "MacIntel")).toBe(false);
  });
});

describe("conflictingInAppShortcuts", () => {
  it("collides mod-based T3 shortcuts with the recorded combo per platform", () => {
    expect(conflictingInAppShortcuts("mod+shift+1", "Win32").map((s) => s.command)).toEqual([
      "usage.period.day",
    ]);
    expect(conflictingInAppShortcuts("Ctrl+Shift+2", "Linux").map((s) => s.command)).toEqual([
      "usage.period.week",
    ]);
    expect(conflictingInAppShortcuts("Cmd+Shift+3", "MacIntel").map((s) => s.command)).toEqual([
      "usage.period.month",
    ]);
  });

  it("does not confuse Ctrl and Cmd on macOS", () => {
    expect(conflictingInAppShortcuts("Ctrl+Shift+1", "MacIntel")).toEqual([]);
    expect(conflictingInAppShortcuts("Shift+1", "MacIntel")).toEqual([]);
  });

  it("matches single-key T3 shortcuts and stays case-insensitive", () => {
    expect(conflictingInAppShortcuts("C", "Win32").map((s) => s.command)).toEqual(["usage.cost"]);
  });

  it("returns nothing for unbound or empty combos", () => {
    expect(conflictingInAppShortcuts("mod+shift+9", "Win32")).toEqual([]);
    expect(conflictingInAppShortcuts("", "Win32")).toEqual([]);
  });

  it("recognizes the app chords without treating the second key of a sequence as a shortcut", () => {
    expect(conflictingInAppShortcuts("Ctrl+K", "Win32").map((entry) => entry.command)).toEqual(["showPalette"]);
    expect(conflictingInAppShortcuts("Cmd+,", "MacIntel").map((entry) => entry.command)).toEqual(["navigate.settings"]);
    expect(conflictingInAppShortcuts("s", "Win32")).toEqual([]);
  });
});

describe("comboLabel", () => {
  it("renders platform-specific labels", () => {
    expect(comboLabel("mod+shift+1", "Win32")).toBe("Ctrl+Shift+1");
    expect(comboLabel("mod+shift+1", "MacIntel")).toBe("Cmd+Shift+1");
    expect(comboLabel("meta+k", "Win32")).toBe("Win+K");
    expect(comboLabel("meta+k", "MacIntel")).toBe("Cmd+K");
  });

  it("normalises aliases and key names", () => {
    expect(comboLabel("ctrl+alt+space", "Win32")).toBe("Ctrl+Alt+Space");
    expect(comboLabel("control+option+B", "Win32")).toBe("Ctrl+Alt+B");
    expect(comboLabel("esc", "Win32")).toBe("Esc");
    expect(comboLabel("b", "Win32")).toBe("B");
    expect(comboLabel("  mod + shift + b ", "MacIntel")).toBe("Cmd+Shift+B");
  });
});

describe("comboFromKeyboardEvent", () => {
  it("builds Ctrl combos off macOS", () => {
    usePlatform("Win32");
    expect(
      comboFromKeyboardEvent({ key: "b", code: "KeyB", ctrlKey: true, shiftKey: true }),
    ).toBe("Ctrl+Shift+B");
    expect(comboFromKeyboardEvent({ key: "b", code: "KeyB", altKey: true, shiftKey: true })).toBe(
      "Alt+Shift+B",
    );
    expect(comboFromKeyboardEvent({ key: "b", code: "KeyB", metaKey: true })).toBe("Meta+B");
  });

  it("builds Cmd-first combos on macOS", () => {
    usePlatform("MacIntel");
    expect(
      comboFromKeyboardEvent({ key: "b", code: "KeyB", metaKey: true, shiftKey: true }),
    ).toBe("Cmd+Shift+B");
    expect(
      comboFromKeyboardEvent({ key: "b", code: "KeyB", ctrlKey: true, metaKey: true }),
    ).toBe("Cmd+Ctrl+B");
    expect(comboFromKeyboardEvent({ key: "b", code: "KeyB", ctrlKey: true })).toBe("Ctrl+B");
  });

  it("prefers the physical key from event.code", () => {
    usePlatform("Win32");
    expect(comboFromKeyboardEvent({ key: "!", code: "Digit1", ctrlKey: true })).toBe("Ctrl+1");
    expect(comboFromKeyboardEvent({ key: "b", code: "KeyB", ctrlKey: true })).toBe("Ctrl+B");
    expect(comboFromKeyboardEvent({ key: "F12", code: "F12", altKey: true })).toBe("Alt+F12");
  });

  it("falls back to event.key for named and printable keys", () => {
    usePlatform("Win32");
    expect(comboFromKeyboardEvent({ key: " ", ctrlKey: true })).toBe("Ctrl+Space");
    expect(comboFromKeyboardEvent({ key: "Escape" })).toBe("Escape");
    expect(comboFromKeyboardEvent({ key: "5", shiftKey: true })).toBe("Shift+5");
    expect(comboFromKeyboardEvent({ key: "f5", ctrlKey: true })).toBe("Ctrl+F5");
  });

  it("keeps waiting on modifier-only presses, repeats and IME composition", () => {
    usePlatform("Win32");
    expect(
      comboFromKeyboardEvent({ key: "Shift", code: "ShiftLeft", shiftKey: true }),
    ).toBeNull();
    expect(comboFromKeyboardEvent({ key: "Control", code: "ControlLeft", ctrlKey: true })).toBeNull();
    expect(comboFromKeyboardEvent({ key: "b", code: "KeyB", ctrlKey: true, repeat: true })).toBeNull();
    expect(
      comboFromKeyboardEvent({ key: "b", code: "KeyB", ctrlKey: true, isComposing: true }),
    ).toBeNull();
  });

  it("rejects unsupported keys, including a literal plus", () => {
    usePlatform("Win32");
    expect(comboFromKeyboardEvent({ key: "+", ctrlKey: true })).toBeNull();
    expect(comboFromKeyboardEvent({ key: "Dead" })).toBeNull();
    expect(comboFromKeyboardEvent({ key: "Unidentified" })).toBeNull();
  });
});
