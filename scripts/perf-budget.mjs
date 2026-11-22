#!/usr/bin/env node
// Burnrate performance budget gate. See docs/PERFORMANCE.md for the table and the
// measurement recipe. No dependencies: plain Node 20+ (fetch/zlib/child_process).
//
//   node scripts/perf-budget.mjs                 # human readable, exits 1 on a breach
//   node scripts/perf-budget.mjs --json          # machine readable (CI)
//   node scripts/perf-budget.mjs --skip-server   # web bundle gate only
//   node scripts/perf-budget.mjs --idle-seconds 5
//
// The web gates read dist/web, so run `corepack pnpm build` first. The server gate
// needs a release binary (the integrator builds it); when it is missing the gate is
// reported as skipped instead of failing.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

export const KB = 1024;
export const MB = 1024 * 1024;

/** Contract budgets. Sizes are gzip bytes. */
export const DEFAULT_BUDGETS = Object.freeze({
  /** Initial static JS of index.html (gzip KB). */
  mainJsKb: 520,
  /** Every CSS file emitted into dist/web (gzip KB). */
  cssKb: 60,
  /** Server RSS after 20 s idle (MB). */
  idleRssMb: 60,
  /** Release binary: reported, not gated, until a baseline exists (soft target). */
  releaseBinaryMb: 25,
});

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const posix = (p) => p.replace(/\\/g, "/");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function formatKb(value) {
  return `${value.toFixed(1)} KB`;
}

export function formatMb(value) {
  return `${value.toFixed(1)} MB`;
}

/** Deterministic gzip size, same algorithm a static file server would use. */
export function gzipSize(buffer) {
  return zlib.gzipSync(buffer).length;
}

/** Creates a memoised reader so a chunk shared by both entries is compressed once. */
export function sizeReader(webDir) {
  const cache = new Map();
  return (relative) => {
    const rel = posix(relative).replace(/^\/+/, "");
    if (!cache.has(rel)) {
      const file = path.join(webDir, rel);
      cache.set(rel, fs.existsSync(file) ? gzipSize(fs.readFileSync(file)) : 0);
    }
    return cache.get(rel);
  };
}

/** Finds the manifest key for the HTML entry (index.html). */
export function findEntryKey(manifest, htmlName) {
  const keys = Object.keys(manifest);
  return (
    keys.find((key) => key === htmlName) ??
    keys.find((key) => key.endsWith(`/${htmlName}`)) ??
    keys.find((key) => manifest[key]?.isEntry && posix(manifest[key].src ?? "").endsWith(htmlName)) ??
    null
  );
}

/**
 * Resolves the static import graph of a manifest entry.
 * `lazyJs` / `lazyCss` are the dynamic-import closure, reported but not gated: the
 * integrator's dynamic import points fetch those files on first use.
 */
export function graphFromManifest(manifest, entryKey) {
  const js = new Set();
  const css = new Set();
  const seen = new Set();
  const lazySeeds = new Set();

  const walkStatic = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const item = manifest[key];
    if (!item) return;
    if (item.file && item.file.endsWith(".js")) js.add(item.file);
    for (const file of item.css ?? []) css.add(file);
    for (const imported of item.imports ?? []) walkStatic(imported);
    for (const dynamic of item.dynamicImports ?? []) lazySeeds.add(dynamic);
  };
  walkStatic(entryKey);

  const lazyJs = new Set();
  const lazyCss = new Set();
  const lazySeen = new Set();
  const walkLazy = (key) => {
    if (lazySeen.has(key)) return;
    lazySeen.add(key);
    const item = manifest[key];
    if (!item) return;
    if (item.file && item.file.endsWith(".js") && !js.has(item.file)) lazyJs.add(item.file);
    for (const file of item.css ?? []) if (!css.has(file)) lazyCss.add(file);
    for (const imported of item.imports ?? []) walkLazy(imported);
    for (const dynamic of item.dynamicImports ?? []) walkLazy(dynamic);
  };
  for (const seed of lazySeeds) walkLazy(seed);

  return { js: [...js].sort(), css: [...css].sort(), lazyJs: [...lazyJs].sort(), lazyCss: [...lazyCss].sort() };
}

/**
 * Manifest-free fallback (older builds): start at the `<script>`/`<link>` tags in the
 * HTML file and follow relative static imports in the emitted ESM chunks.
 */
