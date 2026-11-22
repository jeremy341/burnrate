# Provider definitions - authoring guide

Burnrate reads usage for API-key providers from **declarative definitions**: a TOML file that says
where to ask, how to authenticate, and how to map the JSON onto percent windows and money balances.
Adding a provider means adding data, not Rust code.

- Normative schema: [`docs/CONTRACTS.md`](CONTRACTS.md) section 4.
- Files: `server-rs/defs/<id>.toml` (built in) and `<data>/providers.d/<id>.toml` (user).
- Template: [`server-rs/defs/_example.toml`](../server-rs/defs/_example.toml) (every field commented).
- Directory notes and fixture layout: [`server-rs/defs/README.md`](../server-rs/defs/README.md).
- Background research (endpoints and evidence per provider):
  [`docs/research/03-universal-providers.md`](research/03-universal-providers.md).

A definition is data only. It cannot run code, read local files, call another host than the ones it
declares, or see anything except the API key the user stored for that provider id.

---

## 1. Files, loading and lifecycle

| Source | Location | Notes |
| --- | --- | --- |
| Built in | `server-rs/defs/<id>.toml` | Embedded by `build.rs` into `defs::BUILTIN_DEFS`; ships with the app |
| User | `<data>/providers.d/<id>.toml` | Loaded when `providers.customDefinitions` is on; edited through the UI or `PUT /api/defs/user/<id>` |
| Template | `server-rs/defs/_example.toml` | Files starting with `_` are ignored |

- The `id` must equal the file name, match `[a-z0-9-]{1,40}` and be unique. A user definition cannot
  shadow a built-in id.
- Keys are stored under the **definition id** in the encrypted key store and added through the normal
  provider routes (`/api/providers/<id>/keys`). `GET /api/providers` lists every enabled definition.
- One `LimitsAccount` is produced per saved key: `id = "<defId>-<keyName>"`, `driver = defId`, with
  `limits.windows`, `limits.balances` and the optional `plan`.
- Any HTTP or parse failure produces `limits.unavailable = { reason: "probeFailed", message }` with the
  key redacted. A failed account is never hidden and never reported as `0%`.

### Status

| `status` | Meaning | Visibility |
| --- | --- | --- |
| `stable` | Verified against the provider's official documentation | Always |
| `experimental` | Unofficial/community/private endpoint, or documented but not live-verified | Hidden unless `advanced.experimental.<id>` is on |
| `disabled` | No per-key usage API exists; the file documents why | Listed (with a catalog note), never probed |

`stable` is a claim about evidence, not about the endpoint being pretty. If the only source is a
tracker, a reverse-engineered CLI or a browser session, the definition is `experimental` and carries a
`# UNVERIFIED: <why>` comment. If there is no key-scoped balance or limit endpoint at all, the
definition is `disabled` and the provider is tracked with a budget instead (section 3C).

---

## 2. Schema reference

### 2.1 Top level

| Key | Type | Required | Rules |
| --- | --- | --- | --- |
| `schema` | integer | yes | `1` |
| `id` | string | yes | `[a-z0-9-]{1,40}`, unique, equals the file name |
| `label` | string | yes | Shown in the provider list |
| `color` | string | yes | `#rrggbb`; icon fallback colour |
| `status` | enum | yes | `stable` \| `experimental` \| `disabled` |
| `category` | enum | no | `agent` \| `apiKey` (default) \| `admin` \| `localLogs`: the Providers screen group (organisation/admin keys are `admin`) |
| `key_url` | string | no | https page where the user creates the key |
| `docs` | string | yes | Official documentation URL (the source of every mapping) |
| `auth` | enum | yes | `apiKey` \| `none` |
| `key_hosts` | array of strings | when `auth = "apiKey"` | Hosts the key may be sent to. Exact host or subdomain, nothing else |
| `poll_seconds` | integer | yes | Minimum `60`; the engine adds up to 20% jitter |
| `plan` | string | no | Displayed as the account's plan name |

### 2.2 `[[request]]` (1..4, executed in order)

| Key | Type | Required | Rules |
| --- | --- | --- | --- |
| `id` | string | yes | Unique; referenced by `from` in windows and balances |
| `method` | enum | yes | `GET` \| `POST` |
| `url` | string | yes | `https://` only; host must be inside `key_hosts` |
| `headers` | table of strings | no | Values may contain the single placeholder `{{key}}` |
| `body` | string | no | JSON body for `POST` (a JSON string, not a nested table) |
| `timeout_seconds` | integer | yes | Request timeout |

