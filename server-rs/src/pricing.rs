// Pricing logic derived from T3 Code's usage pricing (MIT, see NOTICE).
use crate::types::Record;
use serde_json::{Map, Value};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TokenRates {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_creation: f64,
    /// Cache writes with a 1-hour TTL; the 5-minute rate when unpublished.
    pub cache_creation_1h: f64,
}

#[derive(Clone)]
pub struct SpeedRates {
    pub base: TokenRates,
    pub fast: Option<TokenRates>,
    pub ultrafast: Option<TokenRates>,
}

/// A request whose prompt exceeds `threshold` tokens bills every token at this tier.
#[derive(Clone)]
pub struct ContextTier {
    pub threshold: f64,
    pub rate: SpeedRates,
}

#[derive(Clone)]
pub struct ModelRate {
    pub speeds: SpeedRates,
    /// Sorted by descending threshold.
    pub tiers: Vec<ContextTier>,
}

#[derive(Default)]
pub struct RateTable {
    map: HashMap<String, ModelRate>,
}

impl RateTable {
    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn get(&self, key: &str) -> Option<&ModelRate> {
        self.map.get(key)
    }
}

fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn get_f(entry: &Map<String, Value>, name: &str, suffix: &str) -> Option<f64> {
    finite(entry.get(&format!("{name}{suffix}")))
}

/// Missing cache rates fall back to input pricing, and a missing 1-hour write rate to the 5-minute one.
fn read_token_rates(entry: &Map<String, Value>, suffix: &str, standard: Option<&TokenRates>, output_fallback: Option<f64>) -> Option<TokenRates> {
    let input = get_f(entry, "input_cost_per_token", suffix)?;
    let output = get_f(entry, "output_cost_per_token", suffix).or(output_fallback)?;
    let cache_rate = |name: &str, pick: fn(&TokenRates) -> f64, fallback: f64| -> f64 {
        get_f(entry, name, suffix).unwrap_or_else(|| match standard {
            Some(s) if s.input > 0.0 => pick(s) / s.input * input,
            _ => fallback,
        })
    };
    let cache_creation = cache_rate("cache_creation_input_token_cost", |s| s.cache_creation, input);
    Some(TokenRates {
        input,
        output,
        cache_read: cache_rate("cache_read_input_token_cost", |s| s.cache_read, input),
        cache_creation,
        cache_creation_1h: cache_rate("cache_creation_input_token_cost_above_1hr", |s| s.cache_creation_1h, cache_creation),
    })
}

fn scale(r: &TokenRates, m: f64) -> TokenRates {
    TokenRates {
        input: r.input * m,
        output: r.output * m,
        cache_read: r.cache_read * m,
        cache_creation: r.cache_creation * m,
        cache_creation_1h: r.cache_creation_1h * m,
    }
}

fn fast_multiplier(entry: &Map<String, Value>) -> Option<f64> {
    let specific = entry.get("provider_specific_entry")?.as_object()?;
    finite(specific.get("fast")).filter(|f| *f > 0.0)
}

fn read_speed_rates(entry: &Map<String, Value>, standard: TokenRates, suffix: &str) -> SpeedRates {
    let fast = match fast_multiplier(entry) {
        Some(m) => Some(scale(&standard, m)),
        None => read_token_rates(entry, &format!("{suffix}_priority"), Some(&standard), None),
    };
    let ultrafast = read_token_rates(entry, &format!("{suffix}_ultrafast"), Some(&standard), None);
    SpeedRates { base: standard, fast, ultrafast }
}

/// `input_cost_per_token_above_<n>k_tokens` with an optional `_priority` or `_ultrafast` tail.
fn tier_threshold(key: &str) -> Option<String> {
    let rest = key.strip_prefix("input_cost_per_token_above_")?;
    let end = rest.find("k_tokens")?;
    let digits = &rest[..end];
    if digits.is_empty() || digits.len() > 7 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    match &rest[end + "k_tokens".len()..] {
        "" | "_priority" | "_ultrafast" => Some(digits.to_string()),
        _ => None,
    }
}

