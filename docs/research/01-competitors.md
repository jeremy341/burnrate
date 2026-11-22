# 01 – Competitive landscape: AI coding agent usage / limit / cost trackers

Research date: 2026-11-20. Author: research sub-agent 1 of 5. Read-only on code; this file is the only output.

**Method and confidence.** Star counts, push dates, licences, release cadence, download counts and issue
reactions come from the GitHub API (`gh api`) on 2026-11-20 and are **verified**. Vendor policy text was
fetched directly from code.claude.com. Feature lists come from each project's README. Product and
pricing claims that came only from secondary blogs or search summaries are marked **(unverified)**. I did
not run any of these tools.

What Burnrate already has (from README/DESIGN.md): Rust server + React UI cloned from T3 Code's Usage
window, limit bars with pace ticks, multi-account pooling in one bar, cost and tokens from local
transcripts (Claude, Codex, OpenCode), LiteLLM prices with overrides, banked reset credits, encrypted API
keys, about 125 MB RSS, dark/light. It does **not** yet appear to have a tray/widget surface, notifications,
a CLI/statusline, or budgets (verify in other reports).

---

## 1. The landscape in six clusters

| Cluster | Representative tools | What they are good at | Weak spot |
|---|---|---|---|
| A. Local-log cost reporters | ccusage, tokscale, splitrail, phuryn/claude-usage | Exact tokens/cost per day/session/model from transcripts, 20+ agents, zero auth | No real quota; "blocks" estimates drift from Anthropic's meter; CLI-first |
| B. macOS menubar limit trackers | CodexBar, OpenUsage (Robin Ebers), Claude-Usage-Tracker, ClaudeBar, opencode-bar, LimitBar | Polished glance UX, many providers, pace, notifications | macOS only; credential/Keychain friction; bloat |
| C. Windows tray ports/clones | **Pane**, **OpenQuota**, AIUsage.NET, 8+ single-purpose Claude tray apps | Fill the Windows gap; fast-moving | Mostly unsigned, young, Claude/Codex-centric; many 0–20 star repos |
| D. Linux shells and extensions | CodexBar (Qt), OpenUsage Community, OpenQuota (AppImage/deb), 5+ GNOME extensions, KDE plasmoid | Panel-native widgets | Fragmented; each covers 1–3 providers; Wayland/tray quirks |
| E. In-agent surfaces | Claude Code statusline (`rate_limits`), ccstatusline, claude-hud, CCometixLine, Gemini `/stats`, Codex `/status`, OpenCode usage plugins, T3 Code Usage→Limits | Zero-install, official data, live per session | Per-agent, no cross-provider or history view |
| F. Gateways / observability | LiteLLM, Helicone, Langfuse, OpenRouter, ccflare, CLIProxyAPI, claude-code-router | Real per-key budgets, enforcement, team features | Need a proxy and often Postgres; wrong tool for subscription quotas on a dev laptop |

Burnrate's niche is the intersection of **B + C + D + A with T3-grade UI**. Nobody ships that on Windows
and Linux today.

---

## 2. Tool profiles (what matters for Burnrate)

Snapshot stats are GitHub API values on 2026-11-20 unless noted.

