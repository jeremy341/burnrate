// Antigravity conversation reader. Format knowledge and the model table derive from T3 Code's
// Antigravity usage reader (MIT, see NOTICE), simplified to one pass per database.
use super::{env_path, home, mtime_ms, walk, FileInfo, Source};
use crate::types::{ReadResult, Record};
use rusqlite::{Connection, OpenFlags};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Clone)]
enum Val {
    Num(f64),
    Bytes(Vec<u8>),
}

type Fields = HashMap<u64, Vec<Val>>;

/// Minimal protobuf reader: field number to its raw values.
fn fields(bytes: &[u8]) -> Result<Fields, String> {
    let mut offset = 0usize;
    let mut out: Fields = HashMap::new();
    let varint = |offset: &mut usize| -> Result<u64, String> {
        let mut value: u64 = 0;
        for shift in (0..70).step_by(7) {
            let byte = *bytes.get(*offset).ok_or("truncated")?;
            *offset += 1;
            if shift == 63 && byte > 1 {
                return Err("varint overflow".into());
            }
            if shift < 64 {
                value |= ((byte & 127) as u64) << shift;
            }
            if byte < 128 {
                return Ok(value);
            }
        }
        Err("invalid varint".into())
    };
    while offset < bytes.len() {
        let tag = varint(&mut offset)?;
        let number = tag / 8;
        let wire = tag % 8;
        if number == 0 {
            return Err("invalid field".into());
        }
        let value = match wire {
            0 => Val::Num(varint(&mut offset)? as f64),
            2 => {
                let len = varint(&mut offset)? as usize;
                let end = offset.checked_add(len).filter(|e| *e <= bytes.len()).ok_or("truncated field")?;
                let v = Val::Bytes(bytes[offset..end].to_vec());
                offset = end;
                v
            }
            1 | 5 => {
                let len = if wire == 1 { 8 } else { 4 };
                if len > bytes.len() - offset {
                    return Err("truncated field".into());
                }
                offset += len;
                continue;
            }
            _ => return Err("unsupported wire type".into()),
        };
        out.entry(number).or_default().push(value);
    }
    Ok(out)
}

fn num_at(v: &Fields, key: u64) -> f64 {
    match v.get(&key).and_then(|e| e.first()) {
        Some(Val::Num(n)) => *n,
        _ => 0.0,
    }
}
fn bytes_at<'a>(v: &'a Fields, key: u64) -> Option<&'a [u8]> {
    match v.get(&key).and_then(|e| e.first()) {
        Some(Val::Bytes(b)) => Some(b),
        _ => None,
    }
}
fn nested(v: &Fields, key: u64) -> Result<Fields, String> {
    match bytes_at(v, key) {
        Some(b) => fields(b),
        None => Ok(HashMap::new()),
    }
}
fn text_at(v: &Fields, key: u64) -> Result<String, String> {
    match bytes_at(v, key) {
        Some(b) => Ok(std::str::from_utf8(b).map_err(|e| e.to_string())?.trim().to_string()),
        None => Ok(String::new()),
    }
}
fn timestamp(v: &Fields) -> Option<f64> {
    let seconds = num_at(v, 1);
    (seconds > 0.0).then(|| seconds * 1000.0 + (num_at(v, 2) / 1_000_000.0).floor())
}