fn read_context_tiers(entry: &Map<String, Value>, base: &TokenRates) -> Vec<ContextTier> {
    let mut thresholds: Vec<String> = Vec::new();
    for key in entry.keys() {
        if let Some(t) = tier_threshold(key) {
            if !thresholds.contains(&t) {
                thresholds.push(t);
            }
        }
    }
    let mut tiers: Vec<ContextTier> = thresholds
        .iter()
        .map(|t| {
            let suffix = format!("_above_{t}k_tokens");
            let standard = read_token_rates(entry, &suffix, Some(base), Some(base.output)).unwrap_or(*base);
            ContextTier { threshold: t.parse::<f64>().unwrap_or(0.0) * 1000.0, rate: read_speed_rates(entry, standard, &suffix) }
        })
        .collect();
    tiers.sort_by(|a, b| b.threshold.partial_cmp(&a.threshold).unwrap_or(std::cmp::Ordering::Equal));
    tiers
}

const FIRST_PARTY: [&str; 7] = ["anthropic", "deepseek", "gemini", "meta", "mistral", "openai", "xai"];

fn normalize_key(model: &str) -> String {
    model.trim().to_lowercase()
}

fn bare_name(key: &str) -> &str {
    key.rsplit_once('/').map_or(key, |(_, b)| b)
}

/// Only Bedrock's base ID gives a bare alias; its regional and GovCloud IDs carry markups.
fn bedrock_base(key: &str) -> &str {
    key.strip_prefix("anthropic.").unwrap_or(key)
}

fn strip_variant(key: &str) -> &str {
    key.split('[').next().unwrap_or(key)
}

/// Two explicitly declared rates must agree; a rate missing on either side is filled from the
/// other entry. (The old `same_rates(&fast, &b.fast.or(fast))` spelled this out indirectly.)
fn compatible_rates(a: Option<TokenRates>, b: Option<TokenRates>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => x == y,
        _ => true,
    }
}

/// Resellers often omit speed and context tiers, so a missing tier fills from the other entry.
fn merge_speed_rates(a: &SpeedRates, b: &SpeedRates) -> Option<SpeedRates> {
    let fast = a.fast.or(b.fast);
    let ultrafast = a.ultrafast.or(b.ultrafast);
    if a.base != b.base || !compatible_rates(a.fast, b.fast) || !compatible_rates(a.ultrafast, b.ultrafast) {
        return None;
    }
    Some(SpeedRates { base: a.base, fast, ultrafast })
}

fn merge_tiers(a: &[ContextTier], b: &[ContextTier]) -> Option<Vec<ContextTier>> {
    if a.is_empty() {
        return Some(b.to_vec());
    }
    if b.is_empty() {
        return Some(a.to_vec());
    }
    if a.len() != b.len() {
        return None;
    }
    let mut out = Vec::new();
    for (t, o) in a.iter().zip(b) {
        let rate = merge_speed_rates(&t.rate, &o.rate)?;
        if t.threshold != o.threshold {
            return None;
        }
        out.push(ContextTier { threshold: t.threshold, rate });
    }
    Some(out)
}

fn merge_alias(a: &ModelRate, b: &ModelRate) -> Option<ModelRate> {
    Some(ModelRate { speeds: merge_speed_rates(&a.speeds, &b.speeds)?, tiers: merge_tiers(&a.tiers, &b.tiers)? })
}

