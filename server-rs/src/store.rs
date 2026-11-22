use crate::types::Record;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::Arc;

/// Parsed usage is kept as one Vec<f64> per transcript file: 14 numbers per record. The on-disk
/// cache is the same bytes and the same layout as the TypeScript server's, so either can read it.
pub const STRIDE: usize = 14;
pub const C_TS: usize = 0;
pub const C_PROVIDER: usize = 1;
pub const C_MODEL: usize = 2;
pub const C_RATE_MODEL: usize = 3;
pub const C_SESSION: usize = 4;
pub const C_SPEED: usize = 5;
pub const C_UNCACHED: usize = 6;
pub const C_CACHED: usize = 7;
pub const C_CACHE_WRITE: usize = 8;
pub const C_OUTPUT: usize = 9;
pub const C_REASONING: usize = 10;
pub const C_CACHE_1H: usize = 11;
pub const C_REPORTED: usize = 12;
pub const C_KEY: usize = 13;

#[derive(Default)]
pub struct Interner {
    pub strings: Vec<String>,
    ids: HashMap<String, u32>,
}

impl Interner {
    pub fn from_strings(strings: Vec<String>) -> Self {
        let ids = strings.iter().enumerate().map(|(i, s)| (s.clone(), i as u32)).collect();
        Interner { strings, ids }
    }
    pub fn id(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.ids.get(s) {
            return id;
        }
        let id = self.strings.len() as u32;
        self.strings.push(s.to_string());
        self.ids.insert(s.to_string(), id);
        id
    }
    /// The id of an already interned string, without interning it.
    pub fn lookup(&self, s: &str) -> Option<u32> {
        self.ids.get(s).copied()
    }
    pub fn get(&self, id: f64) -> &str {
        self.strings.get(id as usize).map(String::as_str).unwrap_or("")
    }
    /// Rebuild the table from the ids still referenced by cached rows. Ids not in `live`
    /// (strings orphaned by deleted transcript files) are discarded. Returns an old-id ->
    /// new-id remap so callers can rewrite persisted id columns before saving.
    pub fn retain_ids(&mut self, live: &HashSet<u32>) -> HashMap<u32, u32> {
        let mut remap = HashMap::new();
        let mut kept = Vec::with_capacity(live.len());
        for (old, s) in self.strings.drain(..).enumerate() {
            if live.contains(&(old as u32)) {
                remap.insert(old as u32, kept.len() as u32);
                kept.push(s);
            }
        }
        self.strings = kept;
        self.ids = self.strings.iter().enumerate().map(|(i, s)| (s.clone(), i as u32)).collect();
        remap
    }
}

/// 53-bit hash of a dedupe key (two FNV-1a style passes), identical to the TypeScript server's.
///
/// ACCEPTED RISK (review 02 #8): at ~5e7 distinct keys a birthday collision becomes likely and two
/// different messages merge at the per-channel maximum (undercounting). The 53-bit width is fixed
/// by the shared TS cache format; widening it needs a coordinated cache-version bump on both sides.
pub fn hash_key(key: &str) -> f64 {
    let mut a: u32 = 0x811c9dc5;
    let mut b: u32 = 0x9747b28c;
    for unit in key.encode_utf16() {
        let c = unit as u32;
        a = (a ^ c).wrapping_mul(0x01000193);
        b = (b ^ c).wrapping_mul(0x85ebca6b) ^ (b >> 13);
    }
    (a as f64) * 2097152.0 + ((b >> 11) as f64)
}

pub fn pack(records: &[Record], strings: &mut Interner) -> Vec<f64> {
    let mut rows = vec![0.0; records.len() * STRIDE];
    for (i, r) in records.iter().enumerate() {
        let o = i * STRIDE;
        rows[o + C_TS] = r.ts;
        rows[o + C_PROVIDER] = strings.id(&r.provider) as f64;
        rows[o + C_MODEL] = strings.id(&r.model) as f64;
        rows[o + C_RATE_MODEL] = r.rate_model.as_deref().map_or(-1.0, |m| strings.id(m) as f64);
        rows[o + C_SESSION] = strings.id(&r.session) as f64;
        rows[o + C_SPEED] = r.speed as f64;
        rows[o + C_UNCACHED] = r.uncached;
        rows[o + C_CACHED] = r.cached;
        rows[o + C_CACHE_WRITE] = r.cache_write;
        rows[o + C_OUTPUT] = r.output;
        rows[o + C_REASONING] = r.reasoning;
        rows[o + C_CACHE_1H] = r.cache_1h;
        rows[o + C_REPORTED] = r.reported.unwrap_or(f64::NAN);
        rows[o + C_KEY] = match &r.key {
            Some(k) => hash_key(&format!("{}\0{}", r.provider, k)),
            None => f64::NAN,
        };
    }
    rows
}

