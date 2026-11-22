import { describe, expect, it } from "vitest";

import { filterCommands, foldText, fuzzyScore, groupCommands, scoreCommand } from "./fuzzy";
import type { PaletteCommand } from "./types";

function command(id: string, overrides: Partial<PaletteCommand> = {}): PaletteCommand {
  return {
    id,
    title: id,
    group: "Actions",
    groupOrder: 30,
    run: () => {},
    ...overrides,
  };
}

describe("foldText", () => {
  it("is case- and accent-insensitive and trims", () => {
    expect(foldText("  Crème Brûlée ")).toBe("creme brulee");
  });
});

describe("fuzzyScore", () => {
  it("ranks exact above prefix above subsequence", () => {
    const exact = fuzzyScore("theme", "theme")!;
    const prefix = fuzzyScore("theme", "theme settings")!;
    const subsequence = fuzzyScore("theme", "toggle home element")!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(subsequence);
  });

  it("matches case-insensitively and on word boundaries", () => {
    expect(fuzzyScore("RL", "Refresh Limits")).not.toBeNull();
    expect(fuzzyScore("rfl", "Refresh Limits")).not.toBeNull();
  });

  it("returns null when a character is missing", () => {
    expect(fuzzyScore("xyz", "Refresh limits")).toBeNull();
  });

  it("treats an empty query as a neutral match", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("scoreCommand / filterCommands", () => {
  const commands = [
    command("refresh", {
      title: "Refresh limits",
      description: "Probe providers again now",
      keywords: ["reload", "update"],
    }),
    command("theme", { title: "Switch to dark mode", keywords: ["theme", "appearance"] }),
    command("settings", { title: "Settings: general", group: "Settings", groupOrder: 20 }),
    command("hidden", { enabled: () => false, keywords: ["theme"] }),
  ];

  it("gives a title hit a larger bonus than an equally good keyword hit", () => {
    const themed = command("themed", { title: "theme", keywords: ["appearance"] });
    expect(scoreCommand(themed, "theme")!).toBeGreaterThan(
      scoreCommand(themed, "appearance")!,
    );
    // Keywords are still searchable.
    expect(filterCommands(commands, "update").map((c) => c.id)).toEqual(["refresh"]);
  });

  it("keeps registry order for an empty query and skips disabled commands", () => {
    expect(filterCommands(commands, "").map((c) => c.id)).toEqual([
      "refresh",
      "theme",
      "settings",
    ]);
  });

  it("filters and ranks by match quality", () => {
    expect(filterCommands(commands, "theme").map((c) => c.id)).toEqual(["theme"]);
    expect(filterCommands(commands, "settings")[0]!.id).toBe("settings");
    expect(filterCommands(commands, "nonsense")).toEqual([]);
  });

  it("supports abbreviated queries across words", () => {
    expect(filterCommands(commands, "rfsh")[0]!.id).toBe("refresh");
  });
});

describe("groupCommands", () => {
  it("groups by label and orders groups, preserving rank within a group", () => {
    const groups = groupCommands([
      command("a", { group: "Actions", groupOrder: 30 }),
      command("s", { group: "Settings", groupOrder: 20 }),
      command("b", { group: "Actions", groupOrder: 30 }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Settings", "Actions"]);
    expect(groups[1]!.commands.map((c) => c.id)).toEqual(["a", "b"]);
  });
});