/// Drops models missing input or output rates to avoid understating cost.
pub fn parse_rate_table(document: &Value) -> RateTable {
    let mut map: HashMap<String, ModelRate> = HashMap::new();
    // JavaScript Maps keep insertion order; alias resolution below depends on it.
    let mut order: Vec<String> = Vec::new();
    let Some(object) = document.as_object() else { return RateTable { map } };
    for (name, raw) in object {
        let Some(entry) = raw.as_object() else { continue };
        let Some(standard) = read_token_rates(entry, "", None, None) else { continue };
        let key = normalize_key(name);
        if key.is_empty() {
            continue;
        }
        let rate = ModelRate { speeds: read_speed_rates(entry, standard, ""), tiers: read_context_tiers(entry, &standard) };
        if map.insert(key.clone(), rate).is_none() {
            order.push(key);
        }
    }
    struct Candidate {
        rate: Option<ModelRate>,
        first_party: bool,
    }
    let mut candidates: HashMap<String, Candidate> = HashMap::new();
    let mut candidate_order: Vec<String> = Vec::new();
    for key in &order {
        let rate = &map[key];
        let slash = key.find('/');
        let alias = if slash.is_none() { bedrock_base(key) } else { bare_name(key) };
        if alias.is_empty() || alias == key || map.contains_key(alias) {
            continue;
        }
        let first_party = slash.is_some_and(|s| FIRST_PARTY.contains(&&key[..s]));
        match candidates.get(alias) {
            None => {
                candidate_order.push(alias.to_string());
                candidates.insert(alias.to_string(), Candidate { rate: Some(rate.clone()), first_party });
            }
            Some(held) if first_party && !held.first_party => {
                candidates.insert(alias.to_string(), Candidate { rate: Some(rate.clone()), first_party });
            }
            Some(held) if held.rate.is_some() && first_party == held.first_party => {
                let merged = merge_alias(held.rate.as_ref().unwrap(), rate);
                candidates.insert(alias.to_string(), Candidate { rate: merged, first_party });
            }
            Some(_) => {}
        }
    }
    for alias in candidate_order {
        if let Some(Candidate { rate: Some(rate), .. }) = candidates.remove(&alias) {
            map.insert(alias, rate);
        }
    }
    RateTable { map }
}

/// A user price override in USD per million tokens. Each slot is optional: a missing slot keeps
/// the looked-up rate instead of silently becoming a free (0) rate.
#[derive(Clone, Copy, Debug, Default)]
pub struct Overrides {
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
}

#[derive(Default)]
pub struct OverrideTable {
    map: HashMap<String, Overrides>,
}

impl OverrideTable {
    /// Use the same normalisation as `lookup` so a differently-cased or variant-suffixed key
    /// matches both the published rate and the override.
    pub fn get(&self, model: &str) -> Option<&Overrides> {
        self.map.get(strip_variant(&normalize_key(model)).trim())
    }
}

pub fn override_table(overrides: &HashMap<String, [Option<f64>; 4]>) -> OverrideTable {
    // [input, output, cacheRead, cacheWrite] per million tokens.
    let mut map = HashMap::new();
    for (model, p) in overrides {
        let key = strip_variant(&normalize_key(model)).trim().to_string();
        if key.is_empty() || p.iter().all(Option::is_none) {
            continue;
        }
        let clean = |v: Option<f64>| v.filter(|n| n.is_finite() && *n >= 0.0);
        map.insert(key, Overrides { input: clean(p[0]), output: clean(p[1]), cache_read: clean(p[2]), cache_write: clean(p[3]) });
    }
    OverrideTable { map }
}

/// Apply the supplied slots on top of a published rate, converting per-million to per-token.
fn apply_overrides(rates: TokenRates, ov: &Overrides) -> TokenRates {
    let per_token = |v: Option<f64>, base: f64| v.map_or(base, |n| n / 1e6);
    let cache_write = per_token(ov.cache_write, rates.cache_creation);
    TokenRates {
        input: per_token(ov.input, rates.input),
        output: per_token(ov.output, rates.output),
        cache_read: per_token(ov.cache_read, rates.cache_read),
        cache_creation: cache_write,
        // The settings UI exposes one write rate; keep the 1-hour rate in step with it.
        cache_creation_1h: if ov.cache_write.is_some() { cache_write } else { rates.cache_creation_1h },
    }
}

fn overridden_speed(speed: Option<TokenRates>, ov: &Overrides) -> Option<TokenRates> {
    speed.map(|r| apply_overrides(r, ov))
}

fn overridden_rate(rate: &ModelRate, ov: &Overrides) -> ModelRate {
    ModelRate {
        speeds: SpeedRates {
            base: apply_overrides(rate.speeds.base, ov),
            fast: overridden_speed(rate.speeds.fast, ov),
            ultrafast: overridden_speed(rate.speeds.ultrafast, ov),
        },
        tiers: rate
            .tiers
            .iter()
            .map(|t| ContextTier {
                threshold: t.threshold,
                rate: SpeedRates {
                    base: apply_overrides(t.rate.base, ov),
                    fast: overridden_speed(t.rate.fast, ov),
                    ultrafast: overridden_speed(t.rate.ultrafast, ov),
                },
            })
            .collect(),
    }
}

