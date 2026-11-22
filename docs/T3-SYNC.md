# Keeping copied T3 files in sync

Some files in this repo are copied from the [T3 Code](https://github.com/t3code/t3code) checkout
at `C:\Users\jerem\Documents\GITHUB\burnrate\app`. The tool `scripts/sync-t3.mjs` reports and manages
drift between those copies and their upstream originals.

## Modes

Every tracked file has a `mode` in [`scripts/t3-manifest.json`](../scripts/t3-manifest.json):

- **verbatim** — the file must be byte-identical to upstream. Any difference is drift.
- **adapted** — the file was intentionally changed for this app (imports, branding, trimmed code).
  Differences are expected and are never flagged by `--strict`. Pulling an adapted file requires
  `--force` so local edits are not overwritten by accident.

UI primitives under `src/components/ui` are also discovered **dynamically**: the script scans that
folder and matches same-named files under upstream `apps/web/src/components/ui`. Newly added
primitives (badge, checkbox, switch, textarea, wizard, toast, …) therefore show up without a
manifest entry; their initial mode is `verbatim` if the bytes match, otherwise `adapted`. Add an
explicit manifest entry only when you want to pin/override the mode of a non-UI file.

## Usage

From the repo root:

```sh
# Drift table (IDENTICAL / DIFFERS (+ changed lines) / MISSING-IN-OURS / MISSING-UPSTREAM)
node scripts/sync-t3.mjs check

# Fail with exit code 1 if any verbatim file is out of sync (handy in CI)
node scripts/sync-t3.mjs check --strict

# See where upstream is relative to the recorded baseline
node scripts/sync-t3.mjs status

# Inspect a single file's diff (upstream -> ours)
node scripts/sync-t3.mjs diff src/components/ui/button.tsx

# Overwrite our copy with upstream (adapted files need --force)
node scripts/sync-t3.mjs pull src/components/ui/button.tsx
node scripts/sync-t3.mjs pull src/components/usage/UsagePage.tsx --force
```

`npm run sync:t3 -- <args>` is a shortcut for the same command.

`check` uses the exit code only when `--strict` is passed; otherwise it always exits 0 so it can
be used as a pure report.

## Upstream location

The upstream checkout is read from, in order:

1. the `T3_SRC` environment variable,
2. the `upstream` field in `scripts/t3-manifest.json`,
3. a built-in default path.

The upstream checkout is **read only** — never edit it. Set `T3_SRC` to point at a different clone
if needed.

## Updating `baseCommit`

`baseCommit` records the upstream commit the manifest was captured against. `status` compares it to
the upstream `HEAD` and lists upstream files changed since then that appear in the manifest.

To rebaseline, confirm the copies you want to keep are up to date, then set `baseCommit` to the
current upstream HEAD:

```sh
git -C "C:\Users\jerem\Documents\GITHUB\burnrate\app" rev-parse HEAD
```

Paste that hash into the `baseCommit` field of `scripts/t3-manifest.json`. After rebaselining,
`status` will report `IN SYNC with baseCommit` and only future upstream changes will be listed.
