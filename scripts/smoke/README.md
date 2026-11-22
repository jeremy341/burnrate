# Smoke tests

Two dependency-free Node 24 scripts that exercise the **built** app, not the dev server:

| Script | What it proves |
| --- | --- |
| `smoke.mjs` | The real UI loads in headless Edge/Chrome, Usage (Cost/Tokens/Limits), Providers and Settings render, screenshots are written, and there are no console errors, page exceptions or HTTP 5xx responses. |
| `api.mjs` | Every endpoint documented in `docs/CONTRACTS.md` answers with the documented status code and shape. |

No Playwright, Puppeteer, npm packages or global installs: the scripts use Node's `fetch`,
`WebSocket` and `AbortSignal.timeout`, plus the Chrome DevTools Protocol.

## Prerequisites

1. **Node 24+** (the repo already requires it).
2. **A built web bundle**: `corepack pnpm build` writes `dist/web` (the server serves it via
   `BURNRATE_WEB`). Required by `smoke.mjs`; `api.mjs` only needs the server (it still passes a
   web directory to the server, normally `dist/web`).
3. **A built server**: `cargo build --manifest-path server-rs/Cargo.toml` (debug) or use the
   integrator's release binary. The script looks in this order:
   - `--exe FILE`
   - `BURNRATE_SERVER_EXE`
   - `$CARGO_TARGET_DIR/{release,debug}/burnrate-server[.exe]`
   - `server-rs/target/{release,debug}/burnrate-server[.exe]`
   - `target/{release,debug}/burnrate-server[.exe]`

   The scripts never build anything (and never run `cargo build --release`: that belongs to the
   integrator).
4. **Edge or Chrome** (Chromium family). `SMOKE_BROWSER=/path/to/browser` overrides auto-detection.
   On Windows the usual Edge and Chrome install locations are checked; on Linux CI, install
   `chromium` or set `SMOKE_BROWSER`.

## Browser smoke

```powershell
node scripts/smoke/smoke.mjs --out scripts/smoke/.out
```

What happens:

