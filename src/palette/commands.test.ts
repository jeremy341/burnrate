import { describe, expect, it } from "vitest";

import { createBuiltinCommands } from "./commands";

const gt = (message: string, values?: Record<string, unknown>) =>
  values ? message.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key])) : message;

describe("built-in palette commands", () => {
  const commands = createBuiltinCommands({ gt, theme: "dark" });
  const byId = (id: string) => commands.find((command) => command.id === id);

  it("lists every screen as a destination, with its shortcut", () => {
    for (const id of ["view.usage", "view.providers", "view.settings"]) {
      expect(byId(id), id).toBeDefined();
    }
    expect(byId("view.settings")?.title).toBe("Settings");
    expect(byId("view.settings")?.shortcut).toMatch(/Ctrl ,|⌘,/);
    expect(byId("view.providers")?.shortcut).toBe("G P");
    for (const command of commands.filter((c) => c.id.startsWith("view."))) {
      expect(command.group).toBe("Views");
    }
  });

  it("offers only the few global actions, all in one group", () => {
    for (const id of [
      "action.refreshLimits",
      "action.copyStatus",
      "action.toggleTheme",
      "action.openTour",
      "action.quit",
    ]) {
      expect(byId(id), id).toBeDefined();
      expect(byId(id)?.group).toBe("Actions");
    }
    expect(byId("action.toggleTheme")?.title).toBe("Switch to light mode");
    expect(byId("action.openTour")?.title).toBe("Welcome tour");
  });

  it("shows the state the theme toggle acts on", () => {
    const light = createBuiltinCommands({ gt, theme: "light" });
    expect(light.find((c) => c.id === "action.toggleTheme")?.value).toBe("Light");
    expect(byId("action.toggleTheme")?.value).toBe("Dark");
  });

  it("drops nav duplicates and one-off diagnostics", () => {
    for (const id of [
      "action.addProvider",
      "action.connectAgent",
      "action.snoozeAlerts",
      "action.openDataFolder",
      "action.collapseProviders",
      "action.expandProviders",
      "usage.limits",
      "usage.cost",
      "usage.period.7",
    ]) {
      expect(byId(id), id).toBeUndefined();
    }
    expect(commands.some((command) => command.id.startsWith("settings."))).toBe(false);
  });

  it("has unique ids", () => {
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
  });
});
