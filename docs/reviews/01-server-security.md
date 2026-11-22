# Server security review - Rust loopback API

Branch `feature/universal-app`, commit `b0de7a6`. Scope: `server-rs/src/` trust model, secrets, Claude sign-in, SSRF, key-host binding, user provider defs, SSE/webhook/theme proxy. Static reading only.

## High

**1. Stored API keys can be replayed against arbitrary hosts via `POST /api/defs/test`**
[routes/defs_api.rs:46-67](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/routes/defs_api.rs): `find_definition` parses in-request TOML without checking against registered definitions, then `key_for(&state.keys, &def, ..)` looks up the key by `def.id`. A caller who pastes a crafted TOML with `id = "openrouter"` (or `"mistral"`) and `key_hosts = ["attacker.example"]` gets the stored OpenRouter/Mistral key sent to `https://attacker.example/...` (lint only enforces https and that the URL host is in `key_hosts`), and the fetched body is mapped straight back into the response. This is exactly the "key A replayed against host B" scenario: a user pasting an untrusted definition and clicking Test exfiltrates their real provider key. Saved user defs cannot shadow built-in ids (`defs/mod.rs::all_definitions` filters them), but the test endpoint bypasses that protection. Fix: bind keys to hosts at storage time (record the catalog `key_hosts` per provider key), or in `/api/defs/test` refuse defs whose `id` matches a built-in provider unless `def.key_hosts` equals the built-in catalog hosts.

## Medium

**2. Redirects are followed without re-validating through `net_guard` (SSRF guard bypass)**
[alerts/channels.rs:33](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/alerts/channels.rs), [themes.rs:57](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/themes.rs), [providers/mod.rs:214](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/providers/mod.rs), [diagnostics.rs:201](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/diagnostics.rs): these ureq agents use the default redirect policy (follows up to 5 hops, no re-check of the target), while only [defs/fetch.rs:117](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/defs/fetch.rs) sets `.redirects(0)` and re-checks the final host. A 30x from any `check_url`-cleared host moves the request — including `Authorization: Bearer <key>` provider calls — to an arbitrary host, defeating the private/metadata IP and bound-host blocks at the first hop (webhook sender is `allow_local = false` but the ntfy/discord/webhook server the user pointed at can pivot the POST into the LAN). Fix: reject 3xx (redirects(0)) or re-run `check_url` on each `Location`.

**3. Windows absolute-path traversal in `serve_static`**
[lib.rs:316-330](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/lib.rs): the containment check only rejects `Component::ParentDir`. On Windows, a request like `/C:/Windows/win.ini` (or percent-encoded `/C:%5CWindows%5Cwin.ini`) makes `web_dir.join("C:/Windows/win.ini")` replace the whole base (join with a path containing a `Prefix` discards the base), and the resulting components are `Prefix/RootDir/Normal`, so the check passes - an arbitrary local-file read served over loopback HTTP. Fix: reject any component that is not `Normal` (covers Prefix, RootDir, CurDir).

**4. `check_url` DNS validation is not end-to-end (TOCTOU rebinding)**
[net_guard.rs:13-58](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/net_guard.rs): the domain is resolved and refused if any answer is private, but the resolved addresses are not handed back; the actual ureq call re-resolves the name at fetch time. The doc comment's claim that "a rebinding name cannot slip a private IP through" holds only for the check-time lookup; a name flipped between check and connect (or between redirects, see finding 2) reaches private ranges. Fix: pin the validated IPs and connect by address with a `Host` header override, or validate inside the fetch's connector.

## Low

**5. Master key stored in plaintext next to the ciphertext**
[keys.rs:21-28](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/keys.rs): `master.key` sits in the same directory as `keys.enc`, so AES-GCM only protects against accidental disclosure (sync, backups), not any process running as the user - acknowledged in the comment. Fix: derive/protect via Windows DPAPI or an OS keychain.

**6. Unbounded thread-per-connection**
[lib.rs:382-384](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/lib.rs): every incoming request spawns an OS thread with no cap on concurrent connections, and a stalled SSE client pins its thread in `write_all` forever ([routes/status_api.rs](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/routes/status_api.rs) write loop). SSE slots are capped at 8, but plain connections are not; a local client can exhaust threads/memory. Fix: connection cap plus a write timeout on the stream loop.

**7. Guessable sign-in flow ids expose the OAuth URL**
[accounts.rs:303-308](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/accounts.rs): `next_id` is `SystemTime` nanos + a process-local counter, so flow ids are predictable; `GET /api/accounts/claude/<id>` (no custom-header check, unlike non-GET routes) returns the sign-in URL and state to any local process that guesses it. Impact is small (loopback only, server emits no CORS headers so browsers cannot read it), but a random 128-bit id would close it.

## Verified as solid (no finding)

- CSRF/trust model: non-GET requires `X-Burnrate: 1` and, when Origin is present, loopback origin ([lib.rs:169-182](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/lib.rs)); no `Access-Control-Allow-*` headers are ever emitted, so browsers can never read responses cross-origin; Host-header check blocks DNS rebinding ([lib.rs:386-388](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/lib.rs)).
- Secrets: AES-256-GCM, atomic temp-file save, values never returned via API ([routes/secrets_api.rs](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/routes/secrets_api.rs) GET returns names only); diagnostics redact recorded errors with both patterns and literal stored values ([diagnostics.rs](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/diagnostics.rs) `provider_entry`); webhook sender redacts all error text ([alerts/channels.rs:36-51](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/alerts/channels.rs)).
- Claude sign-in (accounts.rs): names validated no-slash, host-session env vars stripped, output capped at 64 KiB and released at terminal phase, URL allow-list to claude.ai/claude.com/anthropic.com; delete paths are narrow - `cleanup_new_dir` only removes dirs the flow created and only when no credentials exist; `claude_signout` (line 648) deletes only `.credentials.json` of a `claude`/`claude-*` dir, transcripts preserved.
- Defs engine (`defs/fetch.rs`): `{{key}}` substitution with leftover-placeholder refusal, `key_hosts` exact-or-subdomain binding, `redirects(0)` plus a post-fetch final-host check, 256 KiB body cap; lint enforces https, no URL credentials, host in key_hosts ([defs/lint.rs](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/defs/lint.rs)); user defs saved atomically with an id charset that prevents filename escape ([defs/user.rs](/c/Users/jerem/Documents/GITHUB/burnrate-app/server-rs/src/defs/user.rs)).
- Theme proxy: opt-in setting gate, strict `namespace.name` validation, host allow-list incl. `files.download` re-validation, 512 KiB/5 MiB caps, sanitized Content-Disposition; upstream errors logged, not echoed.
- SSE stream: 8-subscriber cap with slot reclaim on drop, heartbeat, temp-file-free; ingest route re-checks X-Burnrate and caps body at 64 KiB; `read_body` caps at 16 KiB; static responses set `no-store` for index.html.

## Not verified in this review

- No dynamic testing: all findings come from static reading; the Windows `Path::join` prefix-replacement behaviour in finding 3 is per std semantics, not executed here.
- ureq's exact cross-scheme redirect behaviour (https -> http) was not tested; finding 2 rests on cross-host redirects being followed, which is ureq's documented default.
- `docs/CONTRACTS.md` section 141 documents check-time resolution as the rebinding defense; I did not test whether any deployed fetch path pins addresses.
- The Tauri desktop shell (process sandbox, CSP for the web UI) and `server/` TS reference server were outside the reviewed scope.
