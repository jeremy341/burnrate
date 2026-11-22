#!/usr/bin/env node
/**
 * sync-t3.mjs — drift report / sync helper for files copied from T3 Code.
 *
 * No dependencies. Node ESM. Works with Windows paths.
 *
 * Commands:
 *   check [--strict]   Print a drift table (default when no command is given).
 *   diff <ours-path>   Print a unified diff (upstream -> ours).
 *   pull <ours-path>   Copy the upstream file over ours (--force for adapted files).
 *   status             Show upstream HEAD vs baseCommit and relevant upstream changes.
 *
 * The upstream checkout comes from $T3_SRC, else manifest.upstream, else the
 * built-in default. UI primitive files are discovered dynamically from our
 * src/components/ui so newly added primitives do not require a manifest edit.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MANIFEST_PATH = path.join(HERE, "t3-manifest.json");
const UI_DIR_REL = "src/components/ui";
const UI_T3_DIR_REL = "apps/web/src/components/ui";

// ---------------------------------------------------------------------------
// Setup / manifest
// ---------------------------------------------------------------------------

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
} catch (err) {
  console.error(`Cannot read manifest ${MANIFEST_PATH}: ${err.message}`);
  process.exit(2);
}

const configuredUpstream = process.env.T3_SRC || manifest.upstream;
// T3_SRC wins; otherwise probe the conventional sibling checkout locations so `check:sync` works
// without machine-specific configuration (the documented built-in default).
const candidates = [
  configuredUpstream,
  "../t3code-src",
  "../../t3code-src",
  "../ysws/t3code-src",
  "../../ysws/t3code-src",
].filter(Boolean);
const upstreamFound = candidates
  .map((p) => path.resolve(p))
  .find((p) => fs.existsSync(path.join(p, "apps/web/src/index.css")));
if (!upstreamFound) {
  console.error("Set T3_SRC (or manifest.upstream) to the T3 Code checkout before syncing.");
  process.exit(2);
}
const upstream = upstreamFound;
const baseCommit = manifest.baseCommit || "";

/** Normalize a user-supplied / manifest path to forward slashes, no leading "./". */
function norm(p) {
  return String(p).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

const absOurs = (rel) => path.join(ROOT, ...norm(rel).split("/"));
const absTheirs = (rel) => path.join(upstream, ...norm(rel).split("/"));

function computeMode(oursRel, theirsRel) {
  try {
    const a = readNormalized(absOurs(oursRel));
    const b = readNormalized(absTheirs(theirsRel));
    return a.equals(b) ? "verbatim" : "adapted";
  } catch {
    return "adapted";
  }
}

/** Explicit manifest entries + dynamically discovered UI primitives. */
function buildEntries() {
  const entries = [];
  const seen = new Set();
  for (const f of manifest.files || []) {
    if (!f || !f.ours || !f.theirs) continue;
    const ours = norm(f.ours);
    seen.add(ours.toLowerCase());
    entries.push({
      ours,
      theirs: norm(f.theirs),
      mode: f.mode === "verbatim" ? "verbatim" : "adapted",
      dynamic: false,
    });
  }

  // Dynamically match same-named T3 UI files for anything not listed above.
  const ourUiDir = path.join(ROOT, ...UI_DIR_REL.split("/"));
  if (fs.existsSync(ourUiDir)) {
    for (const name of fs.readdirSync(ourUiDir, { withFileTypes: true })) {
      if (!name.isFile()) continue;
      const ours = `${UI_DIR_REL}/${name.name}`;
      if (seen.has(ours.toLowerCase())) continue;
      const theirs = `${UI_T3_DIR_REL}/${name.name}`;
      if (!fs.existsSync(absTheirs(theirs))) continue;
      seen.add(ours.toLowerCase());
      entries.push({
        ours,
        theirs,
        mode: computeMode(ours, theirs),
        dynamic: true,
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

/** Count removed + added lines using a 2-row LCS. Returns null if unreadable. */
function changedLineCount(aBuf, bBuf) {
  try {
    const a = aBuf.toString("utf8").split(/\r?\n/);
    const b = bBuf.toString("utf8").split(/\r?\n/);
    const n = a.length;
    const m = b.length;
    let prev = new Int32Array(m + 1);
    let cur = new Int32Array(m + 1);
    for (let i = 1; i <= n; i++) {
      cur[0] = 0;
      for (let j = 1; j <= m; j++) {
        if (a[i - 1] === b[j - 1]) cur[j] = prev[j - 1] + 1;
        else cur[j] = Math.max(prev[j], cur[j - 1]);
      }
      const tmp = prev;
      prev = cur;
      cur = tmp;
    }
    const lcs = prev[m];
    return n - lcs + (m - lcs);
  } catch {
    return null;
  }
}

/** Reads a file with CRLF folded to LF, so a Windows checkout (autocrlf) compares equal to T3's LF source. */
function readNormalized(p) {
  const raw = fs.readFileSync(p);
  return raw.includes(13) ? Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8") : raw;
}

function readIfExists(p) {
  try {
    return readNormalized(p);
  } catch {
    return null;
  }
}

/** Classify one entry: status string + changed-line count. */
function classify(entry) {
  const a = readIfExists(absOurs(entry.ours));
  const b = readIfExists(absTheirs(entry.theirs));
  if (a === null && b === null) return { status: "MISSING-IN-OURS", changed: "-" };
  if (a === null) return { status: "MISSING-IN-OURS", changed: "-" };
  if (b === null) return { status: "MISSING-UPSTREAM", changed: "-" };
  if (a.equals(b)) return { status: "IDENTICAL", changed: 0 };
  const changed = changedLineCount(a, b);
  return { status: "DIFFERS", changed: changed === null ? "?" : changed };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdCheck(strict) {
  const entries = buildEntries();
  const rows = entries.map((e) => ({ entry: e, ...classify(e) }));

  const cols = [
    { key: "ours", head: "OURS", width: 0 },
    { key: "theirs", head: "UPSTREAM", width: 0 },
    { key: "status", head: "STATUS", width: 0 },
    { key: "changed", head: "CHANGED", width: 0 },
    { key: "mode", head: "MODE", width: 0 },
  ];
  for (const r of rows) {
    cols[0].width = Math.max(cols[0].width, r.entry.ours.length);
    cols[1].width = Math.max(cols[1].width, r.entry.theirs.length);
    cols[2].width = Math.max(cols[2].width, r.status.length);
    cols[3].width = Math.max(cols[3].width, String(r.changed).length);
    cols[4].width = Math.max(cols[4].width, r.entry.mode.length);
  }
  for (const c of cols) c.width = Math.max(c.width, c.head.length);

  const line = (cells) => cells.map((c, i) => String(c).padEnd(cols[i].width)).join("  ").trimEnd();
  console.log(line(cols.map((c) => c.head)));
  console.log(cols.map((c) => "-".repeat(c.width)).join("  "));
  for (const r of rows) {
    console.log(
      line([r.entry.ours, r.entry.theirs, r.status, r.changed, r.entry.mode]),
    );
  }

  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log("");
  console.log(
    `Tracked ${rows.length} file(s): ` +
      ["IDENTICAL", "DIFFERS", "MISSING-IN-OURS", "MISSING-UPSTREAM"]
        .map((s) => `${s} ${counts[s] || 0}`)
        .join(" | "),
  );
  console.log(`Upstream: ${upstream}`);
  console.log(`baseCommit: ${baseCommit || "(unset)"}`);

  if (strict) {
    const bad = rows.filter(
      (r) => r.entry.mode === "verbatim" && r.status !== "IDENTICAL",
    );
    if (bad.length) {
      console.error(
        `\n--strict: ${bad.length} verbatim file(s) are out of sync:\n` +
          bad.map((r) => `  - ${r.entry.ours} (${r.status})`).join("\n"),
      );
      process.exit(1);
    }
  }
  process.exit(0);
}

function findEntry(oursArg) {
  const wanted = norm(oursArg).toLowerCase();
  const entries = buildEntries();
  return (
    entries.find((e) => norm(e.ours).toLowerCase() === wanted) ||
    entries.find((e) => norm(e.ours).toLowerCase().endsWith("/" + wanted)) ||
    null
  );
}

function runGit(args) {
  return spawnSync("git", args, { encoding: "utf8", windowsHide: true });
}

function cmdDiff(oursArg) {
  const entry = findEntry(oursArg);
  if (!entry) {
    console.error(
      `No tracked file matching "${oursArg}". Run "check" to list tracked files.`,
    );
    process.exit(1);
  }
  const theirs = absTheirs(entry.theirs);
  const ours = absOurs(entry.ours);
  const res = runGit([
    "-c",
    "core.autocrlf=false",
    "diff",
    "--no-index",
    "--no-color",
    "--",
    theirs,
    ours,
  ]);
  const out = (res.stdout || "") + (res.stderr || "");
  process.stdout.write(out);
  // git diff --no-index exits 1 when files differ — that is success for us.
  if (res.status > 1 || res.error) {
    if (res.error) console.error(String(res.error));
    process.exit(2);
  }
  process.exit(0);
}

function cmdPull(oursArg, force) {
  const entry = findEntry(oursArg);
  if (!entry) {
    console.error(`No tracked file matching "${oursArg}".`);
    process.exit(1);
  }
  if (entry.mode === "adapted" && !force) {
    console.error(
      `Refusing to pull "${entry.ours}": mode is "adapted" (local changes expected).\n` +
        `Pass --force to overwrite it anyway.`,
    );
    process.exit(1);
  }
  const src = absTheirs(entry.theirs);
  if (!fs.existsSync(src)) {
    console.error(`Upstream file does not exist: ${entry.theirs}`);
    process.exit(1);
  }
  const dst = absOurs(entry.ours);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`Pulled ${entry.theirs} -> ${entry.ours}${entry.dynamic ? " (dynamic UI entry)" : ""}`);
  process.exit(0);
}

function cmdStatus() {
  const headRes = runGit(["-C", upstream, "rev-parse", "HEAD"]);
  if (headRes.status !== 0 || !headRes.stdout) {
    console.error(`Could not read upstream HEAD from ${upstream}`);
    if (headRes.stderr) process.stderr.write(headRes.stderr);
    process.exit(2);
  }
  const head = headRes.stdout.trim();
  const inSync = head === baseCommit;
  console.log(`Upstream:   ${upstream}`);
  console.log(`baseCommit: ${baseCommit || "(unset)"}`);
  console.log(`HEAD:       ${head}`);
  console.log(`State:      ${inSync ? "IN SYNC with baseCommit" : "OUT OF SYNC with baseCommit"}`);

  if (!baseCommit) {
    process.exit(0);
  }

  const diffRes = runGit([
    "-C",
    upstream,
    "diff",
    "--name-only",
    `${baseCommit}..HEAD`,
  ]);
  if (diffRes.status !== 0) {
    console.error("Could not compute upstream changes since baseCommit.");
    if (diffRes.stderr) process.stderr.write(diffRes.stderr);
    process.exit(2);
  }
  const changed = (diffRes.stdout || "")
    .split(/\r?\n/)
    .map(norm)
    .filter(Boolean);
  const tracked = new Map(
    buildEntries().map((e) => [norm(e.theirs).toLowerCase(), e.ours]),
  );
  const relevant = changed
    .filter((f) => tracked.has(f.toLowerCase()))
    .map((f) => ({ theirs: f, ours: tracked.get(f.toLowerCase()) }));

  console.log("");
  console.log(
    `Upstream files changed since baseCommit: ${changed.length} total, ${relevant.length} tracked here.`,
  );
  if (relevant.length) {
    for (const r of relevant) console.log(`  * ${r.theirs}  ->  ${r.ours}`);
  } else {
    console.log("  (none of the changed upstream files are in this manifest)");
  }
  process.exit(0);
}

function usage() {
  console.log(`Usage: node scripts/sync-t3.mjs <command> [args]

Commands:
  check [--strict]   Drift table (default). --strict exits 1 if a verbatim file is out of sync.
  diff <ours-path>   Unified diff of upstream -> ours for a tracked file.
  pull <ours-path>   Copy upstream over ours (--force required for adapted files).
  status             Upstream HEAD vs baseCommit and relevant upstream changes.

Set T3_SRC to override the upstream checkout path.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const [cmd = "check", ...args] = process.argv.slice(2);
switch (cmd) {
  case "check":
    cmdCheck(args.includes("--strict"));
    break;
  case "diff":
    if (!args[0] || args[0].startsWith("--")) {
      console.error("diff requires an <ours-path> argument.");
      process.exit(2);
    }
    cmdDiff(args[0]);
    break;
  case "pull":
    if (!args[0] || args[0].startsWith("--")) {
      console.error("pull requires an <ours-path> argument.");
      process.exit(2);
    }
    cmdPull(args[0], args.includes("--force"));
    break;
  case "status":
    cmdStatus();
    break;
  case "--help":
  case "-h":
  case "help":
    usage();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    usage();
    break;
}