// Offline fallback for records without names. New names are learned from the scanned metadata.
const MODEL_IDS: &[(u32, &str)] = &[
    (246, "gemini-2.5-pro"), (312, "gemini-2.5-flash"), (313, "gemini-2.5-flash-thinking"), (329, "gemini-2.5-flash-thinking"),
    (330, "gemini-2.5-flash-lite"), (281, "claude-sonnet-4"), (282, "claude-sonnet-4"), (290, "claude-opus-4"), (291, "claude-opus-4"),
    (333, "claude-sonnet-4-5"), (334, "claude-sonnet-4-5"), (340, "claude-haiku-4-5"), (341, "claude-haiku-4-5"),
    (342, "gpt-oss-120b-medium"), (1026, "claude-opus-4-6"), (1035, "claude-sonnet-4-6"), (1016, "gemini-3.1-pro"),
    (1036, "gemini-3.1-pro"), (1037, "gemini-3.1-pro"), (1018, "gemini-3-flash-preview"), (1084, "gemini-3-flash-preview"),
    (1047, "gemini-3-flash-preview"), (1020, "gemini-3.5-flash-medium"), (1021, "gemini-3.1-flash-image"),
    (1050, "gemini-3.1-flash-lite"), (1071, "gemini-3.6-flash-high"), (1072, "gemini-3.6-flash-medium"),
    (1073, "gemini-3.6-flash-low"), (1132, "gemini-3.5-flash-high"), (1133, "gemini-3.5-flash-high"),
    (1187, "gemini-3.5-flash-extra-low"), (1196, "gemini-3.6-flash"), (1266, "gemini-3.6-flash"),
    (1298, "gemini-3.7-flash-high"), (1299, "gemini-3.7-flash-medium"), (1300, "gemini-3.7-flash-low"),
    (1301, "gemini-3.7-flash-tiered"), (1318, "gemini-3.8-flash-high"), (1319, "gemini-3.8-flash-medium"),
    (1320, "gemini-3.8-flash-low"), (1322, "gemini-3.8-flash-tiered"), (1402, "claude-opus-5-5"),
    (1417, "gemini-4-argon"), (1418, "gemini-4-argon"), (1419, "gemini-4-argon"),
];

/// Effort and routing variants share the base model's price.
pub fn rate_model(model: &str) -> String {
    let base = ["-extra-low", "-low", "-medium", "-high", "-tiered", "-control", "-thinking", "-agent"]
        .iter()
        .find_map(|s| model.strip_suffix(s))
        .unwrap_or(model);
    let agent_variant = model.strip_prefix("gemini-3-flash-").is_some_and(|rest| {
        matches!(rest, "agent" | "agent-a" | "agent-b" | "a" | "b")
    });
    if agent_variant {
        "gemini-3.5-flash".into()
    } else if model == "gemini-3.7-flash-safety-le" {
        "gemini-3.7-flash".into()
    } else if base == "gemini-3-flash" {
        "gemini-3-flash-preview".into()
    } else {
        base.to_string()
    }
}

fn model_name(name: &str) -> String {
    if name.is_empty() {
        return String::new();
    }
    let mut n = name.to_lowercase();
    // "model (high)" becomes "model-high".
    if n.ends_with(')') {
        if let Some(open) = n.rfind('(') {
            let inner = n[open + 1..n.len() - 1].to_string();
            n = format!("{}-{}", n[..open].trim_end(), inner);
        }
    }
    let n: String = n.split_whitespace().collect::<Vec<_>>().join("-");
    if let Some(rest) = n.strip_prefix("claude-") {
        // "claude-4.5-sonnet" becomes "claude-sonnet-4.5".
        let mut parts = rest.splitn(2, '-');
        let ver = parts.next().unwrap_or("");
        let tail = parts.next().unwrap_or("");
        let fam = ["sonnet", "opus", "haiku"].into_iter().find(|f| tail.starts_with(f));
        let numeric = !ver.is_empty() && ver.chars().all(|c| c.is_ascii_digit() || c == '.');
        let out = match (numeric, fam) {
            (true, Some(f)) => format!("claude-{f}-{ver}{}", &tail[f.len()..]),
            _ => n.clone(),
        };
        return out.replace('.', "-");
    }
    n
}

fn is_concrete(model: &str) -> bool {
    let starts_digit = |p: &str| model.strip_prefix(p).is_some_and(|r| r.chars().next().is_some_and(|c| c.is_ascii_digit()));
    let family = starts_digit("gemini-")
        || ["claude-sonnet-", "claude-opus-", "claude-haiku-"].iter().any(|p| starts_digit(p))
        || model.starts_with("gpt-");
    let agent = model.strip_prefix("gemini-3-flash-").is_some_and(|r| matches!(r, "agent" | "agent-a" | "agent-b" | "a" | "b"));
    family && !agent
}

struct Metadata {
    model: String,
    model_id: f64,
    timestamp_ms: Option<f64>,
    usages: Vec<Fields>,
}

