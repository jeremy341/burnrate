//! The background transcript scan. It lists every reader first (so progress has an honest total), then
//! parses the changed files provider by provider, newest first, in small batches. Parsing happens
//! outside the data lock; each batch is committed and published under a short lock, so a request can be
//! answered from the partial data at any moment.

use super::*;
use crate::readers::FileInfo;
use crate::store::{C_SESSION, STRIDE};
use std::sync::atomic::Ordering;

/// The first batch is small so the newest data appears quickly; later batches favour throughput.
pub(super) const FIRST_BATCH: usize = 16;
const BATCH: usize = 32;
/// Persist the scan cache this often during a long scan, so a quit mid-scan keeps its progress.
const SAVE_EVERY_MS: f64 = 10_000.0;

/// Rebuild one provider's published view from its surviving file keys. The rows are shared with the
/// cache (an `Arc` clone per file); only providers whose sessions can sit in several files build a
/// deduplicated copy. Distinct sessions are recounted each time (one pass over the session column).
pub(super) fn publish(inner: &mut Inner, index: usize, provider: &str, shared_sessions: bool) {
    let keys = std::mem::take(&mut inner.views[index].keys);
    let entries: Vec<&FileEntry> = keys.iter().filter_map(|k| inner.cache.get(k)).collect();
    let malformed: u32 = entries.iter().map(|e| e.malformed).sum();
    let rows: Vec<Arc<Vec<f64>>> = if shared_sessions {
        // A session moved to an archive can sit in two files: use the copy with the most
        // records as canonical, but keep non-duplicate rows from the other files.
        let mut best: HashMap<u64, (usize, usize)> = HashMap::new(); // session id bits -> (file index, count)
        let mut canonical: HashMap<u64, HashSet<u64>> = HashMap::new(); // session id bits -> row fingerprints
        for (fi, entry) in entries.iter().enumerate() {
            let mut counts: HashMap<u64, usize> = HashMap::new();
            for o in (C_SESSION..entry.rows.len()).step_by(STRIDE) {
                *counts.entry(entry.rows[o].to_bits()).or_default() += 1;
            }
            for (sid, count) in counts {
                if best.get(&sid).map_or(true, |&(_, c)| count > c) {
                    best.insert(sid, (fi, count));
                }
            }
        }
        for (fi, entry) in entries.iter().enumerate() {
            for chunk in entry.rows.chunks_exact(STRIDE) {
                let sid = chunk[C_SESSION].to_bits();
                if best.get(&sid).is_some_and(|&(f, _)| f == fi) {
                    canonical.entry(sid).or_default().insert(row_fingerprint(chunk));
                }
            }
        }
        entries
            .iter()
            .enumerate()
            .map(|(fi, e)| {
                let kept = shared_session_rows(&e.rows, fi, &best, &canonical);
                // Nothing dropped: keep sharing the cached buffer instead of holding a second copy.
                if kept.len() == e.rows.len() { e.rows.clone() } else { Arc::new(kept) }
            })
            .collect()
    } else {
        entries.iter().map(|e| e.rows.clone()).collect()
    };
    let sessions = Some({
        let empty = inner.strings.lookup("").map_or(f64::NAN, f64::from);
        let mut seen: HashSet<u64> = HashSet::new();
        for file in &rows {
            for o in (C_SESSION..file.len()).step_by(STRIDE) {
                if file[o] != empty {
                    seen.insert(file[o].to_bits());
                }
            }
        }
        seen.len()
    });
    drop(entries);
    let view = &mut inner.views[index];
    view.keys = keys;
    view.rows = rows;
    view.malformed = malformed;
    if let Some(n) = sessions {
        view.distinct_sessions = n;
    }
    if view.status.is_empty() {
        // Rows served from the saved cache before this provider has been listed in this process.
        view.status = "ok";
        view.scanned_files = view.keys.len();
    }
    let _ = provider;
    inner.generation += 1;
}

struct Plan {
    index: usize,
    files: Vec<FileInfo>,
    /// Every cache key this listing produced, including files older than the history horizon.
    seen: HashSet<String>,
    /// In-horizon files: (cache key, index into `files`).
    horizon: Vec<(String, usize)>,
    /// Indices into `horizon` of files whose cached rows are missing or out of date.
    stale: Vec<usize>,
}

