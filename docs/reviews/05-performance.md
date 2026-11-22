# Review: Performance

Scope: static review at branch `feature/universal-app`, commit `b0de7a6`. Areas: bundle composition, idle behaviour (frontend + Rust scheduler/SSE), memory under a large synthetic transcript corpus, view/stream cleanup, release profiles, and startup work. No build/test suite was run; `dist/web/` is present in the worktree and was inspected directly (file sizes and the Vite manifest), and gzip sizes were computed read-only with Node `zlib.gzipSync` (the same method `scripts/perf-budget.mjs` uses).

## Severity: Critical

_None found that is provable by reading code alone._

## Severity: High

### H1. Usage-scan string interner is never pruned — unbounded memory and cache-file growth

- Files: `server-rs/src/store.rs:24-47` (`Interner`), `server-rs/src/store.rs:61-83` (`pack`), `server-rs/src/engine.rs:293-299` (stale cache eviction), `server-rs/src/engine.rs:310-313` + `server-rs/src/store.rs:115-132`/`121` (save).
- What is wrong: `store::pack` interns `provider`, `model`, `rate_model` and **`session`** for every record (`store.rs:66-69`). `Interner` keeps every string twice — once in `strings: Vec<String>` and once as a key in `ids: HashMap<String, u32>` (`store.rs:25-27`, `35-43`) — and has **no `remove`/`retain` method**. When a transcript file disappears from disk, `scan()` removes its `FileEntry` from `inner.cache` (`engine.rs:293-299`) but nothing removes the string ids that were referenced only by that file's rows. On the next dirty scan, `store::save` serialises the *entire* `strings` Vec into the cache header (`store.rs:121`) and writes the whole file out (`store.rs:124-139`).
- Why it matters: with a rotating/large synthetic transcript corpus (new session ids over time), `inner.strings` and `inner.ids` grow monotonically for the lifetime of the process, and the on-disk cache grows on every save. This is the "missing cleanup after compaction" case: row data is compacted, the id table is not. Effects are rising RSS (relevant to the 60 MB idle RSS gate in `docs/PERFORMANCE.md:16`) and increasingly expensive save/load cycles (O(total strings ever seen), not O(live rows)). Even without file deletion, a new session id per conversation accumulates for the whole 100-day horizon (`engine.rs:17`).
- Suggested fix: add `Interner::retain`/`rebuild`. After the stale-entry sweep in `engine.rs:293-299`, collect the set of string ids still referenced by any row in `inner.cache`, rebuild `strings`/`ids` from that set, and remap the id columns in every remaining row (`C_PROVIDER`, `C_MODEL`, `C_RATE_MODEL`, `C_SESSION`) before calling `store::save`. Cheaper alternative: make intern ids file-local (per-`FileEntry` table) so eviction frees them automatically, at the cost of duplicate strings across files. Add a regression test that scans a file with unique session ids, deletes it, re-scans, and asserts the interner length returns to baseline.
- Verified: yes — `grep` over `engine.rs` shows all five `strings` touchpoints and no pruning call; `Interner` exposes only `from_strings`/`id`/`get`.

## Severity: Medium

### M1. Startup eagerly runs a full transcript scan plus a full network limits probe before any window is opened

