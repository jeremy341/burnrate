import { describe, expect, it } from "vitest";

import {
  camelCase,
  isIgnoredConsoleError,
  isoDay,
  optionBoolean,
  optionNumber,
  optionString,
  parseArgs,
  slug,
  tail,
} from "./util.mjs";

describe("parseArgs", () => {
  it("parses values, =values and bare flags", () => {
    expect(parseArgs(["--out", "shots", "--port=13851", "--keep"])).toEqual({
      out: "shots",
      port: "13851",
      keep: true,
    });
  });

  it("camel-cases dashed option names", () => {
    expect(parseArgs(["--open-data-dir"])).toEqual({ openDataDir: true });
    expect(camelCase("no-fail-http")).toBe("noFailHttp");
  });

  it("rejects positional arguments and empty option names", () => {
    expect(() => parseArgs(["shots"])).toThrow(/Unexpected argument/);
    expect(() => parseArgs(["--"])).toThrow(/Empty option/);
  });
});

describe("option helpers", () => {
  it("reads typed options with defaults", () => {
    expect(optionNumber({ port: "13851" }, "port", 13_850)).toBe(13_851);
    expect(optionNumber({}, "port", 13_850)).toBe(13_850);
    expect(optionString({ out: "x" }, "out", "default")).toBe("x");
    expect(optionString({}, "out", "default")).toBe("default");
    expect(optionBoolean({ keep: true }, "keep")).toBe(true);
    expect(optionBoolean({ keep: "false" }, "keep")).toBe(false);
    expect(optionBoolean({}, "keep")).toBe(false);
  });

  it("rejects a flag without its value", () => {
    expect(() => optionNumber({ port: true }, "port", 1)).toThrow(/needs a number/);
    expect(() => optionString({ out: true }, "out", "")).toThrow(/needs a value/);
    expect(() => optionBoolean({ keep: "maybe" }, "keep")).toThrow(/true or false/);
  });
});

describe("console noise filter", () => {
  it("ignores favicon and ResizeObserver noise only", () => {
    expect(isIgnoredConsoleError("Failed to load resource: favicon.ico")).toBe(true);
    expect(isIgnoredConsoleError("ResizeObserver loop limit exceeded")).toBe(true);
    expect(isIgnoredConsoleError("Uncaught TypeError: x is not a function")).toBe(false);
    expect(isIgnoredConsoleError("GET /api/status 404")).toBe(false);
  });
});

describe("small helpers", () => {
  it("formats UTC days", () => {
    expect(isoDay(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isoDay(-1) < isoDay(0)).toBe(true);
  });

  it("slugs step names for screenshot files", () => {
    expect(slug("usage: Limits tab")).toBe("usage-limits-tab");
    expect(slug("!!!")).toBe("step");
  });

  it("tails a log without mutating it", () => {
    const log = ["a", "b", "c"];
    expect(tail(log, 2)).toEqual(["b", "c"]);
    expect(log).toEqual(["a", "b", "c"]);
  });
});
