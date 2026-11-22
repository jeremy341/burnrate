//! Usage engine: reads agent transcripts into a row cache and answers `/api/usage` from it.
//!
//! The first scan of a large history takes tens of seconds, so nothing here ever makes a request wait
//! for a scan. A background thread (`engine/scan.rs`) fills the cache provider by provider, newest files
//! first, and publishes after every batch. `summary` answers at once from whatever is published (stale
//! while revalidate), tagged with `scan: {state, filesDone, filesTotal}` so the UI can show honest
//! progress. Summaries are memoised per window and the last ones are persisted, so a restart shows data
//! immediately.

mod aggregate;
mod scan;
#[cfg(test)]
mod tests;

use crate::pricing::{self, RateTable};
use crate::readers::{self, FileInfo, Source};
use crate::settings::Settings;
use crate::store::{self, FileEntry, Interner, C_SESSION, STRIDE};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
/// A request that finds the data older than this starts a background rescan (it still answers at once).
/// Listing every reader's tree is expensive, so revalidation is deliberately not a 5 s affair.
const REVALIDATE_AFTER_MS: f64 = 60_000.0;
const MAX_MEMO: usize = 24;
const PERSISTED_SUMMARIES: usize = 12;
/// Only the most recently used windows are recomputed after a scan; the rest are rebuilt on demand.
const PREWARM_WINDOWS: usize = 3;
const SUMMARY_FILE: &str = "usage-summary-cache.json";
const SUMMARY_FILE_VERSION: u32 = 2;

struct Pricing {
    status: &'static str,
    /// Where the document ultimately came from (litellm / openrouter / cached URL).
    source: String,
    fetched_at: Option<String>,
    known_models: usize,
}

/// Parse a time zone name, falling back to UTC. The bool is true when the name was invalid; callers
/// must surface that so an IANA typo does not silently mis-bucket every day/hour window.
pub(crate) fn time_zone_or_utc(name: &str) -> (chrono_tz::Tz, bool) {
    match name.parse::<chrono_tz::Tz>() {
        Ok(tz) => (tz, false),
        Err(_) => (chrono_tz::UTC, true),
    }
}

fn warn_bad_time_zone(name: &str) {
    eprintln!("burnrate: invalid IANA time zone '{name}'; using UTC (time windows may be misaligned)");
}

/// What one provider currently contributes: the files that survive the last listing, their rows (shared
/// with the cache, never copied) and the figures the sources list reports.
#[derive(Default)]
pub(crate) struct ProviderView {
    /// Shared with the scan plan so a per-batch rebuild only bumps refcounts, not string buffers.
    keys: Vec<Arc<str>>,
    rows: Vec<Arc<Vec<f64>>>,
    /// True once a listing of this provider has completed in this process.
    listed: bool,
    status: &'static str,
    message: Option<&'static str>,
    scanned_files: usize,
    malformed: u32,
    distinct_sessions: usize,
    /// Running session ids for honest intermediate counts between the expensive final recount.
    session_ids: HashSet<u64>,
}

impl ProviderView {
    /// Providers appear in the sources list once they hold cached rows or have been listed.
    fn reported(&self) -> bool {
        self.listed || !self.keys.is_empty()
    }
}

pub(crate) struct Inner {
    strings: Interner,
    cache: HashMap<String, FileEntry>,
    dirty: bool,
    rates: RateTable,
    pricing: Pricing,
    pricing_checked: Option<SystemTime>,
    /// One per reader, in reader order.
    views: Vec<ProviderView>,
    /// Bumped whenever published rows or prices change; memoised summaries carry the one they were built at.
    generation: u64,
}

#[derive(Clone)]
struct ProviderProgress {
    id: &'static str,
    files_done: usize,
    files_total: usize,
    /// pending | scanning | done
    state: &'static str,
}

#[derive(Clone, Default)]
struct Progress {
    scanning: bool,
    files_done: usize,
    files_total: usize,
    providers: Vec<ProviderProgress>,
    started_ms: f64,
    updated_ms: f64,
    /// A scan has run to the end in this process (the data is complete as of `last_finished_ms`).
    completed_once: bool,
    last_finished_ms: f64,
}

struct MemoEntry {
    input: SummaryInput,
    settings: Option<Settings>,
    generation: u64,
    value: Value,
    used: u64,
}

#[derive(Default)]
struct Memo {
    entries: HashMap<String, MemoEntry>,
    tick: u64,
}