fn metadata(bytes: &[u8], step: bool) -> Result<Metadata, String> {
    let root = fields(bytes)?;
    if !step && bytes_at(&root, 1).is_none() {
        return Err("missing generation metadata".into());
    }
    let data = if step { root } else { nested(&root, 1)? };
    let model_fields = if step { nested(&data, 24)? } else { data.clone() };
    let usage = bytes_at(&data, if step { 9 } else { 4 });
    let primary = usage.map(fields).transpose()?;
    let mut usages: Vec<Fields> = primary.iter().cloned().collect();
    for retry in data.get(&(if step { 28 } else { 17 })).map(|v| v.as_slice()).unwrap_or(&[]) {
        let Val::Bytes(b) = retry else { return Err("invalid retry metadata".into()) };
        if let Some(u) = bytes_at(&fields(b)?, 2) {
            usages.push(fields(u)?);
        }
    }
    let names = [text_at(&model_fields, if step { 12 } else { 19 })?, text_at(&model_fields, if step { 8 } else { 21 })?]
        .map(|n| model_name(&n));
    let model = names
        .iter()
        .find(|n| is_concrete(n))
        .or_else(|| names.iter().find(|n| !n.is_empty() && !n.starts_with("model_") && !n.starts_with("model-")))
        .cloned()
        .unwrap_or_default();
    let model_id = match num_at(&model_fields, if step { 1 } else { 3 }) {
        id if id != 0.0 => id,
        _ => primary.as_ref().map_or(0.0, |p| num_at(p, 1)),
    };
    let timestamp_ms = if step {
        timestamp(&nested(&data, 8)?).or(timestamp(&nested(&data, 1)?))
    } else {
        timestamp(&nested(&nested(&data, 9)?, 4)?)
    };
    Ok(Metadata { model, model_id, timestamp_ms, usages })
}

fn read_database(path: &Path, session: &str, fallback_ts: f64, since_ms: f64) -> Result<ReadResult, String> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    let _ = db.busy_timeout(std::time::Duration::from_millis(1000));
    let tables: HashSet<String> = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .and_then(|mut s| s.query_map([], |r| r.get::<_, String>(0))?.collect())
        .map_err(|e| e.to_string())?;
    if !tables.contains("gen_metadata") && !tables.contains("steps") {
        return Ok(ReadResult { records: Vec::new(), malformed: 1 });
    }
    let load = |sql: &str, step: bool| -> Result<Vec<(i64, Metadata)>, String> {
        let mut out = Vec::new();
        let mut stmt = db.prepare(sql).map_err(|e| e.to_string())?;
        // One row at a time: generation rows can hold megabytes of context.
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let Ok(idx) = row.get::<_, i64>(0) else { continue };
            let Ok(Some(data)) = row.get::<_, Option<Vec<u8>>>(1) else { continue };
            out.push((idx, metadata(&data, step)?));
        }
        out.sort_by_key(|(i, _)| *i);
        Ok(out)
    };
    let generations = if tables.contains("gen_metadata") { load("SELECT idx, data FROM gen_metadata ORDER BY rowid", false)? } else { Vec::new() };
    let steps = if tables.contains("steps") { load("SELECT idx, metadata AS data FROM steps ORDER BY rowid", true)? } else { Vec::new() };
    let mut trajectory_ts: Option<f64> = None;
    if tables.contains("trajectory_metadata_blob") {
        let mut stmt = db.prepare("SELECT data FROM trajectory_metadata_blob").map_err(|e| e.to_string())?;
        let blobs: Vec<Vec<u8>> = stmt.query_map([], |r| r.get::<_, Vec<u8>>(0)).map_err(|e| e.to_string())?.flatten().collect();
        for b in blobs {
            if trajectory_ts.is_none() {
                trajectory_ts = timestamp(&nested(&fields(&b)?, 2)?);
            }
        }
    }
    // Model names learned from the metadata itself; an id that maps to two names is ambiguous.
    let mut learned: HashMap<u64, Option<String>> = HashMap::new();
    for (_, entry) in generations.iter().chain(steps.iter()) {
        if entry.model_id > 0.0 && is_concrete(&entry.model) {
            let id = entry.model_id as u64;
            match learned.get(&id) {
                None => {
                    learned.insert(id, Some(entry.model.clone()));
                }
                Some(Some(prev)) if *prev == entry.model => {}
                Some(_) => {
                    learned.insert(id, None);
                }
            }
        }
    }
    let generation_by_idx: HashMap<i64, &Metadata> = generations.iter().map(|(i, m)| (*i, m)).collect();
    let mut records = Vec::new();
    for (source, entries) in [("step", &steps), ("generation", &generations)] {
        for (index, (idx, entry)) in entries.iter().enumerate() {
            for (usage_index, usage) in entry.usages.iter().enumerate() {
                let model_id = match num_at(usage, 1) {
                    id if id != 0.0 => id,
                    _ => entry.model_id,
                };
                let generation = if source == "step" { generation_by_idx.get(idx).copied() } else { None };
                let matches = |m: &Metadata| model_id == 0.0 || m.model_id == model_id;
                let mut model = if matches(entry) && !entry.model.is_empty() {
                    entry.model.clone()
                } else if let Some(g) = generation.filter(|g| matches(g)) {
                    g.model.clone()
                } else {
                    String::new()
                };
                if !is_concrete(&model) {
                    let known = learned.get(&(model_id as u64)).cloned().flatten();
                    if model.is_empty() {
                        model = known
                            .clone()
                            .or_else(|| MODEL_IDS.iter().find(|(id, _)| *id as f64 == model_id).map(|(_, m)| m.to_string()))
                            .unwrap_or_else(|| if model_id > 0.0 { format!("antigravity-model-{model_id}") } else { "antigravity-unknown".into() });
                    }
                    if known.as_deref().is_some_and(is_concrete) {
                        model = known.unwrap();
                    }
                }
                let output = f64::max(num_at(usage, 3), num_at(usage, 9) + num_at(usage, 10));
                let mut r = Record::new("antigravity", entry.timestamp_ms.or(trajectory_ts).unwrap_or(fallback_ts), &model, session);
                r.uncached = num_at(usage, 2);
                r.cached = num_at(usage, 5);
                r.cache_write = num_at(usage, 4);
                r.output = output;
                r.reasoning = num_at(usage, 9).min(output);
                if r.total_tokens() == 0.0 || r.ts < since_ms {
                    continue;
                }
                let keys: Vec<String> = [11u64, 12, 7]
                    .iter()
                    .filter_map(|k| text_at(usage, *k).ok().filter(|t| !t.is_empty()).map(|t| format!("antigravity:{k}:{t}")))
                    .collect();
                let rm = rate_model(&model);
                if rm != model {
                    r.rate_model = Some(rm);
                }
                r.key = Some(keys.into_iter().next().unwrap_or_else(|| format!("antigravity:{session}:{source}:{index}:{usage_index}")));
                records.push(r);
            }
        }
    }
    Ok(ReadResult { records, malformed: 0 })
}