Requests run sequentially. There is no cross-request templating: `{{key}}` is the only placeholder.
A request failing (non-2xx, timeout, bad JSON) makes the whole account unavailable, so never point a
normal inference key at an endpoint that answers `401/403` for it - v1 has no `optional` flag
(see section 7).

### 2.3 `[[window]]` - percent-shaped usage

| Key | Type | Required | Rules |
| --- | --- | --- | --- |
| `id` | string | yes | Unique inside the definition; stable over time (it keys history) |
| `kind` | enum | yes | `session` \| `weekly` \| `monthly` \| `other` |
| `label` | string | yes | Shown under the account |
| `from` | string | yes | `id` of a `[[request]]` |
| `used_percent` | path/number | one form | API already returns a percentage |
| `used` + `limit` | path/number | one form | `used / limit * 100` |
| `remaining` + `limit` | path/number | one form | `(limit - remaining) / limit * 100` |
| `resets_at` | path | no | When the window resets |
| `resets_at_format` | enum | no | `iso8601` (default) \| `unix_s` \| `unix_ms` \| `seconds_from_now` |
| `window_minutes` | integer | no | Constant window length when the API does not report one |
| `skip_if_null` | array of strings | no | Field names (`limit`, `resets_at`, ...) that omit the window when null/missing |
| `transform` | array of strings | no | Closed transform set, applied after extraction |
| `provenance` | enum | no | `official` (default) \| `unofficial` \| `statusline` \| `local` \| `estimated` |

A path is an RFC 9535 JSONPath starting with `$` (`serde_json_path`), or a bare number used as a
literal (`limit = 100`). Use `skip_if_null = ["limit"]` for a key without a spending cap, otherwise
the account would show a meaningless `0%`.

### 2.4 `[[balance]]` - money-shaped data

| Key | Type | Required | Rules |
| --- | --- | --- | --- |
| `id` | string | yes | Unique inside the definition |
| `label` | string | yes | Shown as a credit/spend/cap row |
| `kind` | enum | yes | `credit` (remaining money) \| `spend` (money used in a period) \| `cap` (a limit) |
| `from` | string | yes | `id` of a `[[request]]` |
| `amount` | path | yes | Major units, e.g. `12.5` for USD 12.50 |
| `limit` | path | no | Cap for `credit`/`cap` rows |
| `currency` | string or `{ path = "..." }` | yes | Literal `"USD"`, or a path when the API returns it per account |
| `provenance` | enum | no | As for windows |

Percent values are clamped to `0..100` by the engine. Balances are not clamped and respect the
currency the provider reports.

### 2.5 Extraction and transforms

Extraction accepts JSONPath or a number literal. Missing paths make the window/balance unavailable
rather than `0` (a missing `limit` is what `skip_if_null` is for). The transform set is closed and
applied in order:

| Transform | Effect |
| --- | --- |
| `multiply:n` / `divide:n` | scale (e.g. cents -> dollars) |
| `add:n` | offset |
| `min:n` / `max:n` | one-sided clamp |
| `clamp:a:b` | two-sided clamp (ideal for APIs that overshoot, e.g. 104.7) |
| `invert` | `100 - x` (for "remaining percent" APIs) |
| `round:n` | round to `n` decimals |

There is no arithmetic across two paths, no conditionals and no scripting. When an API only gives
`limit` and `remaining`, use the `remaining` + `limit` form instead of subtracting yourself.

### 2.6 Time

`resets_at_format` tells the engine how to parse the value:

| Value | Example |
| --- | --- |
| `iso8601` | `2026-12-01T00:00:00Z` |
| `unix_s` | `1798761600` |
| `unix_ms` | `1798761600000` |
| `seconds_from_now` | `3600` (the API returns a countdown) |

Use `window_minutes` when the provider reports a duration but no reset timestamp (a 5-hour session,
a 30-day month). The UI then computes the pace from the window length.

### 2.7 Provenance

Always set it deliberately:

- `official` - documented endpoint of the provider.
- `unofficial` - private/community endpoint (must also be `status = "experimental"`).
- `statusline` / `local` - data Burnrate measured itself (Claude Code statusline, local budgets).
- `estimated` - inferred from a baseline or a mix of sources.

The badge in the Limits view tells the user how much to trust the number, so a wrong `official` is
worse than an honest `estimated`.

---

## 3. Worked examples

The three patterns below cover almost every provider: a percent cap, a prepaid balance, and a
provider with no usage API at all.

### A. Percent window plus money balance - OpenRouter