/// A model with no published rate is priced from the override alone; unsupplied slots fall back
/// to the first supplied one rather than to a free 0 rate.
fn synthetic_rate(ov: &Overrides) -> Option<ModelRate> {
    let anchor = ov.input.or(ov.output).or(ov.cache_read).or(ov.cache_write)?;
    let base = TokenRates {
        input: ov.input.unwrap_or(anchor) / 1e6,
        output: ov.output.unwrap_or(anchor) / 1e6,
        cache_read: ov.cache_read.unwrap_or(anchor) / 1e6,
        cache_creation: ov.cache_write.unwrap_or(anchor) / 1e6,
        cache_creation_1h: ov.cache_write.unwrap_or(anchor) / 1e6,
    };
    Some(ModelRate { speeds: SpeedRates { base, fast: None, ultrafast: None }, tiers: Vec::new() })
}

/// Resolve the effective rate for a record: the override is layered on the published rate when one
/// exists, or stands alone otherwise. The scratch slot owns the layered copy.
fn effective_rate<'a>(table: &'a RateTable, r: &Record, overrides: Option<&OverrideTable>, scratch: &'a mut Option<ModelRate>) -> Option<&'a ModelRate> {
    let Some(ov) = overrides.and_then(|o| o.get(&r.model)) else {
        return record_rate(table, r);
    };
    *scratch = Some(match record_rate(table, r) {
        Some(base) => overridden_rate(base, ov),
        None => synthetic_rate(ov)?,
    });
    let scratch: &'a Option<ModelRate> = scratch;
    scratch.as_ref()
}

fn prompt_tokens(r: &Record) -> f64 {
    r.uncached + r.cached + r.cache_write
}

/// A tier without the requested speed keeps the base tier's rate for that speed.
fn rates_at(rate: &ModelRate, speed: u8, r: &Record) -> TokenRates {
    let prompt = prompt_tokens(r);
    let tier = rate.tiers.iter().find(|t| prompt > t.threshold).map(|t| &t.rate);
    let pick = |s: &SpeedRates| match speed {
        1 => s.fast,
        2 => s.ultrafast,
        _ => None,
    };
    if speed == 0 {
        return tier.map_or(rate.speeds.base, |t| t.base);
    }
    tier.and_then(pick).or_else(|| pick(&rate.speeds)).or_else(|| tier.map(|t| t.base)).unwrap_or(rate.speeds.base)
}

const UNPRICEABLE: [&str; 6] = ["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable"];

pub fn lookup<'a>(table: &'a RateTable, model: &str) -> Option<&'a ModelRate> {
    let key = strip_variant(&normalize_key(model)).to_string();
    let bare = bare_name(&key);
    if bare.is_empty() || UNPRICEABLE.contains(&bare) {
        return None;
    }
    table.get(&key)
}

fn record_rate<'a>(table: &'a RateTable, r: &Record) -> Option<&'a ModelRate> {
    r.rate_model.as_deref().and_then(|m| lookup(table, m)).or_else(|| lookup(table, &r.model))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CostSource {
    Unpriced,
    ProviderReported,
    ModelPriced,
}

#[derive(Clone, Copy, Default)]
pub struct Category {
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
}

pub struct Priced {
    pub cost: f64,
    pub source: CostSource,
    pub category: Option<Category>,
    pub speed_premium: f64,
}

fn cost_by_category(r: &Record, rates: &TokenRates) -> Category {
    let one_hour = r.cache_1h.min(r.cache_write);
    Category {
        input: r.uncached * rates.input,
        cache_read: r.cached * rates.cache_read,
        cache_write: (r.cache_write - one_hour) * rates.cache_creation + one_hour * rates.cache_creation_1h,
        output: r.output * rates.output,
    }
}

fn sum(c: &Category) -> f64 {
    c.input + c.cache_read + c.cache_write + c.output
}