fn data_roots() -> Vec<PathBuf> {
    let configured: Vec<PathBuf> = std::env::var("ANTIGRAVITY_DATA_DIR")
        .ok()
        .map(|v| v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from).collect())
        .unwrap_or_default();
    if !configured.is_empty() {
        return configured;
    }
    let h = home();
    let mut roots: Vec<PathBuf> = ["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].iter().map(|n| h.join(".gemini").join(n)).collect();
    roots.push(h.join(".config").join("antigravity"));
    roots
}

pub struct Antigravity;

impl Source for Antigravity {
    fn provider(&self) -> &'static str {
        "antigravity"
    }
    fn dir(&self) -> PathBuf {
        data_roots().into_iter().next().or_else(|| env_path("HOME")).unwrap_or_default()
    }
    fn files(&self) -> Vec<FileInfo> {
        let mut found: Vec<FileInfo> = Vec::new();
        for root in data_roots() {
            walk(&root, &|n| n.ends_with(".db"), &mut found);
        }
        let mut seen = HashSet::new();
        found.retain(|f| f.path.to_string_lossy().contains("conversations") && seen.insert(f.path.clone()));
        // The WAL holds new rows, so it counts toward the change fingerprint.
        for f in &mut found {
            if let Ok(meta) = std::fs::metadata(format!("{}-wal", f.path.display())) {
                f.size += meta.len() as f64;
                f.mtime_ms = f64::max(f.mtime_ms, mtime_ms(&meta));
            }
        }
        found
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let mtime = std::fs::metadata(path).map(|m| mtime_ms(&m)).unwrap_or(0.0);
        read_database(path, id, mtime, since_ms)
    }
}