Reads the current key's spending cap. `limit` is the USD cap (`null` when the key has none) and
`limit_remaining` is what is left, so the window uses the `remaining` + `limit` form. `limit_reset` is a
cadence string (`"monthly"`), not a timestamp, so the reset time comes from
`effective_budget.resets_at`.

```toml
schema = 1
id = "openrouter"
label = "OpenRouter"
color = "#6467f2"
status = "stable"
docs = "https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key"
auth = "apiKey"
key_hosts = ["openrouter.ai"]
poll_seconds = 300
plan = "OpenRouter key"

# source: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key
[[request]]
id = "key"
method = "GET"
url = "https://openrouter.ai/api/v1/key"
headers = { Authorization = "Bearer {{key}}", Accept = "application/json" }
timeout_seconds = 10

# source: same reference - `data.limit` (USD), `data.limit_remaining` (USD),
# `data.effective_budget.resets_at` (ISO 8601).
[[window]]
id = "key-limit"
kind = "monthly"
label = "Key limit"
from = "key"
remaining = "$.data.limit_remaining"
limit = "$.data.limit"
resets_at = "$.data.effective_budget.resets_at"
resets_at_format = "iso8601"
window_minutes = 43200
skip_if_null = ["limit"]
provenance = "official"

[[balance]]
id = "key-cap-remaining"
label = "Key cap remaining"
kind = "cap"
from = "key"
amount = "$.data.limit_remaining"
limit = "$.data.limit"
currency = "USD"
provenance = "official"
```

`fixtures/openrouter-key.json` (documentation sample; the key itself is replaced):

```json
{
  "data": {
    "label": "sk-or-v1-...",
    "limit": 100,
    "limit_remaining": 74.5,
    "limit_reset": "monthly",
    "usage": 25.5,
    "usage_monthly": 25.5,
    "is_free_tier": false,
    "effective_budget": { "limit": 100, "limit_remaining": 74.5, "resets_at": "2026-12-01T00:00:00Z" }
  }
}
```

`fixtures/openrouter.expect.json`:

```json
{
  "windows": [{ "id": "key-limit", "kind": "monthly", "usedPercent": 25.5, "resetsAt": "2026-12-01T00:00:00Z" }],
  "balances": [{ "id": "key-cap-remaining", "kind": "cap", "amount": 74.5, "currency": "USD" }]
}
```

Notes:

- The account-wide `/credits` endpoint needs a **management** key and answers `401/403` for a normal
  key. v1 cannot mark a request optional, so it does not belong in this definition; a separate
  management-key definition is the honest alternative (see section 7).
- `skip_if_null = ["limit"]` keeps the window out of the UI for uncapped keys while the balance row
  still shows "no cap".

### B. Prepaid balance only - DeepSeek

DeepSeek exposes a balance, not a quota. The balance is a credit row; the monthly window is left to a
budget if the user wants one.

```toml
schema = 1
id = "deepseek"
label = "DeepSeek"
color = "#4d6bfe"
status = "stable"
docs = "https://api-docs.deepseek.com/api/get-user-balance"
auth = "apiKey"
key_hosts = ["api.deepseek.com"]
poll_seconds = 300

# source: https://api-docs.deepseek.com/api/get-user-balance
[[request]]
id = "balance"
method = "GET"
url = "https://api.deepseek.com/user/balance"
headers = { Authorization = "Bearer {{key}}", Accept = "application/json" }
timeout_seconds = 10

# One `balance_infos` entry per currency; v1 cannot iterate an array, so the
# first entry is used and its currency is read from the same object.
[[balance]]
id = "deepseek-balance"
label = "DeepSeek balance"
kind = "credit"
from = "balance"
amount = "$.balance_infos[0].total_balance"
currency = { path = "$.balance_infos[0].currency" }
provenance = "official"
```

`fixtures/deepseek-balance.json` (the official documentation sample uses CNY and numbers as strings):

```json
{
  "is_available": true,
  "balance_infos": [
    { "currency": "CNY", "total_balance": "110.00", "granted_balance": "10.00", "topped_up_balance": "100.00" }
  ]
}
```

`fixtures/deepseek.expect.json`:

```json
{ "windows": [], "balances": [{ "id": "deepseek-balance", "kind": "credit", "amount": 110.0, "currency": "CNY" }] }
```

Notes:

- Numeric strings are coerced by the engine; the contract does not say so explicitly yet, so the
  fixture is what pins the behaviour.
- `is_available = false` means the balance is exhausted. v1 has no `flag`/`whenFalse` mapping; the
  engine surfaces the zero balance instead of inventing a 100% window.

### C. No usage API at all - Together AI, Groq, Perplexity (and any self-hosted endpoint)

