#!/usr/bin/env node
// Fill the release tokens in the packaging templates (winget, Scoop, AUR, Flatpak).
//
// Usage:
//   node packaging/scripts/render-manifests.mjs \
//     --version 0.1.0 --repo owner/burnrate \
//     --checksums dist/release/SHA256SUMS --out dist/packaging \
//     [--date 2026-11-20] [--allow-missing]
//
// Templates are copied from packaging/{winget,scoop,aur,flatpak} into --out with
// __VERSION__, __REPO__, __DATE__ and __SHA256_*__ substituted. A checked-in
// template is never overwritten. Rendering fails when an artifact listed in
// SHA256SUMS is missing unless --allow-missing is passed (release drafts).
//
// Token values are never read from the environment: the release workflow passes
// the tag, repository and checksum file explicitly, so a local run cannot leak
// anything.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

export const TOKEN_TO_ARTIFACT = {
  SHA256_WIN_SETUP: (version) => `Burnrate-${version}-windows-x64-setup.exe`,
  SHA256_WIN_ZIP: (version) => `Burnrate-${version}-windows-x64.zip`,
  SHA256_LINUX_TARBALL: (version) => `Burnrate-${version}-linux-x86_64.tar.gz`,
};

export const KNOWN_TOKENS = new Set([
  "VERSION",
  "REPO",
  "DATE",
  ...Object.keys(TOKEN_TO_ARTIFACT),
]);

export const TEMPLATES = [
  "winget/Burnrate.Burnrate.yaml",
  "winget/Burnrate.Burnrate.installer.yaml",
  "winget/Burnrate.Burnrate.locale.en-US.yaml",
  "scoop/burnrate.json",
  "aur/PKGBUILD",
  "flatpak/org.burnrate.Burnrate.yaml",
];

class RenderError extends Error {}
class UsageError extends Error {}

export function parseChecksums(text) {
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (!match) throw new RenderError(`malformed checksum line: ${line}`);
    map.set(match[2], match[1].toLowerCase());
  }
  return map;
}

export function buildValues({ version, repo, date, checksums, allowMissing = false }) {
  if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new UsageError(`invalid --version "${version}" (expected e.g. 1.2.3 or 1.2.3-beta.1)`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new UsageError(`invalid --repo "${repo}" (expected "owner/name")`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new UsageError(`invalid --date "${date}" (expected YYYY-MM-DD)`);
  }

  const values = { VERSION: version, REPO: repo, DATE: date };
  for (const [token, fileName] of Object.entries(TOKEN_TO_ARTIFACT)) {
    const name = fileName(version);
    const digest = checksums.get(name);
    if (!digest) {
      if (!allowMissing) {
        throw new RenderError(
          `checksum for ${name} is missing (SHA256SUMS must list every shipped artifact; use --allow-missing for drafts)`,
        );
      }
      console.warn(`warning: no checksum for ${name}; writing a zero placeholder`);
      values[token] = "0".repeat(64);
      continue;
    }
    values[token] = digest;
  }
  return values;
}

export function render(text, values) {
  let output = text;
  for (const [token, value] of Object.entries(values)) {
    output = output.split(`__${token}__`).join(value);
  }
  const leftover = output.match(/__[A-Z0-9_]+__/);
  if (leftover) throw new RenderError(`unresolved token ${leftover[0]}`);
  return output;
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--self-test")) return selfTest();
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "usage: render-manifests.mjs --version V --repo OWNER/NAME --checksums FILE --out DIR [--date YYYY-MM-DD] [--allow-missing]",
    );
    return 0;
  }

  const options = { allowMissing: false };
  const flags = {
    "--version": "version",
    "--repo": "repo",
    "--checksums": "checksums",
    "--out": "out",
    "--date": "date",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--allow-missing") {
      options.allowMissing = true;
      continue;
    }
    const key = flags[arg];
    if (!key) throw new UsageError(`unknown argument ${arg}`);
    const value = args[++i];
    if (!value) throw new UsageError(`${arg} needs a value`);
    options[key] = value;
  }
  for (const required of ["version", "repo", "checksums", "out"]) {
    if (!options[required]) throw new UsageError(`missing --${required}`);
  }
  if (!fs.existsSync(options.checksums)) throw new UsageError(`no such file: ${options.checksums}`);

  const checksums = parseChecksums(fs.readFileSync(options.checksums, "utf8"));
  const values = buildValues({
    version: options.version,
    repo: options.repo,
    date: options.date ?? new Date().toISOString().slice(0, 10),
    checksums,
    allowMissing: options.allowMissing,
  });

  const outRoot = path.resolve(options.out);
  for (const template of TEMPLATES) {
    const sourcePath = path.join(ROOT, "packaging", template);
    const destinationPath = path.join(outRoot, template);
    const rendered = render(fs.readFileSync(sourcePath, "utf8"), values);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, rendered, "utf8");
    console.log(`rendered ${template}`);
  }
  console.log(`wrote ${TEMPLATES.length} manifest(s) to ${outRoot}`);
  return 0;
}

