#!/usr/bin/env node
// Structural validation for Burnrate packaging files. No dependencies.
//
//   node packaging/scripts/validate-packaging.mjs            validate this repo
//   node packaging/scripts/validate-packaging.mjs --self-test test the YAML parser
//
// This is deliberately not a full YAML/JSON-Schema validator. It catches the
// mistakes that actually break CI: tabs, duplicate keys, wrong indentation,
// unbalanced quotes/collections, wrong GitHub Actions shape, malformed winget
// manifests, unknown release tokens, broken NSIS section structure and a
// PKGBUILD that is missing its package() function.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml, YamlError } from "./lib/yaml-lite.mjs";
import { KNOWN_TOKENS } from "./render-manifests.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readAny(source, relativePath) {
  if (relativePath.endsWith(".json")) return JSON.parse(source);
  return parseYaml(source, relativePath);
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function validateWorkflows() {
  const dir = path.join(ROOT, ".github", "workflows");
  check(fs.existsSync(dir), ".github/workflows is missing");
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
  check(files.length > 0, ".github/workflows has no workflow files");

  for (const name of files) {
    const relative = `.github/workflows/${name}`;
    let doc;
    try {
      doc = parseYaml(readText(relative), relative);
    } catch (error) {
      if (error instanceof YamlError) {
        problems.push(error.message);
        continue;
      }
      throw error;
    }
    check(isObject(doc), `${relative}: top level must be a mapping`);
    if (!isObject(doc)) continue;
    check(typeof doc.name === "string" && doc.name.trim() !== "", `${relative}: missing name`);
    check(doc.on !== undefined && doc.on !== null, `${relative}: missing on: trigger`);
    check(isObject(doc.permissions), `${relative}: missing permissions (least privilege)`);
    check(isObject(doc.jobs) && Object.keys(doc.jobs).length > 0, `${relative}: missing jobs`);

    for (const [jobId, job] of Object.entries(isObject(doc.jobs) ? doc.jobs : {})) {
      const label = `${relative}: jobs.${jobId}`;
      check(isObject(job), `${label}: must be a mapping`);
      if (!isObject(job)) continue;
      if (typeof job.uses === "string") continue; // reusable workflow call
      check(job["runs-on"] !== undefined, `${label}: missing runs-on`);
      check(Array.isArray(job.steps) && job.steps.length > 0, `${label}: missing steps`);
      for (const [index, step] of (Array.isArray(job.steps) ? job.steps : []).entries()) {
        const stepLabel = `${label}.steps[${index}]`;
        check(isObject(step), `${stepLabel}: must be a mapping`);
        if (!isObject(step)) continue;
        const hasRun = typeof step.run === "string" && step.run.trim() !== "";
        const hasUses = typeof step.uses === "string" && step.uses.trim() !== "";
        check(hasRun !== hasUses, `${stepLabel}: needs exactly one of run/uses`);
        if (hasUses) check(/@/.test(step.uses), `${stepLabel}: uses must pin a ref with @`);
        if (step.if !== undefined) {
          check(typeof step.if === "string", `${stepLabel}: if must be a string`);
          check(
            !/\bsecrets\s*\./.test(String(step.if)),
            `${stepLabel}: secrets are not expanded in if:; map them to env and test the env value`,
          );
        }
        if (step.with !== undefined) check(isObject(step.with), `${stepLabel}: with must be a mapping`);
      }
    }

    const text = readText(relative);
    check(!/\bsecrets\.[A-Z0-9_]+\s*[:=]\s*[^\s$]/.test(text), `${relative}: looks like a secret literal`);
    for (const match of text.matchAll(/(?:^|[\s"'`])(packaging\/[A-Za-z0-9_.\-/]+)/g)) {
      const referenced = match[1];
      if (referenced.includes("*")) continue;
      // Only check paths that name a real file, not PowerShell glob fragments.
      if (!/\.[A-Za-z0-9]+$/.test(referenced) && path.basename(referenced) !== "PKGBUILD") continue;
      check(fs.existsSync(path.join(ROOT, referenced)), `${relative}: references missing ${referenced}`);
    }
  }

  const ci = path.join(dir, "ci.yml");
  check(fs.existsSync(ci), ".github/workflows/ci.yml is missing");
  if (fs.existsSync(ci)) {
    const ciText = fs.readFileSync(ci, "utf8");
    for (const required of ["corepack pnpm typecheck", "corepack pnpm test", "cargo test", "validate-packaging.mjs"]) {
      check(ciText.includes(required), `.github/workflows/ci.yml: expected "${required}"`);
    }
  }

  const release = path.join(dir, "release.yml");
  check(fs.existsSync(release), ".github/workflows/release.yml is missing");
  if (fs.existsSync(release)) {
    const text = fs.readFileSync(release, "utf8");
    for (const required of ['"v*"', "checksums.mjs", "render-manifests.mjs", "gh release create"]) {
      check(text.includes(required), `.github/workflows/release.yml: expected "${required}"`);
    }
    check(/contents:\s*write/.test(text), ".github/workflows/release.yml: needs permissions: contents: write");
  }
}

function validateWinget() {
  const versionFile = "packaging/winget/Burnrate.Burnrate.yaml";
  const installerFile = "packaging/winget/Burnrate.Burnrate.installer.yaml";
  const localeFile = "packaging/winget/Burnrate.Burnrate.locale.en-US.yaml";
  for (const file of [versionFile, installerFile, localeFile]) {
    check(fs.existsSync(path.join(ROOT, file)), `${file} is missing`);
  }
  if (!fs.existsSync(path.join(ROOT, versionFile))) return;

  const version = parseYaml(readText(versionFile), versionFile);
  check(version?.ManifestType === "version", `${versionFile}: ManifestType must be version`);
  check(typeof version?.ManifestVersion === "string", `${versionFile}: ManifestVersion must be a quoted string`);
  check(version?.PackageIdentifier === "Burnrate.Burnrate", `${versionFile}: unexpected PackageIdentifier`);

  const installer = parseYaml(readText(installerFile), installerFile);
  check(installer?.ManifestType === "installer", `${installerFile}: ManifestType must be installer`);
  check(installer?.InstallerType === "nullsoft", `${installerFile}: InstallerType must be nullsoft`);
  const installers = installer?.Installers;
  check(Array.isArray(installers) && installers.length > 0, `${installerFile}: missing Installers`);
  for (const entry of Array.isArray(installers) ? installers : []) {
    check(entry?.Architecture === "x64", `${installerFile}: expected an x64 installer`);
    check(
      typeof entry?.InstallerUrl === "string" && entry.InstallerUrl.startsWith("https://"),
      `${installerFile}: InstallerUrl must be https`,
    );
    check(
      typeof entry?.InstallerSha256 === "string" && /^__SHA256_[A-Z0-9_]+__$/.test(entry.InstallerSha256),
      `${installerFile}: InstallerSha256 must be a __SHA256_*__ token`,
    );
  }

  const locale = parseYaml(readText(localeFile), localeFile);
  check(locale?.ManifestType === "defaultLocale", `${localeFile}: ManifestType must be defaultLocale`);
  for (const key of ["PackageLocale", "Publisher", "PackageName", "License", "ShortDescription"]) {
    check(typeof locale?.[key] === "string" && locale[key] !== "", `${localeFile}: missing ${key}`);
  }
}

function validateFlatpak() {
  const file = "packaging/flatpak/org.burnrate.Burnrate.yaml";
  check(fs.existsSync(path.join(ROOT, file)), `${file} is missing`);
  if (!fs.existsSync(path.join(ROOT, file))) return;
  const doc = parseYaml(readText(file), file);
  check(doc?.["app-id"] === "org.burnrate.Burnrate", `${file}: unexpected app-id`);
  check(typeof doc?.runtime === "string" && typeof doc?.["runtime-version"] === "string", `${file}: missing runtime`);
  check(typeof doc?.command === "string", `${file}: missing command`);
  check(Array.isArray(doc?.["finish-args"]) && doc["finish-args"].length > 0, `${file}: missing finish-args`);
  check(Array.isArray(doc?.modules) && doc.modules.length > 0, `${file}: missing modules`);
  const module = Array.isArray(doc?.modules) ? doc.modules[0] : null;
  check(module?.name === "burnrate", `${file}: first module should be burnrate`);
  check(module?.buildsystem === "simple", `${file}: module should use buildsystem: simple`);
  check(Array.isArray(module?.sources) && module.sources.length > 0, `${file}: module needs sources`);
  const source = Array.isArray(module?.sources) ? module.sources[0] : null;
  check(
    typeof source?.url === "string" && source.url.includes("releases/download"),
    `${file}: source url should be a release url`,
  );
  check(source?.sha256 === "__SHA256_LINUX_TARBALL__", `${file}: source sha256 token missing`);
  check(source?.["strip-components"] === "1", `${file}: archive source should use strip-components: 1`);
}

function validateJson() {
  const tauriFile = "packaging/tauri/bundle.conf.json";
  check(fs.existsSync(path.join(ROOT, tauriFile)), `${tauriFile} is missing`);
  if (fs.existsSync(path.join(ROOT, tauriFile))) {
    const bundle = JSON.parse(readText(tauriFile));
    const targets = bundle?.bundle?.targets;
    check(Array.isArray(targets), `${tauriFile}: bundle.targets must be an array`);
    for (const target of ["nsis", "appimage", "deb", "rpm"]) {
      check(Array.isArray(targets) && targets.includes(target), `${tauriFile}: missing ${target} target`);
    }
    check(
      bundle?.bundle?.windows?.nsis?.installMode === "currentUser",
      `${tauriFile}: NSIS installMode should be currentUser`,
    );
    check(
      bundle?.bundle?.windows?.webviewInstallMode?.type === "downloadBootstrapper",
      `${tauriFile}: WebView2 install mode should be downloadBootstrapper`,
    );
    check(
      Array.isArray(bundle?.bundle?.linux?.deb?.depends) && bundle.bundle.linux.deb.depends.length > 0,
      `${tauriFile}: deb depends missing`,
    );
  }

  const scoopFile = "packaging/scoop/burnrate.json";
  check(fs.existsSync(path.join(ROOT, scoopFile)), `${scoopFile} is missing`);
  if (fs.existsSync(path.join(ROOT, scoopFile))) {
    const scoop = JSON.parse(readText(scoopFile));
    check(scoop.version === "__VERSION__", `${scoopFile}: version token missing`);
    const arch = scoop.architecture?.["64bit"];
    check(typeof arch?.url === "string" && arch.url.startsWith("https://"), `${scoopFile}: 64bit url missing`);
    check(arch?.hash === "__SHA256_WIN_ZIP__", `${scoopFile}: 64bit hash token missing`);
    check(
      (Array.isArray(scoop.shortcuts) && scoop.shortcuts.length > 0) || Array.isArray(scoop.bin),
      `${scoopFile}: needs shortcuts or bin`,
    );
  }

  const signingFile = "packaging/tauri/signing.example.json";
  check(fs.existsSync(path.join(ROOT, signingFile)), `${signingFile} is missing`);
  if (fs.existsSync(path.join(ROOT, signingFile))) {
    const signing = JSON.parse(readText(signingFile));
    check(
      typeof signing?.bundle?.windows?.certificateThumbprint === "string",
      `${signingFile}: certificateThumbprint placeholder missing`,
    );
  }
}

function validateNsis() {
  const file = "packaging/windows/burnrate.nsi";
  check(fs.existsSync(path.join(ROOT, file)), `${file} is missing`);
  if (!fs.existsSync(path.join(ROOT, file))) return;
  const text = readText(file);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/;.*$/, "").trim())
    .filter(Boolean);
  check(text.includes('!include "MUI2.nsh"'), `${file}: missing MUI2 include`);
  check(/!insertmacro\s+MUI_PAGE_INSTFILES/.test(text), `${file}: missing install page setup`);
  check(/!insertmacro\s+MUI_LANGUAGE\s+"English"/.test(text), `${file}: missing English language`);
  check(/OutFile\s+/.test(text), `${file}: missing OutFile`);
  check(/InstallDir\s+"\$LOCALAPPDATA/.test(text), `${file}: install dir should be per-user`);
  check(/RequestExecutionLevel\s+user/.test(text), `${file}: must request user level (no admin prompt)`);
  check(!/RequestExecutionLevel\s+admin/.test(text), `${file}: must not request admin`);
  check(/WriteUninstaller/.test(text), `${file}: missing WriteUninstaller`);

  for (const [open, close] of [
    ["Section ", "SectionEnd"],
    ["Function ", "FunctionEnd"],
  ]) {
    const keyword = open.trim();
    const opens = lines.filter((line) => line.startsWith(open) || line === keyword).length;
    const closes = lines.filter((line) => line.startsWith(close)).length;
    check(opens === closes, `${file}: unbalanced ${keyword}/${close} (${opens} vs ${closes})`);
  }
  check(lines.some((line) => line === 'Section "Uninstall"'), `${file}: missing uninstall section`);
  check(text.includes("$SMPROGRAMS"), `${file}: missing Start Menu shortcuts`);

  const cmd = "packaging/windows/start.cmd";
  check(fs.existsSync(path.join(ROOT, cmd)), `${cmd} is missing`);
  if (fs.existsSync(path.join(ROOT, cmd))) {
    const cmdText = readText(cmd);
    check(/BURNRATE_PORT/.test(cmdText), `${cmd}: should set BURNRATE_PORT`);
    check(/BURNRATE_WEB/.test(cmdText), `${cmd}: should set BURNRATE_WEB`);
  }
}

function validatePkgbuild() {
  const file = "packaging/aur/PKGBUILD";
  check(fs.existsSync(path.join(ROOT, file)), `${file} is missing`);
  if (!fs.existsSync(path.join(ROOT, file))) return;
  const text = readText(file);
  for (const required of ["pkgname=", "pkgver=__VERSION__", "pkgrel=", "arch=(", "sha256sums=", "package() {"]) {
    check(text.includes(required), `${file}: missing ${required}`);
  }
  const opens = (text.match(/\{/g) ?? []).length;
  const closes = (text.match(/\}/g) ?? []).length;
  check(opens === closes, `${file}: unbalanced braces (${opens} vs ${closes})`);
  check(/install -Dm755/.test(text), `${file}: does not install binaries`);
  check(text.includes("__SHA256_LINUX_TARBALL__"), `${file}: checksum token missing`);
}

function validateLinuxFiles() {
  const desktop = "packaging/linux/org.burnrate.Burnrate.desktop";
  check(fs.existsSync(path.join(ROOT, desktop)), `${desktop} is missing`);
  if (fs.existsSync(path.join(ROOT, desktop))) {
    const text = readText(desktop);
    check(text.startsWith("[Desktop Entry]"), `${desktop}: must start with [Desktop Entry]`);
    for (const key of ["Type=Application", "Name=", "Exec=", "Icon=", "Categories="]) {
      check(text.split(/\r?\n/).some((line) => line.startsWith(key)), `${desktop}: missing ${key}...`);
    }
  }

  const metainfo = "packaging/linux/org.burnrate.Burnrate.metainfo.xml";
  check(fs.existsSync(path.join(ROOT, metainfo)), `${metainfo} is missing`);
  if (fs.existsSync(path.join(ROOT, metainfo))) {
    const text = readText(metainfo);
    check(text.includes("<component type="), `${metainfo}: missing component element`);
    check(text.includes("</component>"), `${metainfo}: missing closing component`);
    check(text.includes("<id>org.burnrate.Burnrate</id>"), `${metainfo}: id must match the desktop id`);
    check(
      text.includes('<launchable type="desktop-id">org.burnrate.Burnrate.desktop</launchable>'),
      `${metainfo}: launchable desktop-id mismatch`,
    );
  }
}

function validateTokens() {
  const files = walkFiles(path.join(ROOT, "packaging"))
    .filter((file) => !path.relative(ROOT, file).startsWith(`packaging${path.sep}scripts${path.sep}`))
    .filter(
      (file) =>
        /\.(md|ya?ml|json|nsi|cmd|ps1|xml|txt|sh)$/.test(file) || path.basename(file) === "PKGBUILD",
    );
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/__([A-Z][A-Z0-9_]*)__/g)) {
      check(
        KNOWN_TOKENS.has(match[1]),
        `${path.relative(ROOT, file)}: unknown release token ${match[0]} (known: ${[...KNOWN_TOKENS].join(", ")})`,
      );
    }
  }
}