Some providers have no key-scoped balance or quota endpoint: usage lives in a console session, an
enterprise-only API, or plain response headers. Do not invent a percentage. Document why, mark the
definition `disabled`, and let the user track the provider with a budget (contract section 5: a
monthly cap plus locally measured spend, shown as `budget-<id>` with `provenance = "local"`).

```toml
schema = 1
id = "together"
label = "Together AI"
color = "#7C6CF0"
# NO USAGE API: there is no balance endpoint. GET /v1/billing/usage is official
# but beta and enabled per organization on request (404 otherwise); it returns
# cost-annotated line items with no single total and no remaining credit, so
# nothing can be mapped with the closed transform set. Use a local budget.
# CATALOG NOTE: no per-key usage API; budget-based tracking.
# source: https://docs.together.ai/reference/billing-usage
status = "disabled"
docs = "https://docs.together.ai/reference/billing-usage"
auth = "apiKey"
key_hosts = ["api.together.ai"]
poll_seconds = 300

# Schema-only placeholder so the definition parses (1..4 requests required).
# Never executed while status = "disabled"; produces no windows or balances.
[[request]]
id = "usage"
method = "GET"
url = "https://api.together.ai/v1/billing/usage?granularity=day"
headers = { Authorization = "Bearer {{key}}" }
timeout_seconds = 10
```

`fixtures/together.expect.json`:

```json
{ "windows": [], "balances": [] }
```

Notes:

- A disabled definition is still validated and listed; it just never probes. This keeps
  `GET /api/defs` and the provider picker honest about what Burnrate can and cannot measure.
- The catalog note shown next to the provider comes from the note table in
  `scripts/build-catalog.mjs` (plus `status` for experimental definitions); the `# CATALOG NOTE:`
  comment stays for readers of the TOML.
- Research example C in `docs/research/03-universal-providers.md` (section 4.4) also covered a
  self-hosted vLLM via the local proxy and `[[logs]]`. v1 has neither, so the equivalent today is a
  **budget** plus the native local-log readers (package 09) - there is nothing to put in a definition.
- Budgets are configured in Settings -> Usage (or `PUT /api/budgets/<id>`); a budget matches by
  provider id and model prefix, so `{"match":{"providers":["together"]}}` is enough here.

---

## 4. Security rules

Definitions are user-editable data that carries a secret, so the rules are strict and enforced by the
engine (not by convention):

1. **`key_hosts` is an allow-list and a promise.** The key is sent only to those hosts (exact host or
   subdomain). Add only hosts the requests need; never a wildcard, a CDN, a docs domain or a
   shortener.
2. **HTTPS only.** Every URL goes through `net_guard::check_url(url, Some(host), false)` before the
   request. Plain HTTP, userinfo in the URL, IP literals in private/link-local/metadata ranges and
   DNS results that resolve to private addresses are refused.
3. **Redirects to another host are refused.** A 30x to a host outside `key_hosts` fails the probe
   instead of forwarding the key.
4. **One placeholder, never logged.** `{{key}}` is substituted at send time. The key never appears in
   logs, errors, diagnostics or the UI; `net_guard::redact` strips stored secrets, `Bearer <token>`,
   `sk-...`, JWTs and long hex/base64 strings.
5. **Small responses.** Bodies are capped at 256 KiB and parsed as JSON; a provider that needs more
   than that is not a usage endpoint.
6. **Probe etiquette.** `poll_seconds` is at least 60, the engine adds up to 20% jitter, caches results
   for the poll interval, backs off exponentially on `429/5xx`, and keeps at most one in-flight
   request per definition. Do not set 60 s for a provider whose docs ask for 5 minutes.
7. **Never touch another app's tokens.** A definition receives only the key the user stored under the
   same provider id. Do not read cookies, browser storage, other apps' config files or CLI keychains;
   local file formats are native readers, not definitions.
8. **Fixtures contain no secrets or real account data.** Build them from documentation samples; trim
   to the fields the definition reads and replace ids/labels with placeholders.

---

## 5. Testing a definition

### 5.1 Fixtures (offline, required)

For each `[[request]]` add `server-rs/defs/fixtures/<id>-<request>.json` (or `<id>.json` when there is
one request). Add `server-rs/defs/fixtures/<id>.expect.json` with the mapped result:

```json
{
  "windows": [{ "id": "key-limit", "kind": "monthly", "usedPercent": 25.5, "resetsAt": "2026-12-01T00:00:00Z" }],
  "balances": [{ "id": "key-cap-remaining", "kind": "cap", "amount": 74.5, "currency": "USD" }]
}
```