### Cluster A – cost/token reporters
- **ccusage** – [github.com/ccusage/ccusage](https://github.com/ccusage/ccusage) (moved from ryoppippi/ccusage). MIT, **19.5k★**, 934 forks, pushed today, v20.0.51 (releases every 1–3 days). CLI (`npx ccusage`), daily/weekly/monthly/session/`blocks` (Claude 5-hour windows) reports, `--json`, `statusline` hook for Claude Code and an experimental Codex one. **20 sources**: Claude Code, Codex, OpenCode, Amp, Droid, Codebuff, Cline, Hermes, pi, Goose, OpenClaw, Kilo, Kimi, Qwen, Copilot CLI, Gemini CLI, Antigravity, Grok, ZCode, DeepSeek. Data: local JSONL/SQLite; prices from LiteLLM. Windows-specific pain: top-reacted issue #861 (45 👍) "Issue running on v18.0.6", #864 `EUNSUPPORTEDPROTOCOL` on Windows (`runtime:` protocol, also #865 20 👍). Accuracy pain: #705 (12 👍) output tokens wrong, #288 (16 👍) live token count wrong, #483 (11 👍) limit hit earlier than blocks predicted, #459 (10 👍) statusline spawns infinite processes at 100% CPU. #23 (11 👍) "5-hour sessions tracker" is the original ask that created `blocks`.
- **tokscale** – [github.com/junhoyeo/tokscale](https://github.com/junhoyeo/tokscale). MIT, 5.9k★, Rust, active (pushed 2026-11-18). TUI (Ratatui) with Overview/Models/Daily/Stats/Sessions/Hourly tabs, 20+ clients incl. Cursor, Copilot CLI, Gemini, Zed, Kiro, Cline, Devin Desktop, Muse, Mistral Vibe; group-by model/workspace/worktree rollup; **social layer**: `tokscale submit`, public leaderboard, profile badges, "Wrapped". Top asks: energy/CO₂ column (#714, 10 👍), GitHub-profile badges (#111, 8 👍), cross-machine aggregation (#52 and #378, 8 👍 combined), per-session view (#151), Antigravity quota (#303).
- **splitrail** (229★, Rust), **phuryn/claude-usage** (2.3k★, Python) – smaller, same idea.

### Cluster B – macOS menubar
- **CodexBar** – [github.com/steipete/CodexBar](https://github.com/steipete/CodexBar). MIT, **23.2k★**, 2.2k forks, Swift, release train v0.8x. Self-describes **114 providers** (README banner): Codex (app-server RPC → `/status` fallback), Claude (OAuth, browser cookies, or CLI PTY running `/usage`), Cursor/OpenCode/Amp/Windsurf/etc via **browser cookies**, Gemini via CLI OAuth, Copilot device flow, plus ~70 API-key/balance providers (OpenAI Admin cost, Bedrock Cost Explorer, OpenRouter, LiteLLM/Bifrost virtual keys, DeepSeek, xAI…). Features: one status item per provider or merged icon, session/weekly/monthly windows with reset countdowns, credits, provider status incident badges, CLI, **Linux Qt 6 desktop app** (separate CLI binary, glibc ≥ 2.39, GNOME needs a tray extension; has a feature-gap doc vs. macOS), Omarchy bar widget. Complaints (reactions): bloat/over-engineering #1364 (37 👍), UI lag #1274 (35), #1321 (34), #1387 (28), #1360 (29 – menubar freeze); repeated **Keychain prompts** #340 (36), #186 (35), #108 (36), #2115 (30), #624 (26); multiple accounts #81 (28 👍, 32 comments – maintainer: "Login often is gated by anti-bot measures… messy"). A Show HN commenter reported "Claude usage probe timed out" even though it shows numbers.
- **OpenUsage (Robin Ebers)** – [github.com/robinebers/openusage](https://github.com/robinebers/openusage). MIT, 4.6k★, Swift, pushed today. Providers: Claude, ChatGPT/Codex, Cursor, Amp, Antigravity, Copilot (incl. org billing, GHE.com), Devin, Grok, Muse, Ollama, OpenCode, OpenRouter, Z.ai, and **CLIProxyAPI hubs**. v0.8 is a rewrite: *Priority* tab (pinned / running out / used up / **Needs Attention** accounts), All Usage with pace mark, pin/hide/drag-order metrics, unify multiple accounts into one card, rate-limit-reset redemption, share-as-image, notifications ("before a limit runs out" and "before weekly resets mostly unused"), global shortcut, `openusage` JSON CLI, proxy support, Privacy Mode (blurs account names in screen shares), signed Sparkle updates. **Philosophy shift** (issue #1441, 134 👍, the most-reacted issue in any repo I looked at): "Super accurate limits all the time · as many accounts as you want · no random log outs or password requests", at the cost of dropping money/token balances ("they were wrong anyway"), and v0.8 "never reads other tools' credentials" – each account is added with the app's own sign-in. #565 (15 👍) announced removal of 8 providers that the team couldn't test. Backlash: #736 "The old design is better" (18 👍), #1719/#1708/#1700 menu-bar icon regressions (14–16 👍), #791/#366/#415 restore Kimi / add Ollama Cloud (15 each), #475 Antigravity CLI (17), #402 multiple accounts (23), #56 Homebrew (22).
- **Claude-Usage-Tracker (hamed-elfayome)** – [repo](https://github.com/hamed-elfayome/Claude-Usage-Tracker). MIT, 3.8k★, Swift. Claude-only (+ Codex profiles): 5h, weekly, per-model weekly, API Console spend with per-key chart, history charts, **unlimited profiles** that switch your Claude Code login, `claude-<profile>` shell commands, auto-switch at limit (v3), 5 menubar icon styles, six desktop widgets, statusline, "Dynamic Island" notch mode, 15 languages. Issues: popup position (#165, 18 👍), stale weekly/session data (#153), creds not refreshed after sleep (#203), Codex status (#229, 10 👍).
- **ClaudeBar** (tddworks, 1.6k★, Apache-2.0), **opencode-bar** (opgginc, 323★), **LimitBar**, **AI Limitbar**, **ClaUse Bar**, burakgon/**ai-usage-menubar** (57★; Claude, Codex, Cursor, Antigravity, Copilot, Devin, Grok, Kiro, Z.ai) – clones of the same idea. Pace tracking and Grok support are the differentiators they advertise.

### Cluster C – Windows
- **Pane** – [github.com/ItsJazii/pane](https://github.com/ItsJazii/pane) (trypane.xyz). 93★ but real adoption: **v0.5.0 had ~69k release downloads**; v0.5.5 shipped 2026-11-16 (cadence ≈ weekly). Rust + TypeScript on Tauri; installs via **winget** (`winget install Pane.Pane`), PowerShell one-liner, or unsigned NSIS setup (SmartScreen warning documented, code signing "on the roadmap"). 25 providers (Claude, Codex, Cursor, OpenCode Go, Copilot, Grok, Devin, Droid, MiniMax, OpenRouter, Z.ai, Antigravity, DeepSeek, StepFun, Kimi, ElevenLabs, Ollama, Kilo, Hermes, Qwen, One/New-API and Sub2API sites…). **Multi-account Claude and Codex** (one card per `CLAUDE_CONFIG_DIR`/`CODEX_HOME` login, same account twice = one card). Features: pace projections with "will run out" warnings and Windows toasts; Today/Yesterday/30-day spend donut with per-model slices and tokens⇄dollars toggle; **banked rate-limit reset credits** with one-click redeem (same idea as Burnrate's banked reset credits); **live tray numbers** (starred metrics render as logo+% pairs in the tray); **widget mode** (pinned, draggable, collapsible to a 40 px bar cycling providers every 8 s); drag-reorder/hide metrics with Ctrl+Z; share-as-image; **local HTTP API** `127.0.0.1:6736/v1/usage` (loopback-only, no CORS, Host check) usable from Rainmeter/stream overlays; EN/ZH/RU; outbound proxy; signed auto-updates; transparent privacy docs listing every network call (but an always-on anonymous daily stat). Perf issue it had to fix: #223 "stop the spend scan from re-reading gigabytes of session logs". **This is the closest direct competitor on Windows.** Gaps: Windows only, no web UI, no budgets, no per-project attribution seen, unsigned.
- **OpenQuota** – [github.com/deviffyy/OpenQuota](https://github.com/deviffyy/OpenQuota). MIT, 251★, Rust+Tauri 2, ~**78.7k release downloads** across releases. **Windows x64+ARM64, macOS universal, Linux AppImage+deb.** 12 providers (Claude Code with multiple accounts, Codex, Cursor, Antigravity, Copilot incl. org billing, Devin, Grok, OpenCode Go, OpenRouter, Z.ai, Kimi, MiniMax). Tray popup **or floating dashboard**, pin metrics into the tray, used/left toggle, today/yesterday/30-day tokens and estimated spend, pacing alerts, custom layouts, global shortcut, launch at login, **no telemetry/no account**, signed updater. Open requests: sign Windows installer + SHA-256 (#50), resizable floating window (#35), GPT 6.1 local-log usage (#74); a Fedora 44 KDE AppImage crash `EGL_BAD_PARAMETER` in WebKitWebProcess (#32) – a typical Tauri/WebKitGTK risk.
- **AIUsage.NET** (4★, .NET port of OpenUsage, winget, Velopack updates) – notable only for its *postmortem*: the Kiro provider was disabled after proactive refresh-token rotation raced the live Kiro IDE and **force-logged the user out of the IDE** ([issue #8](https://github.com/LuigiElleBalotta/AIUsage.NET/issues/8)).
- **Single-purpose Claude tray apps on Windows** (all 0–22★, MIT, mostly weeks old): Kylittleman/ClaudeUsageTracker, TobiiNT/ClaudeTracker (22★; popover + floating widget + multi-profile + overage costs + alerts), SikamikanikoBG/claude-usage-widget (Rust), paris-paraskevas/claude-usage-tracker, andryghb/claude-usage-tray (finds WSL logins/transcripts), niccolo-sabato/claude-usage-widget (sits in empty taskbar space, notifications at 25/50/75/90/95/100 %), Liwindo/ClaudeUsageTracker (Firefox cookies), kad1r/ai-usage (Claude+Codex+Gemini+Cursor). The sheer count (8+ in ~3 months) is itself the evidence of unmet Windows demand.

### Cluster D – Linux
- CodexBar Qt app (above); **OpenUsage Community** ([repo](https://github.com/openusage-community/openusage), 25★, licence `NOASSERTION`, Tauri; AppImage/deb/rpm, Windows installer+portable; README warns GNOME tray needs AppIndicator extension and Wayland positioning is best-effort; reading the keyring needs `secret-tool`); **CrossUsage** (crossusage.dev, Tauri fork, **unverified**). GNOME extensions: jakubgrzywaczewski/ai-usage-gnome, janpetto/ai-usage-indicator ("reads no credentials"), vitdohnalek/ai-usage-meter (statusline-hook snapshot, credential-free), cse1598/ai-usage-monitor, AltairInglorious/brainusage (also KDE), salihmarangoz/gnome-ai-usage-tracker (70/90 % colour thresholds). KDE: materemias/codexbar-agentview (plasmoid on CodexBar CLI). Almost all are 0–9★, Claude+Codex only.
- **OpenUsage.sh** ([janekbaraniewski/openusage](https://github.com/janekbaraniewski/openusage), MIT, 247★, Go) – terminal dashboard (35 tools per its site, **unverified count**), `daily/weekly/monthly/session/blocks --json`, `statusline install` for Claude Code, **tmux status-bar** integration. Open issue #144: telemetry daemon grows to 2+ GB RSS.

### Cluster E – in-agent surfaces
- **Claude Code statusline** now receives `rate_limits.five_hour/seven_day/(spend_limit)` with `used_percentage` and `resets_at` on stdin ([docs](https://code.claude.com/docs/en/statusline); each window may be absent; reported missing on v2.1.96 in anthropics/claude-code#45133). Tom McFarlin **retired his own macOS app called "BurnRate"** in favour of it: Keychain prompts "unavoidable", separate process to maintain, 5-minute polling lag vs live, "nothing that depends on undocumented endpoints" ([post, 2026-05-25](https://tommcfarlin.com/retiring-burnrate-in-favor-of-claudes-status-line/)).
- **ccstatusline** (13.6k★), **claude-hud** (29.3k★ – plugin showing context, rate limits, tools, agents, todos), **CCometixLine** (3.6k★), cship. Huge star counts show people want this *inside* the terminal.
- **Claude-Code-Usage-Monitor** – [repo](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor), MIT, 8.8k★, Python Rich TUI, last push 2026-07-05 (slowing). v4 "Usage-Ops companion": captures official statusline `rate_limits`, **provenance labels** (`official / local_estimate / experimental / unknown`), machine-readable snapshot + automation exit codes, opt-in persistent warehouse surviving Claude's 30-day cleanup, WSL discovery. Top issues: macOS blank terminal #75 (21), weekly usage + reset day #167 (20), statusline support #131 (11), "not accurate anymore" #137, #106 reset time wrong, #121 timezone (9), multiple Claude accounts #94.
- **T3 Code** (the UI Burnrate clones): Usage→Limits tab added in [PR #9507](https://github.com/pingdotgg/t3code/pull/9507) after request [#5539](https://github.com/pingdotgg/t3code/issues/5539) (19 👍). It handles Claude, Codex (and OpenCode Go per #26838) with bars, elapsed marker, pace, reset countdown. Reliability bugs: Claude limits blank when `get_usage` returns `rate_limits: null` (#15364, #30310), Codex Enterprise monthly shows "No limits reported" (#14614), one Codex tile per environment (#23054). Request #26838: **quota-aware model routing/handoff** across subscriptions. #24649: Anthropic's 5h meter charges Agent SDK / `claude -p` traffic ~1.6–1.7× more than the interactive TUI (weekly unaffected) – so any tool built on the SDK looks "worse"; this is the kind of thing a tracker should explain.
- **Gemini CLI** `/stats model` shows session tokens + quota ([docs](https://geminicli.com/docs/resources/quota-and-pricing)); there is no public API for account quota, CodexBar uses private quota APIs. **Codex** exposes `rateLimits/read` via its app-server (used by T3 Code and CodexBar). **OpenCode** plugins: opencode-quota-plugin, opencode-quotas, opencode-usage, opencode-usage-tracker, opencode-bar (see [pinkpixel-dev/quota](https://github.com/pinkpixel-dev/quota) – Rust desktop app + VS Code ext + CLI for Copilot, Codex, Claude, Antigravity, Kiro, Grok, Cursor, OpenCode Go; 38★).

### Cluster F – gateways and observability
- **LiteLLM** (63.6k★): virtual keys with per-key/team/model budgets, hard blocking, daily/weekly/monthly; needs the proxy + Postgres for spend tracking (secondary sources, **unverified**). **Helicone** (6.3k★, Apache-2.0): logging, per-user cost attribution, alerts; **Langfuse** (37.7k★): tracing, cost by trace. **OpenRouter**: credits, per-key limits, hosted only. None of them can see subscription quotas or local agent transcripts.
- **ccflare** (1.1k★, last push 2026-04) / **claude-rotate** (48★) / **cligate** / **CLIProxyAPI** + dashboards: proxy that pools multiple subscriptions, fails over on 429, shows request history; CLIProxyAPI dropped built-in usage stats in v6.10 so third-party dashboards fill in. **claude-code-router** (38k★): routing/fallback, not analytics. OpenUsage and CodexBar both ingest CLIProxyAPI hubs.

---

## 3. Feature matrix

Legend: ● yes / strong, ◐ partial, ○ no, ? not verified. "Limits" = real subscription quota windows (session/weekly); "Cost" = local-transcript cost/tokens.

| Tool | OS | Form | Providers | Limits | Cost/tokens | Multi-account | Alerts | Pace | API-key budgets/balances | Statusline / CLI / API | Licence · ★ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ccusage | Win/Mac/Linux (Node) | CLI | 20 | ◐ (5h blocks est.) | ● | ○ (config dirs) | ○ | ◐ burn rate | ○ | ● statusline, JSON | MIT · 19.5k |
| tokscale | W/M/L | TUI + web | 20+ | ○ | ● | ○ | ○ | ○ | ○ | JSON | MIT · 5.9k |
| Claude-Code-Usage-Monitor | W/M/L | Rich TUI | Claude | ◐ official via statusline | ● | ◐ | ○ | ● | ○ | ● state file, exit codes | MIT · 8.8k |
| CodexBar | macOS (+Qt Linux) | menubar / Qt app | 114 | ● | ◐ local cost scan | ◐ (limited) | ● | ◐ | ● (~70 balance/spend providers) | ● CLI | MIT · 23.2k |
| OpenUsage (Ebers) | macOS | menubar | ~14 + CLIProxy | ● | ◐ (v0.8 dropped $ balances) | ● unify | ● | ● | ◐ OpenRouter | ● CLI JSON | MIT · 4.6k |
| OpenUsage Community | Win/Linux/mac (Tauri) | tray | plugin-based | ● | ◐ | ? | ? | ? | ? | ◐ CLI, CSV/Excel export | NOASSERTION · 25 |
| OpenUsage.sh | W/M/L | TUI + tmux | ~35 (claimed) | ◐ | ● | ? | ? | ◐ | ● OpenRouter etc. | ● statusline, tmux, JSON | MIT · 247 |
| **Pane** | **Windows** | tray + widget | 25 | ● | ● donut | ● Claude/Codex | ● toasts | ● | ◐ balances | ● local HTTP API | NOASSERTION · 93 (69k dl) |
| **OpenQuota** | **W/M/L** | tray + floating | 12 | ● | ● | ● Claude | ● pacing | ● | ◐ OpenRouter | ○ | MIT · 251 (79k dl) |
| AIUsage.NET | Windows | tray | 10 | ● | ◐ | ○ | ? | ? | ◐ | CLI | NOASSERTION · 4 |
| Claude-Usage-Tracker | macOS | menubar + widgets | Claude, Codex | ● | ◐ | ● profiles | ● | ● | ● Console per-key | ● statusline | MIT · 3.8k |
| ClaudeBar / LimitBar / etc. | macOS | menubar | 3–9 | ● | ○ | ○ | ◐ | ● | ○ | ○ | Apache/MIT · ≤1.6k |
| claude-hud / ccstatusline | W/M/L | terminal statusline | Claude (+) | ● | ◐ | ○ | ○ | ○ | ○ | ● | MIT · 29k / 13.6k |
| T3 Code Usage | W/M/L | desktop app | Claude, Codex, OpenCode Go | ● | ● | ◐ pooled | ◐ resume at reset | ● | ○ | ○ | MIT |
| LiteLLM / Helicone / Langfuse | server | web | any API | ○ | ● | n/a (keys/teams) | ● | ○ | ● hard budgets | API | OSS · 64k/6k/38k |
| ccflare / claude-rotate | server | proxy+web | Anthropic/OpenAI | ◐ | ◐ | ● pooling/failover | ◐ | ○ | ○ | API | MIT · 1.1k / 48 |
| **Burnrate (today)** | W (Linux?) | local web app | 9 | ● (6 w/ limits) | ● (3 readers) | ● pooled bars | ○ | ● tick | ◐ Cursor/Mistral keys | ○ | MIT |

---

## 4. Top 25 features users ask for or love (ranked by evidence)

Evidence strength = reactions on issues, star counts of tools that centre the feature, count of independent re-implementations.

1. **Session + weekly limit bars with reset countdown.** Every tool in clusters B–E; ccusage #23 (11 👍), CCUM #167 weekly+reset day (20 👍), T3 #5539 (19 👍).
2. **Accurate / "official" numbers.** ccusage #705/#288/#483/#487 (12+16+11+8 👍), CCUM #137/#106/#212; OpenUsage #1441's headline promise is "Super accurate limits all the time" (134 👍).
3. **Multiple accounts per provider, shown separately or unified.** CodexBar #81 (28 👍/32 comments), OpenUsage #402 (23), CCUM #94, T3 #23054, Claude-Usage-Tracker profiles, Pane, OpenQuota, claude-rotate.
4. **A zero-click glance surface (tray/menubar number).** OpenUsage #1719/#1708/#1700 (14–16 👍 each) after the icon was removed; HN comment asking for "useful info on the top panel, not just logo"; Pane tray numbers; hamed's 5 icon styles.
5. **Lightweight and fast.** CodexBar #1364 (37), #1274 (35), #1321 (34), #1387 (28), #1360 (29); OpenUsage.sh #144 (2 GB RSS); Pane #223.
6. **No credential prompts or random log-outs.** CodexBar Keychain prompts #340/#186/#108/#2115/#624 (26–36 each); OpenUsage #1441 ("No random log outs or password requests"); AIUsage.NET Kiro force-logout.
7. **Pace / will-I-run-out projection.** Pane, OpenQuota "pacing alerts", hamed time marker, OpenUsage pace mark, CCUM #128 (date-aware forecast); a core of the T3 UI Burnrate copies.
8. **Threshold and reset notifications with cooldown.** OpenUsage notifications, Pane #234 "notify when weekly limit resets", niccolo widget 25–100 %, ClaUse Bar cooldown, janpetto GNOME notifications.
9. **Statusline integration.** CCUM #131 (11 👍), ccstatusline 13.6k★, claude-hud 29.3k★, CCometixLine 3.6k★, ccusage statusline, vitdohnalek/ai-usage-meter, McFarlin's post.
10. **Broad provider coverage with fast onboarding of new ones.** CodexBar 114, ccusage 20, tokscale 20+; OpenUsage #475 Antigravity (17 👍), #791 Kimi (15), #366/#415 Ollama Cloud (15+14), #229 Codex in Claude tracker (10).
11. **Local-only, no telemetry, auditable network calls.** OpenQuota ("no account, cloud backend, analytics"), Pane docs/privacy.md, OpenUsage privacy page; the unavoidable pings in OpenUsage are a recurring criticism class (**unverified** as issue-level).
12. **Cost and tokens by day / model / session / project.** ccusage's whole product; tokscale group-by workspace/worktree and #151 per-session; Pane donut and 30-day trend.
13. **Windows and Linux support.** 8+ Windows tray repos, OpenQuota 79k and Pane 69k downloads, CodexBar Qt port, OpenUsage Community fork "official Linux/Windows" mission; Ebers himself says it "may even create an official Windows/Linux version".
14. **API Console / API-key spend and balance in the same view.** CodexBar OpenAI Admin / Bedrock / LiteLLM / OpenRouter; hamed per-key chart; Pane balance cards; OpenRouter key limit/budget in OpenUsage.
15. **Scriptable output: CLI, JSON, local HTTP API.** OpenUsage `openusage` CLI, Pane `127.0.0.1:6736`, ccusage `--json`, CCUM state file + exit codes, CodexBar CLI.
16. **Customisable layout (pin / hide / reorder, used-vs-left).** OpenUsage, Pane (drag, Ctrl+Z), OpenQuota; **but** redesign backlash (#736 18 👍, CodexBar #1364) shows people want compact defaults and layout stability.
17. **Floating always-on-top mini widget.** Pane widget mode (40 px strip rotating providers), OpenQuota floating dashboard (+#35 resize), TobiiNT, hamed's six widgets, niccolo taskbar widget.
18. **Per-model limits (Opus/Sonnet/Fable/Spark/Design).** hamed #281 (7 👍), OpenUsage "Spark" and "model limits", Pane.
19. **Banked / redeemable rate-limit reset credits.** OpenUsage, Pane (Burnrate already has this – keep ahead).
20. **Easy install and updates.** OpenUsage Homebrew #56 (22 👍), Pane winget + signed updater, OpenQuota #50 (sign Windows installer + checksums), CCUM #7 "publish as a real package" (6 👍 / 13 comments), ccusage Windows `npx` failures (#861 45 👍, #864/#865).
21. **Cross-machine aggregation of the same account.** tokscale #52/#378; Pane "session folders synced from other machines count toward spend".
22. **Needs-attention / re-auth state and provider health.** OpenUsage Priority→Needs Attention; CodexBar status incidents overlay; hamed "Claude's service status"; T3 bugs where cards silently disappear (#15364).
23. **Share card / privacy mode / social proof.** OpenUsage share image + Privacy Mode, Pane ⧉ share card, tokscale leaderboard/badges (#111 8 👍)/Wrapped.
24. **Quota-aware routing or hand-off to another subscription.** T3 #26838, claude-rotate, ccflare, hamed auto-switch (v3), Limitbreak **(unverified)**. High demand, high ToS risk (§7).
25. **Tertiary but recurring:** CO₂/energy (tokscale #714, 10 👍), timezone correctness (CCUM #121, 9 👍), multi-language (Pane, hamed 15 languages, OpenQuota #18), prompt-cache-hit rate in statusline (hamed), history surviving the 30-day transcript purge (CCUM warehouse).

---

## 5. Gaps nobody serves well

1. **Windows + Linux as first-class, with limits *and* history *and* multi-provider.** Pane is Windows-only and tray-only; OpenQuota is cross-platform but 12 providers, no budgets, no web view; CodexBar's Linux app is a feature-gapped port that needs a separate CLI install and glibc 2.39; OpenUsage Community is 25★ with no declared licence; GNOME/KDE widgets cover 1–3 providers. A single Rust binary with a localhost web UI sidesteps the WebKitGTK/tray fragmentation (OpenQuota #32, OpenUsage Community Wayland/AppIndicator notes).
2. **API keys with budgets on a dev machine.** The only real budget enforcement is LiteLLM-class gateways (proxy + Postgres). CodexBar shows balances for ~70 services but no "soft budget + alert + forecast". Nobody offers "monthly cap per provider/key/project, forecast month-end, warn at 80 %" next to subscription quotas.
3. **Provenance and trust.** Only CCUM v4 labels numbers `official / local_estimate / experimental`. OpenUsage *removed* money figures because they were unreliable. A tracker that says why a number can be trusted (and why Agent-SDK traffic drains 1.7× faster, T3 #24649) is unserved.
4. **Burn attribution ("what ate my 5-hour window?").** Cost-per-session/project exists (ccusage, tokscale) but is not joined to the live limit bar. Nobody answers "this session used 31 % of your weekly window".
5. **WSL ↔ Windows reality.** Many Windows devs run Claude/Codex inside WSL; only andryghb/claude-usage-tray and CCUM discover WSL logins/transcripts. Native + WSL accounts should merge or show separately.
6. **Cross-device aggregation of one account.** Requested (tokscale ×2) and only crudely handled (Pane extra Codex folders).
7. **Pooled-headroom guidance without automatic rotation.** T3 #26838 shows demand for "which subscription has room now"; rotation proxies exist but carry ToS risk. A passive "best next provider" hint is a safe middle.
8. **Credential-free mode on every OS.** Statusline-hook ingestion (CCUM, ai-usage-meter) and transcript parsing exist but are fragmented; nobody combines official-data-from-hooks + transcript cost + opt-in token reading in one app.
9. **Stable, un-bloated glance UI.** Both leaders drew "bloated"/"redesign" backlash; the market wants a boring, dense overview that stays boring.

---

## 6. UX patterns worth copying

- **"Priority" home** (OpenUsage): sections *Pinned*, *Running out*, *Used up*, *Needs attention* – answers "what do I act on now?" better than a flat provider list. Thresholds user-configurable for orange/red.
- **Tray icon rendering logo + % pairs for 1–2 starred metrics** (Pane); show the *worst* limit when unpinned. Keep it to one tray item; CodexBar/OpenUsage complaints show icon sprawl is a real cost (#1719: "waste 4 icon slots").
- **Popover from the tray anchored to the icon** + global shortcut (OpenUsage, Pane `Ctrl+Shift+U`, OpenQuota). On Linux add a "Show" tray-menu entry and a shortcut since GNOME may swallow left-click.
- **Widget mode**: pinned, draggable, lockable, collapsible to a slim bar that cycles providers every ~8 s (Pane); optional always-on-top mini window.
- **Pace tick on the bar** (already Burnrate, from T3/OpenUsage/hamed) + colour by projected pace, not just by % used. **Used/left toggle** (OpenQuota, hamed).
- **Statusline as a first-class output**: `burnrate statusline` printing `5h 42% ▸ resets 1h30m | wk 63%` for Claude Code `statusLine`, tmux, starship, PowerShell prompt; Also accept Claude's stdin JSON to learn official `rate_limits` without credentials.
- **Local HTTP JSON API on loopback** with Host check/no CORS (Pane/OpenUsage wire format) so Rainmeter, Raycast, Stream Deck, KDE/GNOME panels, Waybar and Omarchy widgets can be built by others.
- **Notifications with cooldown and "weekly resets mostly unused" nudge** (OpenUsage) – value-oriented, not just alarm.
- **Share-as-image + Privacy Mode** for screenshots; **Ctrl+Z on layout edits**; **per-card quick links** (status page, dashboard).
- **Provenance chip** on every number (CCUM idea): `official`, `estimated`, `stale 12 min`.
- **Cache-first render**: show last good value instantly, refresh in background (OpenQuota "cached values appear immediately").
- **Per-account naming by org/email**, dedupe same login (Pane, OpenUsage "A sign-in you already use isn't added twice").
- **Diagnostics panel** (what was read, from where, last error) to turn "No limits reported" (T3 #14614) into an actionable message.

---

## 7. Pitfalls

**ToS / credential handling (highest risk).**
- Anthropic's [legal & compliance page](https://code.claude.com/docs/en/legal-and-compliance) (fetched 2026-11-20): OAuth "is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans…"; "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users"; "developers may not **collect, store, or intermediate** Claude.ai credentials or session tokens"; Anthropic "may do so without prior notice". Third-party reports say server-side blocking of subscription tokens outside Claude Code began 2026-01-09 (OpenCode, OpenClaw, Roo) – secondary sources, partly inconsistent on later dates **(unverified)**. Reading a token from `.credentials.json` to call the undocumented `api/oauth/usage` endpoint is what most trackers do (CodexBar, hamed, many Windows apps); it is a grey area that is not "routing requests" but does touch "collect/store". OpenUsage's answer was to stop reading other tools' credentials entirely and use its own sign-in; whether that satisfies "sign-in must complete through Anthropic's own flow" is **unverified**.
- **Safest data paths, in order:** (1) local transcripts/SQLite (cost/tokens, no auth); (2) Claude Code statusline stdin `rate_limits` (official, process-local; McFarlin, CCUM, ai-usage-meter); (3) Codex `app-server` `rateLimits/read` (official local protocol); (4) CLI `/usage` PTY scraping (CodexBar fallback; fragile, "probe timed out"); (5) token-based undocumented endpoints, opt-in, read-only; (6) browser-cookie scraping (CodexBar; anti-bot, captchas, Chrome Safe Storage prompts #186) – avoid.
- **Never proactively refresh another app's OAuth tokens.** Refresh-token rotation races can revoke the token family and log the user out of the real tool (AIUsage.NET#8 Kiro; OpenUsage's "no random log outs" promise). Refresh only reactively after a 401 – or not at all.
- **Do not build automatic account rotation/pooling of requests.** claude-rotate, Limitbreak, hamed v3 auto-switch exist, but the legal page says advertised limits "assume ordinary, individual usage" and prohibits routing through plan credentials; melodic-software explicitly warns against it. Display-only pooling (what Burnrate does) is fine.
- **Telemetry**: OpenUsage ships a non-optional daily ping and crash reports; Pane has an always-on daily stat. Burnrate's "everything stays on your computer" pitch is stronger with literally none by default.
- Keep API keys encrypted (DPAPI on Windows, libsecret/`secret-tool` on Linux, file with 0600 fallback) and write-only in the UI (already so).

**Rate-limit probing and polling.**
- Prefer endpoints/streams that cost nothing. Some older trackers made a real tiny API request to read `anthropic-ratelimit-*` headers, which burns quota **(unverified, from memory – not seen in this session's sources)**; avoid inference calls entirely.
- Undocumented usage endpoints can 429/stale: hamed #153 stale weekly, #203 creds not refreshed after sleep. Poll with jitter, exponential backoff, ≥ 60–300 s, refresh on window focus/wake, show "as of" time.
- Respect proxies (Pane/OpenUsage have outbound proxy settings; enterprise users need them).

**Accuracy of cost numbers.**
- Streaming JSONL duplicates and placeholder output tokens (ccusage #705: 13 vs 8,836 actual), cached-token handling (#288), 5-hour block anchoring (#483, CCUM #106), timezone boundaries (CCUM #121), Codex service tiers/fast mode (Burnrate README already notes), cache-write TTL tiers, thinking tokens.
- Subscription "cost" is API-equivalent, not money out of pocket – label it. Anthropic's meter itself differs by surface (Agent SDK ≈ 1.6–1.7× the TUI, T3 #24649). OpenUsage deleted its $ figures as "wrong anyway": design for honesty (provenance chip, "≈", model price source/date, unknown-model flag).
- Validate against ccusage output in CI fixtures (cheap regression oracle); version transcript parsers per agent release – OpenCode's sqlite migration broke ccusage (#845, 33 👍).

**Performance.** Bloat is the #1 CodexBar complaint class; Pane and OpenUsage.sh both had log-rescan/daemon memory problems. Keep incremental per-file offsets, bounded heap, no per-provider chart gradients in the overview.

**Packaging.** Unsigned Windows installers and SmartScreen (Pane, OpenQuota #50, AIUsage.NET); `npx`/Node runtime failures on Windows (ccusage #861/#864); Linux tray fragmentation and WebKitGTK crashes (OpenQuota #32); Homebrew/winget/AppImage/deb/rpm availability matters.

**Provider churn.** Undocumented APIs break (Pane #30 Cursor usage-based plans; OpenUsage removed 8 providers it couldn't test). Plugin isolation, per-provider health states and "last good value" fallback; keep a tested-by-whom column.

**Naming.** "Burnrate/BurnRate" is already used by at least one macOS Claude usage app (Tom McFarlin, retired 2026-05-25), and the word appears in many finance products; check trademark/SEO before launch. **(unverified beyond that one hit; run a proper search.)**

---

## 8. Prioritised recommendations for Burnrate

Burnrate already has the hardest parts (T3-grade UI, pace ticks, pooled multi-account bars, banked resets, compact-row Rust server). The recommendations below concentrate on what the evidence says wins on Windows/Linux.

### MUST
1. **Tray/glance surface on Windows and Linux** (tray icon with live % of the worst/pinned limit, click → popover or open the web UI, autostart, global shortcut). Rationale: the #1 re-implemented feature (8+ Windows tray repos, Pane/OpenQuota downloads 69–79k) and the one Burnrate lacks. Consider a minimal Rust tray (e.g. `tray-icon`) around the existing server instead of Tauri/WebKitGTK to avoid OpenQuota#32-class crashes; add a "Show" menu entry for GNOME without AppIndicator.
2. **Notifications**: configurable thresholds (e.g. 50/80/95 %), pace-based "will run out before reset", "weekly resets with lots unused", reset-happened, with cooldown and per-account mute. Native Windows toasts / `notify-send`. (Pane #234, OpenUsage, niccolo widget.)
3. **Credential-minimal data pipeline with provenance**: prefer Claude statusline `rate_limits` ingestion (install helper that adds a tiny `burnrate statusline` command), Codex app-server RPC, and transcripts; token-reading endpoints only as explicit opt-in, read-only, **never proactively refresh**. Tag every number `official / estimated / stale`. Rationale: ToS exposure (legal page), Keychain/log-out pain, accuracy complaints.
4. **`burnrate` CLI + loopback JSON API + statusline output**: `burnrate status --json`, `burnrate statusline`, `GET 127.0.0.1:<port>/v1/usage` (loopback only, Host check, no CORS, same wire format as OpenUsage/Pane where feasible). Rationale: statusline tools have 13–29k★; unlocks Rainmeter/Waybar/tmux/GNOME/KDE ecosystem for free (Pane, OpenUsage, janek's tmux).
5. **Accuracy hardening of cost/tokens**: message-id dedupe, thinking/output-token reconstruction, cache TTL tiers, Codex service tiers, timezone/week-boundary handling, CI cross-check against ccusage on shared fixtures. Rationale: ccusage's most-reacted accuracy issues; trust is the product.
6. **Multi-account discovery that is Windows-aware**: `CLAUDE_CONFIG_DIR`, `~/.claude*`, `CODEX_HOME`, **WSL distros' homes**, dedupe same login, show org/email names, per-account "Needs attention / sign in again" state. Rationale: #3 and #22 in the ranking; WSL is a gap.
7. **Packaging**: winget manifest, signed (or at minimum checksummed) Windows installer, AppImage + .deb/.rpm, single static Rust binary without Node at runtime, signed auto-update. Rationale: install friction is a top-5 complaint class (ccusage Windows failures, SmartScreen).
8. **Performance budget as a feature**: publish and test an RSS/CPU budget (README already claims ~125 MB), cache-first render, incremental scans, no heavy overview charts. Rationale: CodexBar's 5 top issues are lag/bloat.

### SHOULD
9. **API-key budgets**: per-provider/key monthly caps, month-end forecast, 80/100 % alerts, spend pulled from official billing/usage APIs (OpenAI Admin, Anthropic Admin/Console, OpenRouter key info, Mistral, Cursor) – no proxy required. Rationale: gap #2; today only LiteLLM-class gateways do enforcement.
10. **Priority home view** (pinned / running out / used up / needs attention) plus pin/hide/reorder with undo, used⇄left toggle. (OpenUsage, Pane, OpenQuota.) Keep the dense default—do not redesign often.
11. **Provider breadth to ~20**: add Copilot (premium-request/AI-credit model changed 2026-06-01, **unverified** details), Gemini CLI, Antigravity limits, Kiro, Droid, Amp, Z.ai, Kimi, MiniMax, Ollama Cloud, OpenRouter, Devin, Windsurf; reuse ccusage's path knowledge for transcript readers. Gate each behind a per-provider health state and "tested by" note.
12. **Burn attribution**: join cost to the live window ("this project/session used 31 % of your weekly window"), per project/session/model/sub-agent, explain Agent-SDK metering differences. Rationale: gap #4, tokscale/ccusage asks (#151, #313).
13. **Floating mini widget** (always-on-top, collapse to 40 px strip, optional click-through) as a second window of the same UI.
14. **Per-model limits** (Opus/Sonnet/Fable etc.) and plans without a 5h window displaying the week as primary.
15. **Cross-device aggregation** via optional export/import or a user-chosen sync folder (no cloud). Gap #6.
16. **Passive "best next provider/account" hint** from pooled headroom. Gap #7; avoids rotation/ToS issue.
17. **Share card + Privacy Mode + CSV/JSON export** (OpenUsage, Pane, OpenUsage Community).
18. **Service-status badges** per provider (CodexBar, hamed).
19. **Persistent local history store** that survives Claude's 30-day transcript cleanup (CCUM warehouse) – retention is a hidden killer feature for cost-over-time charts.
20. **i18n scaffolding** (EN + 2–3 languages; Pane, hamed, OpenQuota #18 show demand).

### COULD
21. Thin integrations built on the HTTP API: Raycast, Waybar/Omarchy, KDE plasmoid, GNOME extension, tmux/starship snippets, Stream Deck, Rainmeter skin.
22. **MCP server / agent-facing endpoint** so an agent can ask "how much quota is left?" and self-throttle (T3 #26838 demand, glama "claude-telemetry-mcp" **(unverified)**).
23. CLIProxyAPI / ccflare hub import (OpenUsage, CodexBar already do).
24. Social/gamified: leaderboard, badges, "Wrapped" (tokscale) – fun but off-brand with "everything stays local"; do only opt-in and offline-rendered.
25. Energy/CO₂ column (tokscale #714, 10 👍).
26. Optional PWA install and mobile-width layout for checking from a phone on the LAN (loopback-only by default).

### Explicitly avoid
- Automatic account rotation / request routing through subscription credentials (ToS).
- Browser-cookie scraping and Keychain/Credential-Manager sweeps of other apps.
- Default-on telemetry; mandatory daily pings.
- Frequent redesigns of the main view.

---

## 9. Sources

Repos and stats (GitHub API 2026-11-20):
- ccusage: https://github.com/ccusage/ccusage · issues #861, #845, #705, #288, #483, #459, #23, #864, #865
- tokscale: https://github.com/junhoyeo/tokscale · issues #714, #111, #52, #378, #151
- Claude-Code-Usage-Monitor: https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor · issues #75, #167, #131, #137, #106, #121, #94, #128
- CodexBar: https://github.com/steipete/CodexBar · issues #1364, #1274, #1321, #340, #186, #108, #2115, #81; site https://codexbar.app
- OpenUsage (Ebers): https://github.com/robinebers/openusage · #1441, #565, #736, #1719, #1708, #402, #56, docs/accounts.md, docs/privacy.md
- OpenUsage Community: https://github.com/openusage-community/openusage · OpenUsage.sh: https://github.com/janekbaraniewski/openusage · CrossUsage: https://www.crossusage.dev/ (unverified)
- Pane: https://github.com/ItsJazii/pane · https://trypane.xyz · OpenQuota: https://github.com/deviffyy/OpenQuota · AIUsage.NET: https://github.com/LuigiElleBalotta/AIUsage.NET (issue #8)
- Windows Claude tray apps: https://github.com/TobiiNT/ClaudeTracker · https://github.com/paris-paraskevas/claude-usage-tracker · https://github.com/SikamikanikoBG/claude-usage-widget · https://github.com/Kylittleman/ClaudeUsageTracker · https://github.com/andryghb/claude-usage-tray · https://github.com/niccolo-sabato/claude-usage-widget · https://github.com/Liwindo/ClaudeUsageTracker · https://github.com/kad1r/ai-usage
- Linux: https://github.com/jakubgrzywaczewski/ai-usage-gnome · https://github.com/janpetto/ai-usage-indicator · https://github.com/vitdohnalek/ai-usage-meter · https://github.com/cse1598/ai-usage-monitor · https://github.com/AltairInglorious/brainusage · https://github.com/salihmarangoz/gnome-ai-usage-tracker · https://github.com/materemias/codexbar-kde
- macOS others: https://github.com/hamed-elfayome/Claude-Usage-Tracker · https://github.com/tddworks/ClaudeBar · https://github.com/opgginc/opencode-bar · https://github.com/burakgon/ai-usage-menubar · https://github.com/CoderAI-dev/limitbar
- Statusline: https://github.com/jarrodwatts/claude-hud · https://github.com/sirmalloc/ccstatusline · https://github.com/Haleclipse/CCometixLine · https://code.claude.com/docs/en/statusline · https://github.com/anthropics/claude-code/issues/45133 · https://tommcfarlin.com/retiring-burnrate-in-favor-of-claudes-status-line/
- T3 Code: https://github.com/pingdotgg/t3code/issues/5539 · /pull/9507 · /issues/26838 · /issues/24649 · /issues/15364 · /issues/30310 · /issues/14614 · /issues/23054
- Multi-account/rotation: https://github.com/doxaras/claude-rotate · https://github.com/DSado88/claude-tracker · https://github.com/melodic-software/claude-code-account-rotation · https://github.com/snipeship/ccflare · https://github.com/musistudio/claude-code-router
- OpenCode/other: https://github.com/pinkpixel-dev/quota · https://github.com/Piebald-AI/splitrail · https://github.com/phuryn/claude-usage
- Gateways: https://github.com/BerriAI/litellm · https://github.com/Helicone/helicone · https://github.com/langfuse/langfuse (budget claims from secondary comparison posts, unverified)
- Policy: https://code.claude.com/docs/en/legal-and-compliance (fetched) · secondary: https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block/ · https://aihackers.net/posts/anthropic-claude-code-oauth-policy-feb-2026/ (unverified dates)
- Gemini CLI quotas: https://geminicli.com/docs/resources/quota-and-pricing
- HN: https://news.ycombinator.com/item?id=46544524 (Show HN macOS menu bar app, 161 pts)