/// Clears the running flag even if a reader panics, so a later request can start a new scan.
struct ScanGuard<'a>(&'a Shared);

impl Drop for ScanGuard<'_> {
    fn drop(&mut self) {
        self.0.progress_lock().scanning = false;
        self.0.scanning.store(false, Ordering::Release);
    }
}

impl Shared {
    fn publish_index(&self, inner: &mut Inner, index: usize) {
        publish(inner, index, self.providers[index], self.readers[index].shared_sessions());
        self.generation.store(inner.generation, Ordering::Release);
    }

    fn save_cache(&self, inner: &mut Inner) {
        if inner.dirty {
            inner.dirty = false;
            store::save(&self.data_dir.join("usage-scan-cache.bin"), CACHE_VERSION, &inner.strings, &inner.cache);
        }
    }

    /// `after_batch` runs after every committed batch (tests use it to observe partial results).
    pub(super) fn run_scan(self: &Arc<Self>, after_batch: &mut dyn FnMut()) {
        let _guard = ScanGuard(self);
        let started = now_ms();
        let since = started - HORIZON_DAYS * DAY_MS;
        {
            let mut p = self.progress_lock();
            p.scanning = true;
            p.started_ms = started;
            p.updated_ms = started;
            p.files_done = 0;
            p.files_total = 0;
            for x in &mut p.providers {
                x.files_done = 0;
                x.files_total = 0;
                x.state = "pending";
            }
        }
        self.refresh_pricing_if_due();

        // 1. List everything first so the progress total is real from the start.
        let mut plans: Vec<Plan> = Vec::new();
        for (index, reader) in self.readers.iter().enumerate() {
            let provider = reader.provider();
            let files = reader.files();
            let mut seen = HashSet::with_capacity(files.len());
            let mut horizon = Vec::new();
            for (fi, file) in files.iter().enumerate() {
                let key = format!("{provider}{SEP}{}", file.path.display());
                seen.insert(key.clone());
                // Files untouched since before the history window cannot hold records inside it.
                if file.mtime_ms >= since {
                    horizon.push((key, fi));
                }
            }
            plans.push(Plan { index, files, seen, horizon, stale: Vec::new() });
        }
        {
            let inner = self.lock();
            for plan in &mut plans {
                plan.stale = plan
                    .horizon
                    .iter()
                    .enumerate()
                    .filter(|(_, (key, fi))| !inner.cache.get(key).is_some_and(|e| e.size == plan.files[*fi].size && e.mtime_ms == plan.files[*fi].mtime_ms))
                    .map(|(i, _)| i)
                    .collect();
                // Newest first: today's activity is what the charts need before the long tail.
                plan.stale.sort_by(|a, b| {
                    let (fa, fb) = (plan.horizon[*a].1, plan.horizon[*b].1);
                    plan.files[fb].mtime_ms.partial_cmp(&plan.files[fa].mtime_ms).unwrap_or(std::cmp::Ordering::Equal)
                });
            }
        }
        {
            let mut p = self.progress_lock();
            for plan in &plans {
                let total = plan.horizon.len();
                let done = total - plan.stale.len();
                p.files_total += total;
                p.files_done += done;
                p.providers[plan.index].files_total = total;
                p.providers[plan.index].files_done = done;
            }
        }
        // Providers with nothing to parse finish at once; the rest go by how recent their newest change is.
        plans.sort_by(|a, b| {
            let newest = |p: &Plan| p.stale.first().map_or(f64::INFINITY, |i| p.files[p.horizon[*i].1].mtime_ms);
            newest(b).partial_cmp(&newest(a)).unwrap_or(std::cmp::Ordering::Equal)
        });

        let mut last_save = started;
        for plan in &plans {
            self.scan_provider(plan, since, &mut last_save, after_batch);
        }

        // 3. Settle: drop strings no row uses any more, persist, republish.
        {
            let mut inner = self.lock();
            if prune_interner(&mut inner) {
                for index in 0..self.providers.len() {
                    self.publish_index(&mut inner, index);
                }
            }
            self.save_cache(&mut inner);
        }
        self.prewarm_and_persist();
        let finished = now_ms();
        let mut p = self.progress_lock();
        p.completed_once = true;
        p.last_finished_ms = finished;
        p.updated_ms = finished;
        p.scanning = false;
    }