The engine package runs every fixture through the real parser and mapper - no network. Include edge
cases you can source: a null cap, a missing reset, numbers as strings, an exhausted balance.

### 5.2 Parse + lint (no network)

```bash
node -e "const fs=require('node:fs');fs.writeFileSync('def.json',JSON.stringify({toml:fs.readFileSync('server-rs/defs/acme-ai.toml','utf8')}))"
curl -sS -X POST http://127.0.0.1:13790/api/defs/validate \
  -H "content-type: application/json" --data-binary @def.json
```

Response: `{ "ok": true, "errors": [], "preview": { ... } }`. Lint covers the schema, id charset,
request count, https, `key_hosts`, placeholders, transform syntax and required window forms. It never
contacts the provider.

### 5.3 One live probe with a stored key

```bash
curl -sS -X POST http://127.0.0.1:13790/api/defs/test \
  -H "content-type: application/json" -d '{"id":"acme-ai","keyName":"default"}'
```

This runs the requests once and returns the mapped account with the key redacted. Use a throwaway
key; never commit one.

### 5.4 Repository checks

```bash
cargo test --manifest-path server-rs/Cargo.toml     # parses every TOML + fixture
node scripts/build-catalog.mjs --validate           # catalog shape + definition consistency
node scripts/build-catalog.mjs --self-test          # generator logic, no network
```

`GET /api/defs` should list the new definition with its `status` and `source`, and
`GET /api/providers` should include it once enabled (or once `advanced.experimental.<id>` is on for
`experimental`).

---

## 6. The provider catalog (`catalog.json`)

`server-rs/defs/catalog.json` is the data behind the "Add provider" picker (`GET /api/defs/catalog`).
It is generated - never edit it by hand:

```bash
node scripts/build-catalog.mjs        # fetch models.dev/api.json and rewrite catalog.json
node scripts/build-catalog.mjs --check      # exit 1 when the committed file is stale
node scripts/build-catalog.mjs --validate   # offline structure/consistency check
node scripts/build-catalog.mjs --self-test  # generator self-test
```

Entry shape:

```json
{
  "id": "openrouter",
  "label": "OpenRouter",
  "baseUrl": "https://openrouter.ai/api/v1",
  "docs": "https://openrouter.ai/models",
  "envVars": ["OPENROUTER_API_KEY"],
  "hasDefinition": true,
  "note": "optional explanation"
}
```

- **Source.** <https://models.dev/api.json>: `id`, `name` -> `label`, `api` -> `baseUrl`, `doc` ->
  `docs`, `env` -> `envVars`.