- Files: `server-rs/src/lib.rs:374-381` (eager `engine.summary(today)`), `server-rs/src/scheduler.rs:136-150` (`next_refresh = Instant::now()`, first refresh as soon as a consumer appears), `server-rs/src/scheduler.rs:92-120` → `server-rs/src/lib.rs:131-151` (`limits_report` spawns one read thread per provider, i.e. network calls), `src-tauri/src/main.rs:110-126` (server thread started, then `stream::start` subscribes to `/api/stream` immediately), `src-tauri/src/stream.rs:75-97`.
- What is wrong: two heavy jobs start unconditionally at launch. (1) `lib.rs:377-380` spawns a thread that calls `engine.summary` for today even if the user never opens the Usage view — on a cold cache this parses every in-horizon transcript file (`engine.rs:191-248`). (2) the shell's SSE client subscribes at startup (`main.rs:126`), so `consumer_active()` becomes true (`scheduler.rs:72-74`) and the scheduler's first tick runs `scheduler.refresh()` → `crate::limits_report()`, a network probe of every provider. Both are pure idle CPU/RSS/I/O at a moment when the app may be `start_minimized`.
- Why it matters: this is the dominant cold-start cost and directly affects the idle RSS budget. It is also still open: `docs/PERFORMANCE.md:151-158` already recommended deferring the summary, and the code at `lib.rs:374-381` is unchanged at this commit.
- Suggested fix: delete the startup scan block (`lib.rs:374-381`) — `/api/usage` already calls `engine.summary` on demand (`lib.rs:188-201`), so the first Usage view pays the cost with a skeleton already shown. If pre-warming is desired, gate it behind a short idle delay (e.g. 30 s) and skip when `startMinimized` is true. For the limits probe, consider seeding the tray from the cached compact snapshot (`scheduler::cached_compact()`) on SSE connect and letting the normal interval do the first live refresh, unless fresh data at launch is a product requirement.
- Verified: yes for the eager calls and wiring. The *magnitude* of the cold-start spike is not verified — see "Verified vs unverified".

### M2. Large scans allocate several full copies of the row data and per-row `String`s