1. Starts `burnrate-server` on **port 13850** with a throwaway `BURNRATE_DATA`, a throwaway HOME
   (`USERPROFILE`/`HOME`/`APPDATA`/`XDG_*`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME` are redirected), and
   `BURNRATE_WEB` pointing at the build. **No real Claude/Codex/OpenCode login is read or
   refreshed, and no provider key is used.**
2. Launches headless Edge/Chrome with `--remote-debugging-port=0` and a temporary profile.
3. Navigates to `http://127.0.0.1:13850/` and drives the app:
   - Usage opens; the Cost/Tokens/Limits toggle exists; each tab is selected.
   - Providers and Settings are reached through the "Usage" breadcrumb menu (the screen switcher) and left with Esc.
   - Providers opens and lists at least one provider.
   - Settings opens and shows at least one section.
   - Each view is left with Esc (or the header Close button), back to Usage.
4. Writes screenshots to `--out` (default `scripts/smoke/.out`, git-ignored):
   `01-usage-cost.png`, `02-usage-tokens.png`, `03-usage-limits.png`, `04-providers.png`,
   `05-settings.png` (plus `failed-<step>.png` on a failure), and
   `report.json` with steps, errors, HTTP failures and the server log tail.
5. Fails on: a failed step, a console error, a page exception, a browser dialog, or an HTTP 5xx
   response from `/api/*`. HTTP 4xx responses are printed as warnings and usually also appear as
   console errors. `favicon.*` and the known `ResizeObserver` warnings are ignored.
6. Stops only the processes it started, by PID (`taskkill /PID ... /T /F` on Windows; process-group
   `SIGTERM`/`SIGKILL` elsewhere) and removes the temporary data/home/profile directory.

Options: `--out DIR`, `--port N`, `--exe FILE`, `--web DIR`, `--browser FILE`, `--timeout MS`,
`--headed` (visible window for debugging), `--keep` (keep the temp data/home/profile and print its
path), `--help`.

Exit codes: `0` pass, `1` the app failed a check, `2` setup problem (no build, no browser, port in
use, server exited).

## API contract check

```powershell
node scripts/smoke/api.mjs                 # starts its own server on 13850
node scripts/smoke/api.mjs --base http://127.0.0.1:13790
```

It starts the server exactly like the browser smoke (throwaway data/home), then checks the
documented endpoints. Mutations only touch the throwaway `BURNRATE_DATA`.

`--base` checks an already running server and leaves it running, but it still creates and deletes a
throwaway key, budget, secret, user definition and toggles settings, so point it only at a
disposable instance.

| Method + path | Expected |
| --- | --- |
| `GET /api/settings` | `200`, `AppSettings` v2, `usage.*` maps and the legacy `usagePriceOverrides`/`usageModelAliases` mirrors equal them |
| `PATCH /api/settings` | `200`, deep merge (sibling fields survive) |
| `PATCH /api/settings` bad field | `400 {"error":"invalid settings","field":"appearance.radius"}` |
| `PATCH /api/settings` > 1 MiB | `400`/`413` |
| `PATCH` without `X-Burnrate` | `403` |
| `POST /api/settings/export` | `200 {app:"burnrate",schemaVersion:2,exportedAt,settings}` and no key/token |
| `POST /api/settings/import` | `200` new settings (`merge`) |
| `POST /api/settings/reset` | `200` defaults (`scope:"all"` and `scope:"section"`) |
| `PATCH /api/settings` legacy `{usagePriceOverrides}` | `200`; the nested map and the legacy mirror both update |
| `GET /api/status` | `200` compact status (`checkedAt`, `hostLabel`, `accounts[]`, `notices`, optional `worst`) |
| `GET /api/providers` | `200` `ProviderInfo[]` |
| `POST/PATCH/DELETE /api/providers/<id>/keys[/<name>]` | a throwaway key is added, renamed and removed; no provider is called |
| `GET /api/limits` | `200` `{createdAt, accounts, notices}` |
| `GET /api/usage?since&until&tz` | `200` `UsageSummary` (`contractVersion`, `buckets`, `sources`, `pricing`) |
| `GET /api/defs` | `200` definitions with `id`, `status` (`stable\|experimental\|disabled`), `source` (`builtin\|user`) |
| `GET /api/defs/catalog` | `200` catalog entries with `id`, `label`, `hasDefinition` |
| `POST /api/defs/validate` | `200 {ok, errors[]}` (valid TOML ok, incomplete TOML not ok) |
| `POST /api/defs/test` | `200`/`400` JSON; a missing key fails before any probe |
| `PUT /api/defs/user/smoke-test`, `DELETE` | save + list as `source:"user"`, then remove |
| `GET /api/budgets` | `200 Budget[]` |
| `PUT/GET/DELETE /api/budgets/smoke-budget` | round-trip, `resetDay` 1..28 |
| `PUT/GET/DELETE /api/secrets/alerts/smoke-token` | `GET` returns `[{name,set:true}]`, never the value |
| `GET /api/history` | `200 {series:[{accountId,windowId,points:[[tsMs,usedPercent]]}]}`, at most 500 points per series |
| `DELETE /api/history` | clears the store |
| `GET /api/alerts/state` | `200` snooze state + optional events |
| `POST /api/alerts/test` | `200`/`202`/`204` |
| `POST/DELETE /api/alerts/snooze` | snooze is set, then cleared |
| `GET /api/alerts/recent` | `200` `AlertEvent[]` (or an events envelope) |
| `POST /api/ingest/claude-statusline` | `200` JSON for the documented statusline body |
| `GET /api/stream` | `200` `text/event-stream` |
| `GET /api/themes/openvsx/search` | `403 {"error":"disabled"}` by default (or `200` when the opt-in is on) |
| `GET /api/themes/openvsx/download` | `403 {"error":"disabled"}` by default (or `400`/`404` for the unknown smoke id when on) |
| `GET /api/diagnostics` | `200` documented diagnostics fields |
| `GET /api/update-check` | `200` `{current,latest,url,newer}` when enabled, `403`/`404` when disabled (default) |
| `POST /api/diagnostics/open-data-dir` | **skipped by default** because it opens the OS file manager; pass `--open-data-dir` to check it |

`--json` prints a machine-readable summary; `--keep` keeps the temp data/home directory; `--base`
checks an already running server and leaves it running.

Exit codes: `0` pass, `1` one or more checks failed, `2` setup problem.

### Deliberately tolerant shapes

`docs/CONTRACTS.md` pins the payloads for settings, status, budgets and history exactly, but it does
not pin the envelopes for:

- `GET /api/defs`: accepted as `[...]` or `{definitions|defs|items: [...]}`.
- `GET /api/defs/catalog`: accepted as `[...]` or `{catalog: [...]}`.
- `GET /api/alerts/state`: accepted with `snoozedUntil` and/or an events field; the event shape
  itself is strict.
- `GET /api/alerts/recent`: accepted as `[...]` or `{events|recent|alerts: [...]}`.
- `PATCH /api/settings`: a full settings document or `{ok:true}`; when the body is not a document the
  script reads the result back with `GET /api/settings`.

Everything else is validated field by field with path-qualified errors such as
`accounts[0].windows[1].usedPercent: expected <= 100, got 120`.

## Scripts to add in `package.json`

`package.json` is integrator-owned, so this package does not edit it. Suggested entries:

```json
{
  "scripts": {
    "smoke": "node scripts/smoke/smoke.mjs",
    "smoke:api": "node scripts/smoke/api.mjs"
  }
}
```

## Troubleshooting

- **"Port 13850 is already answering"** — another Burnrate or a previous run owns the port. Stop it
  or pass `--port 13851`. The scripts never kill a process they did not start.
- **"No server binary found"** — build the server or pass `--exe`; the scripts do not build.
- **"No dist/web build found"** — run `corepack pnpm build` (and do not point `BURNRATE_WEB` at a
  dev server).
- **"No Edge/Chrome found"** — install one or set `SMOKE_BROWSER`.
- **Screenshots are blank / steps time out** — run with `--headed --keep`, inspect the visible
  window and the reported temp data directory, then re-run.
- **Linux containers** — Chromium may need `--no-sandbox`; the launch adds it automatically when
  running as root.