/// Reasoning tokens are already included in `output`; they are not charged twice.
pub fn price(table: &RateTable, r: &Record, overrides: Option<&OverrideTable>) -> Priced {
    // Reported cost is authoritative whenever the provider supplied it, including for records that
    // also match a price override; the rates (published or overridden) only split it by category.
    let reported = r.reported.filter(|c| c.is_finite());
    let unsplit = |cost: f64, source: CostSource| Priced { cost, source, category: None, speed_premium: 0.0 };
    let mut scratch = None;
    let Some(rate) = effective_rate(table, r, overrides, &mut scratch) else {
        return match reported {
            None => unsplit(0.0, CostSource::Unpriced),
            Some(c) => unsplit(c, CostSource::ProviderReported),
        };
    };
    let list = cost_by_category(r, &rates_at(rate, r.speed, r));
    let list_cost = sum(&list);
    if let Some(c) = reported {
        if list_cost <= 0.0 {
            return unsplit(c, CostSource::ProviderReported);
        }
    }
    let premium = if r.speed == 0 { 0.0 } else { list_cost - sum(&cost_by_category(r, &rates_at(rate, 0, r))) };
    let scale = reported.map_or(1.0, |c| c / list_cost);
    Priced {
        cost: reported.unwrap_or(list_cost),
        source: if reported.is_none() { CostSource::ModelPriced } else { CostSource::ProviderReported },
        category: Some(Category {
            input: list.input * scale,
            cache_read: list.cache_read * scale,
            cache_write: list.cache_write * scale,
            output: list.output * scale,
        }),
        speed_premium: premium * scale,
    }
}

pub fn cache_savings(table: &RateTable, r: &Record, overrides: Option<&OverrideTable>) -> f64 {
    let mut scratch = None;
    match effective_rate(table, r, overrides, &mut scratch) {
        None => 0.0,
        Some(rate) => {
            let rates = rates_at(rate, r.speed, r);
            r.cached * (rates.input - rates.cache_read)
        }
    }
}

// ---------------------------------------------------------------------------
// Pricing source fallback chain (package 09).
//
// `engine.rs::ensure_pricing` now calls `load_chain(&data_dir, &UreqFetcher, false)` and builds
// its table with `rate_table_from`, so the documented chain (LiteLLM -> OpenRouter models API,
// cached to `pricing-cache.json`) is live. The injectable fetcher keeps the chain unit-testable
// without network access.
// ---------------------------------------------------------------------------

pub const LITELLM_URL: &str = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
pub const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
const PRICE_CACHE_TTL_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

// Public API for the integrator to wire into engine.rs::ensure_pricing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PricingSource {
    /// A fresh read from the configured file (kept for compatibility).
    Cache,
    LiteLLM,
    OpenRouter,
    Unavailable,
}

impl PricingSource {
    pub fn as_str(self) -> &'static str {
        match self {
            PricingSource::Cache => "cached",
            PricingSource::LiteLLM => "litellm",
            PricingSource::OpenRouter => "openrouter",
            PricingSource::Unavailable => "unavailable",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "litellm" => PricingSource::LiteLLM,
            "openrouter" => PricingSource::OpenRouter,
            _ => PricingSource::Cache,
        }
    }
}

/// The result of resolving the pricing fallback chain.
pub struct PricingChain {
    pub document: Option<Value>,
    pub source: PricingSource,
    pub fetched_at: Option<String>,
}

/// Injectable HTTP getter; returns a decoded JSON document or `None`.
pub trait JsonFetcher {
    fn get_json(&self, url: &str, timeout_secs: u64) -> Option<Value>;
}

/// Production fetcher using the already-available `ureq` dependency.
pub struct UreqFetcher;

impl JsonFetcher for UreqFetcher {
    fn get_json(&self, url: &str, timeout_secs: u64) -> Option<Value> {
        ureq::get(url).timeout(std::time::Duration::from_secs(timeout_secs)).call().ok()?.into_json::<Value>().ok()
    }
}

fn price_number(value: Option<&Value>) -> Option<f64> {
    let number = match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }?;
    number.is_finite().then_some(number)
}

