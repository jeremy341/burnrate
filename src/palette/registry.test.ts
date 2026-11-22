import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearCommands,
  getCommands,
  hasCommand,
  registerCommand,
  registerCommands,
  subscribe,
  unregisterCommand,
} from "./registry";
import type { PaletteCommand } from "./types";

function command(id: string, overrides: Partial<PaletteCommand> = {}): PaletteCommand {
  return { id, title: id, group: "Actions", run: () => {}, ...overrides };
}

afterEach(() => clearCommands());

describe("command registry", () => {
  it("registers, reads and unregisters a command", () => {
    const unregister = registerCommand(command("a"));
    expect(getCommands().map((c) => c.id)).toEqual(["a"]);
    expect(hasCommand("a")).toBe(true);
    unregister();
    expect(getCommands()).toEqual([]);
    expect(hasCommand("a")).toBe(false);
  });

  it("replaces a duplicate id and keeps the newest registration", () => {
    registerCommand(command("a", { title: "old" }));
    registerCommand(command("a", { title: "new" }));
    expect(getCommands()).toHaveLength(1);
    expect(getCommands()[0]!.title).toBe("new");
  });

  it("does not let a stale cleanup remove a replacement", () => {
    const first = command("a", { title: "old" });
    const unregisterFirst = registerCommand(first);
    registerCommand(command("a", { title: "new" }));
    unregisterFirst();
    expect(getCommands()[0]!.title).toBe("new");
    unregisterCommand("a");
    expect(getCommands()).toEqual([]);
  });

  it("sorts by group, then priority, then registration order", () => {
    registerCommands([
      command("z", { group: "Actions" }),
      command("s", { group: "Settings", groupOrder: 20 }),
      command("y", { group: "Actions", priority: 10 }),
    ]);
    expect(getCommands().map((c) => c.id)).toEqual(["s", "y", "z"]);
  });

  it("notifies subscribers on every change and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    const dispose = registerCommand(command("a"));
    dispose();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    registerCommand(command("b"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("returns an unregister function from registerCommands", () => {
    const dispose = registerCommands([command("a"), command("b")]);
    expect(getCommands()).toHaveLength(2);
    dispose();
    expect(getCommands()).toEqual([]);
  });
});
