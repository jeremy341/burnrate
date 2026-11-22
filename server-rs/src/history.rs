//! History — compact append-only store of usage samples (docs/CONTRACTS.md section 9).
//!
//! On disk: `<data>/history.bin`. The contract allows "zstd-compressed day files or a ring; owner
//! decides". This is the ring-style choice: a packed, CRC-framed append-only log with interned
//! account/window ids. A sample is exactly 14 bytes (`ts_minute u32`, `account u32`, `window u32`,
//! `usedPercent u16 x100`), so 10 accounts x ~3 windows x 96 samples/day x 90 days is ~3.6 MB,
//! comfortably under the ~5 MB budget. Compaction (retention sweep) rewrites the file atomically.
//!
//! Crash safety: every frame carries a length and a CRC32. A partial or corrupt tail is detected on
//! load, discarded before the next append, and never loses earlier samples. The retention sweep
//! (and the "on start / daily" requirement) is performed lazily on the first access and whenever
//! expired samples are seen; this package does not own `lib.rs`/`scheduler.rs`, so no startup hook
//! is installed here.

use crate::State;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// File format -----------------------------------------------------------------

const MAGIC: &[u8; 8] = b"BRHIST01";
const HEADER_LEN: usize = 16; // magic(8) | version u32(4) | reserved(4)
const FRAME_HEADER_LEN: usize = 8; // payload length u32 | crc32 u32

const REC_INTERN: u8 = 1;
const REC_SAMPLES: u8 = 2;
const INTERN_ACCOUNT: u8 = 0;
const INTERN_WINDOW: u8 = 1;
const SAMPLE_BYTES: usize = 14;
const SAMPLES_PER_FRAME: usize = 1000;
const MAX_FRAME_BYTES: usize = 64 * 1024;
const DEFAULT_HISTORY_DAYS: u32 = 90;
const MAX_POINTS: usize = 500;
/// One sample per 15 minutes, or as soon as the value moves by >= 0.5 percent.
const SAMPLE_INTERVAL_MIN: u32 = 15;
const CHANGE_THRESHOLD_X100: i32 = 50;

/// Keeps one validated Store in memory. The fingerprint is the file's length and modification
/// time: a change made outside this process forces a reload on the next call, while our own writes
/// adopt the new fingerprint so a snapshot/GET pair does not re-read and CRC the whole log.
struct Cached {
    state: (u64, u128),
    store: Store,
}

/// Serialises all file access and guards the cached Store.
static IO: Mutex<Option<Cached>> = Mutex::new(None);

fn file_state(path: &Path) -> (u64, u128) {
    fs::metadata(path)
        .map(|m| {
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            (m.len(), modified)
        })
        .unwrap_or((0, 0))
}