export function graphFromHtml(webDir, htmlFile) {
  const read = (file) => fs.readFileSync(path.join(webDir, file), "utf8");
  const html = read(htmlFile);
  const refs = [...html.matchAll(/\b(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => posix(m[1]).replace(/^\/+/, ""));
  const js = new Set();
  const css = new Set();
  const queue = [];
  for (const ref of refs) {
    if (ref.endsWith(".css")) css.add(ref);
    else if (!js.has(ref)) {
      js.add(ref);
      queue.push(ref);
    }
  }
  const importPatterns = [
    /import\s*(?:[^"'()]*?\bfrom\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g,
    /export\s*(?:\*|\{[^}]*\})\s*from\s*["'](\.{1,2}\/[^"']+\.js)["']/g,
  ];
  while (queue.length) {
    const current = queue.pop();
    let source;
    try {
      source = read(current);
    } catch {
      continue;
    }
    for (const pattern of importPatterns) {
      for (const match of source.matchAll(pattern)) {
        const resolved = posix(path.posix.normalize(path.posix.join(path.posix.dirname(current), match[1])));
        if (!js.has(resolved)) {
          js.add(resolved);
          queue.push(resolved);
        }
      }
    }
  }
  return { js: [...js].sort(), css: [...css].sort(), lazyJs: [], lazyCss: [] };
}

function sumSizes(files, sizeOf) {
  return files.reduce((total, file) => total + sizeOf(file), 0);
}

function entryReport(name, graph, sizeOf) {
  const jsBytes = sumSizes(graph.js, sizeOf);
  const cssBytes = sumSizes(graph.css, sizeOf);
  return {
    name,
    jsKb: jsBytes / KB,
    cssKb: cssBytes / KB,
    totalKb: (jsBytes + cssBytes) / KB,
    lazyJsKb: sumSizes(graph.lazyJs, sizeOf) / KB,
    lazyCssKb: sumSizes(graph.lazyCss, sizeOf) / KB,
    jsFiles: graph.js.map((file) => ({ file, gzipKb: sizeOf(file) / KB })),
    cssFiles: graph.css.map((file) => ({ file, gzipKb: sizeOf(file) / KB })),
    lazyFiles: [...graph.lazyJs, ...graph.lazyCss],
  };
}

/** Every CSS/JS file under dist/web (excluding the Vite manifest). */
export function listAssets(webDir) {
  const assets = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".vite") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else assets.push(posix(path.relative(webDir, full)));
    }
  };
  walk(webDir);
  return assets.sort();
}

/** Reads dist/web and attributes chunks to the two HTML entries. */
export function loadWebReport(webDir) {
  if (!fs.existsSync(webDir)) {
    const error = new Error(`web build not found at ${webDir}; run \`corepack pnpm build\` first`);
    error.code = "BUILD_MISSING";
    throw error;
  }
  const sizeOf = sizeReader(webDir);
  const manifestPath = [path.join(webDir, ".vite", "manifest.json"), path.join(webDir, "manifest.json")].find((file) =>
    fs.existsSync(file),
  );
  const entries = {};
  let source = "html";
  if (manifestPath) {
    source = "manifest";
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const [name, html] of [["main", "index.html"]]) {
      const key = findEntryKey(manifest, html);
      if (key) entries[name] = entryReport(name, graphFromManifest(manifest, key), sizeOf);
    }
  } else {
    for (const [name, html] of [["main", "index.html"]]) {
      if (fs.existsSync(path.join(webDir, html))) entries[name] = entryReport(name, graphFromHtml(webDir, html), sizeOf);
    }
  }

  const assets = listAssets(webDir);
  const cssFiles = assets.filter((file) => file.endsWith(".css"));
  const jsFiles = assets.filter((file) => file.endsWith(".js"));
  return {
    webDir,
    source,
    entries,
    cssKb: sumSizes(cssFiles, sizeOf) / KB,
    jsKb: sumSizes(jsFiles, sizeOf) / KB,
    assetKb: sumSizes(assets, sizeOf) / KB,
    cssFiles: cssFiles.map((file) => ({ file, gzipKb: sizeOf(file) / KB })),
  };
}

function check(id, label, value, budget, unit, { gated = true } = {}) {
  return {
    id,
    label,
    value,
    budget,
    unit,
    gated,
    pass: !gated || value <= budget,
  };
}

/** Applies the web budgets. Server checks are appended by the caller. */
export function evaluateBudgets(report, budgets = DEFAULT_BUDGETS) {
  const checks = [];
  const main = report.entries.main;
  if (main) checks.push(check("main-js", "main initial JS", main.jsKb, budgets.mainJsKb, "KB"));
  checks.push(check("css-total", "CSS in dist/web", report.cssKb, budgets.cssKb, "KB"));
  return checks;
}

