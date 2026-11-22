// Usage: node scripts/check-ownership.mjs <package-id> [baseRef]
// Fails when the working tree/branch changed files outside the package's globs in docs/work/ownership.json.
import { execSync } from "node:child_process";
import fs from "node:fs";

// Optional `--ref <branch>`: check what <branch> changed relative to the base instead of the current checkout.
const rawArgs = process.argv.slice(2);
const refAt = rawArgs.indexOf("--ref");
const ref = refAt >= 0 ? rawArgs[refAt + 1] : null;
if (refAt >= 0) rawArgs.splice(refAt, 2);
const [id, baseArg] = rawArgs;
const own = JSON.parse(fs.readFileSync(new URL("../docs/work/ownership.json", import.meta.url), "utf8")).packages;
if (!id || !own[id]) {
  console.error(`unknown package "${id}". Known: ${Object.keys(own).join(", ")}`);
  process.exit(2);
}

const SPECIAL = /[.+^${}()|[\]\\]/g;
const toRx = (glob) =>
  new RegExp(
    "^" +
      glob
        .replace(SPECIAL, "\\$&")
        // Use placeholders so the single-star pass cannot rewrite the output of the double-star passes.
        .replace(/\*\*\//g, "\u0001")
        .replace(/\*\*/g, "\u0002")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0001/g, "(.*/)?")
        .replace(/\u0002/g, ".*") +
      "$",
  );

const rxs = own[id].globs.map(toRx);
const sh = (cmd) =>
  execSync(cmd, { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

const base = baseArg ?? "feature/universal-app";
const changed = new Set();
try {
  sh(`git diff --name-only ${base}...${ref ?? "HEAD"}`).forEach((f) => changed.add(f));
} catch {
  /* base ref missing: only the working tree is checked */
}
if (!ref) {
  execSync("git status --porcelain -uall", { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .forEach((line) => changed.add(line.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()));
}

// A test file (`*.test.ts|tsx|mjs`) is allowed when it sits in a directory the package owns files in.
const TEST_FILE = /\.test\.(ts|tsx|mjs)$/;
// A `dir/**` glob (or `dir/x*`) allows tests anywhere below `dir`; a plain file glob allows tests only in that file's own directory.
const dirOf = (f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");
const ownedDirs = own[id].globs.map((g) => {
  const star = g.indexOf("*");
  if (star === -1) return { dir: dirOf(g), deep: false };
  const prefix = g.slice(0, star);
  const dir = prefix.endsWith("/") ? prefix.slice(0, -1) : dirOf(prefix);
  return { dir, deep: g.includes("**") };
});
const ownsTestDir = (f) =>
  TEST_FILE.test(f) && ownedDirs.some(({ dir, deep }) => dir !== "" && (dirOf(f) === dir || (deep && dirOf(f).startsWith(dir + "/"))));

const bad = [...changed].filter((f) => !rxs.some((r) => r.test(f)) && !ownsTestDir(f));
if (bad.length) {
  console.error(`Package ${id} (${own[id].name}) touched files it does not own:\n  ` + bad.join("\n  "));
  process.exit(1);
}
console.log(`ok: ${changed.size} changed file(s), all owned by package ${id} (${own[id].name})`);
