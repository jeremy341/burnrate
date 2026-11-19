use crate::pricing::{self, Category, CostSource, RateTable};
use crate::readers::{self, Source};
use crate::settings::Settings;
use crate::store::{self, FileEntry, Interner, C_CACHED, C_CACHE_WRITE, C_KEY, C_OUTPUT, C_REASONING, C_SESSION, C_TS, C_UNCACHED, STRIDE};
use crate::types::Record;
use chrono::{TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const LITELLM_URL: &str = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PRICE_TTL_SECS: u64 = 24 * 60 * 60;
/// History kept; the widest window the UI offers is 90 days.
const HORIZON_DAYS: f64 = 100.0;
const DAY_MS: f64 = 86_400_000.0;
const QUARTER_HOUR_MS: f64 = 15.0 * 60.0 * 1000.0;
/// Bump when readers change what they extract or the row layout changes, so stale caches are dropped.
const CACHE_VERSION: u32 = 3;
const SEP: char = '\0';
/// Providers that repeat a message key (Claude per content block, Antigravity per retry): count it once at the maximum of each channel.
const MAX_MERGE: [&str; 2] = ["claude", "antigravity"];

struct Pricing {
    status: &'static str,
    fetched_at: Option<String>,
    known_models: usize,
}

struct Inner {
    strings: Interner,
    cache: HashMap<String, FileEntry>,
    dirty: bool,
    rates: RateTable,
    pricing: Pricing,
    pricing_checked: Option<SystemTime>,
}

pub struct Engine {
    data_dir: PathBuf,
    readers: Vec<Box<dyn Source>>,
    inner: Mutex<Inner>,
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn max_merge(provider: &str) -> bool {
    MAX_MERGE.contains(&provider)
}

/// Merges records that share a key within one file, taking the maximum of each channel.
fn merge_within_file(records: Vec<Record>) -> Vec<Record> {
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<Record> = Vec::with_capacity(records.len());
    for r in records {
        let Some(key) = r.key.clone().filter(|_| max_merge(&r.provider)) else {
            out.push(r);
            continue;
        };
        match index.get(&key) {
            None => {
                index.insert(key, out.len());
                out.push(r);
            }
            Some(&at) => {
                let first = &mut out[at];
                first.uncached = first.uncached.max(r.uncached);
                first.cached = first.cached.max(r.cached);
                first.cache_write = first.cache_write.max(r.cache_write);
                first.output = first.output.max(r.output);
                first.reasoning = first.reasoning.max(r.reasoning);
                first.cache_1h = first.cache_1h.max(r.cache_1h);
                if first.reported.is_none() {
                    first.reported = r.reported;
                }
            }
        }
    }
    out
}

/// Follow alias chains to their end; a cycle resolves to nothing.
fn resolve_aliases(aliases: &HashMap<String, String>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for start in aliases.keys() {
        let mut seen = HashSet::new();
        let mut target = start.as_str();
        while let Some(next) = aliases.get(target) {
            if !seen.insert(target) {
                break;
            }
            target = next;
        }
        if !aliases.contains_key(target) {
            out.insert(start.clone(), target.to_string());
        }
    }
    out
}

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

pub struct SummaryInput {
    pub since_day: String,
    pub until_day: String,
    pub time_zone: String,
    pub hourly: bool,
}

impl Engine {
    pub fn new(data_dir: PathBuf) -> Engine {
        let (strings, cache) = store::load(&data_dir.join("usage-scan-cache.bin"), CACHE_VERSION).unwrap_or_else(|| (Interner::default(), HashMap::new()));
        Engine {
            data_dir,
            readers: readers::all(),
            inner: Mutex::new(Inner {
                strings,
                cache,
                dirty: false,
                rates: RateTable::default(),
                pricing: Pricing { status: "unavailable", fetched_at: None, known_models: 0 },
                pricing_checked: None,
            }),
        }
    }

    pub fn reader_dir(&self, provider: &str) -> Option<PathBuf> {
        self.readers.iter().find(|r| r.provider() == provider).map(|r| r.dir())
    }

    fn ensure_pricing(&self, inner: &mut Inner) {
        if inner.pricing_checked.is_some_and(|t| t.elapsed().map_or(false, |e| e < Duration::from_secs(PRICE_TTL_SECS))) {
            return;
        }
        inner.pricing_checked = Some(SystemTime::now());
        let file = self.data_dir.join("pricing-cache.json");
        let mut document: Option<Value> = None;
        let mut fetched_at: Option<String> = None;
        if let Ok(text) = std::fs::read_to_string(&file) {
            if let Ok(saved) = serde_json::from_str::<Value>(&text) {
                fetched_at = saved.get("fetchedAt").and_then(Value::as_str).map(str::to_string);
                document = saved.get("document").cloned();
            }
        }
        let stale = match &fetched_at {
            None => true,
            Some(t) => crate::types::parse_rfc3339_ms(t).map_or(true, |ms| now_ms() - ms > PRICE_TTL_SECS as f64 * 1000.0),
        };
        let mut status = if document.is_some() { "cached" } else { "unavailable" };
        if stale {
            let fetched = ureq::get(LITELLM_URL).timeout(Duration::from_secs(20)).call().ok().and_then(|r| r.into_json::<Value>().ok());
            if let Some(doc) = fetched {
                let at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let _ = std::fs::create_dir_all(&self.data_dir);
                let _ = std::fs::write(&file, serde_json::to_vec(&json!({"fetchedAt": at, "document": doc})).unwrap_or_default());
                document = Some(doc);
                fetched_at = Some(at);
                status = "fresh";
            }
        }
        if let Some(doc) = document {
            inner.rates = pricing::parse_rate_table(&doc);
            inner.pricing = Pricing { status, fetched_at, known_models: inner.rates.len() };
        }
    }

    fn scan(&self, inner: &mut Inner) -> (Vec<(String, Vec<f64>)>, Vec<Value>) {
        let since = now_ms() - HORIZON_DAYS * DAY_MS;
        let mut scanned: Vec<(String, Vec<f64>)> = Vec::new();
        let mut sources: Vec<Value> = Vec::new();
        for reader in &self.readers {
            let provider = reader.provider();
            let files = reader.files();
            let mut seen: HashSet<String> = HashSet::new();
            let mut malformed = 0u32;
            let mut status = if files.is_empty() { "missing" } else { "ok" };
            let mut message: Option<&str> = if files.is_empty() { Some("Nothing found on this computer.") } else { None };
            let mut keys: Vec<(String, String)> = Vec::new(); // (cache key, path)
            // Files changed since the cached read are parsed in parallel, a batch at a time to bound memory.
            let mut stale_files: Vec<(String, &readers::FileInfo)> = Vec::new();
            for file in &files {
                let key = format!("{provider}{SEP}{}", file.path.display());
                seen.insert(key.clone());
                // Files untouched since before the history window cannot hold records inside it.
                if file.mtime_ms < since {
                    continue;
                }
                let fresh = inner.cache.get(&key).is_some_and(|e| e.size == file.size && e.mtime_ms == file.mtime_ms);
                if !fresh {
                    stale_files.push((key.clone(), file));
                }
                keys.push((key, file.path.display().to_string()));
            }
            let workers = std::thread::available_parallelism().map_or(2, |n| n.get()).clamp(1, 8);
            let mut failed: HashSet<String> = HashSet::new();
            for batch in stale_files.chunks(64) {
                let next = std::sync::atomic::AtomicUsize::new(0);
                let results: Mutex<Vec<(usize, Result<crate::types::ReadResult, String>)>> = Mutex::new(Vec::new());
                std::thread::scope(|scope| {
                    for _ in 0..workers.min(batch.len()) {
                        scope.spawn(|| loop {
                            let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            let Some((_, file)) = batch.get(i) else { break };
                            let result = reader.read(&file.path, since);
                            results.lock().unwrap_or_else(|e| e.into_inner()).push((i, result));
                        });
                    }
                });
                for (i, result) in results.into_inner().unwrap_or_default() {
                    let (key, file) = &batch[i];
                    match result {
                        Ok(read) => {
                            let rows = store::pack(&merge_within_file(read.records), &mut inner.strings);
                            inner.cache.insert(key.clone(), FileEntry { size: file.size, mtime_ms: file.mtime_ms, malformed: read.malformed, rows });
                            inner.dirty = true;
                        }
                        Err(_) => {
                            failed.insert(key.clone());
                            status = "partial";
                            message = Some("Some files could not be read.");
                        }
                    }
                }
            }
            keys.retain(|(key, _)| !failed.contains(key));
            for (key, _) in &keys {
                malformed += inner.cache[key].malformed;
            }
            // A session moved to an archive can sit in two files: keep the copy with the most records.
            let mut best: HashMap<u64, (usize, usize)> = HashMap::new(); // session id bits -> (file index, count)
            if reader.shared_sessions() {
                for (fi, (key, _)) in keys.iter().enumerate() {
                    let rows = &inner.cache[key].rows;
                    let mut counts: HashMap<u64, usize> = HashMap::new();
                    for o in (C_SESSION..rows.len()).step_by(STRIDE) {
                        *counts.entry(rows[o].to_bits()).or_default() += 1;
                    }
                    for (sid, count) in counts {
                        if best.get(&sid).map_or(true, |&(_, c)| count > c) {
                            best.insert(sid, (fi, count));
                        }
                    }
                }
            }
            let mut sessions: HashSet<u64> = HashSet::new();
            let empty_session = inner.strings.id("") as f64;
            for (fi, (key, _)) in keys.iter().enumerate() {
                let entry = &inner.cache[key];
                let rows: Vec<f64> = if reader.shared_sessions() {
                    // Rows of sessions whose best copy is another file are dropped.
                    let mut kept = Vec::with_capacity(entry.rows.len());
                    for chunk in entry.rows.chunks_exact(STRIDE) {
                        if best.get(&chunk[C_SESSION].to_bits()).is_some_and(|&(f, _)| f == fi) {
                            kept.extend_from_slice(chunk);
                        }
                    }
                    kept
                } else {
                    entry.rows.clone()
                };
                for o in (C_SESSION..rows.len()).step_by(STRIDE) {
                    if rows[o] != empty_session {
                        sessions.insert(rows[o].to_bits());
                    }
                }
                scanned.push((provider.to_string(), rows));
            }
            let prefix = format!("{provider}{SEP}");
            let stale: Vec<String> = inner.cache.keys().filter(|k| k.starts_with(&prefix) && !seen.contains(*k)).cloned().collect();
            if !stale.is_empty() {
                inner.dirty = true;
            }
            for k in stale {
                inner.cache.remove(&k);
            }
            sources.push(json!({
                "fingerprint": {"hostId": "local", "provider": provider, "resolvedHomePath": reader.dir().display().to_string(), "volumeId": ""},
                "status": status,
                "scannedFiles": files.len(),
                "skippedFiles": 0,
                "malformedRecords": malformed,
                "distinctSessions": sessions.len(),
                "message": message,
            }));
        }
        if inner.dirty {
            inner.dirty = false;
            store::save(&self.data_dir.join("usage-scan-cache.bin"), CACHE_VERSION, &inner.strings, &inner.cache);
        }
        (scanned, sources)
    }

    pub fn summary(&self, input: &SummaryInput, settings: &Settings) -> Value {
        let started = now_ms();
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let inner = &mut *guard;
        let aliases = resolve_aliases(&settings.aliases);
        self.ensure_pricing(inner);
        let (files, sources) = self.scan(inner);
        let overrides = if settings.prices.is_empty() { None } else { Some(pricing::override_table(&settings.prices)) };
        let tz: Tz = input.time_zone.parse().unwrap_or(chrono_tz::UTC);
        let mut day_slots: HashMap<i64, String> = HashMap::new();
        let mut day_of = |ms: f64| -> String {
            let slot = (ms / QUARTER_HOUR_MS).floor() as i64;
            day_slots
                .entry(slot)
                .or_insert_with(|| tz.timestamp_millis_opt((slot as f64 * QUARTER_HOUR_MS) as i64).single().map_or_else(String::new, |d| d.format("%Y-%m-%d").to_string()))
                .clone()
        };

        // Rows with a key can appear in several files. Keys of "max merge" providers are first collected
        // at the maximum of each channel; every key then counts once.
        let mut maxed: HashMap<u64, [f64; 5]> = HashMap::new();
        for (provider, rows) in &files {
            if !max_merge(provider) {
                continue;
            }
            for chunk in rows.chunks_exact(STRIDE) {
                let key = chunk[C_KEY];
                if key.is_nan() {
                    continue;
                }
                let vals = [chunk[C_UNCACHED], chunk[C_CACHED], chunk[C_CACHE_WRITE], chunk[C_OUTPUT], chunk[C_REASONING]];
                maxed
                    .entry(key.to_bits())
                    .and_modify(|held| (0..5).for_each(|c| held[c] = held[c].max(vals[c])))
                    .or_insert(vals);
            }
        }
        let mut counted: HashSet<u64> = HashSet::new();
        let mut buckets: HashMap<String, Acc> = HashMap::new();
        for (provider, rows) in &files {
            let merge = max_merge(provider);
            for i in 0..rows.len() / STRIDE {
                let o = i * STRIDE;
                let ts = rows[o + C_TS];
                let day = day_of(ts);
                if day < input.since_day || day > input.until_day {
                    continue;
                }
                let key = rows[o + C_KEY];
                if !key.is_nan() && !counted.insert(key.to_bits()) {
                    continue;
                }
                let mut r = store::unpack(rows, i, &inner.strings);
                if merge && !key.is_nan() {
                    if let Some(m) = maxed.get(&key.to_bits()) {
                        r.uncached = m[0];
                        r.cached = m[1];
                        r.cache_write = m[2];
                        r.output = m[3];
                        r.reasoning = m[4];
                    }
                }
                // A model name mapped to another is counted and priced as that one.
                if let Some(target) = aliases.get(&r.model) {
                    r.model = target.clone();
                    r.rate_model = None;
                }
                let hour = input.hourly.then(|| tz.timestamp_millis_opt(ts as i64).single().map_or_else(|| "00".into(), |d| d.format("%H").to_string()));
                let bucket_key = format!("{day}|{}|{}|{}", hour.as_deref().unwrap_or(""), r.provider, r.model);
                let b = buckets.entry(bucket_key).or_insert_with(|| Acc {
                    day: day.clone(),
                    hour_start: hour.as_ref().map(|h| format!("{day}T{h}:00")),
                    provider: r.provider.clone(),
                    model: r.model.clone(),
                    ..Acc::default()
                });
                let priced = pricing::price(&inner.rates, &r, overrides.as_ref());
                for (t, v) in b.totals.iter_mut().zip([r.uncached, r.cached, r.cache_write, r.output, r.reasoning]) {
                    *t += v;
                }
                b.cost += priced.cost;
                b.cache_savings += pricing::cache_savings(&inner.rates, &r, overrides.as_ref());
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
                if !r.session.is_empty() {
                    b.sessions.insert(rows[o + C_SESSION].to_bits());
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
        json!({
            "contractVersion": 6,
            "readAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "timeZone": input.time_zone,
            "sinceDay": input.since_day,
            "untilDay": input.until_day,
            "buckets": buckets_json,
            "sources": sources,
            "pricing": {"status": inner.pricing.status, "source": LITELLM_URL, "fetchedAt": inner.pricing.fetched_at, "knownModels": inner.pricing.known_models},
            "scanDurationMs": (now_ms() - started) as u64,
        })
    }
}
