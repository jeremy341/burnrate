#!/usr/bin/env node
// SHA256 checksums for release artifacts, compatible with `sha256sum -c`.
//
// Usage:
//   node packaging/scripts/checksums.mjs <dir-or-file>... [--out FILE] [--verify FILE]
//   node packaging/scripts/checksums.mjs --self-test
//
// Defaults: writes <dir>/SHA256SUMS with sorted "<hash>  <name>" lines. Only
// regular files are hashed (no recursion); the output file is skipped.
// --verify exits 1 when a hash is missing, mismatched, or a file is absent.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

class ChecksumError extends Error {}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--self-test")) return selfTest();

  if (args.includes("--help") || args.includes("-h")) {
    console.log("usage: checksums.mjs <dir-or-file>... [--out FILE] [--verify FILE] [--self-test]");
    return EXIT_OK;
  }

  let verifyFile = null;
  let outFile = null;
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out") {
      outFile = args[++i];
      if (!outFile) throw new UsageError("--out needs a file path");
    } else if (arg === "--verify") {
      verifyFile = args[++i];
      if (!verifyFile) throw new UsageError("--verify needs a SHA256SUMS file");
    } else if (arg.startsWith("--")) {
      throw new UsageError(`unknown option ${arg}`);
    } else {
      targets.push(arg);
    }
  }

  if (verifyFile) return verify(verifyFile);
  if (targets.length === 0) throw new UsageError("no input files or directories given");

  const files = collectFiles(targets);
  if (files.length === 0) throw new UsageError("no regular files found in the given paths");

  const destination = outFile ?? path.join(firstDirectory(targets) ?? process.cwd(), "SHA256SUMS");
  const lines = [];
  for (const file of files) {
    if (path.resolve(file) === path.resolve(destination)) continue;
    const digest = await sha256File(file);
    lines.push(`${digest}  ${path.basename(file)}`);
  }
  if (lines.length === 0) throw new UsageError("nothing to hash (only the output file was given)");
  lines.sort((a, b) => a.slice(66).localeCompare(b.slice(66), "en"));

  fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  fs.writeFileSync(destination, lines.join("\n") + "\n", "utf8");
  console.log(`wrote ${lines.length} checksum(s) to ${destination}`);
  return EXIT_OK;
}

function firstDirectory(targets) {
  for (const target of targets) {
    try {
      if (fs.statSync(target).isDirectory()) return target;
    } catch {
      throw new UsageError(`cannot read ${target}`);
    }
  }
  return null;
}

function collectFiles(targets) {
  const files = [];
  for (const target of targets) {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      throw new UsageError(`cannot read ${target}`);
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        if (entry.isFile()) files.push(path.join(target, entry.name));
      }
    } else if (stat.isFile()) {
      files.push(target);
    }
  }
  return files;
}

async function verify(manifest) {
  if (!fs.existsSync(manifest)) throw new UsageError(`no such checksum file: ${manifest}`);
  const dir = path.dirname(path.resolve(manifest));
  const expected = fs
    .readFileSync(manifest, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
      if (!match) throw new ChecksumError(`malformed line in ${manifest}: ${line}`);
      return { digest: match[1].toLowerCase(), name: match[2] };
    });

  let failures = 0;
  for (const entry of expected) {
    const file = path.resolve(dir, entry.name);
    if (!fs.existsSync(file)) {
      console.error(`MISSING  ${entry.name}`);
      failures++;
      continue;
    }
    const actual = await sha256File(file);
    if (actual === entry.digest) {
      console.log(`OK       ${entry.name}`);
    } else {
      console.error(`MISMATCH ${entry.name} (expected ${entry.digest}, got ${actual})`);
      failures++;
    }
  }
  if (failures > 0) {
    console.error(`${failures} checksum(s) failed`);
    return EXIT_FAIL;
  }
  console.log(`${expected.length} checksum(s) verified`);
  return EXIT_OK;
}

class UsageError extends Error {}

async function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burnrate-checksums-"));
  let failed = 0;
  const check = (condition, label) => {
    if (condition) {
      console.log(`ok   ${label}`);
    } else {
      console.error(`FAIL ${label}`);
      failed++;
    }
  };

  try {
    fs.writeFileSync(path.join(dir, "b-artifact.zip"), "second artifact\n");
    fs.writeFileSync(path.join(dir, "a-artifact.exe"), "first artifact\n");
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "nested", "ignored.txt"), "not hashed\n");

    const manifest = path.join(dir, "SHA256SUMS");
    const originalLog = console.log;
    console.log = () => {};
    const code = await main(["node", "checksums.mjs", dir, "--out", manifest]);
    console.log = originalLog;
    check(code === EXIT_OK, "generates checksums");
    const text = fs.readFileSync(manifest, "utf8");
    check(/^[a-f0-9]{64} {2}a-artifact\.exe\n[a-f0-9]{64} {2}b-artifact\.zip\n$/.test(text), "sorted sha256sum-compatible output");
    check(!text.includes("nested"), "does not recurse into subdirectories");
    check(!text.includes("SHA256SUMS"), "does not hash its own output");

    console.log = () => {};
    const okCode = await main(["node", "checksums.mjs", "--verify", manifest]);
    console.log = originalLog;
    check(okCode === EXIT_OK, "verifies untouched files");

    fs.appendFileSync(path.join(dir, "a-artifact.exe"), "tampered\n");
    const errors = [];
    const originalError = console.error;
    console.log = () => {};
    console.error = (message) => errors.push(String(message));
    const badCode = await main(["node", "checksums.mjs", "--verify", manifest]);
    console.log = originalLog;
    console.error = originalError;
    check(badCode === EXIT_FAIL, "detects tampered files");
    check(errors.some((line) => line.includes("MISMATCH a-artifact.exe")), "names the mismatched file");

    fs.rmSync(path.join(dir, "b-artifact.zip"));
    console.error = () => {};
    console.log = () => {};
    const missingCode = await main(["node", "checksums.mjs", "--verify", manifest]);
    console.log = originalLog;
    console.error = originalError;
    check(missingCode === EXIT_FAIL, "detects missing files");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failed === 0 ? "self-test passed" : `self-test failed (${failed})`);
  return failed === 0 ? EXIT_OK : EXIT_FAIL;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof UsageError) {
        console.error(`error: ${error.message}`);
        console.error("usage: checksums.mjs <dir-or-file>... [--out FILE] [--verify FILE] [--self-test]");
        process.exitCode = EXIT_USAGE;
      } else if (error instanceof ChecksumError) {
        console.error(`error: ${error.message}`);
        process.exitCode = EXIT_FAIL;
      } else {
        console.error(error);
        process.exitCode = EXIT_FAIL;
      }
    });
}

export { sha256File };
