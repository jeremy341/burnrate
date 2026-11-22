# Built-in provider definitions

One `<id>.toml` file per declarative provider. The server embeds every file in this directory
(`build.rs` -> `defs::BUILTIN_DEFS`) and can also load user definitions from
`<data>/providers.d/*.toml`. The normative schema is `docs/CONTRACTS.md` section 4; the authoring
guide with worked examples is [`docs/PROVIDER-DEFINITIONS.md`](../../docs/PROVIDER-DEFINITIONS.md).

A definition only describes **how to read usage**: HTTPS requests, JSONPath extraction and a closed
set of transforms. There is no scripting, no local file access and no way to send a key anywhere that
is not listed in `key_hosts`.

## Layout

```
server-rs/defs/
├── <id>.toml              built-in definition (schema = 1)
├── _example.toml          fully commented template - files starting with "_" are ignored
├── catalog.json           generated provider catalog (models.dev + these definitions)
├── README.md              this file
└── fixtures/
    ├── <id>-<request>.json    one example response per [[request]], from official docs only
    ├── <id>.json              (shorthand when the definition has a single request)
    └── <id>.expect.json       expected mapped windows/balances for the fixture
```

## Adding a definition

1. Copy `_example.toml` to `<id>.toml` (the id must match the file name, `[a-z0-9-]{1,40}`).
2. Fill in only fields you can cite from the provider's official documentation. Add
   `# source: <url>` next to every mapping and put the main URL in `docs`.
3. Choose the honest status: `stable` only for documented, verified endpoints; `experimental` for
   unofficial/community endpoints (hidden until `advanced.experimental.<id>` is on); `disabled` when
   the provider has no per-key usage API at all (see below).
4. Add fixtures built from documentation samples - never from a real account.
5. Validate and try it through the management API (the server must be running):

   ```bash
   # parse + lint only, never touches the network
   node -e "const fs=require('node:fs');fs.writeFileSync('def.json',JSON.stringify({toml:fs.readFileSync('acme-ai.toml','utf8')}))"
   curl -sS -X POST http://127.0.0.1:13790/api/defs/validate \
     -H "content-type: application/json" --data-binary @def.json

   # run the requests once with a stored key and return the mapped account (redacted)
   curl -sS -X POST http://127.0.0.1:13790/api/defs/test \
     -H "content-type: application/json" -d '{"id":"acme-ai","keyName":"default"}'
   ```

   `GET /api/defs` lists every definition with `status` and `source` (`builtin` | `user`).
6. Regenerate the catalog and run the checks:

   ```bash
   node scripts/build-catalog.mjs            # needs network (models.dev/api.json)
   node scripts/build-catalog.mjs --validate
   node scripts/build-catalog.mjs --self-test
   cargo test --manifest-path server-rs/Cargo.toml   # parses every definition + fixture
   ```

## Schema at a glance

| Field | Notes |
| --- | --- |
| `schema` | `1` |
| `id` | `[a-z0-9-]{1,40}`, unique, equals the file name |
| `label`, `color`, `plan?` | display only; `plan` becomes the account's plan |
| `status` | `stable` \| `experimental` \| `disabled` |
| `category` | optional: `agent` \| `apiKey` (default) \| `admin` \| `localLogs`; admin/organisation keys must say `admin` |
| `key_url` | optional https page where the key is created |
| `docs` | official documentation URL (source of every field) |
| `auth` | `apiKey` \| `none` (local logins are native Rust providers) |
| `key_hosts` | hosts the key may be sent to; **required** for `apiKey` |
| `poll_seconds` | probe interval, minimum 60 (the engine adds up to 20% jitter) |
| `[[request]]` | 1..4, run in order: `id`, `method`, `url`, `headers`, `body?`, `timeout_seconds` |
| `[[window]]` | percent window: `id`, `kind`, `label`, `from`, one of `used_percent` / `used`+`limit` / `remaining`+`limit`, optional `resets_at`, `resets_at_format`, `window_minutes`, `skip_if_null`, `transform`, `provenance` |
| `[[balance]]` | money data: `id`, `label`, `kind` (`credit` \| `spend` \| `cap`), `from`, `amount`, optional `limit`, `currency`, `provenance` |