- Files: `server-rs/src/engine.rs:273-284` (clones each file's `rows`), `server-rs/src/store.rs:86-105` (`unpack` builds a `Record` with up to five owned `String`s per row), `server-rs/src/store.rs:78-81` (`format!("{}\0{}", …)` per row in `pack`), `server-rs/src/engine.rs:384-385` (`hour` and `bucket_key` `format!` per row), `server-rs/src/engine.rs:354-355` (`counted: HashSet<u64>`, `buckets: HashMap<String, Acc>`).
- What is wrong: for a large corpus, a single `summary()` holds the cached packed rows in `inner.cache`, a second full copy in `scanned` (`rows.clone()` at `engine.rs:283`), plus transient `Record` objects and formatted keys for every row in the 100-day horizon. `day_slots` caches day strings (`engine.rs:326-333`) but `hour` is re-formatted per row when `hourly` is set.
- Why it matters: these allocations are transient (freed when the request ends), so this is not a leak, but peak memory during a scan can be several times the on-disk cache size. With the stated "large synthetic transcript corpus" this can breach the 60 MB idle/loaded RSS budget and cause allocator churn. It also compounds H1 (a bigger interner makes every `unpack` series of `to_string()` calls larger).
- Suggested fix: aggregate directly from the packed `Vec<f64>` without constructing a full `Record` per row — resolve `strings.get(id)` only when a bucket key is first created (the per-bucket `Acc` already stores provider/model strings at `engine.rs:386-392`), and intern/cache the `hour` string per `(slot, tz)` alongside `day_slots`. Avoid cloning `entry.rows` for non-`shared_sessions` readers (`engine.rs:283`): iterate a slice instead of owning a copy; only the `shared_sessions` filter needs a fresh `Vec`.
- Verified: yes — all listed allocations are in the read code. The actual peak RSS is not verified (measurement needed).

## Severity: Low

### L1. Windows fullscreen watcher is an always-on 2 s poll while the widget window exists

- File: `src-tauri/src/windows.rs:169-217` (loop at `:188`, `std::thread::sleep(Duration::from_secs(2))` at `:214`).
- What is wrong: the watcher thread is started with the widget window (`main.rs` → `windows.rs::start_fullscreen_watch`), and its loop exits only on shutdown or widget-window *destruction* (`:189-195`). The widget window is created at startup and normally just hidden/shown, so this thread wakes every 2 s for the entire session, including while the widget is hidden. Its own comment (`windows.rs:170-172`) claims no unbounded polling, but "only while the widget window exists" is effectively "always" in normal use.
- Why it matters: a small but constant CPU wake-up and two Win32 calls every 2 s; it is the one exception to the otherwise clean idle story. Not a leak — the flag is cleared on `WindowEvent::Destroyed` (`windows.rs:160-164`).
- Suggested fix: skip the work when the widget window is not visible (`widget.is_visible()`), and/or replace polling with a foreground-window-change listener. At minimum, document the 2 s wake in `docs/PERFORMANCE.md`.
- Verified: yes.

### L2. `store::load` holds the whole cache file in memory and then copies every row

- File: `server-rs/src/store.rs:142-166` (`fs::read` at `:143`, `rows: Vec<f64>` collected at `:159`).
- What is wrong: `buf` (raw file bytes) and the parsed `Vec<f64>` rows coexist, so peak memory during load is roughly 2× the file size plus interner strings. This runs in `Engine::new` at startup (`engine.rs:136`).
- Why it matters: a large scan cache produces a startup RSS spike on top of M1. It is a one-time cost (the cache stays resident afterwards), so impact is bounded to launch.
- Suggested fix: parse directly out of `buf` and drop it incrementally per file (the rows are little-endian f64, so a single copy into `Vec<f64>` is unavoidable without `unsafe`, but `buf` need not outlive the loop), or memory-map the file and let the OS page it. Low priority.
- Verified: yes.

### L3. All seven Inter font subsets are still shipped

- Files: `src/main.tsx:3` (`import "@fontsource-variable/inter"`), `dist/web/.vite/manifest.json:114-121` and `:124-151`.
- What is wrong: the package entry emits 7 woff2 files totalling ~213 KB raw / ~166 KB of subsets most users never use (`docs/PERFORMANCE.md:113-120` flagged this earlier; still open at this commit).
- Why it matters: package/download size, not first-paint JS: each `@font-face` has a `unicode-range`, so a Latin-only client fetches only the latin subset. Not a budget breach.
- Suggested fix: replace the bare import with explicit `@font-face` rules against `inter-latin-wght-normal.woff2` (and optionally `latin-ext`) in `index.css`.
- Verified: manifest + `main.tsx`; actual network fetches are browser/locale-dependent and were not measured.

## Severity: Info

These are verified non-findings / positive confirmations that answer the brief directly.

- **I1 — Bundle is within budget and correctly split.** Measured from `dist/web/.vite/manifest.json` + gzip of the assets: main initial JS = `main` 126.7 KB + `vendor-base-ui` 88.3 KB + `vendor-react` 69.2 KB + `ProviderIcon` 20.2 KB + `utils` 10.6 KB + `vendor-color` 9.3 KB + `preload-helper` 2.6 KB = **~319 KB gzip** (budget 520 KB, `scripts/perf-budget.mjs:28`). Widget initial JS = `widget` 3.0 + `vendor-react` 69.2 + `preload` 2.6 = **~75 KB gzip** (budget 120 KB); widget CSS is absent from its entry graph. CSS total = **~42 KB gzip** (budget 60 KB). The widget entry loads no view chunk and no Base UI chunk (`manifest.json:317-332`), so the previously reported widget-bundle regression is fixed. `vite.config.ts:9-26` deliberately assigns only vendor chunks; `manualChunks` does not force unused modules into a chunk.
- **I2 — `lucide-react` is not a bloat source.** It is intentionally unassigned in `manualChunks` (`vite.config.ts:21-22`) and tree-shakes: counting `viewBox` occurrences per emitted chunk gives 3 in `main`, 9 in `ProviderIcon`, 2 in `InsightsView`, 2 in `ThemeEditorPanel`, 1 in the widget ring layout. There is no whole-icon-library payload.
- **I3 — `culori` is isolated and eagerly loaded for a real reason.** Only `src/themePalette.ts:11-12` imports it (`culori/css`, `culori/fn`); `src/appearance.ts:13` imports that module and `src/main.tsx:14` calls `startClientAppearance()` before the first React render to apply the palette. The `vendor-color` chunk is 9.3 KB gzip — too small to justify lazy loading, and deferring it would cause a palette flash.
- **I4 — View lazy-loading is in place.** `src/views/registry.ts:3` still uses `import.meta.glob(..., { eager: true })`, but each view host loads its heavy page via `lazy()` (`src/views/settings.tsx:9`, `src/views/providers.tsx:8`, `src/views/insights.tsx:8`), and the manifest shows `SettingsPage`, `ProvidersPage`, `InsightsView`, `ThemeEditorPanel`, `ThemeImportDialog`, `DefinitionEditor` as `isDynamicEntry: true`. The `docs/PERFORMANCE.md:94-103` recommendation is effectively addressed. Base UI is imported only through subpaths (e.g. `src/components/ui/dialog.tsx:1`), so finding #4 there is also addressed.
- **I5 — No idle polling in the frontend.** Every timer/stream found and its gating: `src/state/usage.ts:375-382` interval only when `active` (App passes `view === "usage"` at `src/App.tsx:141`); `src/state/usage.ts:280-315` minute ticker only when enabled + `document.visibilityState === "visible"`, cleared on hide/unmount; `src/alerts/stream.ts:41-131` EventSource only when `enabled && !hidden`, bounded exponential backoff, `dispose()` clears retry and closes; `src/settings/store.ts:336-366` singleton SSE closes on hide with capped backoff; `src/widget/useStatus.ts:47-131` closes on hide and in the effect return; `src/overlays/alerts.tsx:43-57` calls `stream.dispose()` on unmount; `src/components/providers/ClaudeSignInDialog.tsx:185-239` 1 s poll only while open and in a non-terminal phase; `src/appearance.ts:27` and `src/App.tsx:20` `requestAnimationFrame` are one-shot; `ThemeEditorPanel.tsx:690-747` rAF/MutationObserver work is event-driven and cleaned up. Fetch hooks abort in cleanup (`src/insights/panels/history.tsx:97-124`, `src/insights/today/useTodayUsage.ts:26-51`, `src/hooks/…` via `useLoad` in `src/api.ts:86-105`).
- **I6 — No render loop like the one fixed in 4e9560c remains.** The memoisation is present at `src/components/usage/UsagePage.tsx:207`; `useUsage`'s render-time `setLastAnswered` guard (`src/state/usage.ts:201-218`) compares against `input` which comes from `windowSelection` state (`UsagePage.tsx:189-217`), so it converges. Static search found no `requestAnimationFrame` loop in `src/views/`, `src/components/usage/` or `src/App.tsx`.
- **I7 — Rust idle behaviour is a condvar park, not a poll.** `server-rs/src/scheduler.rs:136-151` parks on `hub::wait_for_activity` with `IDLE_WAIT = 3600 s` (`:20`) when no consumer is active; `server-rs/src/hub.rs:64-89` implements this with `Condvar::wait_timeout`, and publish/subscribe/unsubscribe call `wake()` (`hub.rs:46-52, 78-82, 92-123`). The `/api/stream` heartbeat is 25 s but only while a client is connected (`server-rs/src/routes/status_api.rs:12, 63-79`). `src-tauri/src/stream.rs:99-125` blocks on a socket read; it sleeps with backoff only after a disconnect (`:75-97`). The 500 ms loop in `server-rs/src/accounts.rs:497-540` and 1 s frontend poll above exist only for an active Claude sign-in flow and terminate on completion/timeout (300 s).
- **I8 — History store is bounded and stateless.** `server-rs/src/history.rs:518-553` reloads from disk per call, sweeps expired samples, and `sweep()` (`:403-413`) drops both old samples and orphaned account/window interns before rewriting. Responses are capped by `MAX_POINTS = 500` downsampling (`:37`, `:453-473`). No cross-call Vec/HashMap accumulation. (The unbounded structure is the *usage-scan* interner in H1, not this store.)
- **I9 — Release profiles are present and sane.** `server-rs/Cargo.toml:28-33`: `opt-level = 3`, `lto = true`, `codegen-units = 1`, `panic = "abort"`, `strip = true`. `src-tauri/Cargo.toml:36-41`: same except `opt-level = "s"` (size). Both are release-appropriate; no missing settings. `docs/PERFORMANCE.md:132-149` has further optional size notes (`rusqlite/bundled`, `serde_json/preserve_order`, zstd features) but those are recommendations, not defects. No release binary was present to measure.
- **I10 — Stream/AbortController cleanup on view changes is correct.** All event sources and fetch controllers in `src/views/`, `src/api.ts`, `src/widget/` and `src/hooks/` have matching cleanup returns; no leaked stream tied to navigation was found. The two module-level SSE subscribers (`src/settings/store.ts` and the shell) are app-lifetime singletons with explicit `stopSettingsSync()`/`shutdown` paths, not per-view.

## Measurements to run (not run in this read-only review)

- Confirm H1/M2 with the corpus that triggered the review: record `Get-Process -Id <pid> -WorkingSet64` and the size of `data/usage-scan-cache.bin` before and after several scans that rotate the transcript set, and watch for monotonic growth. The existing gate is `node scripts/perf-budget.mjs --server-exe <path>` (measures idle + loaded RSS, `scripts/perf-budget.mjs:374-425`).
- Confirm M1 by comparing `scanDurationMs` in the `/api/usage` response (`server-rs/src/engine.rs:479`) on a cold cache at launch vs. on first view open, and by sampling CPU for the first 20 s after launch with the widget hidden. `docs/PERFORMANCE.md:44-53` documents the RSS recipe.
- Confirm L1 with an ETW/WPA or Task Manager CPU trace over 60 s idle on Windows and check for the 2 s `burnrate-fullscreen` wake-ups.
- Release binary size: build with `cargo build --release --manifest-path server-rs/Cargo.toml` and run `node scripts/perf-budget.mjs` (it reports the soft 25 MB target at `scripts/perf-budget.mjs:38, 285-292`). Static serving is uncompressed (`server-rs/src/lib.rs:47-60`), which is fine for loopback.

## Verified vs unverified

Verified by reading code (and reading `dist/web` + manifest for bundle numbers):
- H1 — no interner pruning anywhere; `Interner` has no removal API and `store::save` writes all strings.
- M1 — eager `engine.summary` call at `lib.rs:374-381` and startup SSE subscription at `main.rs:126` → immediate scheduler refresh.
- M2 — all listed row-copy and per-row `String` allocations present in `engine.rs`/`store.rs`.
- L1 — 2 s loop with only shutdown/destroy exit conditions in `windows.rs:188-215`.
- L2 — `fs::read` + `collect()` duplication in `store.rs:142-166`.
- L3 — `main.tsx:3` bare font import and 7 woff2 assets in the manifest.
- I1–I10 — bundle sizes/gzip and manifest graph, timer/stream gating, cleanup returns, history sweep, Cargo profiles, and the intact 4e9560c memoisation were all read directly.

Suspicions / not verified (need runtime measurement):
- The **magnitude** of the M1 cold-start CPU/RSS spike and the M2 peak RSS — code proves the work happens; only a release binary + the large corpus can quantify whether the 60 MB gate is breached.
- Whether H1's growth is observable in a realistic session length — depends on how many unique session ids the synthetic corpus rotates; growth itself is proven, rate is not.
- L1's actual CPU cost — two Win32 calls every 2 s are cheap; no profile was taken.
- L3's network impact — depends on the browser locale and `unicode-range` matching; no network trace was taken.
- No release binary exists in the worktree, so binary-size contributors (I9) are code-read only; `cargo bloat --release` was not run.
