//! The background transcript scan. It lists every reader first (so progress has an honest total), then
//! parses the changed files provider by provider, newest first, in small batches. Parsing happens
//! outside the data lock; each batch is committed and published under a short lock, so a request can be
//! answered from the partial data at any moment.

use super::*;
use crate::readers::FileInfo;
use crate::store::{C_SESSION, STRIDE};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

/// The first batch is small so the newest data appears quickly; later batches favour throughput.
pub(super) const FIRST_BATCH: usize = 16;
const BATCH: usize = 32;
/// Persist the scan cache this often during a long scan, so a quit mid-scan keeps its progress.
const SAVE_EVERY_MS: f64 = 60_000.0;

/// Full publish: rebuild this provider's view from its surviving file keys, including the
/// deduplicated rows and an exact session recount. Used at startup, at settle and after pruning.
pub(super) fn publish(inner: &mut Inner, index: usize, provider: &str, shared_sessions: bool) {
    publish_impl(inner, index, provider, shared_sessions, true);
}

fn publish_impl(inner: &mut Inner, index: usize, provider: &str, shared_sessions: bool, bump_generation: bool) {
    let keys = std::mem::take(&mut inner.views[index].keys);
    let entries: Vec<&FileEntry> = keys.iter().filter_map(|k| inner.cache.get(&**k)).collect();
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
    let empty = inner.strings.lookup("").map_or(f64::NAN, f64::from);
    let mut seen: HashSet<u64> = HashSet::new();
    for file in &rows {
        for o in (C_SESSION..file.len()).step_by(STRIDE) {
            if file[o] != empty {
                seen.insert(file[o].to_bits());
            }
        }
    }
    drop(entries);
    let view = &mut inner.views[index];
    view.keys = keys;
    view.rows = rows;
    view.malformed = malformed;
    view.session_ids = seen;
    view.distinct_sessions = view.session_ids.len();
    if view.status.is_empty() {
        // Rows served from the saved cache before this provider has been listed in this process.
        view.status = "ok";
        view.scanned_files = view.keys.len();
    }
    let _ = provider;
    if bump_generation {
        inner.generation += 1;
    }
}

/// Cheap per-batch publish. The rows are shared from the cache as they are (deduplication happens
/// only at the final publish), and session counts stay honest through a running set per provider.
pub(super) fn publish_batch(inner: &mut Inner, index: usize, new_sessions: &HashSet<u64>) {
    let mut rows = Vec::new();
    let mut malformed = 0u32;
    for key in &inner.views[index].keys {
        if let Some(entry) = inner.cache.get(&**key) {
            rows.push(entry.rows.clone());
            malformed += entry.malformed;
        }
    }
    let view = &mut inner.views[index];
    view.rows = rows;
    view.malformed = malformed;
    view.session_ids.extend(new_sessions.iter().copied());
    view.distinct_sessions = view.session_ids.len();
    if view.status.is_empty() {
        view.status = "ok";
        view.scanned_files = view.keys.len();
    }
    inner.generation += 1;
}

struct Plan {
    index: usize,
    files: Vec<FileInfo>,
    /// Every cache key this listing produced, including files older than the history horizon.
    seen: HashSet<String>,
    /// In-horizon files: (cache key, index into `files`).
    horizon: Vec<(Arc<str>, usize)>,
    /// Indices into `horizon` of files whose cached rows are missing or out of date.
    stale: Vec<usize>,
}

