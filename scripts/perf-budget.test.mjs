import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BUDGETS,
  evaluateBudgets,
  findEntryKey,
  findFreePort,
  formatKb,
  gzipSize,
  graphFromHtml,
  graphFromManifest,
  loadWebReport,
  parseArgs,
  processRssMb,
} from "./perf-budget.mjs";

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burnrate-perf-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const MANIFEST = {
  "_shared.js": { file: "assets/shared.js" },
  "_view.js": {
    file: "assets/view.js",
    imports: ["_shared.js"],
    css: ["assets/view.css"],
    dynamicImports: ["_lazy.js"],
  },
  "_lazy.js": { file: "assets/lazy.js", css: ["assets/lazy.css"], dynamicImports: ["_lazy2.js"] },
  "_lazy2.js": { file: "assets/lazy2.js" },
  "index.html": {
    file: "assets/main.js",
    isEntry: true,
    imports: ["_shared.js", "_view.js"],
    css: ["assets/main.css"],
  },
};

describe("gzipSize", () => {
  it("compresses repeated content and never returns zero for a non-empty buffer", () => {
    const body = Buffer.from("burnrate ".repeat(1000));
    expect(gzipSize(body)).toBeGreaterThan(0);
    expect(gzipSize(body)).toBeLessThan(body.length);
  });
});

describe("findEntryKey", () => {
  it("finds the exact HTML key", () => {
    expect(findEntryKey(MANIFEST, "index.html")).toBe("index.html");
  });

  it("falls back to a nested key or the entry src", () => {
    expect(findEntryKey({ "nested/index.html": { file: "assets/main.js" } }, "index.html")).toBe("nested/index.html");
    const bySrc = { main: { file: "assets/main.js", isEntry: true, src: "/repo/index.html" } };
    expect(findEntryKey(bySrc, "index.html")).toBe("main");
  });

  it("returns null when the entry is missing", () => {
    expect(findEntryKey({}, "index.html")).toBeNull();
  });
});

describe("graphFromManifest", () => {
  it("follows static imports but keeps dynamic imports separate", () => {
    const graph = graphFromManifest(MANIFEST, "index.html");
    expect(graph.js).toEqual(["assets/main.js", "assets/shared.js", "assets/view.js"]);
    expect(graph.css).toEqual(["assets/main.css", "assets/view.css"]);
    expect(graph.lazyJs).toEqual(["assets/lazy.js", "assets/lazy2.js"]);
    expect(graph.lazyCss).toEqual(["assets/lazy.css"]);
  });

  it("tolerates missing manifest keys", () => {
    const graph = graphFromManifest(MANIFEST, "missing.html");
    expect(graph).toEqual({ js: [], css: [], lazyJs: [], lazyCss: [] });
  });
});

describe("graphFromHtml fallback", () => {
  it("parses script/link tags and follows relative imports", () => {
    const dir = tempDir();
    write(
      dir,
      "index.html",
      '<script type="module" src="/assets/entry.js"></script><link rel="stylesheet" href="/assets/app.css">',
    );
    write(dir, "assets/entry.js", 'import{a}from"./chunk-1.js";import"./chunk-2.js";console.log(a);');
    write(dir, "assets/chunk-1.js", "import{b}from'./chunk-3.js';export const a=1;");
    write(dir, "assets/chunk-2.js", "export const c=2;");
    write(dir, "assets/chunk-3.js", "export const b=3;");
    const graph = graphFromHtml(dir, "index.html");
    expect(graph.js).toEqual(["assets/chunk-1.js", "assets/chunk-2.js", "assets/chunk-3.js", "assets/entry.js"]);
    expect(graph.css).toEqual(["assets/app.css"]);
  });
});

