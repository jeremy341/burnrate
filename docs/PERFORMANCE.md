# Burnrate performance budgets

Size and idle-cost budgets are a product feature (see `docs/ROADMAP.md`, "Lightweight budget").
This page defines the numbers, the measurement recipe, and the current measured baseline.
`scripts/perf-budget.mjs` enforces the web budgets in CI; the server RSS gate runs when a
release binary is present (the integrator builds release binaries, packages never do).

## Budgets

| Gate | Budget | Notes |
|---|---|---|
| `main` initial JS | **520 KB gzip** | Static import graph of `index.html` (entry chunk + all statically imported chunks). Dynamic imports are reported separately and are not charged to first paint. |
| CSS in `dist/web` | **60 KB gzip** | Every emitted `.css` file (entry CSS plus CSS of lazy chunks). |
| Server idle RSS | **60 MB** | Release binary, fresh temp data dir, measured after 20 s idle. Gated when a release binary exists. |
| Server loaded RSS | *reported* | Same process after `/api/usage` has run twice and `/api/limits` once; informational until a baseline exists. |
| Release binary | *reported* | Soft target 25 MB. Not gated yet; `cargo build --release` belongs to the integrator. |

Sizes are gzip bytes (Node `zlib.gzipSync`, default level 6) and "KB" means 1024 bytes.
Vite prints decimal kB (1000 bytes), so its numbers are ~2.4% larger for the same file;
use the script's totals for decisions and the chunk table below (converted to 1024-byte KB)
for per-chunk comparisons.