/// A cached listing is trusted only when its files still match their own metadata and every
/// directory that could contain an entry has a usable mtime. Anything we cannot verify (notably
/// Windows directory mtimes, which are not reliable) makes the fingerprint inconclusive, and the
/// caller re-walks the tree.
fn listing_fingerprint(dir: &Path, files: &[FileInfo]) -> Option<u64> {
    if cfg!(windows) {
        return None;
    }
    fn mix(hash: &mut u64, value: u64) {
        *hash = (*hash ^ value).wrapping_mul(0x0100_0000_01b3);
    }
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut dirs: HashSet<PathBuf> = HashSet::new();
    for file in files {
        let meta = fs::metadata(&file.path).ok()?;
        let time = crate::readers::mtime_ms(&meta) as u64;
        // A reader that synthesises size/mtime (a database plus its WAL, for instance) cannot be
        // verified this way, so its listing is deliberately never reused.
        if time == 0 || time as f64 != file.mtime_ms || meta.len() as f64 != file.size {
            return None;
        }
        mix(&mut hash, time);
        mix(&mut hash, meta.len());
        let mut parent = file.path.parent();
        while let Some(p) = parent {
            dirs.insert(p.to_path_buf());
            parent = p.parent();
        }
    }
    dirs.insert(dir.to_path_buf());
    let mut parent = dir.parent();
    while let Some(p) = parent {
        dirs.insert(p.to_path_buf());
        parent = p.parent();
    }
    let mut dirs: Vec<PathBuf> = dirs.into_iter().collect();
    dirs.sort();
    for d in dirs {
        let meta = fs::metadata(&d).ok()?;
        let time = crate::readers::mtime_ms(&meta) as u64;
        if time == 0 {
            return None;
        }
        mix(&mut hash, time);
        mix(&mut hash, meta.len());
    }
    Some(hash)
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
        self.publish_index_with(inner, index, true);
    }

    fn publish_index_with(&self, inner: &mut Inner, index: usize, bump_generation: bool) {
        publish_impl(inner, index, self.providers[index], self.readers[index].shared_sessions(), bump_generation);
        self.generation.store(inner.generation, Ordering::Release);
    }

    fn publish_batch_index(&self, inner: &mut Inner, index: usize, new_sessions: &HashSet<u64>) {
        publish_batch(inner, index, new_sessions);
        self.generation.store(inner.generation, Ordering::Release);
    }

    /// Copy the immutable rows out from under the lock and serialize outside it: `store::save` walks
    /// every row, and a request must not wait for that on the inner lock.
    fn save_cache(&self) {
        let snapshot = {
            let mut inner = self.lock();
            if !inner.dirty {
                return;
            }
            inner.dirty = false;
            (crate::store::Interner::from_strings(inner.strings.strings.clone()), inner.cache.clone())
        };
        store::save(&self.data_dir.join("usage-scan-cache.bin"), CACHE_VERSION, &snapshot.0, &snapshot.1);
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

        // 1. List everything first so the progress total is real from the start. A revalidation
        // reuses a reader's last listing only while its fingerprint is conclusive and unchanged.
        let mut plans: Vec<Plan> = Vec::new();
        {
            let mut listings = self.listings.lock().unwrap_or_else(|e| e.into_inner());
            for (index, reader) in self.readers.iter().enumerate() {
                let provider = reader.provider();
                let slot = &mut listings[index];
                let reused = slot.as_ref().and_then(|cached| {
                    listing_fingerprint(&reader.dir(), &cached.files).map(|fp| (fp, cached.files.clone()))
                });
                let files = match reused {
                    Some((fp, files)) if Some(fp) == slot.as_ref().map(|c| c.fingerprint) => files,
                    _ => {
                        let files = reader.files();
                        let fingerprint = listing_fingerprint(&reader.dir(), &files);
                        *slot = fingerprint.map(|fingerprint| CachedListing { fingerprint, files: files.clone() });
                        files
                    }
                };
                let mut seen = HashSet::with_capacity(files.len());
                let mut horizon = Vec::new();
                for (fi, file) in files.iter().enumerate() {
                    let key: Arc<str> = Arc::from(format!("{provider}{SEP}{}", file.path.display()).as_str());
                    seen.insert(key.to_string());
                    // Files untouched since before the history window cannot hold records inside it.
                    if file.mtime_ms >= since {
                        horizon.push((key, fi));
                    }
                }
                plans.push(Plan { index, files, seen, horizon, stale: Vec::new() });
            }
        }
        {
            let inner = self.lock();
            for plan in &mut plans {
                plan.stale = plan
                    .horizon
                    .iter()
                    .enumerate()
                    .filter(|(_, (key, fi))| !inner.cache.get(&**key).is_some_and(|e| e.size == plan.files[*fi].size && e.mtime_ms == plan.files[*fi].mtime_ms))
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
        let mut removed_any = false;
        for plan in &plans {
            removed_any |= self.scan_provider(plan, since, &mut last_save, after_batch);
        }

        // 3. Settle: drop strings no row uses any more, persist, republish. The full row scan in
        // prune_interner only pays off when a listing actually removed a cache entry.
        {
            let mut inner = self.lock();
            if removed_any && prune_interner(&mut inner) {
                for index in 0..self.providers.len() {
                    self.publish_index(&mut inner, index);
                }
            }
        }
        self.save_cache();
        self.prewarm_and_persist();
        let finished = now_ms();
        let mut p = self.progress_lock();
        p.completed_once = true;
        p.last_finished_ms = finished;
        p.updated_ms = finished;
        p.scanning = false;
    }

    /// Returns true when this listing dropped at least one cache entry (a deleted transcript).
    fn scan_provider(&self, plan: &Plan, since: f64, last_save: &mut f64, after_batch: &mut dyn FnMut()) -> bool {
        let reader = &self.readers[plan.index];
        let provider = reader.provider();
        self.progress_lock().providers[plan.index].state = "scanning";
        let workers = std::thread::available_parallelism().map_or(2, |n| n.get()).clamp(1, 8);
        let mut failed: HashSet<Arc<str>> = HashSet::new();
        let mut new_sessions: HashSet<u64> = HashSet::new();
        let mut rows_changed = false;
        let mut offset = 0;
        let mut first = true;
        while offset < plan.stale.len() {
            let size = if first { FIRST_BATCH } else { BATCH };
            first = false;
            let end = (offset + size).min(plan.stale.len());
            let batch: Vec<(&Arc<str>, &FileInfo)> = plan.stale[offset..end].iter().map(|i| (&plan.horizon[*i].0, &plan.files[plan.horizon[*i].1])).collect();
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
                        rows_changed = true;
                        let rows = Arc::new(store::pack(&records, &mut inner.strings));
                        let empty = inner.strings.lookup("").map_or(f64::NAN, f64::from);
                        for o in (C_SESSION..rows.len()).step_by(STRIDE) {
                            if rows[o] != empty {
                                new_sessions.insert(rows[o].to_bits());
                            }
                        }
                        inner.cache.insert((&**key).to_string(), FileEntry { size: file.size, mtime_ms: file.mtime_ms, malformed, rows });
                        inner.dirty = true;
                    }
                    Err(_) => {
                        failed.insert(key.clone());
                        message_partial = true;
                    }
                }
            }
            let keys: Vec<Arc<str>> = plan.horizon.iter().filter(|(k, _)| !failed.contains(k) && inner.cache.contains_key(&**k)).map(|(k, _)| k.clone()).collect();
            inner.views[plan.index].keys = keys;
            if message_partial {
                inner.views[plan.index].status = "partial";
                inner.views[plan.index].message = Some("Some files could not be read.");
            }
            self.publish_batch_index(&mut inner, plan.index, &new_sessions);
            let should_save = inner.dirty && now_ms() - *last_save >= SAVE_EVERY_MS;
            drop(inner);
            if should_save {
                *last_save = now_ms();
                self.save_cache();
            }
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
        let gone: Vec<String> = inner.cache.keys().filter(|k| k.starts_with(&prefix) && !plan.seen.contains(k.as_str())).cloned().collect();
        let removed_any = !gone.is_empty();
        if removed_any {
            inner.dirty = true;
        }
        for key in gone {
            inner.cache.remove(&key);
        }
        let keys: Vec<Arc<str>> = plan.horizon.iter().filter(|(k, _)| !failed.contains(k) && inner.cache.contains_key(&**k)).map(|(k, _)| k.clone()).collect();
        let view = &mut inner.views[plan.index];
        let old_status = view.status;
        let old_message = view.message;
        let old_scanned = view.scanned_files;
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
        let metadata_changed = old_status != view.status || old_message != view.message || old_scanned != view.scanned_files;
        let changed = rows_changed || removed_any || metadata_changed;
        self.publish_index_with(&mut inner, plan.index, changed);
        drop(inner);
        self.progress_lock().providers[plan.index].state = "done";
        after_batch();
        removed_any
    }
}