async function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burnrate-manifests-"));
  const version = "9.9.9";
  let failed = 0;
  const check = (condition, label) => {
    if (condition) console.log(`ok   ${label}`);
    else {
      console.error(`FAIL ${label}`);
      failed++;
    }
  };

  try {
    const checksums = new Map(
      Object.values(TOKEN_TO_ARTIFACT).map((fileName) => [fileName(version), "a".repeat(64)]),
    );
    const values = buildValues({ version, repo: "burnrate/burnrate", date: "2026-01-02", checksums });
    check(values.SHA256_WIN_SETUP === "a".repeat(64), "maps checksums to tokens");
    check(values.VERSION === version && values.REPO === "burnrate/burnrate", "passes through version and repo");

    for (const template of TEMPLATES) {
      const rendered = render(fs.readFileSync(path.join(ROOT, "packaging", template), "utf8"), values);
      check(!rendered.includes("__"), `renders all tokens in ${template}`);
      check(rendered.includes(version) || template === "aur/PKGBUILD", `writes the version in ${template}`);
    }

    let rejected = false;
    try {
      buildValues({ version, repo: "burnrate/burnrate", date: "2026-01-02", checksums: new Map() });
    } catch (error) {
      rejected = error instanceof RenderError;
    }
    check(rejected, "rejects missing checksums without --allow-missing");

    const allowed = buildValues({
      version,
      repo: "burnrate/burnrate",
      date: "2026-01-02",
      checksums: new Map(),
      allowMissing: true,
    });
    check(allowed.SHA256_WIN_ZIP === "0".repeat(64), "--allow-missing writes a placeholder");

    let leftoverRejected = false;
    try {
      render("x __NOT_A_TOKEN__", values);
    } catch (error) {
      leftoverRejected = error instanceof RenderError;
    }
    check(leftoverRejected, "rejects unresolved tokens");

    const out = path.join(dir, "out");
    const fakeChecksums = path.join(dir, "SHA256SUMS");
    fs.writeFileSync(
      fakeChecksums,
      [...checksums].map(([name, digest]) => `${digest}  ${name}`).join("\n") + "\n",
      "utf8",
    );
    await main([
      "node",
      "render-manifests.mjs",
      "--version",
      version,
      "--repo",
      "burnrate/burnrate",
      "--checksums",
      fakeChecksums,
      "--out",
      out,
    ]);
    check(fs.existsSync(path.join(out, "winget", "Burnrate.Burnrate.installer.yaml")), "writes rendered winget manifest");
    check(fs.existsSync(path.join(out, "aur", "PKGBUILD")), "writes rendered PKGBUILD");
    check(fs.readFileSync(path.join(out, "scoop", "burnrate.json"), "utf8").includes("a".repeat(64)), "substitutes hashes");
    check(
      fs.readFileSync(path.join(ROOT, "packaging", "scoop", "burnrate.json"), "utf8").includes("__SHA256_WIN_ZIP__"),
      "leaves the checked-in template untouched",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failed === 0 ? "self-test passed" : `self-test failed (${failed})`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof UsageError) {
        console.error(`error: ${error.message}`);
        process.exitCode = 2;
      } else {
        console.error(`error: ${error.message}`);
        process.exitCode = 1;
      }
    });
}
