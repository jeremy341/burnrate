# Burnrate contracts (read this before touching anything)

Every work package codes against this file. If something here is wrong or missing, say so in your final summary
(`CONTRACT_ISSUE: ...`); do not silently invent a different shape. Skeleton: `docs/work/PACKAGES.md` lists who owns which files.

## 0. Rules for every package
- You work in your own git worktree/branch. Edit ONLY files matching your package's globs in `docs/work/ownership.json`.
  Run `node scripts/check-ownership.mjs <package-id>` before finishing; it must pass.
- Never change dependency lists (`package.json`, `Cargo.toml`, lockfiles). If you need a crate/npm package that is not
  there, finish without it and write `NEEDS_DEPS: name@version why` in your summary.
- `src/index.css` must stay byte-identical to T3's (`node scripts/sync-t3.mjs check --strict`). Burnrate-only CSS lives in
  `src/appearance.css` and `src/a11y.css`.
- Build/test: web `corepack pnpm install --frozen-lockfile` (first, in your worktree), `corepack pnpm typecheck`, `corepack pnpm test`.
  Rust: `CARGO_TARGET_DIR=<temp>/burnrate-target cargo check|test --manifest-path server-rs/Cargo.toml`.
  Never `cargo build --release` (only the integrator does), never touch `server-rs/target`.
- Never use real API keys or real accounts. Never read or print anything from `C:\Users\<user>\.claude*`, `.codex`, keys or tokens.
  Tests use temp dirs and fixtures. Do not kill processes by image name; if you start a server use your own port
  (13800 + package number) and a temp `BURNRATE_DATA`, and stop only that PID.
- Do not run installers, autostart/registry/protocol-handler/AUMID code for real names. Such code is written behind functions and
  tested only with throwaway names that the test removes in the same run.
- Lightweight: no polling in hidden windows, no unbounded caches, no timers without cleanup, no new heavy dependency, lazy-load big UI.
- UI must be 1:1 with T3's look: reuse `src/components/ui/*` (identical to T3) and T3's class names. UI strings go through `useGT()`/`msg` from `~/i18n`.
- Accessibility: labelled controls, visible focus, `aria-live` for async results, `prefers-reduced-motion` respected.
- Keep Windows and Linux paths working (`std::path`, no hard-coded backslashes). Code that can only be verified on Linux/Wayland is
  written behind `cfg(...)` and marked `// UNVERIFIED on Linux` in a comment.
- Finish with a summary: files changed, endpoints/exports added, tests added (and result), `NEEDS_DEPS`, `CONTRACT_ISSUE`, anything skipped.

## 1. Provenance and data shapes (already in `src/contracts.ts`)
`UsageWindow` (percent windows) gained `provenance?: Provenance`; `UsageLimits.balances?: UsageBalance[]` carries money-shaped data
(balance, spend, key cap; major units). `Provenance = "official" | "unofficial" | "statusline" | "local" | "estimated"`.
`LimitsAccount.limits.unavailable` stays for failures (never hide a failed account).

## 2. Settings (`/api/settings`)
Schema: `src/settings/schema.ts` (`AppSettings` v2, `DEFAULT_SETTINGS`). Server persists `data/settings.json`.
- `GET /api/settings` -> full merged `AppSettings` (defaults filled) plus legacy top-level mirrors `usagePriceOverrides`, `usageModelAliases`
  (kept until the UI migrates; they equal `usage.usagePriceOverrides` / `usage.usageModelAliases`).
- `PATCH /api/settings` body `{ "patch": SettingsPatch }`: deep merge (objects merge, arrays and scalars replace, `null` on a map entry deletes it).
  Validate every field against the schema table in Rust (types, ranges, enums, string lengths, id patterns); reject the whole patch with
  `400 {"error":"invalid settings","field":"appearance.radius"}` on the first bad field. Body cap 1 MiB (theme CSS is up to 100 000 chars).
  Legacy patches `{ usagePriceOverrides, usageModelAliases }` stay accepted.
- `POST /api/settings/export` -> `{ "app":"burnrate","schemaVersion":2,"exportedAt":..., "settings": AppSettings }` (never contains secrets).
- `POST /api/settings/import` body `{ settings, mode: "merge" | "replace" }` -> validated like PATCH; returns the new settings.
- `POST /api/settings/reset` body `{ scope: "all" | "section", section?: "general"|"appearance"|... }` -> new settings.
- Storage: atomic write (`settings.json.tmp` then rename), keep `settings.json.bak` of the previous version, `schemaVersion` + migration
  from v1 (`{usagePriceOverrides, usageModelAliases}` only). A corrupt file is moved to `settings.json.corrupt-<ts>` and defaults are used.