Transforms (closed set, applied after extraction): `multiply:n`, `divide:n`, `add:n`, `min:n`,
`max:n`, `clamp:a:b`, `invert` (100 - x), `round:n`.

`provenance` is `official` for documented endpoints, `unofficial` for community/private ones,
`statusline`/`local` for data the app measures itself, and `estimated` for inferred values.

## Fixtures

`fixtures/<id>-<request>.json` holds a response copied from the provider's documentation (trim it to
the fields the definition reads). `fixtures/<id>.expect.json` holds the mapping the engine must
produce:

```json
{
  "windows": [{ "id": "key-limit", "kind": "monthly", "usedPercent": 25.5, "resetsAt": "2026-12-01T00:00:00Z" }],
  "balances": [{ "id": "key-cap-remaining", "kind": "cap", "amount": 74.5, "currency": "USD" }]
}
```

The test harness parses every TOML here and maps every fixture; a definition without a fixture is an
unverified definition.

## Providers without a usage API

Some providers expose no per-key balance or quota endpoint (only console sessions, enterprise-only
APIs or response headers). Do not invent a percentage for them: keep a definition with
`status = "disabled"`, a `# NO USAGE API` comment explaining why, and a catalog note. Users track
those providers with a **budget** (a monthly cap plus locally measured spend, `docs/CONTRACTS.md`
section 5), which is honest about where the number comes from.

Currently disabled for this reason: **Groq**, **Perplexity**, **Together AI** - "no per-key usage
API; budget-based tracking".

## catalog.json

`catalog.json` is the provider picker's data source (`GET /api/defs/catalog`) and is generated by
`scripts/build-catalog.mjs` from <https://models.dev/api.json> plus the TOML files in this directory:

```json
{ "id": "openrouter", "label": "OpenRouter", "baseUrl": "https://openrouter.ai/api/v1",
  "docs": "https://openrouter.ai/models", "envVars": ["OPENROUTER_API_KEY"], "hasDefinition": true }
```

- `hasDefinition` is computed from the files in this directory - never from models.dev - so the UI can
  only offer definitions that actually ship.
- `note` explains exceptions: disabled definitions ("no per-key usage API; budget-based tracking"),
  experimental endpoints, admin-key-only definitions.
- The list is capped at 120 entries: a curated coding-agent core first (first-party labs, coding
  plans, agent/IDE vendors, local runtimes, gateways), then the rest of models.dev ranked by coding
  relevance (tool calling, coding models, endpoint and key variables, catalogue size).
- Definitions whose id has no models.dev entry (e.g. `openai-admin`, `kiro`) get a synthesized entry;
  ids that models.dev names differently are aliased (`togetherai` -> `together`,
  `ollama-cloud` -> `ollama`, `github-copilot` -> `copilot`, `moonshotai` -> `moonshot`,
  `kimi-code-plan-global` -> `kimi-code`).

Run `node scripts/build-catalog.mjs` after merging definition branches so `hasDefinition` and the
synthesized entries match the tree. `--check` fails when the committed file is stale, `--validate`
checks the committed file offline, `--self-test` exercises the generator without network.

## Security and probe etiquette

- HTTPS only; every URL is checked with `net_guard::check_url(url, Some(host), false)` before a
  request, and redirects to another host are refused.
- The key is only ever sent to `key_hosts` (exact host or subdomain) and is redacted from logs and
  errors; the only placeholder is `{{key}}`.
- Responses are capped at 256 KiB and never cached beyond `poll_seconds`; results are shared per
  definition, with exponential backoff on 429/5xx and at most one in-flight request per definition.
- Never read another application's tokens or cookies. A definition only receives the key the user
  stored under the same provider id.