describe("loadWebReport", () => {
  it("attributes gzipped sizes to entries from the manifest", () => {
    const dir = tempDir();
    write(dir, ".vite/manifest.json", JSON.stringify(MANIFEST));
    const files = {
      "assets/main.js": "console.log('main');",
      "assets/shared.js": "export const shared = 1;",
      "assets/view.js": "export const view = 2;",

      "assets/lazy.js": "export const lazy = 3;",
      "assets/lazy2.js": "export const lazy2 = 4;",
      "assets/main.css": "body{color:red}",
      "assets/view.css": "body{color:blue}",
      "assets/lazy.css": "body{color:green}",
    };
    for (const [relative, body] of Object.entries(files)) write(dir, relative, body);

    const report = loadWebReport(dir);
    expect(report.source).toBe("manifest");
    const expectedMainJs =
      ["assets/main.js", "assets/shared.js", "assets/view.js"].reduce(
        (total, relative) => total + gzipSize(fs.readFileSync(path.join(dir, relative))),
        0,
      ) / 1024;
    expect(report.entries.main.jsKb).toBeCloseTo(expectedMainJs, 5);
    expect(report.entries.main.lazyJsKb).toBeGreaterThan(0);
    const expectedCss =
      ["assets/main.css", "assets/view.css", "assets/lazy.css"].reduce(
        (total, relative) => total + gzipSize(fs.readFileSync(path.join(dir, relative))),
        0,
      ) / 1024;
    expect(report.cssKb).toBeCloseTo(expectedCss, 5);
    expect(report.cssFiles.map((file) => file.file)).toEqual([
      "assets/lazy.css",
      "assets/main.css",
      "assets/view.css",
    ]);
  });

  it("falls back to HTML when no manifest exists", () => {
    const dir = tempDir();
    write(dir, "index.html", '<script type="module" src="/assets/main.js"></script>');
    write(dir, "assets/main.js", "console.log('main');");
    const report = loadWebReport(dir);
    expect(report.source).toBe("html");
    expect(report.entries.main.jsFiles.map((file) => file.file)).toEqual(["assets/main.js"]);
  });

  it("throws a BUILD_MISSING error when dist/web does not exist", () => {
    expect(() => loadWebReport(path.join(tempDir(), "missing"))).toThrow(/pnpm build/);
    try {
      loadWebReport(path.join(tempDir(), "missing"));
    } catch (error) {
      expect(error.code).toBe("BUILD_MISSING");
    }
  });
});

describe("evaluateBudgets", () => {
  const report = (mainJsKb, cssKb) => ({
    entries: {
      main: { jsKb: mainJsKb, totalKb: mainJsKb },
    },
    cssKb,
  });

  it("passes when every entry is under budget", () => {
    const checks = evaluateBudgets(report(100, 20));
    expect(checks.every((entry) => entry.pass)).toBe(true);
  });

  it("fails the exact gate that is over budget", () => {
    const checks = evaluateBudgets(report(521, 20));
    expect(checks.find((entry) => entry.id === "main-js").pass).toBe(false);
  });

  it("gates all CSS", () => {
    const checks = evaluateBudgets(report(100, 60.5));
    expect(checks.find((entry) => entry.id === "css-total").pass).toBe(false);
  });

  it("skips entries that are not in the build", () => {
    const checks = evaluateBudgets({ entries: { main: { jsKb: 1 } }, cssKb: 1 });
    expect(checks.map((entry) => entry.id)).toEqual(["main-js", "css-total"]);
  });
});

describe("parseArgs", () => {
  it("has sane defaults", () => {
    const options = parseArgs([]);
    expect(options).toMatchObject({ json: false, skipServer: false, skipBinary: false, idleSeconds: 20 });
    expect(options.webDir.endsWith(path.join("dist", "web"))).toBe(true);
  });

  it("parses overrides", () => {
    const options = parseArgs(["--json", "--skip-server", "--web-dir", "tmp/web", "--idle-seconds", "3"]);
    expect(options.json).toBe(true);
    expect(options.skipServer).toBe(true);
    expect(options.idleSeconds).toBe(3);
    expect(options.webDir).toBe(path.resolve("tmp/web"));
  });

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });

  it("rejects a flag without its value", () => {
    expect(() => parseArgs(["--web-dir"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--idle-seconds", "soon"])).toThrow(/non-negative number/);
  });
});

describe("processRssMb", () => {
  it("reads the current process working set", () => {
    const rss = processRssMb(process.pid);
    expect(rss).toBeGreaterThan(1);
    expect(rss).toBeLessThan(4096);
    // Starts a PowerShell on Windows; on a busy machine that alone can pass the default 5 s.
  }, 30_000);
});

describe("findFreePort", () => {
  it("returns a port that can be bound", async () => {
    const port = await findFreePort(13849, 3);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});

describe("formatKb", () => {
  it("renders one decimal", () => {
    expect(formatKb(123.456)).toBe("123.5 KB");
    expect(formatKb(0)).toBe("0.0 KB");
  });
});

