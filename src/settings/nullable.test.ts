import { describe, expect, it } from "vitest";

import { deepMerge } from "./migrate";

describe("deepMerge null semantics", () => {
  it("stores null for nullable settings so the stock theme choice sticks", () => {
    const base = { appearance: { darkThemeId: "burnrate-dark", radius: 0.5 } };
    const next = deepMerge(base, { appearance: { darkThemeId: null } });
    expect(next.appearance.darkThemeId).toBeNull();
    expect(next.appearance.radius).toBe(0.5);
  });

  it("still deletes map entries with null", () => {
    const base = { usage: { usageModelAliases: { a: "x", b: "y" } } };
    const next = deepMerge(base, { usage: { usageModelAliases: { a: null } } });
    expect(next.usage.usageModelAliases).toEqual({ b: "y" });
  });

  it("covers the other nullable fields", () => {
    const base = { shell: { globalShortcut: "Ctrl+B" }, notifications: { snoozeUntil: "2026-01-01T00:00:00Z" }, appearance: { fontFamily: "Inter" } };
    const next = deepMerge(base, { shell: { globalShortcut: null }, notifications: { snoozeUntil: null }, appearance: { fontFamily: null } });
    expect(next.shell.globalShortcut).toBeNull();
    expect(next.notifications.snoozeUntil).toBeNull();
    expect(next.appearance.fontFamily).toBeNull();
  });
});
