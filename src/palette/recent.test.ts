import { describe, expect, it } from "vitest";

import { filterCommands, groupCommands } from "./fuzzy";
import {
  MAX_RECENT_COMMANDS,
  readRecentCommands,
  recordRecentCommand,
  RECENT_COMMANDS_KEY,
  withRecentGroup,
} from "./recent";
import type { PaletteCommand } from "./types";

function memoryStorage(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[RECENT_COMMANDS_KEY, initial]]);
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const command = (id: string, title: string, group = "Actions"): PaletteCommand => ({ id, title, group, run: () => undefined });

describe("recent commands", () => {
  it("remembers the latest uses first, without duplicates, up to the limit", () => {
    const storage = memoryStorage();
    for (const id of ["a", "b", "c", "d", "e", "c"]) recordRecentCommand(id, storage);
    expect(readRecentCommands(storage)).toEqual(["c", "e", "d", "b"]);
    expect(readRecentCommands(storage)).toHaveLength(MAX_RECENT_COMMANDS);
  });

  it("survives corrupt or blocked storage", () => {
    expect(readRecentCommands(memoryStorage("not json"))).toEqual([]);
    expect(readRecentCommands(memoryStorage('{"a":1}'))).toEqual([]);
    expect(readRecentCommands(null)).toEqual([]);
    expect(recordRecentCommand("x", null)).toEqual(["x"]);
  });

  it("lifts recents into a leading group once each, in recency order", () => {
    const all = [command("view.usage", "Usage", "Views"), command("a", "Alpha"), command("b", "Beta")];
    const lifted = withRecentGroup(all, ["b", "view.usage", "gone"], "Recent");
    expect(lifted.map((entry) => entry.id)).toEqual(["b", "view.usage", "a"]);
    const groups = groupCommands(lifted);
    expect(groups.map((group) => group.label)).toEqual(["Recent", "Actions"]);
    expect(groups[0]!.commands.map((entry) => entry.id)).toEqual(["b", "view.usage"]);
    expect(withRecentGroup(all, [], "Recent")).toBe(all);
  });

  it("breaks search ties in favour of a recently used command", () => {
    const all = [command("a", "Refresh limits"), command("b", "Refresh tokens")];
    expect(filterCommands(all, "refresh").map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(filterCommands(all, "refresh", ["b"]).map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});