/** Finds the release server binary, if the integrator has built one. */
export function findServerBinary(root = REPO_ROOT) {
  const exe = process.platform === "win32" ? "burnrate-server.exe" : "burnrate-server";
  const candidates = [
    process.env.BURNRATE_SERVER_EXE,
    process.env.CARGO_TARGET_DIR ? path.join(process.env.CARGO_TARGET_DIR, "release", exe) : null,
    path.join(root, "server-rs", "target", "release", exe),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function binaryReport(serverExe, budgets = DEFAULT_BUDGETS) {
  if (!serverExe) return null;
  const sizeMb = fs.statSync(serverExe).size / MB;
  return {
    ...check("release-binary", "release server binary", sizeMb, budgets.releaseBinaryMb, "MB", { gated: false }),
    file: serverExe,
  };
}

/** Current working set of one PID. Windows: Get-Process; Linux: /proc; macOS: ps. */
export function processRssMb(pid) {
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    const bytes = Number(out);
    if (!Number.isFinite(bytes) || bytes <= 0) throw new Error(`Get-Process returned no working set for PID ${pid}`);
    return bytes / MB;
  }
  if (process.platform === "linux") {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (!match) throw new Error(`/proc/${pid}/status has no VmRSS`);
    return Number(match[1]) / KB;
  }
  const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
  return Number(out) / KB;
}

async function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** A free port at or after `start`; the contract test range starts at 13800 + package id. */
export async function findFreePort(start = 13849, tries = 20) {
  for (let port = start; port < start + tries; port += 1) {
    if (await portIsFree(port)) return port;
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`server exited (${child.signalCode ?? child.exitCode}): ${child.__stderr ?? ""}`.trim());
    }
    try {
      const response = await fetch(`${baseUrl}/api/providers`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`server did not answer ${baseUrl} in ${timeoutMs} ms (${lastError})`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Starts the release server on a temp port/data dir, waits for it to settle, then
 * measures RSS idle and after the usage scan has run. The child environment points
 * every data/config path at the temp dir, so no real transcripts or logins are read.
 */
export async function measureServer({ webDir, serverExe, idleSeconds = 20, root = REPO_ROOT } = {}) {
  if (!serverExe) return { skipped: true, reason: "release binary not found (the integrator builds it with `cargo build --release`)" };
  const port = await findFreePort(13849);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "burnrate-perf-"));
  const childEnv = {
    ...process.env,
    BURNRATE_PORT: String(port),
    BURNRATE_DATA: dataDir,
    BURNRATE_WEB: path.resolve(webDir),
    USERPROFILE: dataDir,
    HOME: dataDir,
    APPDATA: dataDir,
    LOCALAPPDATA: dataDir,
    XDG_DATA_HOME: path.join(dataDir, "xdg-data"),
    XDG_CONFIG_HOME: path.join(dataDir, "xdg-config"),
    CLAUDE_CONFIG_DIR: path.join(dataDir, "claude"),
    CODEX_HOME: path.join(dataDir, "codex"),
    GROK_HOME: path.join(dataDir, "grok"),
  };
  const child = spawn(serverExe, [], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
    child.__stderr = stderr;
  });
  child.stdout?.on("data", () => {});
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl, child, 20_000);
    await sleep(Math.max(0, idleSeconds) * 1000);
    const idleRssMb = processRssMb(child.pid);
    // "Loaded" run: exercise the usage scan and the limits route once the cache is warm.
    const today = new Date().toISOString().slice(0, 10);
    for (const route of [
      `/api/usage?since=${today}&until=${today}&tz=UTC`,
      `/api/usage?since=${today}&until=${today}&tz=UTC`,
      "/api/limits",
    ]) {
      try {
        await fetch(`${baseUrl}${route}`, { signal: AbortSignal.timeout(10_000) });
      } catch {
        /* the loaded run is informational; a 404 on a stub route must not fail the gate */
      }
    }
    await sleep(1000);
    const loadedRssMb = processRssMb(child.pid);
    return { skipped: false, port, idleSeconds, idleRssMb, loadedRssMb, dataDir };
  } finally {
    child.kill();
    await waitForExit(child, 5000);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    json: false,
    skipServer: false,
    skipBinary: false,
    webDir: path.join(REPO_ROOT, "dist", "web"),
    serverExe: null,
    idleSeconds: 20,
    help: false,
  };
  const requireValue = (args, index, flag) => {
    const value = args[index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      case "--skip-server":
        options.skipServer = true;
        break;
      case "--skip-binary":
        options.skipBinary = true;
        break;
      case "--web-dir":
        options.webDir = path.resolve(requireValue(argv, ++i, "--web-dir"));
        break;
      case "--server-exe":
        options.serverExe = path.resolve(requireValue(argv, ++i, "--server-exe"));
        break;
      case "--idle-seconds": {
        const raw = requireValue(argv, ++i, "--idle-seconds");
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`--idle-seconds expects a non-negative number, got "${raw}"`);
        options.idleSeconds = seconds;
        break;
      }
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function statusLabel(entry) {
  if (!entry.gated) return "INFO";
  return entry.pass ? "PASS" : "FAIL";
}

export function renderReport({ report, checks, binary, binarySkipped = false, server }) {
  const lines = [];
  lines.push(`Burnrate performance budget (${new Date().toISOString()})`);
  lines.push(`web: ${report.webDir} (chunk map: ${report.source})`);
  lines.push("");
  lines.push("Entry      JS gzip    CSS gzip   JS+CSS     Lazy JS");
  for (const name of ["main"]) {
    const entry = report.entries[name];
    if (!entry) {
      lines.push(`${name.padEnd(10)} (entry not found)`);
      continue;
    }
    lines.push(
      `${name.padEnd(10)} ${formatKb(entry.jsKb).padEnd(10)} ${formatKb(entry.cssKb).padEnd(10)} ${formatKb(entry.totalKb).padEnd(10)} ${formatKb(entry.lazyJsKb)}`,
    );
  }
  lines.push("");
  lines.push("Gate                    Value        Budget       Result");
  for (const entry of checks) {
    const label = entry.label.padEnd(22);
    const value = (entry.unit === "MB" ? formatMb(entry.value) : formatKb(entry.value)).padEnd(12);
    const budget = (entry.unit === "MB" ? formatMb(entry.budget) : formatKb(entry.budget)).padEnd(12);
    lines.push(`${label}${value}${budget}${statusLabel(entry)}`);
  }
  if (binarySkipped) {
    lines.push("");
    lines.push("release binary: skipped (--skip-binary)");
  } else if (binary) {
    lines.push("");
    lines.push(`release binary: ${formatMb(binary.value)} (${binary.file}); soft target ${formatMb(binary.budget)}`);
  } else {
    lines.push("");
    lines.push("release binary: not found (release builds are integrator-only)");
  }
  if (server?.skipped) {
    lines.push(`server RSS: skipped - ${server.reason}`);
  } else if (server) {
    lines.push(
      `server RSS: ${formatMb(server.idleRssMb)} idle after ${server.idleSeconds}s, ${formatMb(server.loadedRssMb)} after a usage scan (port ${server.port})`,
    );
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (options.help) {
    console.log(
      [
        "Usage: node scripts/perf-budget.mjs [options]",
        "  --json                machine-readable output",
        "  --skip-server         web bundle gate only",
        "  --skip-binary         skip the release binary size report",
        "  --web-dir <dir>       default dist/web",
        "  --server-exe <file>   override the release binary path",
        "  --idle-seconds <n>    default 20",
      ].join("\n"),
    );
    return 0;
  }

  let report;
  try {
    report = loadWebReport(options.webDir);
  } catch (error) {
    if (error?.code === "BUILD_MISSING") {
      console.error(error.message);
      return 2;
    }
    throw error;
  }

  const budgets = DEFAULT_BUDGETS;
  const checks = evaluateBudgets(report, budgets);
  const serverExe = options.serverExe ?? findServerBinary();
  if (options.serverExe && !fs.existsSync(options.serverExe)) {
    console.error(`server binary not found at ${options.serverExe}`);
    return 2;
  }
  const binary = options.skipBinary ? null : binaryReport(serverExe, budgets);

  const server = options.skipServer
    ? { skipped: true, reason: "disabled with --skip-server" }
    : await measureServer({ webDir: options.webDir, serverExe, idleSeconds: options.idleSeconds });
  if (!server.skipped) {
    checks.push(check("idle-rss", "server idle RSS", server.idleRssMb, budgets.idleRssMb, "MB"));
    checks.push(check("loaded-rss", "server loaded RSS", server.loadedRssMb, budgets.idleRssMb, "MB", { gated: false }));
  }

  const failures = checks.filter((entry) => !entry.pass);
  if (options.json) {
    console.log(JSON.stringify({ ok: failures.length === 0, report, checks, binary, server }, null, 2));
  } else {
    console.log(renderReport({ report, checks, binary, binarySkipped: options.skipBinary, server }));
    if (failures.length) {
      console.log("");
      for (const failure of failures) {
        console.log(`budget exceeded: ${failure.label} ${failure.value.toFixed(1)} ${failure.unit} > ${failure.budget} ${failure.unit}`);
      }
    }
  }
  return failures.length ? 1 : 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    });
}
