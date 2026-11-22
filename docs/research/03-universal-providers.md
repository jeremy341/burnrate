# 03 - Universal providers: how to read limits, balances, budgets and logs for any AI provider

Research report for the Burnrate product plan. Date: 2026-11-20. Scope: read-only research, no code changes, no real keys used.

## 0. Summary (read this first)

1. **Three data shapes exist, and only one fits Burnrate's current `UsageWindow` (id, kind, usedPercent, resetsAt, windowDurationMins):**
   - **Quota windows** (percent used + reset time): subscription and coding plans (Claude, Codex, Cursor, Z.ai GLM, Kimi Code, MiniMax, Copilot, Windsurf, Amp, Kiro, Cline's ClinePass, ZenMux, Synthetic, Qwen Cloud/Alibaba token plan, Gemini).
   - **Money**: prepaid balance (DeepSeek, Moonshot, xAI, OpenRouter, Vercel AI Gateway, Poe, Ollama), spend over a period (OpenAI/Anthropic admin APIs, Fireworks, Together, Bedrock), or a **key-level cap** (OpenRouter `limit`, LiteLLM `max_budget`, Bifrost virtual keys). Money has no natural "reset" and often no "total", so it needs new fields (`balances[]`, `spend`) plus a way to synthesize a window.
   - **Rate limits** (RPM/TPM/RPD): only available as response headers on real inference calls, and a few org-level admin endpoints. Not a spend/quota signal; low priority.
2. **Most plan-quota endpoints are unofficial** (Claude `oauth/usage`, Codex `wham/usage`, Z.ai `monitor/usage/quota/limit`, Copilot `copilot_internal/user`, Kimi Code `coding/v1/usages`, Kiro `GetUsageLimits`, Windsurf `GetPlanStatus`). **Most API-key balance/cap endpoints are official** (OpenRouter `/key`, DeepSeek `/user/balance`, Moonshot `/v1/users/me/balance`, xAI Management API, OpenAI/Anthropic admin APIs, Ollama `/api/usage` + `/api/balance`).
3. **Correction to the brief:** OpenRouter `GET /api/v1/credits` requires a **management key** per the official spec, not a normal inference key. A normal key only gets `/key` (key limit, per-key usage). The declarative example must therefore mark `/credits` as optional ("management key only"). See section 2 (OpenRouter) and 4.2.
4. **Several big providers have no per-key balance/usage API at all** (Anthropic individual Console accounts, Gemini API keys, Perplexity API, Together balance, Fireworks balance, Groq non-enterprise, Cerebras, Mistral API). For these, **local measurement (logs or a local proxy) plus a user-entered budget** is the only universal answer. That is why the "key with budget" concept and the optional local proxy are the highest-leverage design items.
5. **Do not scrape browser cookies/localStorage.** CodexBar does it for ~25 providers (Perplexity, Groq console, Windsurf, Gemini app, MiniMax, Mistral console, Qwen Cloud, ...). It is fragile, ToS-gray and a security liability. Burnrate should only support (a) official keys, (b) read-only reuse of CLI credential files (as it already does for Claude/Codex/Grok), (c) manual paste of a token with a clear warning, in that order.
6. **Best leverage for "any provider" with little code:** a declarative provider definition (section 4), seeded from **models.dev `api.json`** (324 providers with base URL, env var names, and per-model prices) and **LiteLLM** prices, plus read-only log adapters for the ~15 popular agent CLIs listed in section 3.
7. **Recommended order (section 9):** engine + budgets first; then OpenRouter, DeepSeek, Moonshot, Z.ai, Kimi Code, Copilot, Gemini CLI, OpenAI/Anthropic admin; then log adapters; then proxy; clouds (Bedrock/Vertex/Azure) later; cookie providers last or never.

### Evidence legend
- **[V]** official documentation fetched or quoted by a search of the official site in this session.
- **[C]** community usage-tracker documentation fetched in this session, from open-source projects that run these endpoints in production: CodexBar (`steipete/CodexBar`, `docs/*.md`), CodeBurn (`getagentseal/codeburn`, `docs/providers/*.md`), UsageBar. These are strong evidence an endpoint works, but are not a contract.
- **[S]** web-search summary only; the underlying page was not opened.
- **[U]** unverified: inferred from conventions or prior knowledge. Needs a live check before shipping.

"Official?" values: **official** (documented, key-scoped), **official-admin** (documented but needs an org admin/management key), **unofficial** (private API of the vendor's own client; can change or break; ToS gray), **local** (reads files on disk).

---

## 1. What Burnrate has today (from the repo)

- `server-rs/src/providers/mod.rs`: trait `Provider { id, label, color, auth: ApiKey|LocalLogin|LocalLogs, has_login, read(&KeyStore) -> Vec<Value>, test_key }`; `Window::new(id, kind, label, used).resets(iso).mins(n)`; `account_with(head, windows)` and `unavailable_account(head, msg)`; `agent()` = ureq with a 10 s timeout. Window kinds in `src/contracts.ts`: `session | weekly | monthly | other`. `UsageLimits` also has `zeroSpendCap`, `resetCredits`, `externalUsage {label,url}`, `unavailable {reason: unsupported|probeFailed}`.
- Implemented limit sources: Claude (`api.anthropic.com/api/oauth/usage`, OAuth token from `.credentials.json`), Codex (`chatgpt.com/backend-api/wham/usage`), Grok (`cli-chat-proxy.grok.com/v1/billing?format=credits`), Cursor (`api2.cursor.sh` key exchange then `DashboardService/GetCurrentPeriodUsage`), OpenCode Go (`opencode.ai/zen/go/v1/usage`), Mistral (`api.mistral.ai/v1/billing/budget` -> `vibe_budget.usage_percentage`, `reset_at`).
- `keys.rs`: AES-256-GCM key file `keys.enc` plus a per-install `master.key` stored beside it (so it protects against casual disclosure only). Keys are write-only through the HTTP API; each provider has multiple named keys (`KeyStore::list(provider) -> [(name, key)]`).
- Cost pipeline: `readers/*` produce `types::Record { provider, ts, model, rate_model, session, uncached, cached, cache_write, output, reasoning, cache_1h, reported, speed, key }` (note: **`key: Option<String>` already exists**, useful for per-key attribution) -> `pricing.rs` (LiteLLM `model_prices_and_context_window.json`, alias candidates incl. Bedrock base ids, context tiers, fast/ultrafast multipliers, user overrides). Readers exist for Claude (all `~/.claude*`), Codex (incl. archived), OpenCode (SQLite), Antigravity, Grok, Pi, Muse.
- Server: `tiny_http` + `ureq` (sync). Bound to 127.0.0.1.

Gaps this report addresses: no balance/spend concept; no per-key budgets; limits providers are hard-coded; few log readers; no proxy.

---

## 2. Provider-by-provider findings

Table convention: one table per provider. Rows are the six questions asked: (a) plan/quota windows, (b) balance/spend/budget, (c) per-key limits, (d) local logs, (e) auth, (f) official/stability/ToS. "-" means no source found.

### 2.1 Subscription and coding plans

#### Claude Code (subscription) - implemented
| Item | Detail |
|---|---|
| (a) windows | `GET https://api.anthropic.com/api/oauth/usage` (Burnrate already uses `?cedar_ember=1&skip_spend=1`), headers `Authorization: Bearer <oauth accessToken>`, `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-cli/<ver>`. Windows: 5-hour, 7-day, per-model weekly. [C, repo] |
| (b) | CodexBar's `skip_spend=1` implies a spend block exists in the same response [U]. |
| (d) logs | `%USERPROFILE%\.claude\projects\**\*.jsonl` (+ `CLAUDE_CONFIG_DIR`, `~/.config/claude/projects`, `.claude-*` accounts). Implemented. |
| (e) auth | `~/.claude/.credentials.json` -> `claudeAiOauth.accessToken` (Windows/Linux; macOS uses Keychain). |
| (f) | **Unofficial.** Client headers are spoofed. Moderate break risk. Never refresh the CLI's refresh token (rotation breaks the CLI; same lesson as Kimi, below). |

#### OpenAI Codex / ChatGPT - implemented
| Item | Detail |
|---|---|
| (a) | `GET https://chatgpt.com/backend-api/wham/usage`, `Authorization: Bearer <access_token>`, `OpenAI-Beta: codex-1`, `Originator: Codex Desktop`, optional `Chatgpt-Account-Id`. Reads `~/.codex/auth.json`. [repo] |
| (d) | `~/.codex/sessions/**.jsonl` + `archived_sessions`. Implemented. |
| (f) | Unofficial. CodexBar also uses the app-server JSON-RPC (`codex app-server`: `account/rateLimits/read`) as a fallback [C], which is the more stable path because it is the client's own protocol. |

#### Z.ai / GLM Coding Plan (also BigModel CN)
| Item | Detail |
|---|---|
| (a) windows | `GET https://api.z.ai/api/monitor/usage/quota/limit` (CN: `https://open.bigmodel.cn/api/monitor/usage/quota/limit`). Response `data.limits[]` entries with `type` in `TOKENS_LIMIT` (5-hour token quota), `TIME_LIMIT` (MCP/tool calls, monthly), `CREDIT_LIMIT` (newer credit plans); per entry: `percentage` (integer), `usage`/`currentValue`/`remaining` counts, `unit`+`number` (window length), `nextResetTime` (epoch ms), `usageDetails[]`; plan name in `data.planName`/`level`. [C: CodexBar `docs/zai.md`; S: opencode-glm-quota, zai-usage] Z.ai relaunched plans with credits and a **weekly** limit [S: docs.z.ai/devpack/notice/usage-revision], so expect a weekly entry. |
| (b) spend | `GET /api/monitor/usage/model-usage?startTime=&endTime=` (tokens/calls per model), `/tool-usage`, and a day-level billing ledger `/api/platform-charge-zai/bill/day?customerId=&billingPeriod=YYYY-MM` [S, zai-usage README]. |
| (c) per-key | - (quota is account-wide). Team mode (CN) needs headers `Bigmodel-Organization`, `Bigmodel-Project`, query `type=2` [C]. |
| (d) logs | None native. Used through Claude Code/OpenCode/Zed, whose logs Burnrate already reads (prices must be mapped, see section 6). |
| (e) auth | Plan API key as `Authorization: Bearer <key>` per CodexBar; one third-party CLI sends the raw key with no `Bearer` prefix [S]. Support both with a fallback. |
| (f) | **Unofficial/undocumented** (Z.ai docs point to the dashboard). Same key as inference, so a leaked probe leaks a spendable key: enforce host allow-list. Empty `data: {}` is returned when team headers are missing, so "success with empty limits" must show "unavailable", never 0%. |

#### Kimi Code (Kimi For Coding membership) and Moonshot API
| Item | Kimi Code | Moonshot / Kimi Open Platform |
|---|---|---|
| (a) windows | `GET https://api.kimi.com/coding/v1/usages` (intl: `https://api.kimi.ai/coding/v1/usages`), `Authorization: Bearer <Kimi Code API key>`. Legacy shape: `usage{limit,used,remaining,resetTime}` (weekly request quota, numbers as strings) and `limits[]{window{duration:300,timeUnit:"TIME_UNIT_MINUTE"}, detail{limit,used,remaining,resetTime}}` (5-hour). Newer `usages` ratio pools for 5h/weekly/monthly. [C: CodexBar `docs/kimi.md`] | - |
| (b) balance | gift/promo balances via web only | `GET https://api.moonshot.ai/v1/users/me/balance` (CN: `api.moonshot.cn`), `Authorization: Bearer`. `data.available_balance` (USD intl / CNY cn; cash + voucher), `data.voucher_balance`, `data.cash_balance` (can be negative). When `available_balance <= 0` requests fail with `exceeded_current_quota_error`. [V: platform.kimi.ai/docs/api/balance] |
| (c) per-key | - | - (keys are region-bound: do not send a CN key to the intl host) |
| (d) logs | `$KIMI_SHARE_DIR/sessions` or `%USERPROFILE%\.kimi\sessions\<workdir-md5>\<session>\wire.jsonl`; record `{"timestamp":<s>,"message":{"type":"StatusUpdate","payload":{"message_id","token_usage":{"input_other","input_cache_read","input_cache_creation","output"}}}}`. Model is not on each line: read `~/.kimi/config.toml` default. Subagents under `subagents/<id>/wire.jsonl`. [C: CodeBurn `kimi.md`] | none |
| (e) auth | API key from the Kimi Code console, or CLI OAuth file `~/.kimi-code/credentials/kimi-code.json` (CLI-owned, short-lived 15 min access token: **read only, never refresh**, because Kimi rotates refresh tokens and a refresh from another process invalidates the CLI session) [C]. | API key |
| (f) | Kimi Code usage: unofficial but key-scoped. Moonshot balance: **official**, stable. | |

#### MiniMax (Coding Plan / Token Plan)
| Item | Detail |
|---|---|
| (a) | Web console endpoints, cookie auth: `/backend/account/token_plan/remains_percent` (China console, reports used and total percentages for 5-hour and weekly windows, totals can exceed 100%) and legacy `/v1/api/openplatform/coding_plan/remains`; hosts `platform.minimax.io`, `platform.minimaxi.com`, `platform.minimax.cn`. Coding Plan API tokens are `sk-cp-*` (standard keys are `sk-api-*`). [C: CodexBar `docs/minimax.md`] Response field names not published: **[U]**. |
| (b)-(c) | - |
| (d) | Used through other CLIs; no native log. |
| (e) | API token (`sk-cp-*`) preferred; cookie fallback. |
| (f) | Unofficial. Defer; ship only the key-with-budget/log path until a token-auth quota endpoint is verified live. |

#### GitHub Copilot
| Item | Detail |
|---|---|
| (a) windows | `GET https://api.github.com/copilot_internal/user`, headers `Authorization: token <github oauth token>`, `Accept: application/json`, `Editor-Version: vscode/1.96.2`, `Editor-Plugin-Version: copilot-chat/0.26.7`, `User-Agent: GitHubCopilotChat/0.26.7`, `X-Github-Api-Version: 2025-04-01`. Fields: `quota_snapshots.premium_interactions` (percent remaining, entitlement/remaining, unlimited flag, `credits_used` for token-based billing), `quota_snapshots.chat`, `quota_reset_date` (ISO or `YYYY-MM-DD`), `copilotPlan`/`access_type_sku`. Premium-request counters reset on the 1st 00:00 UTC. [C: CodexBar `docs/copilot.md`; S: docs.github.com] Exact JSON key spelling varies (camel vs snake): **[U]** until tested live. |
| (b) spend | Official REST: `GET /users/{username}/settings/billing/premium_request/usage` (fine-grained PAT with user permission "Plan: read"; data for the last 24 months; enterprise/org variants exist) [S: docs.github.com/en/rest/billing/usage]. Gives included usage, billed overage, remaining. |
| (c) budgets | Web-only `github.com/settings/billing/budgets` (cookie) - skip. |
| (d) logs | Copilot CLI: `~/.copilot/session-state/<id>/events.jsonl` (`assistant.usage`, `session.usage_checkpoint` events) and SQLite `~/.copilot/session-store.db` table `assistant_usage_events` (column `total_nano_aiu`); VS Code Copilot Chat: `%APPDATA%\Code\User\workspaceStorage\<hash>\chatSessions\*.jsonl` (delta journal: `kind:0` set root, `kind:1` set path, `kind:2` append) and `...\GitHub.copilot-chat\transcripts\`; OTel store `agent-traces.db` has full input/output/cache; JetBrains Nitrite DBs under `~/.config/github-copilot/<ide>/...`; ccusage reads `~/.copilot/otel/*.jsonl`. [C: CodeBurn `copilot.md`; S: ccusage] Premium requests are not tokens: price in "credits/premium requests", not USD. |
| (e) auth | GitHub OAuth device-flow token (scope `read:user`) that Burnrate would obtain itself, or a token read from Copilot's local config [U: `~/.config/github-copilot/apps.json` / `hosts.json`; do not rely on without checking]. For the official billing API: a user-created fine-grained PAT. |
| (f) | `copilot_internal` is **unofficial**; REST billing is **official** (but needs the user to create a PAT). Largest user base of any coding plan, so worth shipping with the official PAT path as the fallback. |

#### Windsurf (Codeium)
| Item | Detail |
|---|---|
| (a) | `POST https://windsurf.com/_backend/.../GetPlanStatus` (ConnectRPC/protobuf; headers `x-auth-token` + `x-devin-*`; body `{auth_token, include_top_up_status:true}`) -> daily/weekly quota %. [C: CodexBar `windsurf.md`] Requires `devin_session_token`, `devin_auth1_token`, `devin_account_id`, `devin_primary_org_id` taken from a browser's localStorage. |
| (d) | Local cache: SQLite `state.vscdb`, `ItemTable` key `windsurf.settings.cachedPlanInfo` (macOS `~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb`; Windows `%APPDATA%\Windsurf\User\globalStorage\state.vscdb` **[U: by VS Code convention]**). Stale until Windsurf launches. |
| (f) | Web-session based, **not recommended**. Support only the local-cache read (read-only, safe). |

#### Amp (Sourcegraph)
| Item | Detail |
|---|---|
| (a)-(b) | `amp usage` CLI output; or `POST https://ampcode.com/api/internal?userDisplayBalanceInfo` with `AMP_API_KEY`/access token. Gives Amp Free daily meter (resets 20:00 America/New_York), monthly subscription pools (Agent $, Orb hours), individual and workspace credit balances. [C: CodexBar `docs/amp.md`] Response schema **[U]**. |
| (d) | `$AMP_DATA_DIR/threads/**/*.json` or `~/.local/share/amp/threads/` (Windows path **[U]**, likely `%USERPROFILE%\.local\share\amp\threads`). `{id, messages[], usageLedger.events[]{id,timestamp,model,tokens{input,output,total},toMessageId,credits}}`; cache tokens live on the message, not the event. [C: CodeBurn `amp.md`] |
| (f) | Internal endpoint, token is a user-created access token (acceptable). |

#### Factory Droid
| Item | Detail |
|---|---|
| (a) | Factory billing-limits endpoint with `Authorization: Bearer <FACTORY_API_KEY>` (key also in `~/.factory/.env`). Exact URL **[U]** (not in the fetched docs). [C: CodexBar `docs/factory.md`] |
| (d) | `$FACTORY_DIR` or `~/.factory/sessions/<subdir>/*.jsonl`. [C: CodeBurn `droid.md`] |
| (f) | Unofficial. Logs-only first. |

#### Kiro (AWS)
| Item | Detail |
|---|---|
| (a) | `POST https://codewhisperer.us-east-1.amazonaws.com/` (EU: `https://q.eu-central-1.amazonaws.com/`), header `X-Amz-Target: AmazonCodeWhispererService.GetUsageLimits`, body `{"profileArn": "..."}` (or `{}` for Builder ID logins), bearer from the CLI's SQLite `data.sqlite3` table `auth_kv` key `kirocli:odic:token` -> `access_token`. Fallback: `kiro-cli chat --no-interactive "/usage"` (parses ANSI). [C: CodexBar `docs/kiro.md`] |
| (d) | `%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\` (legacy `.chat`, extensionless exec files) and `~/.kiro/sessions/...` (CLI `cli/<id>.jsonl`, IDE `sess_<id>/`). [C: CodeBurn `kiro.md`] |
| (f) | Private CLI service contract; read the token **read-only**. Low priority. |

#### JetBrains AI
| Item | Detail |
|---|---|
| (a) | Local file `<IDE config>/options/AIAssistantQuotaManager2.xml` (XML with HTML-encoded JSON): monthly credits and refill date; fresher state in `idea.log` (`QuotaManager2Impl - New quota state is: Available(...)`, Junie `quota_update:{...}` with `tariffQuota`, `until` epoch ms). Config dirs: macOS `~/Library/Application Support/JetBrains/`, Linux `~/.config/JetBrains/`; Windows `%APPDATA%\JetBrains\<IDE><ver>\options\` **[U]**. [C: CodexBar `docs/jetbrains.md`] |
| (f) | Purely local, read-only: **safest** possible source. Good first "local quota" example for the definition format (file source, not HTTP). |

#### Cline / ClinePass, Kilo, Codebuff, ZenMux, Synthetic, Chutes, Neuralwatt (smaller coding plans with API-key quota endpoints) [C]
| Provider | Endpoint | Shape |
|---|---|---|
| ClinePass | `GET https://api.cline.bot/api/v1/users/me/plan/usage-limits` (`CLINE_API_KEY`, or `cline auth` session file) | 5-hour, weekly and monthly limits. |
| ZenMux | management API key | five-hour and seven-day windows plus PAYG balance. |
| Synthetic | `SYNTHETIC_API_KEY`, quota API | weekly credits, search-hourly lane, optional 5-hour. |
| Chutes | `https://api.chutes.ai` subscription usage + quota | rolling, monthly, PAYG. |
| Neuralwatt | `GET https://api.neuralwatt.com/v1/quota` | kWh subscription usage + USD prepaid + per-key allowance. |
| Kilo | `KILO_API_KEY`; CLI auth `~/.local/share/kilo/auth.json` (`kilo.access`) | endpoint **[U]**. |
| Codebuff | `CODEBUFF_API_KEY` or `~/.config/manicode/credentials.json` | credits, weekly rate limit; base URL override `CODEBUFF_API_URL`. |
Local: Cline/Kilo/Roo tasks at `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\tasks\<id>\ui_messages.json` (+`api_conversation_history.json`) and `~/.cline/data/tasks/`; `kilocode.kilo-code` and `rooveterinaryinc.roo-cline` use the same layout [C: CodeBurn `cline.md`, `kilo-code.md`]; Codebuff `~/.config/manicode/projects/<p>/chats/<id>/chat-messages.json` (credits at $0.01 each) [C].

### 2.2 First-party model APIs (API keys)

#### OpenAI API
| Item | Detail |
|---|---|
| (a) windows | - (no plan windows for API keys). |
| (b) spend | `GET https://api.openai.com/v1/organization/costs` (daily buckets `bucket_width=1d`, `group_by=line_item`, optional `project_ids`) and `GET /v1/organization/usage/completions` (`bucket_width=1m|1h|1d`, `group_by=model|batch|project_id|api_key_id`). Header `Authorization: Bearer <admin key>`. Admin keys (`sk-admin-...`) are created by organization owners at `platform.openai.com/settings/organization/admin-keys`; they **cannot call inference**. Usage lags 2-3 minutes. [V/S: developers.openai.com reference; C: CodexBar `docs/openai.md`] Legacy `GET /v1/dashboard/billing/credit_grants` is **not in the public reference** [C]. There is no public prepaid-balance endpoint [S]. |
| (c) per-key | Rate-limit response headers on every inference response: `x-ratelimit-limit-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-requests` (e.g. `1s`), `x-ratelimit-reset-tokens` (e.g. `6m0s`). [V: developers.openai.com/api/docs/guides/rate-limits] Community reports `-1`/`0` anomalies [S]. Per-project caps: `GET /v1/organization/projects/{id}/rate_limits`; there is no organization-level limits endpoint [C]. |
| (d) logs | Via tools (Codex with API key, OpenCode, ...). |
| (e) auth | Admin key for costs; normal key only for headers. |
| (f) | **official-admin**, stable. Project service-account keys cannot read these endpoints. |

#### Anthropic API
| Item | Detail |
|---|---|
| (b) spend | `GET https://api.anthropic.com/v1/organizations/cost_report` (USD decimal strings in cents, `1d` buckets only; Priority Tier excluded) and `GET /v1/organizations/usage_report/messages` (`bucket_width` 1m/1h/1d; group by model, workspace, service tier, api_key_id; `has_more`/`next_page` pagination). Headers: `x-api-key: sk-ant-admin01-...` (or OAuth token with `org:admin`), `anthropic-version: 2023-06-01` (docs examples now use `2026-10-21`). Marked **legacy**; the recommended replacement is the "Usage and Cost Analytics API" (`GET /v1/organizations/analytics/usage`). **Not available to the Team plan or individual Console accounts**, and not on Claude Platform on AWS. [V: platform.claude.com/docs/en/manage-claude/usage-cost-api] Console prepaid credit balance is only available through undocumented cookie endpoints [C: CodexBar `claudeplatform`] - skip. |
| (c) per-key | Response headers: `anthropic-ratelimit-requests-{limit,remaining,reset}`, `anthropic-ratelimit-tokens-{limit,remaining,reset}` (reset in RFC 3339, token remaining rounded to nearest thousand), `-input-tokens-`, `-output-tokens-`, and `retry-after` on 429. [S: docs.anthropic.com rate limits; verify exact names] |
| (d) logs | Claude Code transcripts (implemented) cover API-key and Bedrock/Vertex routes too. Claude Code also exports OpenTelemetry metrics `claude_code.token.usage` and `claude_code.cost.usage` when `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317|4318` [V: code.claude.com/docs/en/monitoring-usage]. |
| (e)-(f) | **official-admin** for organizations; individuals must use local measurement. |

#### Google Gemini (CLI, app, API)
| Item | Detail |
|---|---|
| (a) windows | **Gemini CLI**: `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` body `{"project":"<id>"}` (or `{}`); project from `loadCodeAssist` (`cloudaicompanionProject`), tier from `POST ...:loadCodeAssist` with `{"metadata":{"ideType":"GEMINI_CLI","pluginType":"GEMINI"}}`; `Authorization: Bearer <access_token>`; creds `~/.gemini/oauth_creds.json` (`access_token`, `refresh_token`, `id_token`, `expiry_date`); refresh via `https://oauth2.googleapis.com/token` using the CLI's client id/secret extracted from the installed package's `oauth2.js` (or env `GEMINI_OAUTH_CLIENT_ID/SECRET`). [C: CodexBar `docs/gemini.md`] **Gemini app** (5-hour/weekly pools `GXU_FIVE_HOURLY`, `GXU_WEEKLY` via a cookie GraphQL call) - skip, fragile. |
| (b)-(c) | **Gemini API key / AI Studio**: no key-level balance or usage endpoint found. Spend lives in Google Cloud Billing (Budgets API, BigQuery export) and quotas in Cloud Monitoring (`generativelanguage.googleapis.com` quota metrics) **[U]**. |
| (d) logs | `%USERPROFILE%\.gemini\tmp\<project>\chats\session-*.json` or `.jsonl` (format changed after CLI 0.38; try whole-file JSON, fall back to JSONL). Token fields on `gemini`-type messages; **cached tokens are a subset of input** (subtract); thoughts billed as output. [C: CodeBurn `gemini.md`; S: official session-management doc says `~/.gemini/tmp/<project_hash>/chats/`] Optional telemetry (`gemini_cli.token.usage` counter) to `.gemini/telemetry.log` or an OTLP endpoint [S]. |
| (e) | CLI OAuth file (above), or API key (inference only). |
| (f) | CLI quota API is **unofficial** and depends on scraping the CLI's embedded OAuth client secret: medium risk. Logs are safe. Proxy: `GOOGLE_GEMINI_BASE_URL` / `GOOGLE_VERTEX_BASE_URL` are honored [V: gemini-cli `docs/reference/configuration.md`]. |

#### DeepSeek
| Item | Detail |
|---|---|
| (b) balance | `GET https://api.deepseek.com/user/balance`, `Authorization: Bearer <key>`, `Accept: application/json`. Response `{"is_available": true, "balance_infos": [{"currency":"CNY"|"USD", "total_balance":"110.00", "granted_balance":"10.00", "topped_up_balance":"100.00"}]}` (all amounts are **strings**; one entry per currency). [V: api-docs.deepseek.com/api/get-user-balance] |
| (a)/(c) | None; DeepSeek uses dynamic rate limiting, no per-key caps. Private Platform endpoints (`platform.deepseek.com/api/v0/usage/by_api_key/amount|cost`, `users/get_user_summary`) need a browser `userToken`: skip. [C] |
| (d) logs | Via CLIs. Price lookup: LiteLLM / models.dev (`deepseek` provider, e.g. `deepseek-flash` input 0.15 / output 0.6 per 1M, cache read 0.003 in models.dev). |
| (f) | **official**, stable. The simplest possible declarative example. |

#### xAI (Grok API) vs Grok consumer
| Item | Detail |
|---|---|
| (b) balance | Management API (separate **management key**, created in console.x.ai > Settings > Management Keys; inference keys are rejected): `GET https://management-api.x.ai/v1/billing/teams/{team_id}/prepaid/balance` (inverted ledger in string USD cents: a $10 top-up appears as `"-1000"`), `GET .../postpaid/invoice/preview`, `POST .../usage` (daily USD-summed analytics query; has a cardinality cap `limitReached`). [V: docs.x.ai management API; C: CodexBar `docs/xai.md`] |
| (a) | Grok consumer plan: already implemented (`cli-chat-proxy.grok.com/v1/billing?format=credits`). |
| (f) | **official-admin**. Needs team id + management key, so two fields in the UI. |

#### Mistral
Already implemented through `GET https://api.mistral.ai/v1/billing/budget` (Vibe) [repo]. Console billing/credit balance and API usage require `admin.mistral.ai` cookies [C] - skip.

#### Perplexity
| Item | Detail |
|---|---|
| (b) | Official Analytics API needs an org-admin-generated analytics key and exposes credits **used only**, not remaining [S: docs.perplexity.ai computer-analytics-api]. Balance is only in the console, or via undocumented `/rest/pplx-api/v2/groups` with a session cookie [S]. Consumer plan credits (recurring, bonus, purchased) via cookie only [C]. |
| (f) | No key-based balance. Use budget + local measurement. |

#### Groq
| Item | Detail |
|---|---|
| (c) | Response headers: `x-ratelimit-limit-requests` (= requests **per day**), `x-ratelimit-limit-tokens` (= tokens per minute), `x-ratelimit-remaining-*`, `x-ratelimit-reset-*`, `retry-after` only on 429. [V/S: console.groq.com/docs/rate-limits] |
| (b) | Spend/usage only via the console session (Stytch cookie) at `GET https://api.groq.com/platform/v1/organizations/{orgId}/activity?start_date&end_date`, or Enterprise Prometheus metrics. [C] |
| (f) | No key-based spend. Budget + proxy. |

#### Together AI
| Item | Detail |
|---|---|
| (b) | `GET /v1/billing/usage` (beta; access must be enabled by support) returns cost-annotated line items for the organization; cost analytics group by product, line item, project or API key (project/API-key grouping in beta). **No balance endpoint**; prepaid accounts hard cut off at $0 (metering delay means it is not an exact cap); project/organization budgets and spend alerts "coming soon". [V: docs.together.ai/docs/billing-spend-controls] |
| (f) | official but beta/gated. Budget + proxy is the practical path. |

#### Fireworks
| Item | Detail |
|---|---|
| (b) | `GET https://api.fireworks.ai/v1/accounts` (discover slug; `firectl whoami` also), then `GET /v1/accounts/{slug}/billing/summary?startTime=<ISO>&endTime=<ISO>` -> `lineItems[].totalCost{currencyCode, units, nanos}`; sum `units + nanos/1e9`. **No balance endpoint.** `Authorization: Bearer`. [C: CodexBar `docs/fireworks.md`] |
| (f) | Documented-in-practice, key-scoped. Good multi-step example (discover slug, then query). |

#### Cerebras / SambaNova
| Item | Detail |
|---|---|
| Cerebras | Console Analytics (Usage, Cached-Usage, Cost) is UI-only; Prometheus-format `https://cloud.cerebras.ai/api/v1/metrics/organizations/<org-id>` with bearer API key [S]. Rate-limit headers: **not confirmed** [U]. Limits are an uncached-token limit and a total-token limit per org [S]. |
| SambaNova | **Not researched in depth; no balance/usage API known [U].** Treat as OpenAI-compatible: budget + proxy/logs. |

#### Qwen / Alibaba (Model Studio, Coding Plan, Token Plan, Qwen Cloud)
| Item | Detail |
|---|---|
| (a) | Alibaba Coding Plan: console RPC with web cookies + `sec_token`, API-key fallback; Qwen Cloud Token Plan: 5-hour/weekly via `https://cs-data.qwencloud.com/data/api.json?action=IntlBroadScopeAspnGateway&product=sfm_bailian` (cookies); Alibaba Token Plan via the signed-in Bailian `bl` CLI. [C: CodexBar] All unofficial / cookie-based. |
| (b) | DashScope account balance via Alibaba Cloud BSS OpenAPI `QueryAccountBalance` (AccessKey-signed) **[U]**. |
| (d) | Qwen Code CLI: `$QWEN_DATA_DIR` or `~/.qwen/projects/<project>/chats/*.jsonl`, tokens in `usageMetadata{promptTokenCount, candidatesTokenCount, thoughtsTokenCount, cachedContentTokenCount}`, dedupe on `<sessionId>:<uuid>` [C: CodeBurn]; newer official docs describe `~/.qwen/logs/sessions/<projectId>/<sessionId>/segments/<runId>.jsonl` [S: qwenlm.github.io data-privacy 1.x] - **support both layouts**. A design proposal for `usage/token-usage-YYYY-MM.jsonl` exists (#4479) but is not confirmed shipped [S]. |
| (f) | Logs now; cookie endpoints no. |

#### Hugging Face, Poe, Venice, Ollama, others with simple key endpoints [C unless noted]
| Provider | Endpoint | Shape |
|---|---|---|
| Ollama cloud | `GET https://ollama.com/api/usage?range=24h|7d|30d` with `Authorization: Bearer $OLLAMA_API_KEY` -> `totals{request_count, usage_usd, input_tokens, cached_input_tokens, output_tokens}` + hourly/daily `buckets` [V: docs.ollama.com/api/cloud-usage]; `GET /api/balance` for remaining included/purchased credits [V: linked from the same page; schema not opened]. | official, new, clean. |
| Poe | official usage API: current point balance + history. | balance. |
| Venice | API key -> DIEM/USD balance. | balance. |
| Hugging Face | access token -> Inference Providers charges, optional ZeroGPU quota. | spend. |
| Vercel AI Gateway | `GET https://ai-gateway.vercel.sh/v1/credits` -> `balance`, `total_used` (decimal strings); personal budgets via `GET api.vercel.com/ai-gateway/budgets/list?teamId=&scopeType=user` with an access token. | balance (+ budget windows daily/weekly(Monday UTC)/monthly). |
| DeepInfra | `GET https://api.deepinfra.com/payment/checklist?compute_owed=true` (prepaid balance, billing-cycle spend, spending limit, suspension) and `GET /payment/usage?from=current`. | balance + spend + limit => real percent. |
| Atlas Cloud, abliteration, Linkup, Sofya, fal, Tripo, Soniox, Tavily, Exa, ... | single balance endpoints. | balance. |

### 2.3 Gateways, routers and proxies with budgets (the best "key with budget" sources)

#### OpenRouter
| Item | Detail |
|---|---|
| (b)+(c) key | `GET https://openrouter.ai/api/v1/key`, `Authorization: Bearer <inference or management key>`. `data` fields (verified from the OpenAPI example): `label`, `limit` (USD cap, null = none), `limit_remaining`, `limit_reset` (cadence string, e.g. `"monthly"`, nullable), `include_byok_in_limit`, `usage` (all-time USD), `usage_daily`, `usage_weekly`, `usage_monthly`, `byok_usage`, `byok_usage_daily|weekly|monthly`, `is_free_tier`, `is_management_key`, `is_provisioning_key`, `expires_at`, `creator_user_id`, `workspace_id`, `organization_id`, `allowed_data_regions[]`, `free_model_daily_requests{limit,remaining,used}`, deprecated `rate_limit{requests,interval}`, and guardrail budgets: `effective_budget` and `budgets[]` each `{budget_id, guardrail_id, scope (e.g. "member"), limit_usd, spend_usd, remaining_usd, reset_interval, resets_at (ISO), include_byok}`. [V: openrouter.ai/docs/api/api-reference/api-keys/get-current-key] Daily-reset boundaries (UTC midnight, Monday weekly, 1st monthly) are documented elsewhere on OpenRouter [U]. |
| (b) credits | `GET https://openrouter.ai/api/v1/credits` -> `data{total_credits, total_usage}` (USD; balance = difference). **Management key required** [V: openrouter.ai/docs/api/api-reference/credits/get-credits]. CodexBar still *tries* the normal key and treats a rejection as "balance unavailable" [C]. |
| (b) activity | `GET /api/v1/activity` (management key): last 30 completed UTC days. |
| models/prices | `GET https://openrouter.ai/api/v1/models` (public; 477 models at fetch time; `pricing` as per-token **strings**, e.g. `{"prompt":"0.000002","completion":"0.000006"}`; also `context_length`, `top_provider`, `per_request_limits`). [V, fetched] |
| (d) logs | none; usage comes from the tools. The response `usage` object can carry `cost` per call [U], which makes proxy measurement exact. |
| (f) | **official**, stable, richest per-key data. The reference implementation for "key with budget". |

#### LiteLLM proxy (self-hosted gateway)
| Item | Detail |
|---|---|
| (b)+(c) | With a **virtual key** (not the master key): `GET {base}/key/info` -> `spend`, `max_budget`, `budget_duration` (e.g. `"30d"`), `budget_reset_at`, `rpm_limit`, `tpm_limit`, `user_id`, `team_id`; then `GET /user/info?user_id=` or `GET /team/info?team_id=` for personal/team budgets and member budgets (`team_memberships[].litellm_budget_table`). Base URL may or may not end in `/v1`; management calls go to the root. `Authorization: Bearer <virtual key>`. [C: CodexBar `docs/litellm.md`; S: docs.litellm.ai/docs/proxy/users] |
| (f) | official, but self-hosted so base URLs are user-supplied: SSRF rules in section 7 apply (CodexBar allows plain HTTP only to loopback/RFC1918/link-local/ULA/`.local`). |

#### Other gateways (all key + base URL) [C]
Bifrost (`GET /api/governance/virtual-keys/quota`, header `x-bf-vk: <virtual key>`, budgets ordered by shortest reset cycle), sub2api (`GET /v1/usage`: key quota, 5h/day/week limits, wallet balance), ClawRouter (`GET /v1/usage`: monthly budget, spend), LLM Proxy (`GET /v1/quota-stats`), Aixy (`/v1/usage`), Wayfinder (loopback gateway: `/healthz`, `/v1/savings`). They show the pattern clearly: **`GET <base>/<something>` with the same key returns a budget/spend object**. A declarative format can cover all of them.

### 2.4 Clouds (enterprise-style, SigV4/OAuth, lower priority)

| Cloud | Spend / usage | Limits | Local logs | Notes |
|---|---|---|---|---|
| **AWS Bedrock** | AWS Cost Explorer `GetCostAndUsage` filtered to Bedrock (also AWS Budgets); **$0.01 per Cost Explorer request** and CodexBar caches for 6 h [V/C: CodexBar `docs/bedrock.md`]. CloudWatch `AWS/Bedrock` metrics (rolling token/request totals, extra CloudWatch charges) [C]. | Service Quotas [U]. | Claude Code and OpenCode transcripts when run against Bedrock (Hermes records `billing_provider`) [C]. | SigV4 signing needed (Rust: `aws-sigv4`/`aws-config`) or shell out to `aws` CLI. Price ids: `anthropic.claude-...-v1:0`, `us.`/`eu.`/`global.` inference profiles (pricing.rs already has Bedrock base-id aliasing). |
| **Google Vertex AI** | Billing export to BigQuery [U]; Cloud Monitoring quota metrics `serviceruntime.googleapis.com/quota/allocation/usage` vs `.../quota/limit`, resource `consumer_quota`, `service="aiplatform.googleapis.com"` -> quota used %. Auth: `gcloud auth application-default login` (ADC). [C: CodexBar `docs/vertexai.md`] | same. | Claude Code transcripts filtered to Vertex entries. | Needs Cloud Monitoring API enabled. |
| **Azure OpenAI / Foundry** | Azure Monitor metrics (`ProcessedPromptTokens`, `ProcessedInferenceTokens`; PTU utilization) [S: learn.microsoft.com monitor-openai-reference]; Cost Management Query API [U]; no key-level balance. | Response headers `x-ratelimit-remaining-requests|tokens` [U for Azure specifics]. Deployment validation by a minimal chat call is what CodexBar does [C]. | via tools. | Endpoint is **user-specific** (`https://<res>.openai.azure.com`, `api-key` header, `api-version`): must enforce HTTPS and host suffix `.openai.azure.com`/`.cognitiveservices.azure.com`/`.services.ai.azure.com` [C: CodexBar blocks http/userinfo]. |

### 2.5 Local-log-only agents (cost + tokens, no quota API)
| Tool | Path (Windows `%USERPROFILE%` = `~`) | Format / tokens | Source |
|---|---|---|---|
| Gemini CLI | `~/.gemini/tmp/<project>/chats/session-*.json|jsonl` | per `gemini` message: input (includes cached), output, thoughts, cached | [C] |
| Qwen Code | `~/.qwen/projects/<p>/chats/*.jsonl` or `~/.qwen/logs/sessions/<id>/<sid>/segments/*.jsonl` | `usageMetadata` (Gemini-style) | [C]/[S] |
| Kimi CLI | `~/.kimi/sessions/<md5>/<sid>/wire.jsonl` | `StatusUpdate.token_usage` | [C] |
| Copilot CLI / Chat | `~/.copilot/session-state/`, `~/.copilot/session-store.db`, `%APPDATA%\Code\User\workspaceStorage\*\chatSessions\*.jsonl` | `assistant.usage`, `assistant_usage_events` | [C] |
| Amp | `~/.local/share/amp/threads/**/*.json` | `usageLedger.events` | [C] |
| Droid | `~/.factory/sessions/*/*.jsonl` | jsonl | [C] |
| Cline/Kilo/Roo | VS Code `globalStorage\<ext>\tasks\<id>\ui_messages.json` | `api_req_started` entries | [C] |
| Goose | Windows `%APPDATA%\Block\goose\sessions\sessions.db`; Linux `~/.local/share/goose/sessions/sessions.db` | SQLite | [C] |
| Crush | registry `%LOCALAPPDATA%\crush\projects.json` -> per-project `<project>/.crush/crush.db`, table `sessions(prompt_tokens, completion_tokens, cost, ...)` | SQLite; **has a reported `cost`** | [C] |
| Zed | Windows `%LOCALAPPDATA%\Zed\threads\threads.db`; Linux `~/.local/share/zed/threads/threads.db` | SQLite, zstd-compressed JSON `request_token_usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` | [C] |
| Hermes | `%LOCALAPPDATA%\hermes\state.db` or `$HERMES_HOME/state.db` | SQLite session aggregates incl. cost and `billing_provider` | [C] |
| Mistral Vibe | `$VIBE_HOME/logs/session/` or `~/.vibe/logs/session/` (legacy `meta.json`+`messages.jsonl`; 2.25+ `unified/<id>/` journals) | cumulative envelopes | [C] |
| Warp | macOS group container `warp.sqlite` (Windows path **[U]**) | SQLite | [C] |
| OpenCode, Codex, Claude, Grok, Pi, Muse, Antigravity | implemented | | repo |

Note ccusage (the most-used tracker) currently lists ~20 sources (Claude Code, Codex, OpenCode, Amp, Droid, Codebuff, Cline, Hermes, pi-agent, Goose, OpenClaw, Kilo, Kimi, Qwen, Copilot CLI, Gemini CLI, Antigravity, Grok Build, ZCode, DeepSeek Harness) [S], so those are the de facto "expected" adapters.

---

## 3. Master matrix (what each provider can give Burnrate)

Legend: W = quota windows (% + reset), B = balance, S = spend over period, K = key-level cap/limit, H = rate-limit headers, L = local logs. Auth: key / admin key / cli-file / cookie / oauth. Official: O official, A official-admin, U unofficial, L local.

| Provider | W | B | S | K | H | L | Auth | Official | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Claude Code sub | yes | - | - | - | - | yes | cli-file | U | implemented |
| Codex/ChatGPT | yes | - | - | - | - | yes | cli-file | U | implemented |
| Cursor | yes | - | - | - | - | - | key | U | implemented |
| Grok (SuperGrok) | yes | - | - | - | - | yes | cli-file | U | implemented |
| OpenCode Go | yes | - | - | - | - | yes | key | U | implemented |
| Mistral Vibe | yes | - | - | - | - | yes | key | U | implemented |
| Z.ai GLM plan | yes | - | yes | - | - | via tools | key | U | high demand |
| Kimi Code | yes | - | - | - | - | yes | key/cli-file | U | |
| MiniMax plan | yes | - | - | - | - | - | cookie/key | U | defer |
| Copilot | yes | - | yes | - | - | yes | oauth/PAT | U + O (REST) | |
| Gemini CLI | yes | - | - | - | - | yes | cli-file | U | needs client secret from CLI install |
| Windsurf | yes | - | - | - | - | cache only | cookie | U | skip web |
| Amp | yes | yes | - | - | - | yes | key | U | |
| Kiro | yes | - | - | - | - | yes | cli-file | U | |
| JetBrains AI | yes | - | - | - | - | yes | none | L | local file |
| ClinePass / ZenMux / Synthetic / Chutes / Neuralwatt | yes | some | - | some | - | - | key | U | |
| OpenAI API | - | - | yes | - | yes | via tools | admin key | A | |
| Anthropic API | - | - | yes | - | yes | yes | admin key | A | orgs only |
| Gemini API | - | - | - | - | - | yes | key | - | local only |
| DeepSeek | - | yes | - | - | - | via tools | key | O | |
| Moonshot API | - | yes | - | - | - | via tools | key | O | |
| xAI API | - | yes | yes | - | - | - | mgmt key | A | |
| OpenRouter | - | mgmt | yes | yes | - | - | key (+mgmt) | O | |
| LiteLLM / Bifrost / sub2api / ClawRouter | maybe | maybe | yes | yes | - | - | virtual key | O | self-hosted |
| Vercel AI Gateway | - | yes | yes | yes (budgets) | - | - | key / token | O | |
| Ollama cloud | - | yes | yes | - | - | - | key | O | |
| Together | - | - | yes (beta) | - | - | - | key | O (gated) | no balance |
| Fireworks | - | - | yes | - | - | - | key | O | no balance |
| Groq | - | - | console only | - | yes | - | key | O (headers) | |
| Perplexity API | - | console only | admin only (used) | - | - | - | - | - | |
| Cerebras | - | - | console only | - | ? | - | key | - | Prometheus endpoint |
| Bedrock | - | - | yes ($0.01/req) | quotas | - | via tools | AWS creds | O | SigV4 |
| Vertex | quota % | - | BQ export | quotas | - | via tools | ADC | O | |
| Azure OpenAI | - | - | Cost Mgmt | - | ? | via tools | Entra/key | O | |

---

## 4. Design 1 - A universal provider model ("provider definition")

### 4.1 Goals and shape
- A **provider definition** is a declarative file (TOML for humans, canonical JSON for storage/validation) that describes: how to authenticate, one or more **probes** (HTTP calls or local file reads), and how to map each response onto Burnrate's output shapes: `windows[]` (existing `UsageWindow`), `balances[]` (new), `spend[]` (new) and `plan`.
- Bundled definitions ship in the binary (`include_str!`); user definitions live in `data/providers.d/*.toml`; a UI form edits them. Built-in Rust providers (Claude, Codex, Cursor, Kiro protobuf, Bedrock SigV4, ...) stay as code; a definition can say `engine = "builtin:cursor"`.
- Mapping language: **RFC 9535 JSONPath** (Rust crate e.g. `serde_json_path`) with a small closed set of transforms. No scripting, no `eval`. (A cheaper v1 alternative is JSON Pointer via `serde_json::Value::pointer`, which the code already uses, plus `[*]` and one filter; JSONPath is nicer for `data.limits[?(@.type=='TOKENS_LIMIT')]`.)
- Multi-step probes with **captures** (output of step N becomes `{{var}}` in step N+1), needed for Cursor (key exchange), LiteLLM (`/key/info` then `/user/info`), Fireworks (accounts then billing).

### 4.2 Schema (v1)

```toml
schema = 1                       # integer, required
id = "openrouter"                # [a-z0-9-]{2,40}, unique
label = "OpenRouter"
color = "#6467f2"
icon = "openrouter"              # optional; falls back to initials
category = "gateway"             # subscription | api | gateway | cloud | local
homepage = "https://openrouter.ai"
dashboardUrl = "https://openrouter.ai/settings/credits"   # -> UsageLimits.externalUsage

[auth]
kind = "apiKey"                  # apiKey | adminKey | bearerFile | oauthFile | none
env  = ["OPENROUTER_API_KEY"]    # optional: offer to import from env
fields = [
  { id = "key", label = "API key", secret = true, pattern = "^sk-or-" },
  # { id = "teamId", label = "Team ID", secret = false }
]
# kind = "oauthFile": file = "~/.kimi-code/credentials/kimi-code.json", pointer = "$.access_token", readOnly = true

[net]
hosts = ["openrouter.ai"]        # REQUIRED allow-list: the key is only ever sent to these hosts
allowLocal = false               # true permits loopback/RFC1918 + plain http (self-hosted gateways)
timeoutMs = 8000
maxBytes = 1048576

[[steps]]                        # sequential; a failed `optional` step is skipped
id = "key"
method = "GET"                   # GET | POST
url = "https://openrouter.ai/api/v1/key"
headers = { Authorization = "Bearer {{key}}", Accept = "application/json" }
# body = '{"project": "{{teamId}}"}'  (string; JSON or form); query = { range = "30d" }
ttl = "60s"                      # cache time for this step
test = true                      # used by "Test key" (must be 200 and pass `require`)
expect = { status = [200] }
require = ["$.data"]             # response invalid (not "0%") when missing
capture = { }                    # name = JSONPath (string or number), usable as {{name}} in later steps

  [[steps.windows]]              # 0..n windows per step
  when = "$.data.limit != null"
  id = "key-limit"
  kind = "monthly"               # session|weekly|monthly|other  OR  kindFrom = { path=..., map={...} }  OR  kindByDuration = true
  label = "Key limit"
  used = "$.data.limit - $.data.limit_remaining"     # expr (see 4.3)
  limit = "$.data.limit"
  # usedPercent = "$.data.percentage"               # alternative when the API gives a percent
  resetsAt = { coalesce = ["$.data.effective_budget.resets_at", { cadence = "$.data.limit_reset" }] }
  windowDurationMins = { cadence = "$.data.limit_reset" }
  unit = "usd"                   # for tooltip: "$12.50 of $50"

  [[steps.balances]]
  when = "..."
  id = "credits"
  label = "Credits"
  role = "remaining"             # remaining | spent | limit
  amount = "$.data.total_credits - $.data.total_usage"
  currency = "USD"               # literal or JSONPath
  # select = "$.balance_infos[*]"  -> one balance per array element (paths inside are relative)
  breakdown = [ { label = "Granted", path = "$.granted_balance" } ]
  lowBelow = 5.0                 # optional: tint when under this amount

  [[steps.spend]]                # period spend, optionally with tokens
  id = "month"
  label = "This month"
  period = "month"               # day | week | month | rolling:30d | custom
  amount = "$.data.usage_monthly"
  currency = "USD"
  tokens = { input = "$.in", output = "$.out", cached = "$.cache" }   # optional

[plan]
path = "$.data.planName"         # optional; or literal

[[test]]                         # offline fixtures, run in CI and by "Validate definition"
step = "key"
response = '''{"data":{"limit":100,"limit_remaining":74.5,"limit_reset":"monthly","usage_monthly":25.5}}'''
expect = { windows = [{ id = "key-limit", usedPercent = 25.5 }] }
```

Other source kinds (replace `[[steps]]`):
- `[[files]]`: `path = ["%LOCALAPPDATA%/...", "~/.config/..."]`, `format = "json|xml|toml|sqlite"`, `query` (SQLite) or `xpath`, same mapping blocks. (JetBrains quota XML, Windsurf `cachedPlanInfo`.)
- `[[logs]]`: JSONL/SQLite transcript mapping to `Record` fields for cost+tokens (see 4.4 example 3). Replaces the need for a new Rust reader in the common case.
- `[proxy]` section (see section 8): declares upstream base URL, wire protocol (`openai|anthropic|gemini`), and how to extract the model and usage from responses.

### 4.3 Expressions and transforms (closed set)
- Arithmetic on JSONPath values: `+ - * / ( )`, `min()`, `max()`, `clamp()`, `coalesce()`, `percent(a,b)` (= 100*a/b, guards b=0), `round()`.
- Value coercion: numbers may arrive as strings (`"110.00"`, Kimi `"2048"`) so every numeric read uses `toNumber`; invalid -> step result "invalid", never 0.
- Time: `as = "iso" | "epochMs" | "epochSec" | "rfc3339"`; `cadence` (maps `daily|weekly|monthly` to next UTC boundary and duration in minutes); `durationMins = { value = "$.window.duration", unit = "$.window.timeUnit", map = { TIME_UNIT_MINUTE = 1, TIME_UNIT_HOUR = 60, TIME_UNIT_DAY = 1440 } }`.
- `kindByDuration = true`: <=360 min session, ~10080 weekly, 28-31 days monthly, else other (works for Z.ai/Kimi/Copilot where only the length is given).
- Iteration: `select = "<JSONPath returning array>"` on a windows/balances block produces one item per match; `{{index}}`, `{{item.field}}` available in `id`/`label`.
- Safety invariants (enforced by the engine, not the file): percent is clamped to 0..100 (existing `clamp`); a response that matches no windows and has `limits` empty is `unavailable{reason:"unsupported"}` (Z.ai lesson: empty success is not 0%); string/array sizes capped.

### 4.4 Worked examples

#### Example A: OpenRouter (`/key` + optional `/credits`)

```toml
schema = 1
id = "openrouter"
label = "OpenRouter"
color = "#6467f2"
category = "gateway"
dashboardUrl = "https://openrouter.ai/settings/credits"

[auth]
kind = "apiKey"
env = ["OPENROUTER_API_KEY"]
fields = [{ id = "key", label = "API key (sk-or-v1-...)", secret = true, pattern = "^sk-or-" }]

[net]
hosts = ["openrouter.ai"]

[[steps]]
id = "key"
url = "https://openrouter.ai/api/v1/key"
headers = { Authorization = "Bearer {{key}}" }
ttl = "60s"
test = true
require = ["$.data"]

  # Key-level spending cap (only if the key has one)
  [[steps.windows]]
  when = "$.data.limit != null"
  id = "key-cap"
  label = "Key spending cap"
  kindFrom = { path = "$.data.limit_reset", map = { daily = "other", weekly = "weekly", monthly = "monthly" }, default = "other" }
  used = "$.data.limit - $.data.limit_remaining"
  limit = "$.data.limit"
  unit = "usd"
  resetsAt = { coalesce = ["$.data.effective_budget.resets_at", { cadence = "$.data.limit_reset" }] }
  windowDurationMins = { cadence = "$.data.limit_reset" }

  # Guardrail / workspace budget enforced for this key (can be stricter than the key cap)
  [[steps.windows]]
  select = "$.data.budgets[*]"
  when = "$.limit_usd != null"
  id = "budget-{{index}}"
  label = "Budget ({{item.scope}})"
  kindFrom = { path = "$.reset_interval", map = { daily = "other", weekly = "weekly", monthly = "monthly" }, default = "other" }
  used = "$.spend_usd"
  limit = "$.limit_usd"
  unit = "usd"
  resetsAt = { path = "$.resets_at", as = "iso" }

  # Free-tier daily request allowance
  [[steps.windows]]
  when = "$.data.free_model_daily_requests != null"
  id = "free-daily"
  label = "Free models (requests/day)"
  kind = "other"
  used = "$.data.free_model_daily_requests.used"
  limit = "$.data.free_model_daily_requests.limit"
  unit = "requests"

  [[steps.spend]]
  id = "month"
  label = "This month"
  period = "month"
  amount = "$.data.usage_monthly"
  currency = "USD"

[[steps]]
id = "credits"
optional = true                     # management keys only: 401/403 => silently skipped, shown as "balance needs a management key"
url = "https://openrouter.ai/api/v1/credits"
headers = { Authorization = "Bearer {{key}}" }
ttl = "5m"

  [[steps.balances]]
  id = "credits"
  label = "Credits"
  role = "remaining"
  amount = "$.data.total_credits - $.data.total_usage"
  currency = "USD"
  lowBelow = 5.0

[[test]]
step = "key"
response = '''{"data":{"limit":100,"limit_remaining":74.5,"limit_reset":"monthly","usage_monthly":25.5,"free_model_daily_requests":{"limit":50,"remaining":38,"used":12}}}'''
expect = { windows = [{ id = "key-cap", kind = "monthly", usedPercent = 25.5 }, { id = "free-daily", usedPercent = 24 }] }
```

#### Example B: DeepSeek (`/user/balance`, balance only, synthetic window from a baseline)

```toml
schema = 1
id = "deepseek"
label = "DeepSeek"
color = "#4d6bfe"
category = "api"
dashboardUrl = "https://platform.deepseek.com/usage"

[auth]
kind = "apiKey"
env = ["DEEPSEEK_API_KEY", "DEEPSEEK_KEY"]
fields = [{ id = "key", label = "API key", secret = true, pattern = "^sk-" }]

[net]
hosts = ["api.deepseek.com"]

[[steps]]
id = "balance"
url = "https://api.deepseek.com/user/balance"
headers = { Authorization = "Bearer {{key}}", Accept = "application/json" }
ttl = "5m"
test = true
require = ["$.balance_infos"]

  [[steps.balances]]
  select = "$.balance_infos[*]"            # one entry per currency; amounts are strings
  id = "balance-{{item.currency}}"
  label = "Balance ({{item.currency}})"
  role = "remaining"
  amount = "$.total_balance"
  currency = "$.currency"
  breakdown = [
    { label = "Topped up", path = "$.topped_up_balance" },
    { label = "Granted",   path = "$.granted_balance" },
  ]
  lowBelow = 2.0

  # Optional: turn a prepaid balance into a window so it shows in the Limits view.
  # The engine remembers the highest balance seen since the last detected top-up
  # (a balance increase > 1% counts as a top-up) and reports used = 1 - balance/baseline.
  [steps.balances.asWindow]
  baseline = "highWaterMark"               # or { fixed = 100.0 } (user-editable)
  kind = "other"
  label = "Prepaid credit left"

[[test]]
step = "balance"
response = '''{"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"110.00","granted_balance":"10.00","topped_up_balance":"100.00"}]}'''
expect = { balances = [{ id = "balance-USD", amount = 110.0 }] }
```
Note: when `is_available` is `false` the engine should surface "insufficient balance" rather than a 100% bar; add `flag = { path = "$.is_available", whenFalse = "Balance exhausted" }`.

#### Example C: a generic OpenAI-compatible endpoint with only local logs (self-hosted vLLM / any provider with no usage API)

```toml
schema = 1
id = "my-vllm"
label = "GPU box (vLLM)"
color = "#8c7bd1"
category = "api"

[auth]
kind = "none"                      # or apiKey if the server requires one (used only by the proxy to forward)

[net]
hosts = ["gpu-box.lan"]
allowLocal = true                  # RFC1918 + http allowed, user explicitly opted in

# 1) No usage API -> measure through the Burnrate local proxy
[proxy]
upstream = "http://gpu-box.lan:8000/v1"
wire = "openai"                    # openai | anthropic | gemini
path = "/p/my-vllm"                # clients use http://127.0.0.1:<port>/p/my-vllm/v1
forwardAuth = "client"             # pass the client's Authorization through; never stored
usage = { input = "$.usage.prompt_tokens", output = "$.usage.completion_tokens",
          cached = "$.usage.prompt_tokens_details.cached_tokens", model = "$.model" }

# 2) Or: read a log the user already has (JSONL, one object per request)
# [[logs]]
# glob = ["~/vllm-logs/*.jsonl"]
# format = "jsonl"
# ts = { path = "$.ts", as = "epochSec" }
# model = "$.model"
# tokens = { input = "$.prompt_tokens", output = "$.completion_tokens" }
# key = "$.api_key_name"

# 3) Prices: self-hosted, so use a flat user-defined rate (per 1M tokens), currency USD
[pricing]
source = "custom"
rates = { "*" = { input = 0.10, output = 0.30 } }      # or alias to a known model: alias = "llama-3.3-70b-instruct"

# 4) Budget (see section 5). Creates a monthly window from measured spend.
[budget]
amount = 50.0
currency = "USD"
period = "month"
```

### 4.5 Engine integration (Rust)
- New `providers::declarative::Declarative { def }` implementing the existing `Provider` trait: `read()` runs steps, applies TTL caches, and builds `Window`s via `account_with`. `all()` = built-ins + bundled defs + user defs. `test_key()` runs steps flagged `test`.
- `contracts.ts` additions: `LimitsAccount.balances?: {id,label,amount,currency,role,asOf,breakdown?}[]`, `spend?: {...}[]`, `UsageWindow.used?/limit?/unit?` (for "$12.50 of $50.00" tooltips), `UsageWindow.source?: "provider" | "measured" | "budget"` and a `estimated` flag. UI: a "Credits" row type in the Providers/Limits views for balance-only providers.
- Registry import: `models.dev/api.json` already lists 324 providers with `api` (base URL), `env` (key variable names) and per-model `cost`; use it to **pre-fill the "Add custom provider" wizard** (name, base URL, env var, models, prices) for any OpenAI-compatible provider, and to detect which keys are present in the environment.
- Definitions are data, so the community can contribute them as PRs (with `[[test]]` fixtures) without touching Rust. Ship an "Unverified" badge for definitions without a passing live check.

---

## 5. Design 2 - "Key with budget" (user budget + locally measured spend => window)

### 5.1 Concept
Many keys have a budget the provider does not expose (Anthropic API for individuals, Gemini, Groq, Perplexity, Cerebras, Together, Fireworks balance, Azure). The user types a budget; Burnrate measures spend itself and emits a normal `UsageWindow`.

```
KeyBudget {
  providerId, keyName,                       // keyName is the existing KeyStore name
  amount: 50.0, currency: "USD",
  period: "month" | "week" | "day" | "rolling:Nd",
  anchor: { dayOfMonth: 1 | "billing" , tz: "UTC" },   // match the provider's reset (e.g. OpenRouter UTC, Anthropic Console = billing cycle)
  measure: "proxy" | "logs" | "both",
  alerts: [0.5, 0.8, 0.95],                  // notifications
  mode: "monitor" | "enforce",               // enforce only with proxy: reject with 429 + message when exceeded
}
```

### 5.2 Output window
`Window { id: "budget:<provider>:<key>", kind: monthly|weekly|other, label: "Budget", usedPercent = clamp(100 * spend / amount), resetsAt = next anchor, windowDurationMins = period length, used = spend, limit = amount, unit = "usd", source: "budget", estimated: true }`. The existing pace tick (even-spend marker) works unchanged, since window length and reset are known.

### 5.3 Measuring spend per key
- **Proxy**: the proxy sees the `Authorization`/`x-api-key`/`api-key`/`x-goog-api-key` header; compute `fingerprint = HMAC-SHA256(installSecret, key)[0..8]` and match it to `KeyStore` entries (fingerprint stored beside the encrypted blob, no raw key in the usage store). `Record.key` already exists. Exact tokens from the response `usage`; prices from section 6.
- **Logs**: only tools that record which key/profile is used (OpenCode auth id, Hermes `billing_provider`, Crush/ Goose cost fields) can be attributed; otherwise attribute by provider ("all usage of provider X") and let the user bind a provider to a key.
- Reconcile with provider truth when available: OpenRouter `usage_monthly`/`limit_remaining`, LiteLLM `spend`, Fireworks billing summary, OpenAI/Anthropic admin cost. Rules: (1) provider-reported value wins and is labeled "from provider"; (2) local measurement is shown as "this computer only" and used to **fill gaps between provider polls** (provider data can lag 2-3 minutes to hours); (3) when both exist, show the difference as a drift badge ("provider says $12.40, local measure $9.90: other machines/tools used this key").
- Prepaid balance providers (DeepSeek, Moonshot, xAI): `budget.amount` can be omitted; the window uses the high-water-mark baseline from Example B, and local spend gives a burn rate (days of runway = balance / trailing 7-day spend).

### 5.4 Edge cases
- Currency: never convert silently. Window currency = key currency (CNY for DeepSeek CN / Moonshot CN). Optional manual FX rate in settings.
- Subscription-routed usage is $0 marginal: tag records `billing = plan|api` (Hermes already distinguishes `billing_provider`) and budgets count only `api` records unless the user chooses otherwise. Show "list-price equivalent" separately.
- Estimated cost for unknown models: count tokens but mark spend as partial ("12% of tokens unpriced"); never silently treat unpriced as $0 in a budget percent (show a warning chip).
- Clock/tz: period boundaries computed in the anchor tz (default UTC, like OpenRouter and Vercel budgets).

---

## 6. Design 3 - Pricing sources and model alias handling

| Source | URL | Content | Use |
|---|---|---|---|
| LiteLLM | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` | ~7,000 entries (7,039 fetched); keys like `azure_ai/deepseek-v3.2`; `input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`, `cache_creation_input_token_cost(_above_1hr)`, `..._above_<n>k_tokens` tiers, `litellm_provider`, `deprecation_date`, `successor_model`, `mode` | **Already used** (`pricing.rs`). Keep as primary. Cache 24 h; ship a bundled snapshot for offline start. |
| models.dev | `https://models.dev/api.json` (6.8 MB, 324 providers) | per provider: `id, env[], npm, api (base URL), name, doc, models{ cost{input, output, reasoning, cache_read, cache_write} per 1M tokens }` (e.g. deepseek `deepseek-flash` 0.15/0.6, cache_read 0.003) | **Provider catalog** (base URLs, env vars) + **provider-scoped price table**. CodexBar uses it with a 24 h TTL and 15 min unknown-model retry cooldown [C: `docs/model-pricing.md`]. Provider scoping prevents two providers with the same model id sharing prices wrongly. |
| OpenRouter models | `https://openrouter.ai/api/v1/models` (public, no key) | `pricing.prompt/completion` as per-token strings (+ image, request, cache fields when present) for `vendor/model` ids | Fallback for models routed through OpenRouter and for brand-new models LiteLLM lacks; **also the right table when the traffic really went through OpenRouter** (its prices can differ from first-party). |
| Provider pricing pages | e.g. platform.deepseek.com, openai.com/api/pricing | HTML | Never scrape. Only as documentation links in the "edit price" UI. |
| User overrides | `data/prices.json` (exists) | per-model overrides | Highest priority. Add per-provider and "flat custom rate" (self-hosted). |

**Resolution order for `(provider, model)`:** user override -> models.dev provider-scoped -> LiteLLM exact (`<litellm_provider>/<model>`) -> LiteLLM bare alias (existing candidate logic in `pricing.rs`) -> OpenRouter `vendor/model` -> unpriced (counted, flagged).

**Alias normalization (extend `normalize_key`/`strip_variant`):**
1. lowercase; strip `vendor/` prefixes (`openai/`, `anthropic/`, `moonshotai/`, `z-ai/`), but remember the vendor for scoped lookup;
2. strip OpenRouter/gateway variants `:free`, `:thinking`, `:nitro`, `:floor`, `:online`; strip date suffixes `-20250929`, `-2025-09-29`, `@20250929` (Vertex), `-v1:0`, `-v2`; Bedrock `anthropic.claude-...` and region profiles `us.`, `eu.`, `apac.`, `global.` (pricing.rs has `bedrock_base`; keep, and note regional/GovCloud IDs carry markups);
3. punctuation equivalence: `claude-sonnet-4-5` == `claude-sonnet-4.5`, `gpt-5.1` == `gpt-5-1`;
4. `-latest`/tier aliases need a **user-editable alias table**: `kimi-for-coding`, `kimi-auto`, `kimi-code` -> `kimi-k2-thinking` (CodeBurn's convention so managed Kimi Code sessions are not $0); `glm-4.6`/`glm-5.x` Z.ai ids; OpenAI's launch aliases (`gpt-daybreak-blue-latest` etc., as models.dev docs show); Claude `k3[1m]` suffix [C];
5. keep the existing `UNPRICEABLE` guard (`opus`, `sonnet`, `haiku`, `<synthetic>`) so bare family names never silently price;
6. **Route-aware pricing:** the same model id has different prices per route (Anthropic direct vs Bedrock vs Vertex vs OpenRouter). Record `route` (CodeBurn has `route = bedrock`), and use the matching table.
7. **Plan routes** (subscriptions) price at $0 marginal plus a "list-price equivalent" column (CodexBar separates native cost from list-price equivalent).
8. Provider-reported cost beats computed cost when present (Grok `costUsdTicks`, Crush `cost`, Hermes cost, OpenRouter response `usage.cost` [U]); `Record.reported` already exists.
9. Currency per price entry (CNY vs USD); never mix in one total.

---

## 7. Design 4 - Local logging proxy (OpenAI/Anthropic/Gemini-compatible)

### 7.1 What it is
A loopback HTTP server inside the Burnrate server process (separate listener, e.g. `127.0.0.1:8787`) that forwards requests to the real upstream, passes the response (including SSE streams) through byte-for-byte, and records only metadata: timestamp, provider, model, token counts (input/cached/cache-write/output/reasoning), status, latency, key fingerprint, and (optionally) response-reported cost. Users point any tool at it:

| Tool | How to point it | Verified |
|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787/p/anthropic` (also usable with gateways; setting only the URL without a gateway credential does not replace the login) | [V: code.claude.com llm-gateway] |
| Codex CLI | `openai_base_url = "http://127.0.0.1:8787/p/openai/v1"` in the **user** `~/.codex/config.toml` (project-local config ignores it); or a `[model_providers.burnrate]` table with `base_url` + `env_key`. Reserved ids `openai`, `ollama`, `lmstudio` cannot be redefined | [V: developers.openai.com/codex config docs] |
| Gemini CLI | `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_VERTEX_BASE_URL` | [V: gemini-cli configuration.md] |
| OpenCode, Cline, Kilo, Roo, Aider, Continue, Goose, Crush, Zed, Cursor (BYOK) | per-provider `baseURL` settings | [U] per tool |
| Any OpenAI-SDK app | `OPENAI_BASE_URL` / `base_url=` | standard |
Copilot, Cursor's own models, Windsurf and Antigravity are closed clients: cannot be proxied.

### 7.2 Pros and cons

| | Pros | Cons / risks |
|---|---|---|
| Accuracy | exact token counts straight from the billing response (`usage` in OpenAI JSON / final SSE chunk with `stream_options.include_usage`, Anthropic `message_start` + `message_delta` usage, Gemini `usageMetadata`); cache read/write split; no log-format drift | needs correct handling of streaming edge cases (aborted streams, retries, `include_usage` not set by the client: do not inject silently; fall back to counting if impossible and flag "estimated"). |
| Coverage | works for **any** tool and provider with a base-URL setting, including providers with no logs and no usage API; per-key attribution; non-agent scripts too | Closed clients cannot be redirected; some tools hard-code endpoints or use WebSockets (Codex Responses over WebSocket support **[U]**); subscription (OAuth) traffic needs the original host and headers preserved. |
| Control | can **enforce** budgets (return a clear 429 body when the key budget is exhausted), add per-key rate limits and alerts; the only way to turn a monitor into a guardrail | A guardrail that blocks work is dangerous if wrong (clock, double-count). Default `monitor`; `enforce` is opt-in per key with a "soft-stop 1 request" override. |
| Reliability | - | **Single point of failure**: if Burnrate is not running, tools pointed at it fail. Mitigations: launcher that sets env vars only while the proxy is up, a `fail-open` shim (a tiny tray-less forwarder?) is overkill; document `unset` instructions; health check endpoint; start proxy at login. |
| Latency | loopback adds ~1 ms | thread-per-connection with sync `ureq` streaming is fine at personal scale; if concurrency grows, move the proxy to `hyper`/`axum` (bigger dependency change). |
| Privacy | prompts never leave the machine; store metadata only, never bodies; no TLS interception (we proxy plaintext on loopback to HTTPS upstream, so no MITM CA install) | The proxy *sees* prompts and keys in memory: audit logging, no body persistence, no debug dumps. |
| ToS | API-key traffic: standard gateway pattern (LiteLLM, Helicone, Portkey do the same) | Routing **consumer-subscription OAuth traffic** (Claude/ChatGPT plans) through a third-party process may breach vendor terms or trigger abuse detection: **[U] needs legal/ToS review; ship proxy for API keys first, make subscription passthrough opt-in with a warning.** |
| Security | bind `127.0.0.1` only | other local processes and **DNS-rebinding/browser CSRF** can hit loopback: require an unguessable per-install path prefix/token (`/p/<token>/...`), validate `Host`, reject browser `Origin` headers, never reflect CORS. |

### 7.3 Alternatives to compare (cheaper, often enough)
1. **Log adapters** (section 2.5): zero setup, zero risk; only for tools that log; lags a bit; attribution to key often impossible.
2. **OpenTelemetry receiver** on `127.0.0.1:4318`: Claude Code emits `claude_code.token.usage` and `claude_code.cost.usage` (verified), Gemini CLI emits `gemini_cli.token.usage` [S], Copilot CLI writes `~/.copilot/otel/*.jsonl` [S], Codex has OTel config [U]. Real-time, no traffic interception, but only for tools that export and only if the user sets env vars.
3. **Existing gateways** (LiteLLM proxy, Helicone, Portkey, Bifrost, OpenRouter): users who already run one get budgets for free; Burnrate reads their endpoints via definitions (section 2.3). Recommended as the "power user" route, not something to bundle.
Recommendation: ship adapters + OTLP first, proxy as v2 opt-in (API keys, monitor mode), enforcement last.

---

## 8. Design 5 - Security

### 8.1 Key storage
- Today: AES-256-GCM, master key in `data/master.key` next to `keys.enc` (protects against casual reads and accidental commits only; an attacker with file access has both).
- Upgrade path: (1) store the master key in the OS credential store (Windows Credential Manager/DPAPI, macOS Keychain, libsecret on Linux; Rust `keyring` crate), keeping the file fallback for headless; (2) optional passphrase mode (Argon2id-derived key) for users who want it; (3) restrict file ACL/permissions (0600; on Windows remove inheritance); (4) store a per-key **fingerprint** (HMAC) for proxy attribution so raw keys are never needed in the usage DB; (5) separate "secret" vs "non-secret" fields in definitions (team id, project id are not encrypted but still not logged); (6) keys stay write-only over HTTP (already true); export/backup excludes `master.key` by default.
- Never store third-party OAuth refresh tokens obtained from other apps; read their files, read-only, at call time (Kimi/Gemini rotation lesson). Never refresh another CLI's token in place.

### 8.2 Redaction
- A single `redact()` used for logs, errors, UI messages and diagnostics: replace `Authorization`, `x-api-key`, `api-key`, `x-goog-api-key`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, and any query param named `key|api_key|token|access_token`; regex-scrub body snippets for known prefixes (`sk-`, `sk-ant-`, `sk-ant-admin`, `sk-admin-`, `sk-or-v1-`, `gsk_`, `xai-`, `AIza`, `ghp_`, `gho_`, `github_pat_`, `pplx-`, `kimi-`, `ey` JWTs). Upstream error bodies: truncate to 300 chars and scrub before showing.
- Panic/crash handlers and HTTP debug logging must not include request headers. Test: a unit test that feeds fake keys through every error path and asserts absence (CodexBar does a similar "safe, redacted diagnostic export").
- Definition templating: secret values are injected only into `headers`, `body`, `query` at send time; never echoed in the "Test" result, never allowed in `url` host/path position.

### 8.3 SSRF and key-exfiltration limits for user-defined endpoints
A user-defined or imported definition can name an arbitrary URL and attach the user's key: both an SSRF and a credential-theft vector.
1. **Host allow-list per definition** (`net.hosts`) plus **key-to-host binding**: a stored key is bound to the host set at the time it was saved; editing the definition's hosts requires re-confirming (CodexBar binds Moonshot keys to the selected regional host for the same reason).
2. HTTPS only. Plain HTTP allowed only with `allowLocal = true` and only to loopback / RFC 1918 / link-local / ULA / `.local` hosts (CodexBar's LiteLLM rule). No `user:pass@` in URLs; reject encoded host delimiters (`%2f`, `%40`, `\`) and IDN homograph oddities.
3. **Resolve DNS yourself, validate every resulting IP, then connect to that IP** (pin) to defeat DNS rebinding. Block by default: `127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (incl. cloud metadata `169.254.169.254`), `fe80::/10`, `fc00::/7`, `100.64/10`, `0.0.0.0/8`, multicast, and IPv4-mapped IPv6 forms. `allowLocal` re-enables only the private ranges the user typed, never metadata addresses.
4. **Redirects:** do not follow by default; if enabled, only same-origin, max 3, never forward `Authorization`/`Cookie` cross-origin, never on non-GET (Qwen Cloud plumbing in CodexBar does exactly this).
5. Limits: request timeout 8-10 s, response cap 1 MiB, JSON content-type only, no cookies jar, no proxy env vars honored for these calls, header allow-list (cannot set `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`).
6. **Imported definitions are untrusted code-as-config:** on import show "This will send your <provider> key to: <hosts>" and a diff on update; community registry entries signed or pinned by hash; definitions never gain file access except through declared `[[files]]` entries limited to a path allow-list (the user's home config dirs), with symlink rejection and size caps (CodexBar rejects symlinked profile paths).
7. Proxy upstreams (section 7) obey the same rules; the proxy never forwards to a host not declared in a definition.

### 8.4 Probe etiquette: rate limiting and cache TTLs
| Class | Default min interval / TTL | Notes |
|---|---|---|
| Plan-window endpoints (Claude, Codex, Z.ai, Kimi, Copilot, Cursor) | 60-120 s while the window is visible; 5 min background; pause when idle | Unofficial endpoints: be conservative to avoid flags. |
| Balance endpoints (DeepSeek, Moonshot, OpenRouter /credits, Vercel) | 5 min | |
| Admin cost/usage (OpenAI, Anthropic, xAI, Fireworks, Together) | 15 min (usage lags minutes); user "refresh" button bypasses with a 30 s floor | OpenAI live per-minute view polled at 30 s and doubled on 429 up to 5 min (CodexBar). |
| Paid APIs (AWS Cost Explorer $0.01/request; CloudWatch) | 6 h cache; manual refresh with a cost warning | [C] |
| Rate-limit-header probes | **off by default**; if enabled, one 1-token request per 15 min; never loops | Requires an inference call (costs money). |
- Single-flight per (provider, key), global concurrency 4, jitter +/-10 %, exponential backoff honoring `Retry-After`, circuit breaker after 3 consecutive 401/403 (stop until the key is edited: avoids account lockouts), keep **last good value with `checkedAt` and a stale badge** on transient failure (CodexBar behavior; do not erase), and never show zero on parse failure.
- Map statuses to fixed messages like the existing `test_status_error` (401/403 rejected; 429/5xx "busy, try again"; never echo upstream bodies).

### 8.5 Other
- Never read browser cookies/localStorage/Keychain of other apps; if a cookie is unavoidable, accept a manual paste, store it encrypted like a key, label it "session cookie: may expire/violate terms".
- Sanitize anything rendered from definitions/upstream (labels, plan names) as plain text; no HTML.
- Limit definition size (64 KiB), step count (8), JSONPath result sizes, and expression depth to avoid DoS via regex/path bombs.
- Update channel for bundled definitions via signed release, not an auto-fetched remote file (avoids a remote config becoming a key-stealing channel).

---

## 9. Priority order, effort and risk

Effort in ideal person-days for one engineer familiar with the codebase (+/-50 %). "Risk" combines endpoint stability, ToS, and verification gaps.

### Phase 0 - foundation (do first; everything else depends on it)
| # | Item | Effort | Risk |
|---|---|---|---|
| 0.1 | Declarative engine: schema, JSONPath, transforms, steps/captures, TTL cache, fixtures, 3 bundled defs as tests | 8-10 d | Low (internal). Main risk: scope creep in the expression language; keep the closed set. |
| 0.2 | UI types: `balances`, `spend`, `used/limit/unit`, `estimated`, "Add custom provider" wizard seeded from models.dev | 4-6 d | Low |
| 0.3 | Key-with-budget (measured spend -> window, drift badge, alerts) on existing Records | 4-5 d | Low-Med: attribution quality depends on proxy/logs. |
| 0.4 | Security baseline: redaction, host allow-list/IP pinning, OS keychain master key | 4-5 d | Low |

### Phase 1 - official, cheap, high value (definitions, 0.5-2 d each once 0.1 exists)
1. **OpenRouter** (/key, optional /credits, /activity w/ mgmt key) - 1 d - Low risk. Note the management-key requirement for balance.
2. **DeepSeek** (/user/balance) - 0.5 d - Low.
3. **Moonshot** (/v1/users/me/balance, intl+cn region binding) - 0.5 d - Low.
4. **Ollama cloud** (/api/usage + /api/balance) - 1 d - Low (schema of /api/balance not opened).
5. **Vercel AI Gateway** credits + budgets - 1 d - Low.
6. **xAI Management API** (balance, usage) - 1.5 d - Low-Med (two credentials, ledger sign inversion).
7. **OpenAI admin costs/usage** - 2 d - Low-Med (admin key friction; pagination; project scoping).
8. **Anthropic admin cost_report/usage_report** - 2 d - Med (legacy/new API transition, `anthropic-version` header drift, org-only).
9. **Fireworks** billing summary (2-step) - 1 d; **Together** `/v1/billing/usage` - 1 d (beta/gated); **LiteLLM / Bifrost / sub2api / ClawRouter** - 0.5-1 d each (self-hosted, `allowLocal`).

### Phase 2 - plan quotas people actually ask for (unofficial, test live first)
1. **Z.ai GLM Coding Plan** - 1.5 d - Med (undocumented, plan schema changing to credits+weekly; Bearer vs raw header ambiguity).
2. **Kimi Code** - 1.5 d - Med (CLI-credential handling must be read-only).
3. **GitHub Copilot** - 3 d (device flow or PAT; internal API + official REST fallback) - Med (internal API, JSON key casing unverified).
4. **Gemini CLI quota** - 2-3 d - Med-High (needs the CLI's embedded OAuth client id/secret; token refresh; ToS gray). Ship logs first, quota later.
5. **Amp** - 1.5 d (key-based) - Med. **Windsurf** local cache only - 1 d - Low. **JetBrains AI** local XML/log - 1.5 d - Low. **Kiro** - 2 d - Med-High. **ClinePass/ZenMux/Synthetic/Chutes** - 0.5-1 d each, only if requested. **MiniMax** - blocked until a token-auth endpoint is verified.

### Phase 3 - local log adapters (cost + tokens for every agent users run) - mostly 1-2 d each
Gemini CLI, Copilot CLI + VS Code, Qwen Code (both layouts), Kimi CLI, Amp, Droid, Cline/Kilo/Roo, Goose (SQLite), Crush (SQLite with reported cost), Zed (zstd JSON), Hermes, Mistral Vibe, Warp. Reuse the generic `[[logs]]` mapping for JSONL tools (Qwen, Droid, Kimi wire) to avoid Rust per format; use hand-written readers for SQLite/zstd/delta-journal formats (Copilot chatSessions, Zed, Goose). Total ~15-20 d. Risk Low (read-only), but formats drift often, so version-detect and fail soft.

### Phase 4 - proxy and OTLP
- OTLP receiver (Claude Code, Gemini CLI, Copilot CLI): 3-4 d - Low.
- Logging proxy v1 (OpenAI + Anthropic + Gemini wire formats, SSE usage extraction, key fingerprints, per-install token, monitor mode): 8-12 d - Med (streaming edge cases, WebSockets, ToS for subscription traffic). Enforce mode: +3-4 d - Med-High.

### Phase 5 - clouds
Bedrock (SigV4, Cost Explorer $0.01/request, CloudWatch): 4-5 d - Med (cost of probing, IAM friction). Vertex (ADC OAuth + Cloud Monitoring quota): 3-4 d - Med. Azure (Entra auth, Monitor/Cost Management): 4-5 d - Med-High. Defer unless requested.

### Never / last resort (documented so they are not re-researched)
Cookie or localStorage based: Perplexity, Groq console, Windsurf web, Gemini app limits, MiniMax web, Mistral console, Qwen Cloud/Alibaba cookie RPC, Claude Console credits, Copilot web budgets, DeepSeek Platform session endpoints. High fragility, account-ban and security risk.

### Suggested first release scope ("universal v1")
Engine + budgets + security baseline; definitions for OpenRouter, DeepSeek, Moonshot, Ollama, Vercel, xAI, OpenAI admin, Anthropic admin, Z.ai, Kimi Code; log adapters for Gemini CLI, Copilot CLI, Qwen, Kimi, Amp, Droid, Cline/Kilo; custom-provider wizard seeded by models.dev. Roughly 30-40 person-days.

---

## 10. Open questions and verification gaps (what I could not confirm)

1. **Copilot `copilot_internal/user`** exact JSON key casing and fields (`percent_remaining` vs `percentRemaining`, entitlement fields): confirm with a real response before writing the mapping. Token source on disk not verified.
2. **Z.ai quota** `Authorization` format (Bearer vs raw) and the new credit/weekly entries after the plan relaunch.
3. **MiniMax** token-auth quota endpoint and field names: not verified.
4. **Factory / Kilo / Codebuff / Amp** exact URLs and response schemas: only descriptions available.
5. **Anthropic rate-limit header names** summarized from search results; open the current rate-limits page before relying on `-input-tokens-/-output-tokens-` variants. Anthropic `anthropic-version` value to use for admin endpoints (2023-06-01 vs 2026-10-21).
6. **OpenRouter** reset boundaries for `limit_reset` (UTC midnight/Monday/1st) not re-verified this session; `/api/v1/activity` not opened.
7. **Gemini API key** spend/quota APIs, **Cerebras** headers, **SambaNova**, **Azure Cost Management** specifics: not researched in depth.
8. **Windows paths** marked [U] (Windsurf, JetBrains, Amp, Kiro CLI sqlite, Warp) need a check on a Windows machine; several tools use XDG-style `~/.local/share` even on Windows (OpenCode, Amp likely).
9. **Proxy/ToS** question for subscription OAuth traffic is a legal judgement, not verified.
10. `serde_json_path` (RFC 9535) crate suitability and binary-size impact: not benchmarked.

---

## 11. Sources

Official documentation
- OpenRouter Get current key: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key (OpenAPI fetched via `.md`)
- OpenRouter Get credits (management key required): https://openrouter.ai/docs/api/api-reference/credits/get-credits
- OpenRouter models list: https://openrouter.ai/api/v1/models
- DeepSeek Get User Balance: https://api-docs.deepseek.com/api/get-user-balance
- Moonshot/Kimi Check Balance: https://platform.kimi.ai/docs/api/balance
- Anthropic Usage and Cost API (legacy Admin API): https://platform.claude.com/docs/en/manage-claude/usage-cost-api
- Anthropic rate limits: https://docs.anthropic.com/en/api/rate-limits
- Claude Code monitoring (OTel): https://code.claude.com/docs/en/monitoring-usage ; LLM gateway: https://code.claude.com/docs/en/llm-gateway
- OpenAI rate limits: https://developers.openai.com/api/docs/guides/rate-limits ; Costs API reference: https://developers.openai.com/api/reference/resources/organization/subresources/audit_logs/methods/get_costs ; Codex config: https://developers.openai.com/codex/config-advanced
- xAI Management API billing: https://docs.x.ai/developers/rest-api-reference/management/billing
- Together spend controls: https://docs.together.ai/docs/billing-spend-controls ; billing usage API: https://docs.together.ai/reference/billing-usage
- Ollama cloud usage: https://docs.ollama.com/api/cloud-usage
- Groq rate limits: https://console.groq.com/docs/rate-limits ; Cerebras: https://inference-docs.cerebras.ai/support/rate-limits
- GitHub billing REST: https://docs.github.com/en/rest/billing/usage ; Copilot CLI session data: https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle
- Gemini CLI configuration (base URL env vars): https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/configuration.md ; sessions: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/session-management.md ; telemetry: https://www.geminicli.com/docs/cli/telemetry
- Qwen Code data privacy/logs: https://qwenlm.github.io/qwen-code-docs/1.x/en/users/data-privacy/ ; token usage design: https://qwenlm.github.io/qwen-code-docs/en/design/issue-4479-token-usage-stats-coordination/
- Z.ai plan update notice: https://docs.z.ai/devpack/notice/usage-revision
- Azure OpenAI monitoring reference: https://learn.microsoft.com/en-us/azure/foundry/openai/monitor-openai-reference
- LiteLLM budgets/rate limits: https://docs.litellm.ai/docs/proxy/users
- Perplexity Analytics API: https://docs.perplexity.ai/docs/admin/computer-analytics-api

Community trackers (open source, used as verified-in-practice evidence)
- CodexBar provider catalog (114 providers): https://raw.githubusercontent.com/steipete/CodexBar/main/docs/providers.md ; per-provider docs under https://github.com/steipete/CodexBar/tree/main/docs (`openai.md`, `zai.md`, `kimi.md`, `minimax.md`, `copilot.md`, `gemini.md`, `openrouter.md`, `windsurf.md`, `jetbrains.md`, `amp.md`, `factory.md`, `kiro.md`, `deepseek.md`, `moonshot.md`, `litellm.md`, `vercel.md`, `fireworks.md`, `xai.md`, `bedrock.md`, `vertexai.md`, `groq.md`, `deepinfra.md`, `model-pricing.md`)
- CodeBurn local-log provider docs: https://github.com/getagentseal/codeburn/tree/main/docs/providers (`gemini.md`, `copilot.md`, `qwen.md`, `kimi.md`, `cline.md`, `kilo-code.md`, `amp.md`, `droid.md`, `goose.md`, `crush.md`, `kiro.md`, `zed.md`, `codebuff.md`, `hermes.md`, `mistral-vibe.md`, `warp.md`)
- ccusage (sources list): https://github.com/ccusage/ccusage ; zai-usage CLI: https://github.com/LogicIncZo/zai-usage ; opencode-glm-quota: https://github.com/guyinwonder168/opencode-glm-quota ; UsageBar Kimi: https://github.com/luisleineweber/usagebar/blob/main/docs/providers/kimi.md

Pricing catalogs (fetched)
- LiteLLM: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json (7,039 entries) ; models.dev: https://models.dev/api.json (324 providers) ; OpenRouter models: https://openrouter.ai/api/v1/models (477 models)
