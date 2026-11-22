//! Turns the published rows into the `/api/usage` summary. Pure over `Inner`: it never scans,
//! never touches the network and does not copy row data. Rows outside the requested window are
//! skipped on their timestamp alone, before any string work.

use super::{max_merge, resolve_aliases, time_zone_or_utc, warn_bad_time_zone, Inner, SummaryInput, DAY_MS, QUARTER_HOUR_MS};
use crate::pricing::{self, Category, CostSource};
use crate::settings::Settings;
use crate::store::{self, C_CACHED, C_CACHE_WRITE, C_KEY, C_OUTPUT, C_REASONING, C_SESSION, C_TS, C_UNCACHED, STRIDE};
use crate::types::Record;
use chrono::{NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
struct Acc {
    totals: [f64; 5],
    cost: f64,
    cache_savings: f64,
    category: Category,
    has_category: bool,
    fast_cost: f64,
    ultrafast_cost: f64,
    speed_premium: f64,
    records: u32,
    unpriced_records: u32,
    unpriced_tokens: f64,
    reported_records: u32,
    priced_records: u32,
    sessions: HashSet<u64>,
    day: String,
    hour_start: Option<String>,
    provider: String,
    model: String,
}

/// One quarter-hour of wall-clock time resolved in the viewer's zone, computed once per slot.
#[derive(Clone, Copy)]
struct Slot {
    day: u32,
    hour: u8,
    in_window: bool,
}

struct Slots {
    tz: Tz,
    since: String,
    until: String,
    map: HashMap<i64, Slot>,
    days: Vec<String>,
    day_ids: HashMap<String, u32>,
}

impl Slots {
    fn of(&mut self, ms: f64) -> Slot {
        let slot = (ms / QUARTER_HOUR_MS).floor() as i64;
        if let Some(found) = self.map.get(&slot) {
            return *found;
        }
        let (day, hour) = self
            .tz
            .timestamp_millis_opt((slot as f64 * QUARTER_HOUR_MS) as i64)
            .single()
            .map_or_else(|| (String::new(), 0), |d| (d.format("%Y-%m-%d").to_string(), d.format("%H").to_string().parse::<u8>().unwrap_or(0)));
        let in_window = day.as_str() >= self.since.as_str() && day.as_str() <= self.until.as_str();
        let id = match self.day_ids.get(&day) {
            Some(&id) => id,
            None => {
                let id = self.days.len() as u32;
                self.days.push(day.clone());
                self.day_ids.insert(day, id);
                id
            }
        };
        let found = Slot { day: id, hour, in_window };
        self.map.insert(slot, found);
        found
    }
}

/// UTC bounds that surely contain every instant of the requested local days (a day of slack each
/// side covers any offset). Only a cheap pre-filter: the exact day test still decides.
fn window_bounds(since: &str, until: &str) -> (f64, f64) {
    let ms = |day: &str| NaiveDate::parse_from_str(day, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(0, 0, 0)).map(|d| d.and_utc().timestamp_millis() as f64);
    match (ms(since), ms(until)) {
        (Some(lo), Some(hi)) => (lo - DAY_MS, hi + 2.0 * DAY_MS),
        _ => (f64::NEG_INFINITY, f64::INFINITY),
    }
}

/// A template per distinct (provider, model, rate model): only the numbers change per row, so the
/// strings are built once instead of five `String`s per record.
struct Dim {
    record: Record,
    bucket: u32,
}

fn fill(record: &mut Record, chunk: &[f64]) {
    record.ts = chunk[C_TS];
    record.speed = chunk[store::C_SPEED] as u8;
    record.uncached = chunk[C_UNCACHED];
    record.cached = chunk[C_CACHED];
    record.cache_write = chunk[C_CACHE_WRITE];
    record.output = chunk[C_OUTPUT];
    record.reasoning = chunk[C_REASONING];
    record.cache_1h = chunk[store::C_CACHE_1H];
    let cost = chunk[store::C_REPORTED];
    record.reported = if cost.is_nan() { None } else { Some(cost) };
}

pub(super) fn compute(inner: &Inner, providers: &[&'static str], dirs: &[String], input: &SummaryInput, settings: &Settings) -> Value {
    let started = std::time::Instant::now();
    let aliases = resolve_aliases(&settings.aliases);
    let overrides = if settings.prices.is_empty() { None } else { Some(pricing::override_table(&settings.prices)) };
    let (tz, bad_time_zone) = time_zone_or_utc(&input.time_zone);
    if bad_time_zone {
        warn_bad_time_zone(&input.time_zone);
    }
    let (lo, hi) = window_bounds(&input.since_day, &input.until_day);
    // A "past 24 hours" request still spans two local days; the exact timestamps decide the edges.
    let exact = match (input.since_time, input.until_time) {
        (Some(since), Some(until)) if until > since => Some((since, until)),
        _ => None,
    };
    let in_exact = |ts: f64| exact.map_or(true, |(since, until)| ts >= since && ts < until);
    let mut slots = Slots { tz, since: input.since_day.clone(), until: input.until_day.clone(), map: HashMap::new(), days: Vec::new(), day_ids: HashMap::new() };
    let in_bounds = |ts: f64| ts >= lo && ts < hi;

    // Keys that appear in several files count once, at the maximum of each channel, for the providers that
    // repeat a message key (Claude per content block, Antigravity per retry).
    let mut maxed: HashMap<u64, [f64; 5]> = HashMap::new();
    for (index, provider) in providers.iter().enumerate() {
        if !max_merge(provider) {
            continue;
        }
        for rows in &inner.views[index].rows {
            for chunk in rows.chunks_exact(STRIDE) {
                let key = chunk[C_KEY];
                if key.is_nan() || !in_bounds(chunk[C_TS]) || !in_exact(chunk[C_TS]) {
                    continue;
                }
                let vals = [chunk[C_UNCACHED], chunk[C_CACHED], chunk[C_CACHE_WRITE], chunk[C_OUTPUT], chunk[C_REASONING]];
                maxed
                    .entry(key.to_bits())
                    .and_modify(|held| (0..5).for_each(|c| held[c] = held[c].max(vals[c])))
                    .or_insert(vals);
            }
        }
    }

    let empty_session = inner.strings.lookup("").map_or(f64::NAN, f64::from);
    // Distinct sessions inside the requested window, per provider. `distinct_sessions` on the view is
    // all-time and stays reserved for "sessions on this computer" surfaces.
    let mut window_sessions: Vec<HashSet<u64>> = (0..providers.len()).map(|_| HashSet::new()).collect();
    let mut counted: HashSet<u64> = HashSet::new();
    let mut dims: HashMap<(u64, u64, u64), usize> = HashMap::new();
    let mut dim_list: Vec<Dim> = Vec::new();
    let mut bucket_ids: HashMap<(String, String), u32> = HashMap::new();
    let mut bucket_names: Vec<(String, String)> = Vec::new();
    let mut buckets: HashMap<(u32, u8, u32), Acc> = HashMap::new();
    for (index, provider) in providers.iter().enumerate() {
        let merge = max_merge(provider);
        for rows in &inner.views[index].rows {
            for (i, chunk) in rows.chunks_exact(STRIDE).enumerate() {
                let ts = chunk[C_TS];
                if !in_bounds(ts) {
                    continue;
                }
                if !in_exact(ts) {
                    continue;
                }
                let slot = slots.of(ts);
                if !slot.in_window {
                    continue;
                }
                if chunk[C_SESSION] != empty_session {
                    window_sessions[index].insert(chunk[C_SESSION].to_bits());
                }
                let key = chunk[C_KEY];
                if !key.is_nan() && !counted.insert(key.to_bits()) {
                    continue;
                }
                let dim_key = (chunk[store::C_PROVIDER].to_bits(), chunk[store::C_MODEL].to_bits(), chunk[store::C_RATE_MODEL].to_bits());
                let d = *dims.entry(dim_key).or_insert_with(|| {
                    let mut record = store::unpack(rows, i, &inner.strings);
                    // A model name mapped to another is counted and priced as that one.
                    if let Some(target) = aliases.get(&record.model) {
                        record.model = target.clone();
                        record.rate_model = None;
                    }
                    let names = (record.provider.clone(), record.model.clone());
                    let bucket = *bucket_ids.entry(names.clone()).or_insert_with(|| {
                        bucket_names.push(names);
                        (bucket_names.len() - 1) as u32
                    });
                    dim_list.push(Dim { record, bucket });
                    dim_list.len() - 1
                });
                let dim = &mut dim_list[d];
                fill(&mut dim.record, chunk);
                if merge && !key.is_nan() {
                    if let Some(m) = maxed.get(&key.to_bits()) {
                        dim.record.uncached = m[0];
                        dim.record.cached = m[1];
                        dim.record.cache_write = m[2];
                        dim.record.output = m[3];
                        dim.record.reasoning = m[4];
                    }
                }
                let r = &dim.record;
                let hour = if input.hourly { slot.hour } else { u8::MAX };
                let b = buckets.entry((slot.day, hour, dim.bucket)).or_insert_with(|| {
                    let day = slots.days[slot.day as usize].clone();
                    let (provider, model) = bucket_names[dim.bucket as usize].clone();
                    Acc { hour_start: input.hourly.then(|| format!("{day}T{:02}:00", slot.hour)), day, provider, model, ..Acc::default() }
                });
                let priced = pricing::price(&inner.rates, r, overrides.as_ref());
                for (t, v) in b.totals.iter_mut().zip([r.uncached, r.cached, r.cache_write, r.output, r.reasoning]) {
                    *t += v;
                }
                b.cost += priced.cost;
                b.cache_savings += pricing::cache_savings(&inner.rates, r, overrides.as_ref());
                if let Some(c) = priced.category {
                    b.has_category = true;
                    b.category.input += c.input;
                    b.category.cache_read += c.cache_read;
                    b.category.cache_write += c.cache_write;
                    b.category.output += c.output;
                }
                if r.speed == 1 {
                    b.fast_cost += priced.cost;
                }
                if r.speed == 2 {
                    b.ultrafast_cost += priced.cost;
                }
                b.speed_premium += priced.speed_premium;
                b.records += 1;
                match priced.source {
                    CostSource::Unpriced => {
                        b.unpriced_records += 1;
                        b.unpriced_tokens += r.total_tokens();
                    }
                    CostSource::ProviderReported => b.reported_records += 1,
                    CostSource::ModelPriced => b.priced_records += 1,
                }
                if chunk[C_SESSION] != empty_session {
                    b.sessions.insert(chunk[C_SESSION].to_bits());
                }
            }
        }
    }
    let mut out: Vec<Acc> = buckets.into_values().collect();
    out.sort_by(|a, b| {
        (a.day.as_str(), a.hour_start.as_deref().unwrap_or(""), a.provider.as_str(), a.model.as_str())
            .cmp(&(b.day.as_str(), b.hour_start.as_deref().unwrap_or(""), b.provider.as_str(), b.model.as_str()))
    });
    let buckets_json: Vec<Value> = out
        .iter()
        .map(|b| {
            let mut v = json!({
                "day": b.day,
                "provider": b.provider,
                "model": b.model,
                "totals": {
                    "uncachedInputTokens": b.totals[0], "cachedInputTokens": b.totals[1], "cacheCreationTokens": b.totals[2],
                    "outputTokens": b.totals[3], "reasoningTokens": b.totals[4],
                },
                "costUsd": b.cost,
                "cacheSavingsUsd": b.cache_savings,
                "costSource": if b.unpriced_records == b.records { "unpriced" } else if b.reported_records > 0 && b.priced_records == 0 { "providerReported" } else { "modelPriced" },
                "records": b.records,
                "unpricedRecords": b.unpriced_records,
                "unpricedTokens": b.unpriced_tokens,
                "sessions": b.sessions.len(),
            });
            let m = v.as_object_mut().unwrap();
            if let Some(h) = &b.hour_start {
                m.insert("hourStart".into(), json!(h));
            }
            if b.has_category {
                m.insert("categoryCostUsd".into(), json!({"input": b.category.input, "cacheRead": b.category.cache_read, "cacheWrite": b.category.cache_write, "output": b.category.output}));
            }
            if b.fast_cost > 0.0 {
                m.insert("fastCostUsd".into(), json!(b.fast_cost));
            }
            if b.ultrafast_cost > 0.0 {
                m.insert("ultrafastCostUsd".into(), json!(b.ultrafast_cost));
            }
            if b.speed_premium > 0.0 {
                m.insert("speedPremiumUsd".into(), json!(b.speed_premium));
            }
            v
        })
        .collect();
    let sources: Vec<Value> = providers
        .iter()
        .enumerate()
        .filter_map(|(index, provider)| {
            let view = &inner.views[index];
            view.reported().then(|| {
                json!({
                    "fingerprint": {"hostId": "local", "provider": provider, "resolvedHomePath": dirs[index], "volumeId": ""},
                    "status": view.status,
                    "scannedFiles": view.scanned_files,
                    "skippedFiles": 0,
                    "malformedRecords": view.malformed,
                    "distinctSessions": view.distinct_sessions,
                    "windowSessions": window_sessions[index].len(),
                    "message": view.message,
                })
            })
        })
        .collect();
    let mut result = json!({
        "contractVersion": 6,
        "readAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "timeZone": input.time_zone,
        "sinceDay": input.since_day,
        "untilDay": input.until_day,
        "buckets": buckets_json,
        "sources": sources,
        "pricing": {"status": inner.pricing.status, "source": inner.pricing.source, "fetchedAt": inner.pricing.fetched_at, "knownModels": inner.pricing.known_models},
        "scanDurationMs": started.elapsed().as_millis() as u64,
    });
    if bad_time_zone {
        result["warnings"] = json!([format!("invalid time zone '{}'; used UTC", input.time_zone)]);
    }
    result
}