function validateDocs() {
  for (const file of ["packaging/README.md", "packaging/SIGNING.md"]) {
    check(fs.existsSync(path.join(ROOT, file)), `${file} is missing`);
  }
  if (fs.existsSync(path.join(ROOT, "packaging/README.md"))) {
    const readme = readText("packaging/README.md");
    check(/SHA256SUMS/.test(readme), "packaging/README.md: should document SHA256SUMS");
    check(/winget/i.test(readme), "packaging/README.md: should document winget");
    check(/Flatpak/i.test(readme), "packaging/README.md: should document Flatpak");
  }
  if (fs.existsSync(path.join(ROOT, "packaging/SIGNING.md"))) {
    const signing = readText("packaging/SIGNING.md");
    check(/unsigned by default/i.test(signing), "packaging/SIGNING.md: must state unsigned by default");
    check(/secrets\./.test(signing) || /WINDOWS_CERT_PFX_BASE64/.test(signing), "packaging/SIGNING.md: document secret names");
  }
}

function validateRepo() {
  validateWorkflows();
  validateWinget();
  validateFlatpak();
  validateJson();
  validateNsis();
  validatePkgbuild();
  validateLinuxFiles();
  validateTokens();
  validateDocs();

  if (problems.length) {
    console.error(`packaging validation failed (${problems.length}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log("packaging validation passed");
  return 0;
}

function expectFailure(source, label, reason) {
  try {
    parseYaml(source, label);
    problems.push(`self-test: ${label} should have been rejected`);
  } catch (error) {
    if (!(error instanceof YamlError)) {
      problems.push(`self-test: ${label} threw a non-YamlError: ${error.message}`);
    } else if (!error.reason.includes(reason)) {
      problems.push(`self-test: ${label} rejected with "${error.reason}" (expected "${reason}")`);
    }
  }
}

function selfTest() {
  const good = `name: Example
on:
  push:
    branches: [main, "feature/universal-app"]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run
        run: |
          echo one
          echo two
      - name: Matrix
        if: matrix.os == 'windows-latest'
        with:
          key: value
        run: echo ok
`;
  let doc;
  try {
    doc = parseYaml(good, "good.yml");
  } catch (error) {
    problems.push(`self-test: good workflow rejected: ${error.message}`);
  }
  check(doc?.on?.push?.branches?.[1] === "feature/universal-app", "self-test: parses flow sequences");
  check(doc?.jobs?.build?.steps?.[1]?.run === "echo one\necho two", "self-test: parses block scalars");
  check(doc?.jobs?.build?.steps?.[2]?.if === "matrix.os == 'windows-latest'", "self-test: parses quoted scalars");
  check(doc?.permissions?.contents === "read", "self-test: parses flow mappings");

  const spaced = parseYaml("a:  b\n", "spaces.yml");
  check(spaced?.a === "b", "self-test: trims extra spaces after a colon");

  const nestedSeq = parseYaml("a:\n  - x\n  - y: 1\n    z: 2\n", "nested.yml");
  check(nestedSeq?.a?.length === 2 && nestedSeq.a[1].z === "2", "self-test: parses nested sequence mappings");

  expectFailure("name: a\nname: b\n", "duplicate", "duplicate key");
  expectFailure("a:\n\tb: c\n", "tab", "tab character");
  expectFailure("a:\n    b: c\n  d: e\n", "indent", "unexpected indentation");
  expectFailure('a: "unterminated\n', "quote", "unterminated");
  expectFailure("a: [1, 2\n", "flow", "expected , or ]");
  expectFailure("a: 1\n  - x\n", "late-sequence", "unexpected indentation");
  expectFailure("- a\n  b: c\n", "scalar-then-map", "unexpected indentation");

  if (problems.length) {
    console.error(`self-test failed (${problems.length}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log("self-test passed");
  return 0;
}

const exitCode = process.argv.includes("--self-test") ? selfTest() : validateRepo();
process.exitCode = exitCode;