- Every successful write calls `hub::publish("settings", settings_json)`.
- Client: `src/settings/store.ts` (`useSettings(selector)`, `updateSettings(patch)` optimistic + debounced PATCH, rollback on error,
  write-through `localStorage["burnrate.settings.mirror"]` for first paint). `src/hooks/useSettings.ts` keeps its current exports as a thin adapter.

## 3. Themes
Types and T3's five built-ins: `src/shared/themePalettes.ts` (verbatim from T3: `ThemeDefinition`, `THEME_COLOR_ROLES`, `*_THEME`).
Registry: `src/themes/registry.ts` (`BUILTIN_THEMES`; drop-in presets in `src/themes/presets/*.ts` export `theme: ThemeDefinition`).
Custom themes live in `settings.appearance.customThemes`; the active ids in `appearance.lightThemeId/darkThemeId` (`null` = stock palette;
the default dark id is `burnrate-dark`, the user's "test" palette, see docs/THEME.md). Runtime: `applyThemePalette` sets `data-theme-id` and
`--app-theme-*` inline on `<html>`, exactly as T3 (docs/research/02-t3-themes-settings.md section 2.3). `safeMode` ignores custom themes/CSS.
Theme JSON v1 export format = T3's (`serializeThemeFile`); VS Code theme import via `jsonc-parser`.
Open VSX search is OPT-IN (`advanced.experimental.openVsx`), proxied by `GET /api/themes/openvsx/search?q=` and
`GET /api/themes/openvsx/download?id=` (host allow-list `open-vsx.org`, 5 MiB cap, 10 s timeout, via `net_guard`); the UI states it contacts the internet.
Appearance extras (not in T3): `radius` -> `--radius` rem, `density` -> `html[data-density]`, `uiScale` -> `--burnrate-ui-scale` (CSS `zoom`/rem scale),
`reduceMotion`, `highContrast` -> `html[data-reduce-motion]`, `html[data-high-contrast]`; all CSS in `src/appearance.css`/`src/a11y.css`.

## 4. Provider definitions (declarative, TOML)
Built-in files: `server-rs/defs/<id>.toml` (embedded by `build.rs` into `defs::BUILTIN_DEFS`). User files: `<data>/providers.d/*.toml`
(loaded when `providers.customDefinitions`). Fixtures for tests: `server-rs/defs/fixtures/<id>.json` (a recorded/hand-written response from the
provider's DOCUMENTATION only). Status: `stable` (verified against official docs), `experimental` (unofficial/community endpoint; hidden
unless `advanced.experimental.<id>` is true), `disabled`.

```toml
schema = 1
id = "openrouter"                # [a-z0-9-]{1,40}, unique
label = "OpenRouter"
color = "#6467f2"
status = "stable"                # stable | experimental | disabled
docs = "https://openrouter.ai/docs/api-reference/limits"
auth = "apiKey"                  # apiKey | none   (localLogin providers are native Rust modules, not definitions)
key_hosts = ["openrouter.ai"]    # the key may ONLY be sent to these hosts (exact or subdomain). REQUIRED when auth = "apiKey".
poll_seconds = 300               # min 60
plan = "OpenRouter key"          # optional, shown as account plan

[[request]]                      # 1..4 requests, executed in order; results addressable by id
id = "key"
method = "GET"                   # GET | POST
url = "https://openrouter.ai/api/v1/key"   # https only; host must be within key_hosts
headers = { Authorization = "Bearer {{key}}" }  # {{key}} is the only placeholder; never logged
body = ""                        # optional JSON string for POST
timeout_seconds = 10

[[window]]                       # percent windows (0..n)
id = "key_limit"
kind = "monthly"                 # session | weekly | monthly | other
label = "Key limit"
from = "key"                     # request id
# One of: used_percent | (used + limit) | (remaining + limit)   -> each is a JSONPath (RFC 9535, serde_json_path) or a number literal
used = "$.data.usage"
limit = "$.data.limit"
resets_at = "$.data.limit_reset"          # optional
resets_at_format = "iso8601"              # iso8601 | unix_s | unix_ms | seconds_from_now
window_minutes = 43200                    # optional constant
skip_if_null = ["limit"]                  # window omitted when these paths are null/missing (key without a cap)
provenance = "official"

[[balance]]                      # money-shaped data (0..n)
id = "credits"
label = "Credits"
kind = "credit"                  # credit | spend | cap
from = "key"
amount = "$.data.limit_remaining"
limit = "$.data.limit"           # optional
currency = "USD"                 # literal, or { path = "$.currency" }
provenance = "official"
```
Transforms (closed set, applied as `transform = ["multiply:0.01", "clamp:0:100"]` after extraction): `multiply:n`, `divide:n`, `add:n`, `min:n`, `max:n`,
`clamp:a:b`, `invert` (100 - x), `round:n`. No scripting, no arbitrary code. Result mapping: a definition produces one `LimitsAccount` per saved key
(`id = "<defId>-<keyName>"`, `driver = defId`), `limits.windows`, `limits.balances`; an HTTP/parse failure yields
`limits.unavailable = { reason: "probeFailed", message }` with the key redacted.
Engine rules: HTTPS only, `net_guard::check_url(url, Some(host), false)` before every request, response body cap 256 KiB, redirects to other hosts refused,
per-definition poll interval + 20% jitter, result cache TTL = poll interval, exponential backoff on 429/5xx, never more than one in-flight request per definition.
Keys come from the encrypted key store under provider id = definition id (`KeyStore::list(def_id)`), added through the same `/api/providers/<id>/keys` routes
(`ProviderInfo.auth = "apiKey"`); `GET /api/providers` includes every enabled definition. Management routes (`routes/defs_api.rs`):
`GET /api/defs` (list + status + source builtin|user), `POST /api/defs/validate` body `{toml}` -> `{ok, errors[], preview?}` (parses, lints, never calls the network),
`POST /api/defs/test` body `{id | toml, keyName}` -> runs the requests once with the stored key and returns the mapped account (redacted),
`PUT /api/defs/user/<id>` body `{toml}` (writes `<data>/providers.d/<id>.toml` atomically, id must match), `DELETE /api/defs/user/<id>`.

## 5. Keys with budgets (`routes/budgets_api.rs`, `src/budgets.rs`)
For providers/keys without a usage API: the user sets a monthly budget; spend is measured locally from the engine's records (cost per record, `pricing.rs`).
`GET /api/budgets` -> `Budget[]`; `PUT /api/budgets/<id>` body `Budget`; `DELETE /api/budgets/<id>`.
`Budget = { id, label, monthlyBudget (number, major units), currency, resetDay (1..28), match: { providers?: string[], models?: string[] (prefix), }, color? }`.
Stored in `<data>/budgets.json`. Each budget appears in the limits report as account `budget-<id>` (`driver = "budget"`, `plan = "Budget"`)
with a monthly window `usedPercent = measured / monthlyBudget * 100`, `resetsAt` = next reset day, `provenance = "local"`, plus a `spend` balance.
Engine access: `engine.cost_between(&Matcher, since_ms, until_ms) -> f64` (added by the budgets package in `budgets.rs` using the existing engine API; do not edit engine.rs).

## 6. Secrets (`routes/secrets_api.rs`)
Generic encrypted secret store (same AES-GCM file as keys, scope `secret:<scope>`): `PUT /api/secrets/<scope>/<name>` body `{value}`,
`DELETE ...`, `GET /api/secrets/<scope>` -> `[{name, set:true}]` (values are NEVER returned). Used for notification channel URLs/tokens
(`scope = "alerts"`, names `ntfy`, `discord`, `webhook`). `net_guard::redact(text)` must remove any stored secret value and anything shaped like
`sk-...`, `Bearer <token>`, JWTs and long hex/base64 strings from logs/errors/diagnostics.

## 7. `net_guard` (security, `server-rs/src/net_guard.rs`)
Already stubbed. Final behavior: `check_url(url, bound_host, allow_local)`: parse with `url`, scheme https (or http only to loopback when `allow_local`),
no userinfo, host not an IP literal in private/link-local/metadata ranges (169.254.169.254, fd00::/8 etc.) unless `allow_local`, DNS resolution result also
checked (resolve once, refuse if any address is private) to block DNS rebinding, `bound_host` match = exact or subdomain. Returns the normalised URL.
`redact` as in section 6. Add unit tests for each rule.

## 8. Scheduler, hub, events, status
- `scheduler::start(state)`: a single background thread. It refreshes `limits_report` every `usage.refreshIntervalSec` (min 30) ONLY while at least one
  consumer is active (an SSE client, a recent `/api/limits` request within 3 intervals, or `notifications.enabled` in settings). Idle = it sleeps (park,
  no polling). After each refresh it calls `history::on_snapshot`, `alerts::on_snapshot`, `hub::publish("snapshot", compact_status)`.
  `limits_report` stays the single source; the scheduler caches the last report (`state` cache, TTL = 30 s) so concurrent callers share one probe.
- `GET /api/status` -> compact status (below). `GET /api/stream` -> `text/event-stream` with events `snapshot` (compact status), `alert` (AlertEvent), `settings`;
  heartbeat comment every 25 s; max 8 concurrent streams (429 beyond). `hub` = small broadcast list of `std::sync::mpsc::Sender`, drop dead senders on publish.
- Compact status: `{ checkedAt, hostLabel, accounts: [{ id, provider, label, plan?, windows: [{ id, kind, label, usedPercent, remainingPercent, resetsAt?, windowMinutes?, paceDelta?, state: "ok"|"warn"|"critical"|"unavailable", provenance? }], balances?: [...] , unavailable? }], worst?: { accountId, provider, windowId, label, remainingPercent, resetsAt? }, notices: [] }`.
  `paceDelta` = percent used minus percent of the window elapsed (positive = ahead of pace). `state`: critical when remaining <= 10 or projected to run out before reset;
  warn when remaining <= 25 or paceDelta >= 15.
- Claude Code statusline ingest: `POST /api/ingest/claude-statusline` (loopback, X-Burnrate) body = the statusline JSON Claude Code passes on stdin; the server reads
  `rate_limits.five_hour|seven_day` (`used_percentage`, `resets_at`) and stores them (memory, 15 min TTL) as windows with `provenance="statusline"` for the account
  matching the config dir if known, used when `providers.claudeOAuthProbe` is false or the probe fails.

## 9. History (`src/history.rs`, `routes/history_api.rs`)
Compact append-only sample store `<data>/history.bin` (zstd-compressed day files or a ring; owner decides, must stay under ~5 MB/90 days for 10 accounts):
sample = (ts_minute u32, account hash/id intern, window id intern, usedPercent u16 x100). Sampling: when the value changed by >= 0.5 or every 15 minutes.
Retention `usage.historyDays` (add the field to the schema; default 90). `GET /api/history?since=ISO&until=ISO&account=&window=&step=300` -> `{ series: [{ accountId, windowId, points: [[tsMs, usedPercent], ...] }] }`
(downsampled to at most 500 points per series). `DELETE /api/history` clears it.

## 10. Alerts (`src/alerts/`, `routes/alerts_api.rs`)
Off by default (`notifications.enabled = false`). Pure engine `alerts::evaluate(prev: &AlertState, snapshot: &Value, cfg: &NotificationConfig, now_ms) -> (AlertState, Vec<AlertEvent>)` (unit-testable, no I/O)
and an I/O wrapper `alerts::on_snapshot`. Rules: threshold crossing (80/90/100 default, ascending, one event per threshold per window per reset cycle),
`predictRunout` (EWMA burn rate over the last samples: projected exhaustion before `resetsAt` and at least 10 minutes of data), `notifyOnReset` (usedPercent dropped by >= 50 points or `resetsAt` moved
forward after being >= 80), `notifyOnExpiredLogin` (account `unavailable` with an auth-looking message for >= 2 polls), cooldown (`cooldownMinutes` per window), quiet hours (local time, may wrap midnight),
snooze (`snoozeUntil`), per-provider overrides. `AlertEvent = { id, ts, kind: "threshold"|"runout"|"reset"|"login", accountId, provider, windowId?, title, body, severity: "info"|"warn"|"critical", usedPercent? }`.
Delivery: published on the hub (`alert` event); the browser/shell shows desktop notifications; `alerts/channels.rs` posts to ntfy / Discord webhook / generic webhook using secrets from section 6,
via `net_guard` (https only, 5 s timeout, no retries storm, max 1 per event). Routes: `GET /api/alerts/state` (snooze, last events), `POST /api/alerts/test` (sends a test AlertEvent to enabled channels and the hub),
`POST /api/alerts/snooze` body `{minutes}`, `DELETE /api/alerts/snooze`, `GET /api/alerts/recent`.
Client: overlay `src/overlays/alerts.tsx` listens to `/api/stream`, shows in-app toast and (only if `notifications.desktop` and permission granted) a Web Notification; the desktop shell handles native toasts.

## 11. Desktop shell (`src-tauri/`)
One Rust process on Tauri 2: starts the server in-process (`burnrate_server::run()` in a thread, port from `BURNRATE_PORT` or 13790, falls back to a free port and exposes it to the window),
main window created on demand (loads `http://127.0.0.1:<port>/`) and destroyed on close (`closeToTray`), tray icon with dynamic `%` rendering and a menu (Open, Refresh, Snooze 1h, Quit),
autostart (`launchAtLogin`: Windows `HKCU\...\Run` value named `Burnrate`, Linux `~/.config/autostart/burnrate.desktop`), single-instance (second launch focuses the main window), `burnrate://` deep link, global shortcut,
native toasts (Windows AUMID shortcut created by the installer; Linux libnotify via D-Bus).
It listens to `/api/stream` `alert` events (when `notifications.desktop`). Windows is verified here; Linux code is `cfg`-gated and marked UNVERIFIED.

## 12. CLI (`cli/`, crate `burnrate-cli`, binary `burnrate`)
No GTK/WebView, only `ureq` + `serde_json`. `burnrate status [--json] [--provider ID] [--window session|weekly|monthly] [--port N]` (talks to `http://127.0.0.1:<port>/api/status`, port from `--port`, `BURNRATE_PORT`, or 13790; prints
e.g. `Claude Kernel 27% used - resets 3h57m`, exit code 3 if the server is not reachable), `burnrate statusline` (reads Claude Code statusline JSON on stdin, POSTs it to `/api/ingest/claude-statusline` best-effort in the background with a 300 ms budget,
prints a one-line status from `/api/status` e.g. `5h 47% - 7d 36%`), `burnrate watch` (streams `/api/stream`, redraws one line), `burnrate waybar` (JSON for Waybar `custom` modules: `{text, tooltip, class, percentage}`), `burnrate version`.
Exit codes: 0 ok, 2 bad args, 3 not reachable. Output uses plain ASCII unless `--unicode`. Must start in < 30 ms.

## 13. Providers UX (T3 style)
The Providers view is a compact list, not stacked cards: search box, groups "Connected" and "Available", one row per provider (icon, name, status chip, account count, overflow menu), accounts expand inline.
"Add provider" opens T3's wizard (`AddProviderInstanceDialog` pattern, `ui/wizard.tsx`): step 1 Provider (searchable picker: built-in providers, enabled definitions, the models.dev catalog, "Custom provider"),
step 2 Name and colour, step 3 Authentication (Claude/Codex: browser sign-in; API-key providers: key entry with "Test key"; custom: definition editor with validate/test). Catalog source: `server-rs/defs/catalog.json`
(built from models.dev data by the catalog package; each entry `{id, label, baseUrl?, docs?, envVars?, hasDefinition: bool}`), served by `GET /api/defs/catalog`.

## 14. Accounts, categories and login flows (`routes/accounts_api.rs`, `src/accounts.rs`, `providers/usage_cache.rs`)
**`GET /api/providers`** entries keep `id, label, color, auth, connected, accounts, accountsRenamable` and add:
`category` (`agent | apiKey | admin | localLogs`), `login` (`null` or `{kind: "cli", command, installed, installUrl}`), `keyUrl?` (https page where the key is
created), `hint?` (one line; a connected local login says "Detected on this computer"), `detected` (connected through something found on this computer,
not through a saved key) and `custom?: true` (a user-written definition, meant for "Advanced"). Order is stable: agents, API keys, local logs, admin; inside a group the
order of `providers::all()`. Connected-first sorting is the UI's job. Categories: native Claude Code, Codex, Grok, Cursor = `agent`; Mistral = `apiKey`;
Antigravity, Pi, Muse = `localLogs`; definitions declare `category` in TOML (default `apiKey`; `anthropic-admin`, `openai-admin`, `azure-openai`, `bedrock`,
`vertex` = `admin`; `opencode-go`, `copilot`, `kiro`, `windsurf` = `agent`). Definitions also take an optional `key_url` (https). `GET /api/defs` returns
`status`, `category`, `keyUrl`; `GET /api/defs/catalog` entries with `hasDefinition: true` carry `status` (`stable | experimental | disabled`) and `category`.

**OpenCode appears once**, as `id = "opencode-go"` (label "OpenCode Go", `category: "agent"`, `auth: "apiKey"`, `keyUrl: https://opencode.ai/auth`,
`login: null`). `connected` is true when a Go key is saved through `/api/providers/opencode-go/keys` or OpenCode's own login/data exists on this computer
(`auth.json`, `opencode.db`, `OPENCODE_API_KEY`). The native `opencode` reader is not listed separately (it is only listed when the `opencode-go` definition is
disabled). A key that OpenCode holds and that is also saved under `opencode-go` is read once, so the same quota is never shown twice.

**Generic CLI login.** Providers with `login != null`: `claudeAgent` (`claude auth login`), `codex` (`codex login`, browser; connected when `~/.codex/auth.json` /
`CODEX_HOME` holds `tokens.access_token`), `grok` (`grok login`, connected when `~/.grok/auth.json` holds a credential with a `key`). Cursor (`agent login` is documented at cursor.com/docs/cli/reference/authentication, but Burnrate reads Cursor with an API key, not the CLI's token), Gemini CLI (its
documented sign-in is a first-run prompt inside the app, https://geminicli.com/docs/get-started/authentication, no login command) and OpenCode (`opencode auth login` opens an interactive
provider picker, https://opencode.ai/docs/cli/providers/) return `login: null` plus a `keyUrl`/`hint`. Grok's `grok login` is documented at https://docs.x.ai/build/cli/reference, Codex's `codex login` at https://developers.openai.com/codex/auth.
- `POST /api/accounts/<providerId>/login/start` body `{name?, force?}` -> `{flowId}`. `name` only matters for Claude (a new `~/.claude-<name>` config dir; omitted = `~/.claude`
  when it has no login, else `~/.claude-account-N`); `force: true` re-runs a login that already exists (an expired one) and finishes when the login file changes.
- `GET /api/accounts/flows/<flowId>` -> `{state: starting | waitingForBrowser | connected | failed | cancelled, providerId, url?, error?}`. `url` only ever points at an allowed host for that
  provider (Claude: claude.ai, claude.com, anthropic.com; Codex: openai.com, chatgpt.com; Grok: x.ai, grok.com). A CLI that opens the browser itself and prints no link still reaches
  `waitingForBrowser` after ~4 s (without `url`). `error` is a fixed, user-readable sentence ("codex login stopped before sign-in finished. Try again.", "Sign-in took too long. Start it again."), never CLI output.
- `POST /api/accounts/flows/<flowId>/code` body `{code}` (hands a pasted verification code to the CLI) and `DELETE /api/accounts/flows/<flowId>` (cancel, stops the process tree).
- Errors: `400 cli-not-found` (body also has `installUrl` and `command`), `400 already-connected`, `400 invalid-name`, `400 login-not-supported`, `404 unknown provider | unknown flow`,
  `409 already-running`, `409 flow-ended`, `429 too-many-flows` (4 active flows), `500 sign-in-failed`.
- Safety (shared by every CLI): five minute timeout, process-tree kill on Windows, output capped at 64 KiB and released when the flow ends, config dirs are only removed when this
  flow created them and no credentials exist, host-session variables stripped for Claude, flow ids are 128-bit random. The older `/api/accounts/claude/*` routes
  (`POST` with `{name}`, `GET/POST code/DELETE <flowId>`) keep working and answer `claude-not-found` as before.

**Claude usage under rate limiting** (`providers/usage_cache.rs`). `api/oauth/usage` is probed at most once per account every 5 minutes, shared by every caller (UI, scheduler,
repeated `/api/limits`). The last good windows are kept in memory and in `<data>/claude-usage-cache.json` (percentages and reset times only). On 429, 5xx, network or parse errors the
account keeps those windows with `limits.stale: true`, `limits.staleSince` (ISO time of the last good read), `limits.staleMessage` ("Showing values from 12 minutes ago") and
`limits.staleReason` (a plain sentence such as "Claude is limiting usage checks right now. Burnrate will try again soon.", never a status code); `checkedAt` is the time of the last good read; reset credits are dropped from stale data. Failures back off 5, 10, 20, 30 minutes (capped) and honour
`Retry-After` (numeric seconds). A rejected login (401/403) is never shown as stale: it reports `login-expired:`, and the throttle lifts as soon as the credentials file changes (the user signed in again). With a fresh statusline snapshot, that live data is preferred to stale numbers.