## Running the gate

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
node scripts/perf-budget.mjs            # human readable; exit 1 on a breach
node scripts/perf-budget.mjs --json     # CI-friendly JSON
node scripts/perf-budget.mjs --skip-server
```

Exit codes: `0` all gates pass, `1` a budget was exceeded, `2` usage error or no
`dist/web`. In CI the packaging workflow builds artifacts first, then calls
`node scripts/perf-budget.mjs` (the workflow calls it when present, see package 48).

The script reads `dist/web/.vite/manifest.json` (emitted by `build.manifest = true` in
`vite.config.ts`) so every chunk is attributed to the HTML entry that loads it. Without
a manifest it falls back to parsing the HTML entry tags and following relative imports
in the emitted chunks.

### Server RSS measurement

`measureServer()` starts the binary found at `BURNRATE_SERVER_EXE`,
`$CARGO_TARGET_DIR/release/burnrate-server[.exe]`, or `server-rs/target/release/…` on a
free port at or after `13849`, with a fresh `BURNRATE_DATA` temp dir. The child
environment also points `USERPROFILE`/`HOME`/`APPDATA`/`XDG_*`/`CLAUDE_CONFIG_DIR`/
`CODEX_HOME`/`GROK_HOME` at that temp dir, so a measurement never reads real transcripts
or logins. RSS is read with `Get-Process` on Windows (`WorkingSet64`) and `/proc/<pid>/status`
(`VmRSS`) on Linux; the process is stopped by PID and the temp dir is removed afterwards.
Pass `--idle-seconds N` for a faster local loop (CI uses the default 20 s).

## Measured baseline

Measured 2026-11-20 on Windows, `feature/universal-app` skeleton (2,278 modules, Vite 7.3.8,
React 19.3.1), after the chunk split in `vite.config.ts`:

| Entry | Initial JS (gzip) | Initial CSS (gzip) | JS+CSS | Lazy JS |
|---|---:|---:|---:|---:|
| `main` (`index.html`) | 223.3 KB | 38.3 KB | 261.6 KB | 0.0 KB |
| CSS (all of `dist/web`) | — | 38.3 KB | — | — |

Chunk table (1024-byte KB, measured with the same gzip settings as the gate):

| Chunk | Raw | Gzip |
|---|---:|---:|
| `vendor-react` (react, react-dom, scheduler) | 217.04 KB | 67.57 KB |
| `vendor-base-ui` (`@base-ui/react`) | 217.18 KB | 72.22 KB |
| `main` (Usage view, app shell) | 120.58 KB | 36.11 KB |
| `view-providers` (Providers page/wizard) | 79.55 KB | 35.86 KB |
| `view-settings` (settings shell + sections) | 33.39 KB | 11.06 KB |
| `appearance` (theme boot) | 0.69 KB | 0.39 KB |
| `appearance.css` (Tailwind + theme + fonts) | 261.65 KB | 38.26 KB |

All web gates pass. Splitting chunks alone did not shrink first paint: before the split
the same app was 223.0 KB gzip of main JS in two chunks, after it is 223.3 KB in seven
chunks. The gain is cache granularity and the lazy-loading path below; the per-entry gate
is the number to watch as features land.

Fonts add 213.4 KB of `.woff2` files (7 Inter subsets); they are not part of the JS/CSS
budget but are part of the first load when the CSS references them.

The server gates were skipped in this worktree because release binaries are
integrator-only; run the script in CI after `cargo build --release`. The script reports
idle and loaded RSS as soon as a binary is available.

## Findings and improvement opportunities

### 1. Wire the lazy import points (largest measured win) — ~47 KB gzip first paint

`src/views/registry.ts` (package 38) still uses `import.meta.glob("./*.tsx", { eager: true })`,
so `App.tsx` statically imports every view. `manualChunks` already isolates them, but the
browser still downloads `view-settings` and `view-providers` on first paint. Switching the
registry to `import.meta.glob("./*.tsx")` + `React.lazy`/`Suspense` (or a small async loader
that renders a skeleton until the module resolves) removes **11.1 + 35.9 = 46.9 KB gzip**
from the initial main graph: **223.3 → 176.4 KB gzip (−21%)**. The same wiring makes the
theme editor lazy as it lands, so the saving grows with it.
The registry and `App.tsx` are owned by package 38; this package only provides the chunk map.

### 2. Trim the Inter subsets — 166 KB raw

`@fontsource-variable/inter` (imported by `src/main.tsx`, package 21/38) emits all seven
unicode subsets. The UI only needs `latin` (47.13 KB) and optionally `latin-ext`
(83.07 KB); `greek`, `greek-ext`, `cyrillic`, `cyrillic-ext`, and `vietnamese` account for
**85.2 KB** that most users never fetch (and `latin-ext` another 83.1 KB). Write a small
`@font-face` block against `@fontsource-variable/inter/files/inter-latin-wght-normal.woff2`
instead of importing the package entry (or conditionally import subsets for the locale).

### 4. Audit `@base-ui/react` imports — 72 KB gzip, 32% of main JS

`vendor-base-ui` is the single largest chunk. Only the primitives actually rendered should
be imported (`@base-ui/react/dialog`, `.../menu`, …) rather than the package barrel; Vite
tree-shakes ESM, but a barrel import of a component that re-exports everything can defeat
it. Confirm after package 38/47 land with a bundle analyzer build; this package does not
add an analyzer dependency. React + ReactDOM (67.6 KB gzip) is the practical floor for the
current T3 UI stack; switching to Preact would break the 1:1 T3 component contract, so it
is not recommended.

### 5. Rust release binary (recommendations only — `Cargo.toml` is integrator-owned)

The current profile is already tuned (`lto = true`, `codegen-units = 1`, `panic = "abort"`,
`strip = true`, `opt-level = 3`). From the roadmap and the dependency set:

- `opt-level = "s"` instead of `3`: roadmap recommendation; expect roughly 5–15% smaller
  binaries for compute-light code. Measure with the release binary after the integrator
  build; the script reports the size but does not gate it yet.
- `rusqlite` with `bundled` compiles SQLite into the binary (≈1–2 MB). Confirm the engine
  cache really needs SQLite (`engine.rs`/`store.rs`); a compact append-only cache would
  remove it.
- `zstd` is only needed for history (`history.rs`, package 06) and compressed transcripts.
  Keep it, but check `default-features = false` if the unused bindings/legacy decoders can
  be dropped.
- `serde_json` has `preserve_order` enabled (pulls `indexmap`). If response ordering is not
  part of a contract, dropping that feature saves size and a little CPU.
- Use `cargo bloat --release` / `cargo llvm-lines` (integrator) to attribute the remaining
  size; this worktree only runs `cargo check`/`cargo test`.

### 6. Defer the startup transcript scan

`server-rs/src/lib.rs` spawns a background `engine.summary(today)` immediately at startup.
With a cold cache on a busy machine this is the main source of idle CPU/RSS right after
launch, even when no window is open. Deferring it until the first `/api/usage` request (or
a 30 s idle delay) would improve the idle RSS gate; the script's "loaded RSS" figure
isolates that cost once a release binary exists. `lib.rs` is integrator-owned; recommend,
do not edit.

### 7. Static serving is uncompressed (not gated)

The Rust server serves the built files as-is. Loopback transfers make gzip/brotli
unnecessary for speed, so this is only noted: if a future remote UI is added, pre-compress
the assets at build time instead of compressing per request.

## Limitations

- The RSS gate needs a release binary; package worktrees and PR CI that only run
  `cargo check`/`cargo test` report it as skipped.
- "Loaded RSS" has no baseline yet, so it is reported but not gated. Tighten it once the
  integrator records numbers for a real data dir.
- The manifest attributes only static `import` edges; dynamic imports are reported as
  `lazyJs`/`lazyCss` and deliberately excluded from the first-paint gates.