    fn scan_provider(&self, plan: &Plan, since: f64, last_save: &mut f64, after_batch: &mut dyn FnMut()) {
        let reader = &self.readers[plan.index];
        let provider = reader.provider();
        self.progress_lock().providers[plan.index].state = "scanning";
        let workers = std::thread::available_parallelism().map_or(2, |n| n.get()).clamp(1, 8);
        let mut failed: HashSet<String> = HashSet::new();
        let mut offset = 0;
        let mut first = true;
        while offset < plan.stale.len() {
            let size = if first { FIRST_BATCH } else { BATCH };
            first = false;
            let end = (offset + size).min(plan.stale.len());
            let batch: Vec<(&String, &FileInfo)> = plan.stale[offset..end].iter().map(|i| (&plan.horizon[*i].0, &plan.files[plan.horizon[*i].1])).collect();
            offset = end;
            // Parse in parallel, outside the data lock.
            let next = std::sync::atomic::AtomicUsize::new(0);
            let results: Mutex<Vec<(usize, Result<crate::types::ReadResult, String>)>> = Mutex::new(Vec::new());
            std::thread::scope(|scope| {
                for _ in 0..workers.min(batch.len()) {
                    scope.spawn(|| loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some((_, file)) = batch.get(i) else { break };
                        let result = reader.read(&file.path, since);
                        results.lock().unwrap_or_else(|e| e.into_inner()).push((i, result));
                    });
                }
            });
            let parsed: Vec<(usize, Result<(Vec<crate::types::Record>, u32), String>)> = results
                .into_inner()
                .unwrap_or_default()
                .into_iter()
                .map(|(i, r)| (i, r.map(|read| (merge_within_file(read.records), read.malformed))))
                .collect();
            let mut inner = self.lock();
            let mut message_partial = false;
            for (i, result) in parsed {
                let (key, file) = batch[i];
                match result {
                    Ok((records, malformed)) => {
                        let rows = Arc::new(store::pack(&records, &mut inner.strings));
                        inner.cache.insert(key.clone(), FileEntry { size: file.size, mtime_ms: file.mtime_ms, malformed, rows });
                        inner.dirty = true;
                    }
                    Err(_) => {
                        failed.insert(key.clone());
                        message_partial = true;
                    }
                }
            }
            let keys: Vec<String> = plan.horizon.iter().filter(|(k, _)| !failed.contains(k) && inner.cache.contains_key(k)).map(|(k, _)| k.clone()).collect();
            inner.views[plan.index].keys = keys;
            if message_partial {
                inner.views[plan.index].status = "partial";
                inner.views[plan.index].message = Some("Some files could not be read.");
            }
            self.publish_index(&mut inner, plan.index);
            if inner.dirty && now_ms() - *last_save >= SAVE_EVERY_MS {
                *last_save = now_ms();
                self.save_cache(&mut inner);
            }
            drop(inner);
            let mut p = self.progress_lock();
            p.files_done += batch.len();
            p.providers[plan.index].files_done += batch.len();
            p.updated_ms = now_ms();
            drop(p);
            after_batch();
        }

        // The provider is complete: settle its view and forget cache entries whose file is gone.
        let mut inner = self.lock();
        let prefix = format!("{provider}{SEP}");
        let gone: Vec<String> = inner.cache.keys().filter(|k| k.starts_with(&prefix) && !plan.seen.contains(*k)).cloned().collect();
        if !gone.is_empty() {
            inner.dirty = true;
        }
        for key in gone {
            inner.cache.remove(&key);
        }
        let keys: Vec<String> = plan.horizon.iter().filter(|(k, _)| !failed.contains(k) && inner.cache.contains_key(k)).map(|(k, _)| k.clone()).collect();
        let view = &mut inner.views[plan.index];
        view.keys = keys;
        view.listed = true;
        view.scanned_files = plan.files.len();
        if plan.files.is_empty() {
            view.status = "missing";
            view.message = Some("Nothing found on this computer.");
        } else if failed.is_empty() {
            view.status = "ok";
            view.message = None;
        } else {
            view.status = "partial";
            view.message = Some("Some files could not be read.");
        }
        self.publish_index(&mut inner, plan.index);
        drop(inner);
        self.progress_lock().providers[plan.index].state = "done";
        after_batch();
    }
}