#[derive(Clone)]
pub struct SummaryInput {
    pub since_day: String,
    pub until_day: String,
    pub time_zone: String,
    pub hourly: bool,
    /// Exact window bounds. When both are set, rows outside them are skipped even if their local
    /// day is inside `since_day`..`until_day`. Used by the "past 24 hours" view.
    pub since_time: Option<f64>,
    pub until_time: Option<f64>,
}

/// One reader's last listing. Only reused while its fingerprint stays conclusive and unchanged.
pub(crate) struct CachedListing {
    pub fingerprint: u64,
    pub files: Vec<FileInfo>,
}

pub(crate) struct Shared {
    data_dir: PathBuf,
    readers: Vec<Box<dyn Source>>,
    providers: Vec<&'static str>,
    dirs: Vec<String>,
    inner: Mutex<Inner>,
    progress: Mutex<Progress>,
    memo: Mutex<Memo>,
    listings: Mutex<Vec<Option<CachedListing>>>,
    scanning: AtomicBool,
    pricing_refreshing: AtomicBool,
    generation: AtomicU64,
    last_prewarm_generation: AtomicU64,
    /// The scan cache was missing or unusable at start, so only a persisted summary can be shown at once.
    cold_start: bool,
}

pub struct Engine {
    shared: Arc<Shared>,
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn max_merge(provider: &str) -> bool {
    MAX_MERGE.contains(&provider)
}

/// Merges records that share a key within one file, taking the maximum of each channel.
fn merge_within_file(records: Vec<crate::types::Record>) -> Vec<crate::types::Record> {
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<crate::types::Record> = Vec::with_capacity(records.len());
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

/// Fingerprint a packed row so an exact copy in two files can be recognised. Keyless rows
/// (bridged Codex requests) have no message key, so every channel is compared.
fn row_fingerprint(chunk: &[f64]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for value in chunk.iter().take(STRIDE) {
        hash = (hash ^ value.to_bits()).wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// For a shared-session provider, drop only rows that are exact copies of a row in the canonical
/// file. A session that kept growing after it was copied retains its new rows.
fn shared_session_rows(rows: &[f64], file_index: usize, best: &HashMap<u64, (usize, usize)>, canonical: &HashMap<u64, HashSet<u64>>) -> Vec<f64> {
    let mut kept = Vec::with_capacity(rows.len());
    for chunk in rows.chunks_exact(STRIDE) {
        let sid = chunk[C_SESSION].to_bits();
        let is_canonical = best.get(&sid).is_some_and(|&(f, _)| f == file_index);
        let duplicate = !is_canonical && canonical.get(&sid).is_some_and(|fingerprints| fingerprints.contains(&row_fingerprint(chunk)));
        if !duplicate {
            kept.extend_from_slice(chunk);
        }
    }
    kept
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

/// Deleting a transcript leaves its interned strings referenced by no remaining row. Rebuild the
/// interner from the ids still in use and rewrite those id columns everywhere they are held. The
/// published views share the cache's row buffers, so they are rebuilt by the caller afterwards.
/// Returns true when anything was rewritten.
fn prune_interner(inner: &mut Inner) -> bool {
    let mut live: HashSet<u32> = HashSet::new();
    for entry in inner.cache.values() {
        for chunk in entry.rows.chunks_exact(STRIDE) {
            for c in [store::C_PROVIDER, store::C_MODEL, store::C_RATE_MODEL, C_SESSION] {
                if chunk[c] >= 0.0 {
                    live.insert(chunk[c] as u32);
                }
            }
        }
    }
    if live.len() >= inner.strings.strings.len() {
        return false; // nothing orphaned
    }
    let remap = inner.strings.retain_ids(&live);
    for entry in inner.cache.values_mut() {
        let mut rows = entry.rows.as_ref().clone();
        for chunk in rows.chunks_exact_mut(STRIDE) {
            for c in [store::C_PROVIDER, store::C_MODEL, store::C_RATE_MODEL, C_SESSION] {
                if chunk[c] >= 0.0 {
                    if let Some(&new) = remap.get(&(chunk[c] as u32)) {
                        chunk[c] = new as f64;
                    }
                }
            }
        }
        entry.rows = Arc::new(rows);
    }
    inner.dirty = true;
    true
}

/// Everything in `Settings` that changes a summary, in a stable text form.
fn settings_fingerprint(settings: &Settings) -> String {
    let mut prices: Vec<_> = settings.prices.iter().collect();
    prices.sort_by(|a, b| a.0.cmp(b.0));
    let mut aliases: Vec<_> = settings.aliases.iter().collect();
    aliases.sort_by(|a, b| a.0.cmp(b.0));
    format!("{prices:?}{aliases:?}")
}

fn memo_key(input: &SummaryInput, settings: &Settings) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        input.since_day,
        input.until_day,
        input.since_time.map_or_else(String::new, |v| format!("{v:.0}")),
        input.until_time.map_or_else(String::new, |v| format!("{v:.0}")),
        input.time_zone,
        input.hourly,
        settings_fingerprint(settings)
    )
}

fn pricing_from(chain: &pricing::PricingChain) -> Option<(RateTable, Pricing)> {
    chain.document.as_ref()?;
    let rates = pricing::rate_table_from(chain);
    let age_ms = chain.fetched_at.as_deref().and_then(crate::types::parse_rfc3339_ms).map(|at| (now_ms() - at).max(0.0));
    let fresh = age_ms.is_some_and(|age| age <= PRICE_TTL_SECS as f64 * 1000.0);
    let status = match chain.source {
        pricing::PricingSource::Unavailable => "unavailable",
        _ if fresh => "fresh",
        _ => "cached",
    };
    let known_models = rates.len();
    Some((rates, Pricing { status, source: chain.source.as_str().to_string(), fetched_at: chain.fetched_at.clone(), known_models }))
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn progress_lock(&self) -> MutexGuard<'_, Progress> {
        self.progress.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn memo_lock(&self) -> MutexGuard<'_, Memo> {
        self.memo.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn progress_json(&self) -> Value {
        let p = self.progress_lock().clone();
        json!({
            "state": if p.scanning { "scanning" } else { "idle" },
            "filesDone": p.files_done,
            "filesTotal": p.files_total,
            "completedOnce": p.completed_once,
            "providers": p.providers.iter().map(|x| json!({"id": x.id, "state": x.state, "filesDone": x.files_done, "filesTotal": x.files_total})).collect::<Vec<_>>(),
            "startedAt": (p.started_ms > 0.0).then_some(p.started_ms),
            "finishedAt": (p.last_finished_ms > 0.0).then_some(p.last_finished_ms),
        })
    }

    /// Start a background scan unless one is running. Returns whether a thread was started.
    fn kick(self: &Arc<Self>) -> bool {
        if self.scanning.swap(true, Ordering::AcqRel) {
            return false;
        }
        let shared = Arc::clone(self);
        let started = std::thread::Builder::new().name("burnrate-usage-scan".into()).spawn(move || shared.run_scan(&mut || {}));
        if started.is_err() {
            self.scanning.store(false, Ordering::Release);
            return false;
        }
        true
    }

    fn kick_if_stale(self: &Arc<Self>) {
        let (completed, finished) = {
            let p = self.progress_lock();
            (p.completed_once, p.last_finished_ms)
        };
        if !completed || now_ms() - finished >= REVALIDATE_AFTER_MS {
            self.kick();
        }
    }

    fn with_scan(&self, mut value: Value) -> Value {
        value["scan"] = self.progress_json();
        value
    }

    fn summary(self: &Arc<Self>, input: &SummaryInput, settings: &Settings) -> Value {
        self.kick_if_stale();
        let key = memo_key(input, settings);
        let generation = self.generation.load(Ordering::Acquire);
        let completed_once = self.progress_lock().completed_once;
        {
            let mut memo = self.memo_lock();
            memo.tick += 1;
            let tick = memo.tick;
            if let Some(entry) = memo.entries.get_mut(&key) {
                entry.used = tick;
                if entry.generation == generation {
                    return self.with_scan(entry.value.clone());
                }
                // No scan cache yet: a persisted answer beats a partial one until the first scan completes.
                if self.cold_start && !completed_once && entry.settings.is_none() {
                    let mut value = entry.value.clone();
                    value["stale"] = json!(true);
                    return self.with_scan(value);
                }
            }
        }
        let (value, built_at) = {
            let inner = self.lock();
            (aggregate::compute(&inner, &self.providers, &self.dirs, input, settings), inner.generation)
        };
        self.remember(key, input, settings, built_at, value.clone());
        self.with_scan(value)
    }

    fn remember(&self, key: String, input: &SummaryInput, settings: &Settings, generation: u64, value: Value) {
        let mut memo = self.memo_lock();
        memo.tick += 1;
        let used = memo.tick;
        if memo.entries.len() >= MAX_MEMO && !memo.entries.contains_key(&key) {
            if let Some(oldest) = memo.entries.iter().min_by_key(|(_, e)| e.used).map(|(k, _)| k.clone()) {
                memo.entries.remove(&oldest);
            }
        }
        memo.entries.insert(key, MemoEntry { input: input.clone(), settings: Some(settings.clone()), generation, value, used });
    }

    /// Recompute the most recently used remembered windows against freshly published rows and persist
    /// the latest ones, so switching window is a memo hit and a restart shows an answer at once.
    /// A scan that changed nothing leaves both the memos and the persisted file alone.
    fn prewarm_and_persist(&self) {
        let generation = self.generation.load(Ordering::Acquire);
        if generation == self.last_prewarm_generation.load(Ordering::Acquire) {
            return;
        }
        let mut jobs: Vec<(u64, String, SummaryInput, Settings)> = self
            .memo_lock()
            .entries
            .iter()
            .filter_map(|(k, e)| e.settings.as_ref().map(|s| (e.used, k.clone(), e.input.clone(), s.clone())))
            .collect();
        // Recomputing every remembered window after each scan is quadratic in practice; the most
        // recently used ones are the windows a user can flip back to immediately.
        jobs.sort_by_key(|(used, _, _, _)| std::cmp::Reverse(*used));
        jobs.truncate(PREWARM_WINDOWS);
        for (_, key, input, settings) in jobs {
            let (value, built_at) = {
                let inner = self.lock();
                (aggregate::compute(&inner, &self.providers, &self.dirs, &input, &settings), inner.generation)
            };
            self.remember(key, &input, &settings, built_at, value);
        }
        self.persist_summaries();
        self.last_prewarm_generation.store(generation, Ordering::Release);
    }

    fn persist_summaries(&self) {
        let mut entries: Vec<(u64, Value)> = {
            let memo = self.memo_lock();
            memo.entries
                .iter()
                .filter(|(_, e)| e.settings.is_some())
                .map(|(k, e)| {
                    (
                        e.used,
                        json!({"key": k, "sinceDay": e.input.since_day, "untilDay": e.input.until_day, "sinceTime": e.input.since_time, "untilTime": e.input.until_time, "timeZone": e.input.time_zone, "hourly": e.input.hourly, "value": e.value}),
                    )
                })
                .collect()
        };
        if entries.is_empty() {
            return;
        }
        entries.sort_by_key(|e| std::cmp::Reverse(e.0));
        entries.truncate(PERSISTED_SUMMARIES);
        let body = json!({"version": SUMMARY_FILE_VERSION, "savedAt": now_ms(), "entries": entries.into_iter().map(|(_, v)| v).collect::<Vec<_>>()});
        let path = self.data_dir.join(SUMMARY_FILE);
        let _ = std::fs::create_dir_all(&self.data_dir);
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec(&body).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    /// Persisted summaries wait in the memo at generation 0 with no settings; the first live compute replaces them.
    fn load_summaries(&self) {
        let Ok(bytes) = std::fs::read(self.data_dir.join(SUMMARY_FILE)) else { return };
        let Ok(doc) = serde_json::from_slice::<Value>(&bytes) else { return };
        if doc["version"].as_u64() != Some(u64::from(SUMMARY_FILE_VERSION)) {
            return;
        }
        let mut memo = self.memo_lock();
        for item in doc["entries"].as_array().into_iter().flatten() {
            let (Some(key), Some(since), Some(until), Some(tz)) = (item["key"].as_str(), item["sinceDay"].as_str(), item["untilDay"].as_str(), item["timeZone"].as_str()) else { continue };
            if !item["value"].is_object() {
                continue;
            }
            let input = SummaryInput {
                since_day: since.to_string(),
                until_day: until.to_string(),
                time_zone: tz.to_string(),
                hourly: item["hourly"].as_bool().unwrap_or(false),
                since_time: item["sinceTime"].as_f64(),
                until_time: item["untilTime"].as_f64(),
            };
            memo.entries.insert(key.to_string(), MemoEntry { input, settings: None, generation: 0, value: item["value"].clone(), used: 0 });
        }
    }

    /// The price document refresh can hit the network, so it never runs inside a scan or under a lock.
    fn refresh_pricing_if_due(self: &Arc<Self>) {
        {
            let inner = self.lock();
            if inner.pricing_checked.is_some_and(|t| t.elapsed().map_or(false, |e| e < Duration::from_secs(PRICE_TTL_SECS))) {
                return;
            }
        }
        if self.pricing_refreshing.swap(true, Ordering::AcqRel) {
            return;
        }
        let shared = Arc::clone(self);
        let spawned = std::thread::Builder::new().name("burnrate-pricing".into()).spawn(move || {
            // The documented chain (LiteLLM -> OpenRouter -> stale cache) runs here, off every request path.
            let chain = pricing::load_chain(&shared.data_dir, &pricing::UreqFetcher, false);
            {
                let mut inner = shared.lock();
                inner.pricing_checked = Some(SystemTime::now());
                if let Some((rates, info)) = pricing_from(&chain) {
                    inner.rates = rates;
                    inner.pricing = info;
                    inner.generation += 1;
                    shared.generation.store(inner.generation, Ordering::Release);
                }
            }
            shared.pricing_refreshing.store(false, Ordering::Release);
        });
        if spawned.is_err() {
            self.pricing_refreshing.store(false, Ordering::Release);
        }
    }
}

impl Engine {
    pub fn new(data_dir: PathBuf) -> Engine {
        Engine::with_readers(data_dir, readers::all())
    }

    pub(crate) fn with_readers(data_dir: PathBuf, readers: Vec<Box<dyn Source>>) -> Engine {
        let loaded = store::load(&data_dir.join("usage-scan-cache.bin"), CACHE_VERSION);
        let cold_start = loaded.as_ref().map_or(true, |(_, files)| files.is_empty());
        let (strings, cache) = loaded.unwrap_or_else(|| (Interner::default(), HashMap::new()));
        let providers: Vec<&'static str> = readers.iter().map(|r| r.provider()).collect();
        let dirs: Vec<String> = readers.iter().map(|r| r.dir().display().to_string()).collect();
        // Cached prices (any age) are read here; the network refresh runs in the background.
        let cached_prices = pricing::load_cached(&data_dir);
        let (rates, price_info, checked) = match pricing_from(&cached_prices) {
            Some((rates, info)) => {
                let checked = (info.status == "fresh").then(SystemTime::now);
                (rates, info, checked)
            }
            None => (RateTable::default(), Pricing { status: "unavailable", source: pricing::LITELLM_URL.to_string(), fetched_at: None, known_models: 0 }, None),
        };
        let mut views: Vec<ProviderView> = providers.iter().map(|_| ProviderView::default()).collect();
        for (index, provider) in providers.iter().enumerate() {
            let prefix = format!("{provider}{SEP}");
            let mut keys: Vec<Arc<str>> = cache.keys().filter(|k| k.starts_with(&prefix)).map(|k| Arc::from(k.as_str())).collect();
            keys.sort();
            views[index].keys = keys;
        }
        let mut inner = Inner { strings, cache, dirty: false, rates, pricing: price_info, pricing_checked: checked, views, generation: 1 };
        for index in 0..providers.len() {
            scan::publish(&mut inner, index, providers[index], readers[index].shared_sessions());
        }
        let generation = inner.generation;
        let progress = Progress {
            providers: providers.iter().map(|id| ProviderProgress { id, files_done: 0, files_total: 0, state: "pending" }).collect(),
            ..Progress::default()
        };
        let listings = Mutex::new(providers.iter().map(|_| None).collect());
        let shared = Arc::new(Shared {
            data_dir,
            readers,
            providers,
            dirs,
            inner: Mutex::new(inner),
            progress: Mutex::new(progress),
            memo: Mutex::new(Memo::default()),
            listings,
            scanning: AtomicBool::new(false),
            pricing_refreshing: AtomicBool::new(false),
            generation: AtomicU64::new(generation),
            last_prewarm_generation: AtomicU64::new(0),
            cold_start,
        });
        shared.load_summaries();
        Engine { shared }
    }

    /// Answer from whatever is published right now and revalidate in the background. Never waits for a scan.
    pub fn summary(&self, input: &SummaryInput, settings: &Settings) -> Value {
        self.shared.summary(input, settings)
    }

    /// Like `summary`, but first waits (up to `timeout`) for the first scan of this process to finish, for
    /// callers such as budgets that must not act on a partial total.
    #[allow(dead_code)]
    pub fn summary_settled(&self, input: &SummaryInput, settings: &Settings, timeout: Duration) -> Value {
        let deadline = std::time::Instant::now() + timeout;
        self.shared.kick_if_stale();
        while !self.shared.progress_lock().completed_once && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        self.shared.summary(input, settings)
    }

    /// `GET /api/usage/progress`: cheap, never touches the row data.
    pub fn progress(&self) -> Value {
        self.shared.progress_json()
    }
}