fn with_store<R>(write: bool, f: impl FnOnce(&mut Store) -> R) -> R {
    let path = history_file();
    let mut guard = IO.lock().unwrap_or_else(|e| e.into_inner());
    let state = file_state(&path);
    if guard.as_ref().map_or(true, |cached| cached.state != state) {
        let store = Store::load(&path);
        *guard = Some(Cached { state, store });
    }
    let cached = guard.as_mut().expect("cache populated above");
    let result = f(&mut cached.store);
    if write {
        cached.state = file_state(&path);
    }
    result
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DiskSample {
    ts_min: u32,
    acct: u32,
    win: u32,
    val: u16, // usedPercent * 100, 0..=10000
}

#[derive(Clone, Debug)]
struct NewSample {
    account: String,
    window: String,
    ts_min: u32,
    val: u16,
}

/// Options for `read`. `since_ms`/`until_ms` are inclusive bounds (i64::MIN / now when absent).
pub struct Query {
    pub since_ms: i64,
    pub until_ms: i64,
    pub account: Option<String>,
    pub window: Option<String>,
    /// Downsampling bucket width in seconds (default 300).
    pub step_secs: u64,
}

/// One series in the `GET /api/history` response.
pub struct Series {
    pub account_id: String,
    pub window_id: String,
    pub points: Vec<(i64, f64)>, // (tsMs, usedPercent)
}

struct Store {
    path: PathBuf,
    accounts: HashMap<u32, String>,
    windows: HashMap<u32, String>,
    acct_by_name: HashMap<String, u32>,
    win_by_name: HashMap<String, u32>,
    written_interns: HashSet<u32>,
    next_id: u32,
    samples: Vec<DiskSample>,
    /// Last stored (ts_minute, value) per (account, window), maintained on append so selecting new
    /// samples on a refresh never rescans the whole log.
    last_by_key: HashMap<(u32, u32), (u32, u16)>,
    /// Oldest sample timestamp, for an O(1) retention-sweep check.
    min_ts: Option<u32>,
    /// Byte offset just past the last valid frame; used to trim a corrupt tail before appending.
    valid_end: u64,
    corrupt_tail: bool,
    header_ok: bool,
}

// CRC32 (IEEE, reflected polynomial 0xEDB88320). A tiny local implementation avoids a new crate.
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn write_frame(file: &mut File, payload: &[u8]) -> std::io::Result<()> {
    file.write_all(&(payload.len() as u32).to_le_bytes())?;
    file.write_all(&crc32(payload).to_le_bytes())?;
    file.write_all(payload)
}

fn header_bytes() -> Vec<u8> {
    let mut h = Vec::with_capacity(HEADER_LEN);
    h.extend_from_slice(MAGIC);
    h.extend_from_slice(&1u32.to_le_bytes());
    h.extend_from_slice(&[0u8; 4]);
    h
}

impl Store {
    fn load(path: &Path) -> Store {
        let mut s = Store {
            path: path.to_path_buf(),
            accounts: HashMap::new(),
            windows: HashMap::new(),
            acct_by_name: HashMap::new(),
            win_by_name: HashMap::new(),
            written_interns: HashSet::new(),
            next_id: 1,
            samples: Vec::new(),
            last_by_key: HashMap::new(),
            min_ts: None,
            valid_end: 0,
            corrupt_tail: false,
            header_ok: false,
        };
        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(_) => return s, // missing file: empty store, created on first append
        };
        if bytes.len() < HEADER_LEN || &bytes[..8] != MAGIC {
            // Unusable file: start over. `append`/`rewrite` truncates it before writing.
            s.corrupt_tail = true;
            return s;
        }
        s.header_ok = true;
        s.valid_end = HEADER_LEN as u64;
        let mut off = HEADER_LEN;
        while off + FRAME_HEADER_LEN <= bytes.len() {
            let len = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
            let crc = u32::from_le_bytes(bytes[off + 4..off + 8].try_into().unwrap());
            if len == 0 || len > MAX_FRAME_BYTES || off + FRAME_HEADER_LEN + len > bytes.len() {
                s.corrupt_tail = true;
                break;
            }
            let payload = &bytes[off + FRAME_HEADER_LEN..off + FRAME_HEADER_LEN + len];
            if crc32(payload) != crc || !s.parse_payload(payload) {
                s.corrupt_tail = true;
                break;
            }
            off += FRAME_HEADER_LEN + len;
            s.valid_end = off as u64;
        }
        if off != bytes.len() {
            // A short trailing fragment that could not even form a frame header.
            s.corrupt_tail = true;
        }
        s
    }

    fn parse_payload(&mut self, p: &[u8]) -> bool {
        match p.first().copied() {
            Some(REC_INTERN) => {
                if p.len() < 8 {
                    return false;
                }
                let id = u32::from_le_bytes(p[1..5].try_into().unwrap());
                let kind = p[5];
                let name_len = u16::from_le_bytes(p[6..8].try_into().unwrap()) as usize;
                if p.len() != 8 + name_len {
                    return false;
                }
                let Ok(name) = std::str::from_utf8(&p[8..8 + name_len]) else { return false };
                match kind {
                    INTERN_ACCOUNT => {
                        self.accounts.insert(id, name.to_string());
                        self.acct_by_name.insert(name.to_string(), id);
                    }
                    INTERN_WINDOW => {
                        self.windows.insert(id, name.to_string());
                        self.win_by_name.insert(name.to_string(), id);
                    }
                    _ => return false,
                }
                self.next_id = self.next_id.max(id.wrapping_add(1));
                self.written_interns.insert(id);
                true
            }
            Some(REC_SAMPLES) => {
                if p.len() < 3 {
                    return false;
                }
                let count = u16::from_le_bytes(p[1..3].try_into().unwrap()) as usize;
                if p.len() != 3 + count * SAMPLE_BYTES {
                    return false;
                }
                for c in p[3..].chunks_exact(SAMPLE_BYTES) {
                    let ts_min = u32::from_le_bytes(c[0..4].try_into().unwrap());
                    let acct = u32::from_le_bytes(c[4..8].try_into().unwrap());
                    let win = u32::from_le_bytes(c[8..12].try_into().unwrap());
                    let val = u16::from_le_bytes(c[12..14].try_into().unwrap());
                    if !self.accounts.contains_key(&acct) || !self.windows.contains_key(&win) || val > 10_000 {
                        return false;
                    }
                    self.note_sample(DiskSample { ts_min, acct, win, val });
                }
                true
            }
            _ => false,
        }
    }

    fn intern_account(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.acct_by_name.get(name) {
            return id;
        }
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.accounts.insert(id, name.to_string());
        self.acct_by_name.insert(name.to_string(), id);
        id
    }

    fn intern_window(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.win_by_name.get(name) {
            return id;
        }
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.windows.insert(id, name.to_string());
        self.win_by_name.insert(name.to_string(), id);
        id
    }

    fn index_sample(&mut self, s: &DiskSample) {
        self.last_by_key.insert((s.acct, s.win), (s.ts_min, s.val));
        self.min_ts = Some(self.min_ts.map_or(s.ts_min, |m| m.min(s.ts_min)));
    }

    fn note_sample(&mut self, s: DiskSample) {
        self.samples.push(s);
        self.index_sample(&s);
    }

    fn rebuild_indexes(&mut self) {
        self.last_by_key.clear();
        self.min_ts = None;
        for i in 0..self.samples.len() {
            let s = self.samples[i];
            self.index_sample(&s);
        }
    }

    fn select_new(&self, batch: &[NewSample]) -> Vec<NewSample> {
        batch
            .iter()
            .filter(|s| {
                let Some(&a) = self.acct_by_name.get(&s.account) else { return true };
                let Some(&w) = self.win_by_name.get(&s.window) else { return true };
                match self.last_by_key.get(&(a, w)) {
                    None => true,
                    Some((ts, val)) => {
                        s.ts_min.saturating_sub(*ts) >= SAMPLE_INTERVAL_MIN
                            || (s.val as i32 - *val as i32).abs() >= CHANGE_THRESHOLD_X100
                    }
                }
            })
            .cloned()
            .collect()
    }

    /// Append a frame per new intern plus batched sample frames. Drops a corrupt tail first.
    fn append(&mut self, batch: &[NewSample]) -> bool {
        let mut new_interns: Vec<(u32, u8, String)> = Vec::new();
        let mut resolved: Vec<DiskSample> = Vec::with_capacity(batch.len());
        for s in batch {
            let a = self.intern_account(&s.account);
            let w = self.intern_window(&s.window);
            if !self.written_interns.contains(&a) {
                new_interns.push((a, INTERN_ACCOUNT, s.account.clone()));
            }
            if !self.written_interns.contains(&w) {
                new_interns.push((w, INTERN_WINDOW, s.window.clone()));
            }
            resolved.push(DiskSample { ts_min: s.ts_min, acct: a, win: w, val: s.val });
        }

        if !self.header_ok || self.corrupt_tail {
            // A bad tail means earlier frames may still be valid but cannot simply be kept: the
            // frames we are about to write could refer to intern records that only existed in the
            // tail we are about to drop. Rebuild the whole file from the valid in-memory state.
            for s in resolved {
                self.note_sample(s);
            }
            return self.rewrite();
        }

        let Ok(mut file) = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&self.path) else {
            return false;
        };
        if file.seek(SeekFrom::End(0)).is_err() {
            return false;
        }
        for (id, kind, name) in &new_interns {
            let mut payload = Vec::with_capacity(8 + name.len());
            payload.push(REC_INTERN);
            payload.extend_from_slice(&id.to_le_bytes());
            payload.push(*kind);
            payload.extend_from_slice(&(name.len() as u16).to_le_bytes());
            payload.extend_from_slice(name.as_bytes());
            if self.write_and_track(&mut file, &payload).is_err() {
                return false;
            }
        }
        for chunk in resolved.chunks(SAMPLES_PER_FRAME) {
            let mut payload = Vec::with_capacity(3 + chunk.len() * SAMPLE_BYTES);
            payload.push(REC_SAMPLES);
            payload.extend_from_slice(&(chunk.len() as u16).to_le_bytes());
            for s in chunk {
                payload.extend_from_slice(&s.ts_min.to_le_bytes());
                payload.extend_from_slice(&s.acct.to_le_bytes());
                payload.extend_from_slice(&s.win.to_le_bytes());
                payload.extend_from_slice(&s.val.to_le_bytes());
            }
            if self.write_and_track(&mut file, &payload).is_err() {
                return false;
            }
        }
        if file.flush().is_err() || file.sync_data().is_err() {
            return false;
        }
        self.valid_end = file.stream_position().unwrap_or(self.valid_end);
        for (id, _, _) in &new_interns {
            self.written_interns.insert(*id);
        }
        for s in resolved {
            self.note_sample(s);
        }
        true
    }

    fn write_and_track(&mut self, file: &mut File, payload: &[u8]) -> std::io::Result<()> {
        write_frame(file, payload)?;
        self.valid_end += (FRAME_HEADER_LEN + payload.len()) as u64;
        Ok(())
    }

    /// Atomically rebuild the file from the current in-memory samples.
    fn rewrite(&mut self) -> bool {
        let tmp = self.path.with_extension("bin.tmp");
        let Ok(mut file) = File::create(&tmp) else { return false };
        let mut ok = file.write_all(&header_bytes()).is_ok();
        if ok {
            let mut interned: Vec<(u32, u8, String)> = Vec::new();
            interned.extend(self.accounts.iter().map(|(&id, name)| (id, INTERN_ACCOUNT, name.clone())));
            interned.extend(self.windows.iter().map(|(&id, name)| (id, INTERN_WINDOW, name.clone())));
            interned.sort_by_key(|x| x.0);
            for (id, kind, name) in &interned {
                let mut payload = Vec::with_capacity(8 + name.len());
                payload.push(REC_INTERN);
                payload.extend_from_slice(&id.to_le_bytes());
                payload.push(*kind);
                payload.extend_from_slice(&(name.len() as u16).to_le_bytes());
                payload.extend_from_slice(name.as_bytes());
                ok = write_frame(&mut file, &payload).is_ok();
                if !ok {
                    break;
                }
            }
            if ok {
                for chunk in self.samples.chunks(SAMPLES_PER_FRAME) {
                    let mut payload = Vec::with_capacity(3 + chunk.len() * SAMPLE_BYTES);
                    payload.push(REC_SAMPLES);
                    payload.extend_from_slice(&(chunk.len() as u16).to_le_bytes());
                    for s in chunk {
                        payload.extend_from_slice(&s.ts_min.to_le_bytes());
                        payload.extend_from_slice(&s.acct.to_le_bytes());
                        payload.extend_from_slice(&s.win.to_le_bytes());
                        payload.extend_from_slice(&s.val.to_le_bytes());
                    }
                    ok = write_frame(&mut file, &payload).is_ok();
                    if !ok {
                        break;
                    }
                }
            }
        }
        if ok {
            ok = file.sync_all().is_ok();
        }
        drop(file);
        if !ok || fs::rename(&tmp, &self.path).is_err() {
            let _ = fs::remove_file(&tmp);
            return false;
        }
        self.written_interns = self.accounts.keys().chain(self.windows.keys()).copied().collect();
        self.header_ok = true;
        self.corrupt_tail = false;
        self.valid_end = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        true
    }

    fn needs_sweep(&self, cutoff_min: u32) -> bool {
        self.min_ts.is_some_and(|ts| ts < cutoff_min)
    }

    /// Retention sweep: drop samples older than `cutoff_min` and reclaim their space.
    fn sweep(&mut self, cutoff_min: u32) -> bool {
        self.samples.retain(|s| s.ts_min >= cutoff_min);
        self.rebuild_indexes();
        let accts: HashSet<u32> = self.samples.iter().map(|s| s.acct).collect();
        let wins: HashSet<u32> = self.samples.iter().map(|s| s.win).collect();
        self.accounts.retain(|id, _| accts.contains(id));
        self.windows.retain(|id, _| wins.contains(id));
        self.acct_by_name.retain(|_, id| accts.contains(id));
        self.win_by_name.retain(|_, id| wins.contains(id));
        self.rewrite()
    }

    fn clear(&mut self) -> bool {
        self.samples.clear();
        self.last_by_key.clear();
        self.min_ts = None;
        self.accounts.clear();
        self.windows.clear();
        self.acct_by_name.clear();
        self.win_by_name.clear();
        self.written_interns.clear();
        self.next_id = 1;
        self.rewrite()
    }

    fn query(&self, q: &Query) -> Vec<Series> {
        let mut groups: BTreeMap<(u32, u32), Vec<(i64, f64)>> = BTreeMap::new();
        for s in &self.samples {
            let ts_ms = s.ts_min as i64 * 60_000;
            if ts_ms < q.since_ms || ts_ms > q.until_ms {
                continue;
            }
            if !self.accounts.contains_key(&s.acct) || !self.windows.contains_key(&s.win) {
                continue;
            }
            if q.account.as_ref().is_some_and(|a| self.accounts.get(&s.acct).is_some_and(|n| n != a)) {
                continue;
            }
            if q.window.as_ref().is_some_and(|w| self.windows.get(&s.win).is_some_and(|n| n != w)) {
                continue;
            }
            groups.entry((s.acct, s.win)).or_default().push((ts_ms, s.val as f64 / 100.0));
        }
        groups
            .into_iter()
            .filter_map(|((acct, win), points)| {
                let account = self.accounts.get(&acct)?.clone();
                let window = self.windows.get(&win)?.clone();
                Some(Series { account_id: account, window_id: window, points: downsample(&points, q.step_secs, MAX_POINTS) })
            })
            .collect()
    }
}