/// Convert OpenRouter's public `/api/v1/models` response into the LiteLLM-shaped
/// document that `parse_rate_table` already understands. Per-token prices are
/// strings in that API (e.g. `"0.000002"`), so they are parsed into numbers.
pub fn parse_openrouter_models(document: &Value) -> Option<Value> {
    let models = document.get("data").and_then(Value::as_array)?;
    let mut table = serde_json::Map::new();
    for entry in models {
        let Some(id) = entry.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else { continue };
        let Some(pricing) = entry.get("pricing").and_then(Value::as_object) else { continue };
        let Some(prompt) = price_number(pricing.get("prompt")) else { continue };
        let completion = price_number(pricing.get("completion")).unwrap_or(0.0);
        let mut model = serde_json::Map::new();
        model.insert("input_cost_per_token".into(), serde_json::json!(prompt));
        model.insert("output_cost_per_token".into(), serde_json::json!(completion));
        if let Some(rate) = price_number(pricing.get("input_cache_read")).or_else(|| price_number(pricing.get("cache_read"))) {
            model.insert("cache_read_input_token_cost".into(), serde_json::json!(rate));
        }
        if let Some(rate) = price_number(pricing.get("input_cache_write")).or_else(|| price_number(pricing.get("cache_write"))) {
            model.insert("cache_creation_input_token_cost".into(), serde_json::json!(rate));
        }
        table.insert(id.to_string(), Value::Object(model));
    }
    (!table.is_empty()).then(|| Value::Object(table))
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn write_cache(file: &std::path::Path, document: &Value, source: PricingSource, fetched_at: &str) {
    if std::fs::create_dir_all(file.parent().unwrap_or_else(|| std::path::Path::new("."))).is_err() {
        return;
    }
    let payload = serde_json::json!({"fetchedAt": fetched_at, "source": source.as_str(), "document": document});
    let bytes = match serde_json::to_vec(&payload) {
        Ok(bytes) => bytes,
        Err(_) => return,
    };
    let tmp = file.with_extension(format!("tmp-{}", std::process::id()));
    if std::fs::write(&tmp, bytes).is_ok() {
        let _ = std::fs::rename(&tmp, file);
    }
}

/// The saved price document, whatever its age, without any network call.
fn read_cache(file: &std::path::Path) -> Option<(Value, Option<String>, PricingSource)> {
    let text = std::fs::read_to_string(file).ok()?;
    let saved = serde_json::from_str::<Value>(&text).ok()?;
    let document = saved.get("document").cloned()?;
    let fetched_at = saved.get("fetchedAt").and_then(Value::as_str).map(str::to_string);
    let source = saved.get("source").and_then(Value::as_str).map_or(PricingSource::Cache, PricingSource::parse);
    Some((document, fetched_at, source))
}

/// Prices from the on-disk cache only (any age): what a start-up request can use at once while the
/// network refresh runs in the background.
pub fn load_cached(data_dir: &std::path::Path) -> PricingChain {
    match read_cache(&data_dir.join("pricing-cache.json")) {
        Some((document, fetched_at, source)) => PricingChain { document: Some(document), source, fetched_at },
        None => PricingChain { document: None, source: PricingSource::Unavailable, fetched_at: None },
    }
}

/// Resolve prices from cache, then LiteLLM, then the OpenRouter models API.
/// On a network failure a stale cache is still returned (never zero prices).
pub fn load_chain(data_dir: &std::path::Path, fetcher: &dyn JsonFetcher, force: bool) -> PricingChain {
    let file = data_dir.join("pricing-cache.json");
    let cached = read_cache(&file);
    let fresh = cached.as_ref().and_then(|(_, at, _)| at.as_deref()).and_then(crate::types::parse_rfc3339_ms).is_some_and(|ms| now_ms() - ms < PRICE_CACHE_TTL_MS);
    if !force && fresh {
        if let Some((document, fetched_at, source)) = cached {
            return PricingChain { document: Some(document), source, fetched_at };
        }
    }
    if let Some(document) = fetcher.get_json(LITELLM_URL, 20).filter(|v| v.is_object()) {
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        write_cache(&file, &document, PricingSource::LiteLLM, &at);
        return PricingChain { document: Some(document), source: PricingSource::LiteLLM, fetched_at: Some(at) };
    }
    if let Some(document) = fetcher.get_json(OPENROUTER_MODELS_URL, 10).and_then(|v| parse_openrouter_models(&v)) {
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        write_cache(&file, &document, PricingSource::OpenRouter, &at);
        return PricingChain { document: Some(document), source: PricingSource::OpenRouter, fetched_at: Some(at) };
    }
    match cached {
        Some((document, fetched_at, _)) => PricingChain { document: Some(document), source: PricingSource::Cache, fetched_at },
        None => PricingChain { document: None, source: PricingSource::Unavailable, fetched_at: None },
    }
}

/// Turn a resolved chain into the engine's rate table.
pub fn rate_table_from(chain: &PricingChain) -> RateTable {
    chain.document.as_ref().map_or_else(RateTable::default, parse_rate_table)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct FakeFetcher {
        litellm: Option<Value>,
        openrouter: Option<Value>,
        litellm_calls: AtomicU64,
        openrouter_calls: AtomicU64,
    }

    impl JsonFetcher for FakeFetcher {
        fn get_json(&self, url: &str, _timeout_secs: u64) -> Option<Value> {
            if url == LITELLM_URL {
                self.litellm_calls.fetch_add(1, Ordering::Relaxed);
                self.litellm.clone()
            } else if url == OPENROUTER_MODELS_URL {
                self.openrouter_calls.fetch_add(1, Ordering::Relaxed);
                self.openrouter.clone()
            } else {
                None
            }
        }
    }

    fn temp_dir() -> std::path::PathBuf {
        static COUNT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("burnrate-pricing-{}-{}", std::process::id(), COUNT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn converts_openrouter_models_to_litellm_shape() {
        let doc = serde_json::json!({"data":[
            {"id":"openai/gpt-5","pricing":{"prompt":"0.000002","completion":"0.000006","input_cache_read":"0.0000005"}},
            {"id":"anthropic/claude-sonnet","pricing":{"prompt":"0.000003","completion":"0.000015"}},
            {"id":"broken/no-price","pricing":{}}
        ]});
        let table = parse_openrouter_models(&doc).unwrap();
        assert_eq!(table["openai/gpt-5"]["input_cost_per_token"].as_f64(), Some(0.000002));
        assert_eq!(table["openai/gpt-5"]["output_cost_per_token"].as_f64(), Some(0.000006));
        assert_eq!(table["openai/gpt-5"]["cache_read_input_token_cost"].as_f64(), Some(0.0000005));
        assert!(table.get("broken/no-price").is_none());
        let rates = parse_rate_table(&table);
        assert!(rates.get("openai/gpt-5").is_some());
        assert!(rates.get("anthropic/claude-sonnet").is_some());
        assert!(rates.get("gpt-5").is_some()); // bare alias generated by the existing table logic
    }

    #[test]
    fn falls_back_to_openrouter_and_caches() {
        let dir = temp_dir();
        let fetcher = FakeFetcher {
            litellm: None,
            openrouter: Some(serde_json::json!({"data":[{"id":"vendor/new-model","pricing":{"prompt":"0.001","completion":"0.002"}}]})),
            litellm_calls: AtomicU64::new(0),
            openrouter_calls: AtomicU64::new(0),
        };
        let chain = load_chain(&dir, &fetcher, false);
        assert_eq!(chain.source, PricingSource::OpenRouter);
        assert!(rate_table_from(&chain).get("vendor/new-model").is_some());
        assert_eq!(fetcher.litellm_calls.load(Ordering::Relaxed), 1);
        assert!(dir.join("pricing-cache.json").is_file());

        // Second call is served from the fresh cache with no network calls.
        let chain2 = load_chain(&dir, &fetcher, false);
        assert_eq!(chain2.source, PricingSource::OpenRouter);
        assert_eq!(fetcher.openrouter_calls.load(Ordering::Relaxed), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn litellm_wins_and_stale_cache_survives_network_failure() {
        let dir = temp_dir();
        let fetcher = FakeFetcher {
            litellm: Some(serde_json::json!({"model-a":{"input_cost_per_token":0.001,"output_cost_per_token":0.002}})),
            openrouter: None,
            litellm_calls: AtomicU64::new(0),
            openrouter_calls: AtomicU64::new(0),
        };
        let chain = load_chain(&dir, &fetcher, false);
        assert_eq!(chain.source, PricingSource::LiteLLM);
        assert_eq!(rate_table_from(&chain).len(), 1);

        let offline = FakeFetcher { litellm: None, openrouter: None, litellm_calls: AtomicU64::new(0), openrouter_calls: AtomicU64::new(0) };
        let stale = load_chain(&dir, &offline, true);
        assert_eq!(stale.source, PricingSource::Cache);
        assert!(stale.document.is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn published_table() -> RateTable {
        parse_rate_table(&serde_json::json!({"vendor/model": {
            "input_cost_per_token": 0.000001,
            "output_cost_per_token": 0.000002,
            "cache_read_input_token_cost": 0.0000005,
            "cache_creation_input_token_cost": 0.00000025
        }}))
    }

    fn record(model: &str) -> Record {
        let mut r = Record::new("vendor", 0.0, model, "session");
        r.uncached = 1_000_000.0;
        r.output = 1_000_000.0;
        r
    }

    #[test]
    fn partial_override_fills_missing_slots_from_published_rate() {
        let table = published_table();
        let mut overrides = HashMap::new();
        overrides.insert("Vendor/Model[fast]".to_string(), [Some(2.0), None, None, None]);
        let overrides = override_table(&overrides);
        let mut r = record("vendor/model");
        r.reported = Some(5.0);
        let priced = price(&table, &r, Some(&overrides));
        // Input is overridden to $2/M; output keeps the published $2/M (not zero), and the
        // provider's reported cost is still authoritative rather than being discarded.
        assert_eq!(priced.source, CostSource::ProviderReported);
        assert_eq!(priced.cost, 5.0);
        let category = priced.category.unwrap();
        assert!((category.input - 2.5).abs() < 1e-9);
        assert!((category.output - 2.5).abs() < 1e-9);
    }

    #[test]
    fn override_fills_only_the_slots_it_supplies() {
        let table = published_table();
        let mut overrides = HashMap::new();
        overrides.insert("vendor/model".to_string(), [None, None, None, Some(0.1)]);
        let overrides = override_table(&overrides);
        let mut r = record("vendor/model");
        r.uncached = 0.0;
        r.output = 0.0;
        r.cache_write = 1_000_000.0;
        r.cached = 1_000_000.0;
        let priced = price(&table, &r, Some(&overrides));
        // 0.1/M overridden write + the published 0.5/M cached-read rate (0.1 + 0.5).
        assert!((priced.cost - 0.6).abs() < 1e-9);
        assert!((cache_savings(&table, &r, Some(&overrides)) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn override_keys_are_normalised_and_unmatched_records_keep_reported_cost() {
        let mut overrides = HashMap::new();
        overrides.insert("GPT-4o".to_string(), [None, Some(3.0), None, None]);
        let overrides = override_table(&overrides);
        let mut r = record("gpt-4o[fast]");
        r.output = 0.0;
        let priced = price(&RateTable::default(), &r, Some(&overrides));
        // The only supplied slot (output $3/M) anchors the synthetic rate, not a free input rate.
        assert!((priced.cost - 3.0).abs() < 1e-9);

        let mut unmatched = record("other/model");
        unmatched.reported = Some(7.0);
        let priced = price(&published_table(), &unmatched, Some(&overrides));
        assert_eq!(priced.cost, 7.0);
        assert_eq!(priced.source, CostSource::ProviderReported);
    }

    #[test]
    fn merge_detects_conflicting_explicit_speeds_and_fills_missing_ones() {
        let rates = |v: f64| TokenRates { input: v, output: v, cache_read: 0.0, cache_creation: 0.0, cache_creation_1h: 0.0 };
        let base = rates(1.0);
        let a = SpeedRates { base, fast: Some(rates(2.0)), ultrafast: None };
        let conflicting = SpeedRates { base, fast: Some(rates(3.0)), ultrafast: None };
        assert!(merge_speed_rates(&a, &conflicting).is_none()); // not a tautology

        let missing = SpeedRates { base, fast: None, ultrafast: Some(rates(4.0)) };
        let merged = merge_speed_rates(&a, &missing).expect("complementary speeds merge");
        assert_eq!(merged.fast, Some(rates(2.0)));
        assert_eq!(merged.ultrafast, Some(rates(4.0)));
    }
}
