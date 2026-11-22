# Burnrate flow redesign: shared brief

Read this first. Every agent in this round gets the same brief, then its own area (see the task message).

## What the user said (verbatim, after installing the desktop app)
"isnt styled correctly like stuff, its weird. also how come it didnt get opencode go connected, like for example in t3 code i could easily just press login and stuff. also it shouldnt do it auto going [the onboarding popup]. this looks horrendous: not everything needs to be admin keys. settings is buggy, graphs dont show. like bro pls go over the full UI and also change the whole flow, our app is entirely flawed."

## What exists
Burnrate = local usage tracker for AI coding agents. Rust server `server-rs/` (tiny_http, loopback), React 19 + Vite + Tailwind 4 + Base UI in `src/` cloned 1:1 from T3 Code's Usage window (T3 source, READ ONLY: `C:\Users\jerem\Documents\GITHUB\burnrate\app\apps\web\src`), Tauri 2 desktop shell `src-tauri/`, CLI `cli/`. Read `docs/CONTRACTS.md`, `DESIGN.md`, `docs/DESKTOP.md`, and the earlier review reports `docs/reviews/*.md` (fix anything still open in your area).

## The new flow (decided by the product owner, implement it)
1. The app opens straight on **Usage -> Limits**. **No automatic popups or wizards on first run.** If nothing is connected, the Usage view shows a calm empty state: the agents detected on this computer with a one-click **Connect** each, plus **Add provider**.
2. Anything with a local login on this machine (Claude Code, Codex/ChatGPT, OpenCode / OpenCode Go, Grok, Antigravity, ...) is **detected and connected automatically**. Where the agent has a CLI login, a **Sign in / Connect** button runs the real CLI login (like T3 Code) and shows progress; if the CLI is missing it says so and links to install help. For key-based plans (OpenCode Go) offer "Open the page to get your key" + paste field + Test key.
3. **Providers** screen: lead with *Agents you use* (login based), then *API keys* (OpenRouter, DeepSeek, Mistral, Moonshot, Ollama, ...), and put organisation/admin keys (Anthropic Admin, OpenAI Admin) and custom definitions in an **Advanced** group, collapsed by default and never shown in onboarding/empty state. Not everything needs an admin key. No native `<select>` elements; no "No accounts yet" noise for providers that simply auto-detect (say "Detected on this computer").
4. **Graphs show real data immediately**: Cost/Tokens charts render from local transcripts as soon as the first scan finishes (cached last result shown at once, honest progress such as "Scanning 1,240 files", never skeletons forever). Claude's usage endpoint returning HTTP 429 must not blank the Claude section: keep and show the last good values marked stale.
5. **Default theme is dark** (the T3-style `burnrate-dark` palette, page `#181818`); the Windows window chrome (title bar) matches the app theme with no white flash.
6. **Settings are bug-free**: every control persists, applies live, resets, and works with keyboard.

## Contract between the providers backend and frontend agents
`GET /api/providers` entries gain: `category: "agent" | "apiKey" | "admin" | "localLogs"`; `login: null | { kind: "cli"; command: string; installed: boolean; installUrl: string }`; `keyUrl?: string` (where the user creates a key, e.g. `https://opencode.ai/auth`); `hint?: string` (one line, e.g. "Detected on this computer"). Generic login flow: `POST /api/accounts/<providerId>/login/start` body `{name?}` -> `{flowId}`; `GET /api/accounts/flows/<flowId>` -> `{state: "starting"|"waitingForBrowser"|"connected"|"failed"|"cancelled", url?, error?}`; `POST /api/accounts/flows/<flowId>/code` body `{code}`; `DELETE /api/accounts/flows/<flowId>`. Error codes: `cli-not-found` (400), `already-connected`, `invalid-name`, `already-running`, `too-many-flows`. The existing `/api/accounts/claude/*` routes keep working. The frontend must degrade gracefully when a field is missing (fallback to the provider id lists).

## T3 UI rulebook (mandatory)
Read `docs/T3-UI-RULES.md` BEFORE any UI work (in your worktree if it exists there; otherwise read it at its absolute path in the main checkout, read-only: `C:\Users\jerem\Documents\GITHUB\burnrate-app\docs\T3-UI-RULES.md`). It collects T3's own rules: primitives law, styling law, tokens and spacing, layout patterns, copy, motion, React, performance, proof. Violating it is a defect: check your diff against sections 2 (primitives), 3 (styling), 5 (layout) and 7 (copy) before you commit, and list in your summary which rules applied.

## Rules
- You work in your own git worktree/branch, a fresh checkout of the latest commit. Edit ONLY files in your ownership list (task message). Other agents work in parallel on the other areas. If you need a change elsewhere, write `NEEDS_FROM_OTHER: ...` in your summary. Commit on your branch (message `<area>: ...`); do not push, merge or rebase; never touch the main checkout or other worktrees.
- Never read or print secrets/tokens or contents of `~/.claude*`, `~/.codex`, key files. (The product itself reads local transcripts: you may run the server against the real home for measurements, but never print their contents.)
- Servers you start: your own port range and a temp `BURNRATE_DATA`; stop only your own PID; never kill by image name (the user's real Burnrate may be running on 13790). Cargo: `CARGO_TARGET_DIR=<temp>/burnrate-target-<area>` (`$env:TEMP` on Windows, `$TMPDIR` elsewhere). Do not run installers; never register autostart/protocol/AUMID for real names.
- No new dependencies without need (state `NEEDS_DEPS`). Keep it lightweight (nothing polls while hidden). `src/index.css` stays identical to T3's (`node scripts/sync-t3.mjs check --strict`).
- UI strings go through `useGT()`/`msg`. Accessible: labels, focus rings, `aria-live` for async results, `prefers-reduced-motion`.

## Skills
You have the Skill tool. Before any UI work load and apply: `impeccable`, `critique`, `frontend-design`, `design:ux-copy`, `web-design-guidelines`, `accessibility`. For bugs `systematic-debugging`; for logic `tdd`.

## Verify for real, not just with unit tests
Run the built app in headless Edge via CDP (harnesses: `scripts/smoke/smoke.mjs`, `scripts/smoke/cdp.mjs`): `corepack pnpm install --frozen-lockfile`, `corepack pnpm build`, run the server exe `<temp>/burnrate-target-integ/debug/burnrate-server.exe` (rebuild into YOUR target dir if you change Rust) with `BURNRATE_WEB=<your worktree>/dist/web`. Take screenshots in dark AND light, at 1100x860 and 480x900, READ the PNGs with the Read tool and fix what looks wrong. Test BOTH a brand-new user (temp `USERPROFILE`/`HOME` + temp `BURNRATE_DATA`) and the real home. Run `corepack pnpm typecheck`, `corepack pnpm test`, `cargo test --manifest-path server-rs/Cargo.toml`.

## Done means
The behaviour above works in screenshots you inspected, tests added/updated, everything committed. Final reply: what you changed (files), how you verified (which screenshots), what is still open, `NEEDS_DEPS` / `NEEDS_FROM_OTHER`.