/// Bucket by `step_secs` (keeping the latest value in each bucket), then cap at `max` points by
/// taking evenly spaced samples while always preserving the first and last.
fn downsample(points: &[(i64, f64)], step_secs: u64, max: usize) -> Vec<(i64, f64)> {
    if points.is_empty() || max == 0 {
        return Vec::new();
    }
    let step_ms = step_secs.max(1).saturating_mul(1000) as i64;
    let mut buckets: BTreeMap<i64, (i64, f64)> = BTreeMap::new();
    for &(ts, val) in points {
        buckets.insert(ts.div_euclid(step_ms), (ts, val));
    }
    let kept: Vec<(i64, f64)> = buckets.into_values().collect();
    if kept.len() <= max {
        return kept;
    }
    if max == 1 {
        return vec![kept[0]];
    }
    let last = kept.len() - 1;
    (0..max).map(|i| kept[i * last / (max - 1)]).collect()
}

// Public integration -----------------------------------------------------------

fn data_dir() -> PathBuf {
    if let Some(dir) = crate::readers::env_path("BURNRATE_DATA") {
        return dir;
    }
    // Mirror lib.rs's web-dir discovery so the file lands in the same data directory.
    let web_dir = crate::readers::env_path("BURNRATE_WEB").unwrap_or_else(|| {
        let mut candidates = vec![PathBuf::from("dist/web")];
        if let Ok(exe) = std::env::current_exe() {
            for ancestor in exe.ancestors().skip(1).take(6) {
                candidates.push(ancestor.join("dist").join("web"));
            }
        }
        candidates.into_iter().find(|c| c.join("index.html").is_file()).unwrap_or_else(|| PathBuf::from("dist/web"))
    });
    web_dir.parent().and_then(Path::parent).map_or_else(|| PathBuf::from("data"), |root| root.join("data"))
}

