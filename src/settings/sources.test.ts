import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "./schema";
import {
  addSourcePath,
  describeSourceProblem,
  MAX_SOURCE_PATHS,
  normalizeSourcePath,
  removeSourcePath,
  sameSourcePath,
  SOURCE_FOR_PROVIDER,
  SOURCE_IDS,
  SOURCE_PRESENTATIONS,
  sourcePathProblem,
  sourcePathsFor,
} from "./sources";

const gt = (message: string, values?: Record<string, string | number>) =>
  message.replace(/\{(\w+)\}/g, (match, key: string) => String(values?.[key] ?? match));

describe("local source defaults", () => {
  it("start empty so automatic discovery is the default behaviour", () => {
    expect(DEFAULT_SETTINGS.providers.sources).toEqual({ claude: [], vibe: [] });
    for (const id of SOURCE_IDS) {
      expect(sourcePathsFor(DEFAULT_SETTINGS.providers.sources, id), id).toEqual([]);
    }
  });

  it("tolerates a settings object saved before the field existed", () => {
    expect(sourcePathsFor(undefined, "vibe")).toEqual([]);
    expect(sourcePathsFor({ claude: ["D:\\claude-b"] }, "vibe")).toEqual([]);
    expect(sourcePathsFor({ claude: ["D:\\claude-b"] }, "claude")).toEqual(["D:\\claude-b"]);
    // An old file that never heard of the newer agents still reads their (missing) lists as empty.
    expect(sourcePathsFor({ vibe: ["D:\\vibe"] }, "codex")).toEqual([]);
    expect(sourcePathsFor({ vibe: ["D:\\vibe"] }, "goose")).toEqual([]);
  });
});

describe("the source catalog", () => {
  it("lists every agent whose folders can be configured", () => {
    expect([...SOURCE_IDS]).toContain("claude");
    expect([...SOURCE_IDS]).toContain("vibe");
    for (const id of ["codex", "opencode", "antigravity", "gemini", "qwen", "goose", "crush", "copilot", "grok", "pi", "muse"] as const) {
      expect([...SOURCE_IDS], id).toContain(id);
    }
  });

  it("presents one block per source id, each with a title, helper line and placeholder", () => {
    expect(SOURCE_PRESENTATIONS.map((entry) => entry.id)).toEqual([...SOURCE_IDS]);
    for (const entry of SOURCE_PRESENTATIONS) {
      expect(entry.title.length, entry.id).toBeGreaterThan(3);
      expect(entry.helper.length, entry.id).toBeGreaterThan(10);
      expect(entry.placeholder.length, entry.id).toBeGreaterThan(3);
    }
  });

  it("maps every provider that has a source to a known source id", () => {
    for (const [provider, id] of Object.entries(SOURCE_FOR_PROVIDER)) {
      expect([...SOURCE_IDS], provider).toContain(id);
    }
    expect(SOURCE_FOR_PROVIDER.claudeAgent).toBe("claude");
    expect(SOURCE_FOR_PROVIDER.mistral).toBe("vibe");
    expect(SOURCE_FOR_PROVIDER["opencode-go"]).toBe("opencode");
    expect(SOURCE_FOR_PROVIDER.codex).toBe("codex");
  });
});

describe("source folder paths", () => {
  it("accepts absolute Windows, UNC, POSIX and home-relative paths", () => {
    for (const path of ["C:\\Users\\you\\.vibe2", "d:/profiles/vibe", "\\\\nas\\share\\vibe", "/home/you/.vibe2", "~", "~/vibe", "~\\vibe"]) {
      expect(sourcePathProblem(path), path).toBeNull();
    }
  });

  it("refuses an empty, relative or control-character path with a reason", () => {
    expect(sourcePathProblem("   ")).toBe("empty");
    expect(sourcePathProblem("vibe2")).toBe("relative");
    expect(sourcePathProblem("..\\vibe2")).toBe("relative");
    expect(sourcePathProblem("C:vibe2")).toBe("relative");
    expect(sourcePathProblem("/tmp/a\u0000b")).toBe("control");
    expect(sourcePathProblem(`/${"x".repeat(1100)}`)).toBe("long");
  });

  it("drops the quotes Explorer adds when copying a path", () => {
    expect(normalizeSourcePath('  "C:\\Users\\you\\.vibe2"  ')).toBe("C:\\Users\\you\\.vibe2");
    expect(normalizeSourcePath("'/home/you/.vibe2'")).toBe("/home/you/.vibe2");
  });

  it("treats a drive-letter path as the same folder regardless of case or a trailing slash", () => {
    expect(sameSourcePath("C:\\Users\\You\\.vibe2", "c:\\users\\you\\.vibe2\\")).toBe(true);
    expect(sameSourcePath("/home/you/.vibe2", "/home/you/.vibe2/")).toBe(true);
    expect(sameSourcePath("/home/you/.Vibe2", "/home/you/.vibe2")).toBe(false);
  });
});

describe("editing a source list", () => {
  it("adds a normalized path and keeps the existing ones", () => {
    const result = addSourcePath(["D:\\one"], ' "E:\\two" ');
    expect(result).toEqual({ ok: true, paths: ["D:\\one", "E:\\two"] });
  });

  it("explains why a path was not added and leaves the list alone", () => {
    expect(addSourcePath(["D:\\one"], "d:\\ONE\\")).toEqual({ ok: false, problem: "duplicate" });
    expect(addSourcePath([], "relative/dir")).toEqual({ ok: false, problem: "relative" });
    const full = Array.from({ length: MAX_SOURCE_PATHS }, (_, i) => `/d${i}`);
    expect(addSourcePath(full, "/one-more")).toEqual({ ok: false, problem: "limit" });
  });

  it("removes exactly the chosen path", () => {
    expect(removeSourcePath(["/a", "/b", "/c"], "/b")).toEqual(["/a", "/c"]);
    expect(removeSourcePath(["/a"], "/zzz")).toEqual(["/a"]);
  });

  it("describes every problem in words", () => {
    for (const problem of ["empty", "relative", "long", "control", "duplicate", "limit"] as const) {
      expect(describeSourceProblem(problem, gt).length, problem).toBeGreaterThan(10);
    }
    expect(describeSourceProblem("limit", gt)).toContain(String(MAX_SOURCE_PATHS));
  });
});
