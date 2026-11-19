// Pricing logic derived from T3 Code's usage pricing (MIT, see NOTICE).
use crate::types::Record;
use serde_json::{Map, Value};
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq)]
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

fn same_rates(a: &Option<TokenRates>, b: &Option<TokenRates>) -> bool {
    a == b
}

/// Resellers often omit speed and context tiers, so a missing tier fills from the other entry.
fn merge_speed_rates(a: &SpeedRates, b: &SpeedRates) -> Option<SpeedRates> {
    let fast = a.fast.or(b.fast);
    let ultrafast = a.ultrafast.or(b.ultrafast);
    if a.base != b.base || !same_rates(&fast, &b.fast.or(fast)) || !same_rates(&ultrafast, &b.ultrafast.or(ultrafast)) {
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

pub fn override_table(overrides: &HashMap<String, [Option<f64>; 4]>) -> RateTable {
    // [input, output, cacheRead, cacheWrite] per million tokens.
    let mut map = HashMap::new();
    for (model, p) in overrides {
        let input = p[0].unwrap_or(0.0) / 1e6;
        let output = p[1].unwrap_or(0.0) / 1e6;
        let cache_creation = p[3].map_or(input, |v| v / 1e6);
        let base = TokenRates { input, output, cache_read: p[2].map_or(input, |v| v / 1e6), cache_creation, cache_creation_1h: cache_creation };
        map.insert(model.trim().to_string(), ModelRate { speeds: SpeedRates { base, fast: None, ultrafast: None }, tiers: Vec::new() });
    }
    RateTable { map }
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

#[derive(Clone, Copy, PartialEq)]
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
pub fn price(table: &RateTable, r: &Record, overrides: Option<&RateTable>) -> Priced {
    let override_rate = overrides.and_then(|o| o.get(r.model.trim()));
    let reported = if override_rate.is_none() { r.reported.filter(|c| c.is_finite()) } else { None };
    let unsplit = |cost: f64, source: CostSource| Priced { cost, source, category: None, speed_premium: 0.0 };
    let Some(rate) = override_rate.or_else(|| record_rate(table, r)) else {
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

pub fn cache_savings(table: &RateTable, r: &Record, overrides: Option<&RateTable>) -> f64 {
    let rate = overrides.and_then(|o| o.get(r.model.trim())).or_else(|| record_rate(table, r));
    match rate {
        None => 0.0,
        Some(rate) => {
            let rates = rates_at(rate, r.speed, r);
            r.cached * (rates.input - rates.cache_read)
        }
    }
}