fn history_file() -> PathBuf {
    data_dir().join("history.bin")
}

fn history_days(state: &State) -> u32 {
    let raw = state.settings.raw();
    let value = raw.pointer("/usage/historyDays").or_else(|| raw.get("historyDays"));
    let n = value
        .and_then(Value::as_u64)
        .or_else(|| value.and_then(Value::as_f64).map(|f| f as u64))
        .unwrap_or(DEFAULT_HISTORY_DAYS as u64);
    n.min(3650) as u32
}

fn now_minutes() -> u32 {
    (chrono::Utc::now().timestamp().max(0) / 60) as u32
}

fn cutoff_min(now_min: u32, days: u32) -> u32 {
    now_min.saturating_sub(days.saturating_mul(1440))
}

/// Samples a limits-report / compact-status snapshot. Accepts both shapes: the report nests
/// windows under `limits.windows`, while compact status puts them directly on the account.
pub fn on_snapshot(state: &State, snapshot: &Value) {
    let days = history_days(state);
    let now = now_minutes();
    let batch = extract_samples(snapshot, now);
    with_store(true, |store| {
        if days == 0 {
            if !store.samples.is_empty() {
                store.clear();
            }
            return;
        }
        let cutoff = cutoff_min(now, days);
        if store.needs_sweep(cutoff) {
            store.sweep(cutoff);
        }
        let fresh = store.select_new(&batch);
        if !fresh.is_empty() {
            store.append(&fresh); // keeps flush/sync_data for crash safety
        }
    });
}