- **`hasDefinition`** is computed only from the TOML files in `server-rs/defs/`; it is never taken
  from models.dev. A definition id with no models.dev entry (`openai-admin`, `kiro`, ...) gets a
  synthesized entry from its TOML (`label`, `docs`, the first request's origin).
- **Aliases** map models.dev names to definition ids: `togetherai` -> `together`,
  `ollama-cloud` -> `ollama`, `github-copilot` -> `copilot`, `moonshotai` -> `moonshot`,
  `kimi-code-plan-global` -> `kimi-code`. They apply only while the definition exists, so the catalog
  never advertises an id with nothing behind it.
- **Notes** explain exceptions: disabled definitions ("no per-key usage API; budget-based tracking"),
  experimental endpoints, admin-key-only definitions.
- **Filtering and cap.** Only providers with models, an endpoint or key variable, and a coding signal
  (tool calling or a coding model) are eligible. A curated coding-agent core is kept first, then the
  rest of models.dev is ranked by coding relevance and catalogue size, up to **120 entries**.
- **Regeneration.** Run the script after merging definition branches so `hasDefinition`, the aliases
  and the synthesized entries match the tree. `--validate` warns while a referenced definition is
  not merged yet and `--strict` makes that an error (post-merge CI).

### 6.1 Native providers, definitions and the picker

The picker lists three kinds of rows, in this order: **live providers** (what `/api/providers`
reports: native readers plus enabled definitions), **definitions** that exist but are not loaded
(experimental until `advanced.experimental.<id>` is on; `disabled` ones can never load), and the
remaining **catalog** rows. One id appears once, strongest source first. Product names that are not
an id are matched through `src/providers/aliases.ts` (presentation only).

| Product | How Burnrate reads it | Id in the picker | Status |
| --- | --- | --- | --- |
| ChatGPT Plus / Pro | Native reader over the Codex login (`wham/usage`, undocumented) | `codex` (search "chatgpt") | `unofficial` windows |
| OpenAI API spend | `openai-admin` definition, admin key `sk-admin-...` | `openai-admin` | experimental; costs fields UNVERIFIED (see the TOML header) |
| OpenAI (models.dev row) | none: redirects to the two rows above | `openai` | not addable |
| OpenCode Go with local OpenCode credentials | Native reader (`opencode`): `auth.json`, `opencode.db`, `OPENCODE_API_KEY` | `opencode-go` | local credential access is off by default, windows `unofficial` |
| Mistral (Vibe plan) | Native reader (`mistral`): API key, `GET https://api.mistral.ai/v1/billing/budget`; one-click **Import from Mistral Vibe** copies Vibe's own key(s), including a second profile's DPAPI keyring key on Windows; cost and tokens come from the local `readers/vibe.rs` session index | `mistral` | `official` window; the budget field names are taken from the reader, not from Mistral's published API reference |
| OpenCode Go with a key pasted into Burnrate | `opencode-go` definition, `GET https://opencode.ai/zen/go/v1/usage` | `opencode-go` | stable (shown by default); endpoint and response shape UNVERIFIED, windows `unofficial` |

To connect OpenCode Go, sign in at the OpenCode console and save a Go key in Burnrate's Providers
screen. To use existing local OpenCode credentials, explicitly opt in with `PATCH /api/settings`
and this request body.

```json
{"patch":{"advanced":{"experimental":{"opencodeGoLocalCredentials":true}}}}
```

Set the flag to `false` to stop local credential access. Keys saved directly in Burnrate continue
to work through the `opencode-go` definition. An opt-in without a local Go or Zen credential leaves
the provider disconnected unless a key is saved in Burnrate.

### 6.2 Why Mistral has no "Sign in" button like Claude or Codex

Claude and Codex each ship a CLI whose login writes a token file Burnrate can read (`claude auth login`,
`codex login`). Mistral has neither, so a sign-in cannot be run the same way:

- Mistral publishes no OAuth or device-code endpoint for third-party apps. Its Vibe CLI "Launch browser"
  sign-in is a first-party flow; the docs say only that it "provisions and stores credentials for you"
  (https://docs.mistral.ai/vibe/code/cli/api-keys-profiles, https://docs.mistral.ai/vibe/code/cli/install-setup).
  Reusing Vibe's client id or endpoints would impersonate Mistral's own app and could break at any release,
  so Burnrate does not.
- What those pages do document is where the resulting credential lives: `MISTRAL_API_KEY` in the shell
  environment, `~/.vibe/.env`, or the OS keyring (checked in that order). Verified on Windows: the keyring
  entry is a generic credential with target `ai.mistral.vibe` and user `MISTRAL_API_KEY`; the key it holds is
  accepted by `/v1/billing/budget` and returns the Vibe monthly budget.
- So the supported path is an explicit click, never a poll: `POST /api/accounts/mistral/import-local`
  (`providers/mistral.rs`) reads those three places, tests each key against the budget endpoint, and only
  then saves the first accepted one in Burnrate's encrypted key store as account `Vibe`. `GET /api/providers`
  only checks that `~/.vibe` or the env var exists (no secret is read) and adds `localImport` to the
  Mistral entry so the UI can offer the button. macOS (`security find-generic-password -s ai.mistral.vibe -a MISTRAL_API_KEY`)
  and Linux (`secret-tool lookup service ai.mistral.vibe username MISTRAL_API_KEY`) lookups are implemented
  from the same documented names but UNVERIFIED on those systems.
- Without a Vibe sign-in on this computer there is nothing to import: paste a key from https://console.mistral.ai/api-keys.

### 6.3 A second Vibe profile and the Windows per-instance keyring workaround

Vibe keeps one key per Windows user in Credential Manager (`ai.mistral.vibe` / `MISTRAL_API_KEY`) and has no
`.mistral-acc2`-style switch, so two profiles would share it. The workaround people use (verified here with
`~/.vibe2/keyring_backend/vibe2_keyring.py`) is a second config directory plus a custom Python `keyring` backend,
selected with `PYTHON_KEYRING_BACKEND=vibe2_keyring.DpapiFileKeyring` (optional `VIBE2_KEYRING_FILE`). That backend
stores every secret of the instance in `<config dir>/keyring.bin`: a JSON object `{"<service><NUL><user>": "<secret>"}`
(so `ai.mistral.vibe` + NUL + `MISTRAL_API_KEY`) encrypted as a single Windows DPAPI blob.

- Import discovers it automatically. Every Vibe config directory (see 6.4: `VIBE_HOME`, the folders you list in
  Settings, and every `~/.vibe*`) is searched for a `.env` and, on
  Windows only, a `keyring.bin`. The blob is opened with `CryptUnprotectData` through a minimal FFI declaration (no
  extra crate), the entry is read, and the key is tested against the budget endpoint exactly like the first one.
- Accounts are named after the directory: `~/.vibe` is `Vibe`, `~/.vibe2` is `Vibe 2`, `~/.vibe-work` is `Vibe work`.
  The same key reached twice (environment and keyring) is one account; a different key that would reuse a name already
  taken in the same run gets `Vibe (2)` rather than overwriting. Re-importing later refreshes an account whose key
  rotated and never re-tests a key that is already saved. `POST /api/accounts/mistral/import-local` answers
  `{ok, source, imported: [names]}`: names only.
- `GET /api/providers` keeps `localImport` on the Mistral entry after one key is saved while some Vibe directory
  still has its own key file (`.env` or `keyring.bin`) whose account name is not saved. It checks file existence only;
  no secret is read until the click. Renaming a saved Vibe account makes the offer reappear; importing again is
  harmless because a saved key is recognised by value.
- **DPAPI is current-user-only.** A `keyring.bin` copied from another Windows account or another machine cannot be
  decrypted and is skipped silently (reported as nothing to import, never as a wrong key). DPAPI is Windows-only, so
  the file is ignored on macOS and Linux. The decrypted buffer is wiped after use and no key, blob or decrypted text
  is ever logged or returned.
- UNVERIFIED: the second key's acceptance by `api.mistral.ai` (the click path was not exercised against the network
  here); only that the key decrypts, parses and is distinct from the first.

### 6.4 Local source folders (where Burnrate reads agent files from)

Nothing about a person's machine is built in. Claude Code and Mistral Vibe files are found by looking in the usual
places and in any folder the user adds under **Settings > Providers > Local sources** (`providers.sources`):

```json
"providers": { "sources": { "claude": ["D:\\profiles\\.claude-work"], "vibe": ["~/profiles/vibe-two"] } }
```

| Key      | Each folder is                                                                 | Read for                                                       |
| -------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `claude` | a Claude Code config folder (`projects/`, `.credentials.json`, `.claude.json`) | transcripts (cost, tokens), the account and its login/limits   |
| `vibe`   | a Vibe config folder (`logs/session/unified/`, `.env`, `keyring.bin`)          | sessions (cost, tokens), and keys for the one-click Mistral import |

Precedence for one agent, in the order directories are listed and read (the first one is the one shown as "the"
source folder):

1. the environment variable: `CLAUDE_CONFIG_DIR` or `VIBE_HOME`;
2. the folders listed in settings, in the order given;
3. automatic discovery: `~/.claude` and `~/.claude-*` that contain `projects/`, `~/.vibe*` directories, then the
   XDG/WSL locations for Claude.

Configured folders are read **in addition to** discovery, never instead of it, and a folder reached twice (a trailing
slash, different case on Windows) is read once. Defaults are empty lists, so a machine with no configuration behaves
exactly as before. Rules: absolute paths only (`C:\...`, `\\server\share`, `/...`), or a leading `~` for the home
folder; surrounding quotes are dropped; at most 20 folders per agent; an unknown key under `sources` is rejected by
`PATCH /api/settings` (`providers.sources.<key>`). A folder that does not exist is skipped (no error, nothing is
created) and `GET /api/providers` reports it as `sources: [{path, found: false}]` on the Claude Code / Mistral
entries so Settings can say "Folder not found on this computer". A `projects` folder given for `claude` is
accepted and its parent is used.

- The Windows DPAPI `keyring.bin` is always `<one of the directories above>/keyring.bin`; no directory name is built
  into the import. Accounts are named after the folder (`.vibe2` is "Vibe 2", `my-vibe` is "Vibe (my-vibe)").
- A configured Claude folder becomes an account named after its folder (`.claude-work` is `claude-work`). Two folders with
  the same name in different places would share an id: rename one.
- Other agents (Codex, OpenCode, Gemini, ...) do not have this setting yet; they use their own environment variables
  and standard locations (`readers::config_dirs`). Adding one is a new id in `readers::sources::SOURCE_IDS`.
- Settings exports contain these paths. They are machine-specific: after importing on another computer, an unknown
  folder is reported as not found and ignored.
- UNVERIFIED: a folder on a network share or a different WSL mount was not exercised, only local temp folders.

### 6.5 Mistral usage in Cost and Tokens

Limits come from the budget endpoint; cost and tokens come from Vibe's own logs. `readers/vibe.rs` reads
`logs/session/unified/.session-index.json` in every Vibe config directory (6.4) and files each session under provider
`mistral`:

- `session.tokenUsage` is cumulative per session and `inputTokens` already includes `cachedInputTokens`
  (`totalTokens = input + output`, checked on real data), so a record is `uncached = input - cached`, `cached`,
  `output`. `contextUsage` is the live context window, not spend, and is ignored.
- Sub-agent sessions (`identity.kind = "subagent"`, no `active_model`) are separate usage on top of their root, not
  part of its totals, and inherit the root's model.
- The model shown is Vibe's alias (`glm-5-3`); it is priced by the API id in `completion_catalogue.model`
  (`zai-glm-5-3`), falling back to `zai-<alias>` for `glm-*` aliases. LiteLLM lists these as `mistral/zai-glm-5-3`,
  `mistral/zai-glm-5-3-flash`, `mistral/mistral-large-4-0`. A model with no published rate keeps its tokens and shows as
  unpriced (price overrides still apply); nothing is invented.
- Cumulative totals mean a session that spans several days is attributed to its last-updated day. The same session id
  in two directories (a copied profile) is counted once. Buckets carry no account id, so Cost/Tokens groups by
  provider and model, not by `.vibe` versus `.vibe2`.
- Index schema (`catalog_version: 1`) is read from an observed install, not a published spec: UNVERIFIED across Vibe
  releases. A damaged index is reported as an unreadable file; entries missing an id or with a non-object `tokenUsage`
  count as malformed records.

Quota endpoint details

- `https://opencode.ai/zen/go/v1/usage` and its `usage.{rolling,weekly,monthly}.{percent,resetsAt}`
  shape are taken from the native reader (derived from T3 Code's OpenCode Go reader), not from
  OpenCode documentation. `fixtures/opencode-go.json` is modelled on that reader, not copied from an
  official sample. Hence `provenance = "unofficial"`. The `stable` definition is listed by default so
  users can add a Go key.
- `GET /api/providers` lists OpenCode once, as `opencode-go`; a key that OpenCode holds and that is also saved
  under `opencode-go` is read only once, so the quota is not shown twice (docs/CONTRACTS.md section 15).
- `wham/usage` for ChatGPT is undocumented; `reset_at` units are assumed (see `providers/codex.rs`).

---

## 7. Known v1 limitations

These are deliberate, documented gaps. Work around them in the definition instead of inventing syntax
the engine ignores (the validator rejects unknown fields).

| Limitation | Consequence / workaround |
| --- | --- |
| No `optional` request flag | Any failing request fails the account. Do not mix a normal inference key with a management-only endpoint; ship a separate `<id>-admin` definition instead. |
| No arithmetic across two paths | You cannot express `used = limit - remaining`. Use the `remaining` + `limit` form, or pick the field the API already provides. |
| No array iteration (`select`) | Map a fixed index (`$.balance_infos[0]...`). Multi-currency accounts show the first entry. |
| No conditional windows (`when`) | Use `skip_if_null` for the common "no cap" case; otherwise split definitions. |
| No plan extraction | `plan` is a literal or absent; do not map it from JSON. |
| No local files, SQLite or logs | Those providers are native readers (cost/tokens), not definitions. |
| No proxy/log mapping | Self-hosted endpoints without usage APIs are tracked with budgets. |
| Numeric strings | The engine coerces `"110.00"` -> `110.0` (as described in research section 4.3); the contract does not spell it out, so a fixture pins it. |
| One key per account | Sequential requests share `{{key}}`; there is no second credential field. |
| Percent only for windows | Money-shaped numbers belong in `[[balance]]`, not in a window. |

---

## 8. Review checklist

- [ ] `id` matches the file name and `[a-z0-9-]{1,40}`; label, colour and docs URL are right.
- [ ] `status` matches the evidence (`stable` only for official, verified docs).
- [ ] `key_hosts` contains exactly the hosts used by the requests.
- [ ] Every mapping has a `# source: <url>` and matches the response field names exactly.
- [ ] `skip_if_null` covers optional caps; windows/balances use stable ids (history depends on them).
- [ ] `provenance` is honest; `experimental` definitions say `# UNVERIFIED: <why>`.
- [ ] One fixture per request plus `<id>.expect.json`, both derived from documentation.
- [ ] `POST /api/defs/validate` is clean and `POST /api/defs/test` returns the expected account.
- [ ] `cargo test` passes; `catalog.json` is regenerated (`node scripts/build-catalog.mjs`).
- [ ] No secret, real account id or cookie appears anywhere in the TOML, fixtures or docs.
