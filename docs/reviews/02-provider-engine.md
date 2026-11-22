# Review 02 — Provider engine correctness

Branch `feature/universal-app`, commit `b0de7a6`. Static, read-only review of `server-rs/src/{engine,pricing,store,types,budgets}.rs`, `providers/`, `readers/`, `defs/`, `server-rs/defs/*.toml`, `docs/PROVIDER-DEFINITIONS.md`. No external provider documentation was fetched; docs claims are marked UNVERIFIED below.

## High

1. **Budgets ignore currency — spend and limit are compared across units.** [budgets.rs:430-436](../server-rs/src/budgets.rs:430): `spend` is always the engine's USD `costUsd` (`cost_between` → `sum_costs` over `costUsd`, budgets.rs:381-401), but `parse_budget` accepts any alphanumeric `currency` and `used_percent(spend, budget.monthly_budget)` divides the two directly while the balance reports `"currency": budget.currency` on a USD amount. A user with a EUR/GBP/JPY budget gets a percentage wrong by the exchange rate. Fix: reject non-USD at validation (like the FX-free design implies) or convert.

## Medium

2. **Model price overrides zero-fill missing rates, are case-sensitive, and discard provider-reported costs.** [pricing.rs:255-256](../server-rs/src/pricing.rs:255): unspecified override slots become `0.0` per-million; [pricing.rs:336-337](../server-rs/src/pricing.rs:336) matches overrides by raw `model.trim()` (no lowercase/bare-name normalisation like `lookup()`), and any matching override discards `r.reported` entirely. A partial or differently-cased override silently prices a model at ~0 and can understate cost drastically. Fix: apply overrides field-by-field on top of the looked-up rate, or require all four slots; normalise keys with `normalize_key`+`strip_variant`.

3. **OpenCode shows fabricated "0%" windows when the API omits a window.** [providers/opencode.rs:50](../server-rs/src/providers/opencode.rs:50): `w.get("percent").unwrap_or(0.0)` — for a Zen key without a Go subscription, `usage.rolling/weekly/monthly` are missing and the account still gets Session/Weekly/Monthly windows all reading 0% used. Contrast [providers/grok.rs:38-41](../server-rs/src/providers/grok.rs:38), which deliberately maps "omitted percent" to 0 only when a subscription period exists. Fix: skip the window when `percent` is absent.

4. **Shared-session dedup drops rows on the assumption copies overlap.** [engine.rs:266-283](../server-rs/src/engine.rs:266): for `shared_sessions()` readers (only codex), the file with the most records per session id wins and every record of that session in other files is silently dropped. Correct for a moved archive; if a session id ever sits in two files whose records differ (e.g. a live file still growing after a copy, not a move), usage is lost with no accounting in `malformedRecords`. Codex only appears to move files today, so Low-Medium; fix: merge instead of drop, or verify rows overlap before discarding.

5. **Definitions cannot aggregate arrays; anthropic-admin hard-codes a 100 divisor.** [defs/extract.rs:34](../server-rs/src/defs/extract.rs:34) takes only the first JSONPath match, so multi-item totals (line items, multiple currencies) are silently truncated. [anthropic-admin.toml:31-34](../server-rs/defs/anthropic-admin.toml:31) maps only `$.data[0].results[0].amount` and applies `divide:100`, which is wrong for currencies whose minor unit is not 1/100 (e.g. JPY) and when the response holds several results — the mapped "Daily API cost" then understates. UNVERIFIED against current Anthropic docs; check the response shape and add a `sum` transform or per-currency exponent handling.

## Low

6. **Tautological fast/ultrafast merge check.** [pricing.rs:165](../server-rs/src/pricing.rs:165): `same_rates(&fast, &b.fast.or(fast))` compares `fast` with itself (always true), so two reseller entries with different explicit priority/ultrafast rates merge silently, keeping the first-seen one. Intended "fill missing from the other entry" behaviour only half-holds.

7. **Documented pricing fallback chain is dead code.** [pricing.rs:553-641](../server-rs/src/pricing.rs:553) (`load_chain`, OpenRouter fallback) is `#[allow(dead_code)]` and its own comment says the integrator must wire it into `ensure_pricing`; [engine.rs:150-169](../server-rs/src/engine.rs:150) still fetches only the single LiteLLM URL. Offline first run with no cache → all costs unpriced (budget spend 0) though the feature to avoid this exists.