/// Reads history, applying filters and downsampling. Also performs the retention sweep so the
/// bound is enforced even when no scheduler is feeding snapshots.
pub fn read(state: &State, q: &Query) -> Vec<Series> {
    if history_days(state) == 0 {
        return Vec::new();
    }
    let cutoff = cutoff_min(now_minutes(), history_days(state));
    with_store(true, |store| {
        if store.needs_sweep(cutoff) {
            store.sweep(cutoff);
        }
        store.query(q)
    })
}

/// Clears the whole history store.
pub fn clear() {
    with_store(true, |store| {
        store.clear();
    });
}

fn extract_samples(snapshot: &Value, now_min: u32) -> Vec<NewSample> {
    let Some(accounts) = snapshot.get("accounts").and_then(Value::as_array) else { return Vec::new() };
    let mut out = Vec::new();
    for account in accounts {
        let account_id = account
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| account.get("displayName").and_then(Value::as_str))
            .or_else(|| account.get("label").and_then(Value::as_str))
            .unwrap_or("");
        if account_id.is_empty() {
            continue;
        }
        let windows = account
            .get("limits")
            .and_then(|l| l.get("windows"))
            .and_then(Value::as_array)
            .or_else(|| account.get("windows").and_then(Value::as_array));
        let Some(windows) = windows else { continue };
        for window in windows {
            let window_id = window
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| window.get("kind").and_then(Value::as_str))
                .unwrap_or("");
            if window_id.is_empty() {
                continue;
            }
            let Some(percent) = window.get("usedPercent").and_then(Value::as_f64) else { continue };
            if !percent.is_finite() {
                continue;
            }
            let val = (percent.clamp(0.0, 100.0) * 100.0).round() as u16;
            out.push(NewSample { account: account_id.to_string(), window: window_id.to_string(), ts_min: now_min, val });
        }
    }
    out
}

