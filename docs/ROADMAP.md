# Burnrate roadmap (draft for approval, 2026-11-20)

Merged from `docs/research/01..05`. Goal: the best, lightest usage tracker for coding agents on Windows and Linux.

## Decisions already made
- Open VSX theme search: yes. The T3 "test" palette ships as a built-in dark theme. Radius and density controls: yes.
- Themes and settings persist on the server. Notifications are in scope, off by default.
- Universal providers (custom, no-code), keys with budgets, a full desktop app.

## Architecture
One Rust process on the Tauri 2 runtime (replaces the PowerShell/Edge launcher).
- The existing `tiny_http` server runs as a thread. Host/Origin checks stay; no Tauri IPC.
- The main window is created on demand and destroyed on close, so idle cost is the server thread only.
- `burnrate-cli` is a separate tiny binary (`status`, `statusline`, `--json`) that needs no GTK or WebView.

## Lightweight budget (to be enforced in CI)
- Idle with no window open: server thread only, target < 40 MB RSS, ~0% CPU. (Today ~125 MB with a warm cache.)
- Release profile: `lto = "fat"`, `codegen-units = 1`, `strip`, `panic = "abort"`, `opt-level = "s"` where it does not cost speed.
- No polling while nothing is visible; back off on battery and when idle; scan transcripts incrementally and lazily; cap caches.
- Web bundle: split Usage / Settings chunks (the main bundle is 683 kB today).

## Phases
| # | Phase | Contents | Effort |
|---|---|---|---|
| 0 | Prototypes | Linux webview RAM; Windows toast with AUMID; tray on GNOME 50; server embedded in Tauri; signing path | 1 wk |
| 1 | Foundation | Rust settings store rewrite (all keys, versioning, 1 MB body cap, atomic writes); Settings page; theme manager port (MVP first); safe-mode; UI parity fixes (modal enter/exit animation, Limits loading/error/stale states, keep views mounted, refresh-on-enter with 5 min throttle, minute ticker, remove T3 wording, locale) | 2–3 wk |
| 2 | Provider engine | Declarative provider definitions (TOML + JSONPath), built-ins re-expressed in it; `balances` and `spend` data model; keys with budgets; host-bound keys and SSRF limits; ~10 definitions first (OpenRouter, DeepSeek, Moonshot, xAI, Z.ai, Kimi Code, Copilot, Ollama, OpenAI/Anthropic admin, Gemini via local logs); log adapters with Linux paths; WSL account discovery; provenance labels (official / estimated) | 4–6 wk |
| 3 | Desktop shell | Tauri host, tray (dynamic % icon), autostart, single-instance, deep links, installers (NSIS + winget, AppImage + deb), checksums/signing | 2–3 wk |
| 4 | Notifications | Master switch off by default; thresholds, EWMA burn-rate "runs out before reset", reset and expired-login notices, quiet hours, snooze, test button, ntfy/Discord/webhook | 2 wk |
| 5 | Integrations | `burnrate status`/`statusline`, Claude Code statusline `rate_limits` ingestion, loopback JSON API, Waybar/GNOME/KDE snippets | 1–2 wk |
| 6 | Extras | History store + sparklines, Today summary, forecast, per-project/model breakdown (needs `cwd` in readers), CSV/JSON export, command palette, onboarding, diagnostics/about, update check | 3–4 wk |

Total ~17–24 weeks of one developer; agents parallelise the independent phases (1, 2, 3 can overlap after Phase 0).

## Open decisions for you
1. **Claude token reading.** Anthropic's legal page restricts "collecting/storing/intermediating" Claude.ai credentials. Burnrate (like T3) calls the usage endpoint with the CLI's token. Recommendation: keep it as an opt-in "Claude OAuth probe" with a provenance label, and make the Claude Code statusline `rate_limits` path plus local transcripts the default. Never refresh another app's tokens.
2. **Name.** A macOS app called "BurnRate" was retired in May 2026. Do a trademark/search check before a public release.
3. **Signing.** Start unsigned with checksums (SmartScreen warning) or invest in signing before the first public release?
4. **Commit the first batch.** Nothing from the first batch is committed yet.