pub fn unpack(rows: &[f64], i: usize, strings: &Interner) -> Record {
    let o = i * STRIDE;
    let rate = rows[o + C_RATE_MODEL];
    let cost = rows[o + C_REPORTED];
    Record {
        provider: strings.get(rows[o + C_PROVIDER]).to_string(),
        ts: rows[o + C_TS],
        model: strings.get(rows[o + C_MODEL]).to_string(),
        rate_model: if rate < 0.0 { None } else { Some(strings.get(rate).to_string()) },
        session: strings.get(rows[o + C_SESSION]).to_string(),
        uncached: rows[o + C_UNCACHED],
        cached: rows[o + C_CACHED],
        cache_write: rows[o + C_CACHE_WRITE],
        output: rows[o + C_OUTPUT],
        reasoning: rows[o + C_REASONING],
        cache_1h: rows[o + C_CACHE_1H],
        reported: if cost.is_nan() { None } else { Some(cost) },
        speed: rows[o + C_SPEED] as u8,
        key: None,
    }
}

pub struct FileEntry {
    pub size: f64,
    pub mtime_ms: f64,
    pub malformed: u32,
    /// Shared with the published view so a summary never copies a file's rows.
    pub rows: Arc<Vec<f64>>,
}

pub fn save(path: &Path, version: u32, strings: &Interner, files: &HashMap<String, FileEntry>) {
    let entries: Vec<(&String, &FileEntry)> = files.iter().collect();
    let list: Vec<serde_json::Value> = entries
        .iter()
        .map(|(k, e)| serde_json::json!({"key": k, "size": e.size, "mtimeMs": e.mtime_ms, "malformed": e.malformed, "rowCount": e.rows.len() / STRIDE}))
        .collect();
    let header = serde_json::json!({"version": version, "strings": strings.strings, "files": list});
    let header_bytes = serde_json::to_vec(&header).unwrap_or_default();
    let padding = (8 - ((4 + header_bytes.len()) % 8)) % 8;
    let mut out = Vec::with_capacity(4 + header_bytes.len() + padding + entries.iter().map(|(_, e)| e.rows.len() * 8).sum::<usize>());
    out.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_bytes);
    out.extend(std::iter::repeat(0u8).take(padding));
    for (_, e) in &entries {
        for v in e.rows.iter() {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("bin.tmp");
    if fs::write(&tmp, out).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

pub fn load(path: &Path, version: u32) -> Option<(Interner, HashMap<String, FileEntry>)> {
    let buf = fs::read(path).ok()?;
    if buf.len() < 4 {
        return None;
    }
    let header_len = u32::from_le_bytes(buf[0..4].try_into().ok()?) as usize;
    let header: serde_json::Value = serde_json::from_slice(buf.get(4..4 + header_len)?).ok()?;
    if header["version"].as_u64()? as u32 != version {
        return None;
    }
    let padding = (8 - ((4 + header_len) % 8)) % 8;
    let mut offset = 4 + header_len + padding;
    let strings: Vec<String> = header["strings"].as_array()?.iter().map(|s| s.as_str().unwrap_or("").to_string()).collect();
    let mut files = HashMap::new();
    for f in header["files"].as_array()? {
        let count = f["rowCount"].as_u64()? as usize * STRIDE;
        let bytes = buf.get(offset..offset + count * 8)?;
        let rows: Arc<Vec<f64>> = Arc::new(bytes.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect());
        offset += count * 8;
        files.insert(
            f["key"].as_str()?.to_string(),
            FileEntry { size: f["size"].as_f64()?, mtime_ms: f["mtimeMs"].as_f64()?, malformed: f["malformed"].as_u64()? as u32, rows },
        );
    }
    Some((Interner::from_strings(strings), files))
}