// Tests -----------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir() -> PathBuf {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        let dir = std::env::temp_dir().join(format!("burnrate-history-{}-{}-{}", std::process::id(), NEXT_DIR.fetch_add(1, Ordering::Relaxed), nonce));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    fn sample(account: &str, window: &str, ts_min: u32, percent: f64) -> NewSample {
        NewSample { account: account.into(), window: window.into(), ts_min, val: (percent * 100.0).round() as u16 }
    }

    #[test]
    fn crc32_known_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn append_query_roundtrip_and_filters() {
        let dir = temp_dir();
        let path = dir.join("history.bin");
        let mut store = Store::load(&path);
        let batch = vec![
            sample("acc-a", "fiveHour", 100, 12.5),
            sample("acc-a", "fiveHour", 115, 20.0),
            sample("acc-a", "sevenDay", 100, 40.0),
            sample("acc-b", "fiveHour", 100, 75.0),
        ];
        assert!(store.append(&batch));
        // Reload from disk to prove persistence and interning survived.
        let loaded = Store::load(&path);
        assert_eq!(loaded.samples.len(), 4);

        let all = loaded.query(&Query { since_ms: i64::MIN, until_ms: i64::MAX, account: None, window: None, step_secs: 1 });
        assert_eq!(all.len(), 3);
        let a5 = all.iter().find(|s| s.account_id == "acc-a" && s.window_id == "fiveHour").unwrap();
        assert_eq!(a5.points, vec![(100 * 60_000, 12.5), (115 * 60_000, 20.0)]);

        let only_b = loaded.query(&Query { since_ms: i64::MIN, until_ms: i64::MAX, account: Some("acc-b".into()), window: None, step_secs: 1 });
        assert_eq!(only_b.len(), 1);
        assert_eq!(only_b[0].account_id, "acc-b");

        let since = loaded.query(&Query { since_ms: 110 * 60_000, until_ms: i64::MAX, account: None, window: None, step_secs: 1 });
        let a5 = since.iter().find(|s| s.account_id == "acc-a" && s.window_id == "fiveHour").unwrap();
        assert_eq!(a5.points.len(), 1);
        assert_eq!(a5.points[0].1, 20.0);
        cleanup(&dir);
    }

    #[test]
    fn incremental_indexes_match_samples_through_append_and_sweep() {
        let dir = temp_dir();
        let mut store = Store::load(&dir.join("history.bin"));
        assert!(store.append(&[sample("a", "w", 100, 10.0), sample("b", "w", 90, 20.0), sample("a", "w", 115, 11.0)]));
        assert_eq!(store.min_ts, Some(90));
        let a = store.acct_by_name["a"];
        let w = store.win_by_name["w"];
        assert_eq!(store.last_by_key.get(&(a, w)), Some(&(115, 1100)));
        assert!(store.sweep(100));
        assert_eq!(store.min_ts, Some(100));
        assert_eq!(store.last_by_key.len(), 1);
        assert_eq!(store.last_by_key.get(&(a, w)), Some(&(115, 1100)));
        cleanup(&dir);
    }

    #[test]
    fn sampling_rule_change_or_interval() {
        let dir = temp_dir();
        let mut store = Store::load(&dir.join("history.bin"));
        assert!(store.append(&[sample("a", "w", 100, 10.0)]));
        // Same value, 5 minutes later: skipped.
        assert!(store.select_new(&[sample("a", "w", 105, 10.2)]).is_empty());
        // +0.5 exactly: recorded.
        assert_eq!(store.select_new(&[sample("a", "w", 105, 10.5)]).len(), 1);
        // +15 minutes: recorded even with the same value.
        assert_eq!(store.select_new(&[sample("a", "w", 115, 10.0)]).len(), 1);
        cleanup(&dir);
    }

    #[test]
    fn downsample_buckets_and_caps_at_500() {
        let points: Vec<(i64, f64)> = (0..5000).map(|i| (i * 60_000, i as f64 / 100.0)).collect();
        // 300 s buckets -> one point per 5 minutes -> 1000 points -> capped to 500.
        // Each bucket keeps its latest sample, so bucket 0 ends at minute 4, bucket 999 at 4999.
        let out = downsample(&points, 300, 500);
        assert_eq!(out.len(), 500);
        assert_eq!(out.first().unwrap().0, 4 * 60_000);
        assert_eq!(out.last().unwrap().0, 4999 * 60_000);
        // One-day buckets over a ~3.5-day span -> 4 points.
        assert_eq!(downsample(&points, 86_400, 500).len(), 4);
        assert_eq!(downsample(&[], 300, 500).len(), 0);
    }

    #[test]
    fn corrupt_tail_is_tolerated() {
        let dir = temp_dir();
        let path = dir.join("history.bin");
        let mut store = Store::load(&path);
        assert!(store.append(&[sample("a", "w", 100, 10.0)]));
        // Append junk after the valid frames.
        {
            let mut file = OpenOptions::new().append(true).open(&path).unwrap();
            file.write_all(&[0xDE, 0xAD, 0xBE, 0xEF, 0x01]).unwrap();
        }
        let mut loaded = Store::load(&path);
        assert!(loaded.corrupt_tail);
        assert_eq!(loaded.samples.len(), 1);
        assert!(loaded.append(&[sample("a", "w", 115, 11.0)]));
        let final_store = Store::load(&path);
        assert!(!final_store.corrupt_tail);
        assert_eq!(final_store.samples.len(), 2);
        cleanup(&dir);
    }

    #[test]
    fn retention_sweep_and_clear() {
        let dir = temp_dir();
        let path = dir.join("history.bin");
        let mut store = Store::load(&path);
        let batch = vec![sample("a", "w", 10, 10.0), sample("a", "w", 1000, 20.0)];
        assert!(store.append(&batch));
        assert!(store.needs_sweep(500));
        assert!(store.sweep(500));
        let loaded = Store::load(&path);
        assert_eq!(loaded.samples.len(), 1);
        assert_eq!(loaded.samples[0].val, 2000);
        let mut store = Store::load(&path);
        assert!(store.clear());
        assert_eq!(Store::load(&path).samples.len(), 0);
        cleanup(&dir);
    }

    #[test]
    fn size_budget_ten_accounts_ninety_days() {
        let dir = temp_dir();
        let path = dir.join("history.bin");
        let mut store = Store::load(&path);
        let windows = ["fiveHour", "sevenDay", "monthly"];
        // Worst case from the contract: a sample whenever it might change, ~every 15 min.
        for account in 0..10 {
            for window in windows {
                for day in 0..90u32 {
                    for slot in 0..96u32 {
                        let ts = day * 1440 + slot * 15;
                        let val = ((slot * 7 + account as u32 * 3) % 10_001) as u16;
                        let acct = store.intern_account(&format!("account-{account}"));
                        let win = store.intern_window(window);
                        store.note_sample(DiskSample { ts_min: ts, acct, win, val });
                    }
                }
            }
        }
        assert_eq!(store.samples.len(), 10 * 3 * 90 * 96);
        assert!(store.rewrite());
        let bytes = fs::metadata(&path).unwrap().len();
        assert!(bytes < 5 * 1024 * 1024, "history file too large: {} bytes", bytes);
        // Reload and downsample a 90-day series: at most 500 points.
        let loaded = Store::load(&path);
        let series = loaded.query(&Query { since_ms: i64::MIN, until_ms: i64::MAX, account: Some("account-0".into()), window: Some("fiveHour".into()), step_secs: 300 });
        assert_eq!(series.len(), 1);
        assert!(series[0].points.len() <= 500);
        cleanup(&dir);
    }

    #[test]
    fn extracts_both_snapshot_shapes() {
        let report = json!({"accounts": [
            {"id": "a", "limits": {"windows": [{"id": "w", "usedPercent": 42.25}]}}
        ]});
        let compact = json!({"accounts": [
            {"id": "a", "windows": [{"id": "w", "usedPercent": 42.25}]}
        ]});
        for snapshot in [&report, &compact] {
            let samples = extract_samples(snapshot, 1234);
            assert_eq!(samples.len(), 1);
            assert_eq!(samples[0].val, 4225);
        }
    }
}