8. **53-bit dedupe hash can collide and silently drop usage.** [store.rs:50-56](../server-rs/src/store.rs:50): keys are hashed to 53 bits for TS cache compatibility; at ~5×10⁷ distinct keys a birthday collision becomes likely and two different messages merge, taking the per-channel max (undercount). Constrained by the shared cache format; a cache-version bump would allow a wider hash.

9. **Reader robustness gaps: unbounded .zst memory, silent line truncation, malformed=0 for Claude.** [readers/mod.rs:142-150](../server-rs/src/readers/mod.rs:142): `.zst` files are read whole, decompressed whole and split into a `Vec<String>` — the streaming comment only holds for plain files; [readers/mod.rs:159](../server-rs/src/readers/mod.rs:159) `Err(_) => None` truncates a file mid-read with no malformed increment; [readers/mod.rs:287](../server-rs/src/readers/mod.rs:287) Claude always reports `malformed: 0`, so unparsable lines are invisible in `malformedRecords`.

10. **Codex resetsAt unit assumption.** [providers/codex.rs:24](../server-rs/src/providers/codex.rs:24): `reset_at * 1000.0` has no seconds-vs-milliseconds tolerance heuristic (contrast [providers/statusline.rs:66-70](../server-rs/src/providers/statusline.rs:66)). If `wham/usage` ever reports ms, resets land ~year 58,000. UNVERIFIED endpoint.

11. **Invalid timezone strings silently become UTC.** [engine.rs:325](../server-rs/src/engine.rs:325), [budgets.rs:367](../server-rs/src/budgets.rs:367): a typo'd tz name moves every day/hour bucket instead of erroring, so DST-sensitive windows (Claude 5h/weekly alignment) are silently wrong by the offset.

12. **Clamping at 100% erases overuse.** `clamp` in [providers/mod.rs:200-202](../server-rs/src/providers/mod.rs:200) and [budgets.rs:303-313](../server-rs/src/budgets.rs:303) mean a 250%-of-budget or over-limit week is indistinguishable from exactly 100%. Documented as intended (PROVIDER-DEFINITIONS.md §2.3), but alerting and history lose the overshoot magnitude.

## Verified

- No reachable `unwrap`/`expect`/slice panic from malformed local log input in the reviewed non-test code: field-before-index discipline in engine/store, `chunks_exact` in store.rs:159, all `as_object_mut().unwrap()` on self-built JSON.
- Division-by-zero guarded at every percent site: `percent_from` (claude.rs:24-27 requires `l > 0`), defs mapping uses/limits (`l != 0.0`), `used_percent` (finite/positive check), `price()` early-returns when `list_cost <= 0` so the reported-cost scale factor never divides by zero.
- Budgets cycle math (leap years, year rollover, half-hour zones, on-reset boundary) is covered by passing unit tests in budgets.rs; sum_costs hour filters strings correctly.
- Codex reader state machine revalidates every computed usage through `read_usage` (non-negative-integral, `cached+cache_write ≤ input`, `reasoning ≤ output`), and ` advancements` overflow to inf is rejected, not propagated.
- `token_count` rejects negative/fractional values; `parse_ts_ms` rejects unparseable timestamps, so bogus lines are skipped, never priced.
- serde_json `preserve_order` IS enabled (Cargo.toml), so the pricing alias-order assumption in parse_rate_table holds.
- DST day boundaries: epoch→local mapping is always unique; the quarter-hour `day_slots` cache in engine.rs cannot mis-bucket.
- Built-in defs carry honest `UNVERIFIED`/`experimental` markers per the PROVIDER-DEFINITIONS.md status rules (openai-admin, copilot, kimi-code, kiro, windsurf, zai flagged).

## Unverified / downgraded

- All claim-of-record limits semantics vs official provider docs (window start, what counts toward a limit, reset instants): anthropic-admin, openai-admin and every `UNVERIFIED` def were accepted as-is; no live or docs check was performed — spot-check anthropic-admin `amount` (cents vs exponent) and openai-admin `/organization/costs` field names first.
- codex `wham/usage` `reset_at` units (seconds assumed) and grok `creditUsagePercent` meaning-of-zero.
- Readers antigravity, cline, copilot, crush, gemini, goose, qwen and others were skimmed for panics/division only, not audited parse-by-parse; history.rs, alerts and routes are outside this review's area.
