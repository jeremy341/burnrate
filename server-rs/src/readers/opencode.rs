// OpenCode reader over its SQLite database (OpenCode 1 `message`, OpenCode 2 `session_message`).
// Derived from T3 Code's OpenCode usage reader (MIT, see NOTICE).
use super::{env_path, home, mtime_ms, FileInfo, Source};
use crate::types::{str_of, token_count, ReadResult, Record};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const GATEWAYS: [&str; 2] = ["opencode", "opencode-go"];

pub fn data_root() -> PathBuf {
    env_path("XDG_DATA_HOME").unwrap_or_else(|| home().join(".local").join("share")).join("opencode")
}

pub fn parse_message(source: &str, id: &str, session: &str, created: Option<f64>) -> Option<Record> {
    let message: Value = serde_json::from_str(source).ok()?;
    if let Some(role) = message.get("role").filter(|r| !r.is_null()) {
        if role.as_str() != Some("assistant") {
            return None;
        }
    }
    let usage = message.get("tokens").cloned().unwrap_or(Value::Null);
    let cache = usage.get("cache").cloned().unwrap_or(Value::Null);
    let model_ref = message.get("model").cloned().unwrap_or(Value::Null);
    let model = [str_of(model_ref.get("id")), str_of(model_ref.get("modelID")), str_of(message.get("modelID"))]
        .into_iter()
        .find(|m| !m.is_empty())
        .unwrap_or("");
    let provider_id = [str_of(model_ref.get("providerID")), str_of(message.get("providerID"))].into_iter().find(|p| !p.is_empty()).unwrap_or("");
    let ts = message.pointer("/time/created").and_then(Value::as_f64).or(created)?;
    if model.is_empty() || !ts.is_finite() {
        return None;
    }
    let reasoning = token_count(usage.get("reasoning"));
    let mut r = Record::new("opencode", ts, model, if session.is_empty() { str_of(message.get("sessionID")) } else { session });
    r.uncached = token_count(usage.get("input"));
    r.cached = token_count(cache.get("read"));
    r.cache_write = token_count(cache.get("write"));
    r.output = token_count(usage.get("output")) + reasoning;
    r.reasoning = reasoning;
    if r.total_tokens() == 0.0 {
        return None;
    }
    let message_id = if id.is_empty() { str_of(message.get("id")) } else { id };
    if provider_id == "opencode-go" && !model.contains('/') {
        r.rate_model = Some(format!("opencode_go/{model}"));
    }
    let free = GATEWAYS.contains(&provider_id) && model.ends_with("-free");
    // OpenCode records zero for unknown rates and paid subscriptions alike.
    r.reported = message.get("cost").and_then(Value::as_f64).filter(|c| c.is_finite() && (*c > 0.0 || (free && *c == 0.0)));
    r.key = (!message_id.is_empty()).then(|| format!("opencode:{message_id}"));
    Some(r)
}

pub struct OpenCode;

impl Source for OpenCode {
    fn provider(&self) -> &'static str {
        "opencode"
    }
    fn dir(&self) -> PathBuf {
        data_root()
    }
    fn files(&self) -> Vec<FileInfo> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(data_root()) else { return out };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_db = name.starts_with("opencode") && name.ends_with(".db") && name[8..name.len() - 3].chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
            if !is_db {
                continue;
            }
            let path = entry.path();
            let (mut size, mut mtime) = (0.0, 0.0);
            // The WAL moves on every commit while the main file can stay put.
            for p in [path.clone(), PathBuf::from(format!("{}-wal", path.display()))] {
                if let Ok(meta) = std::fs::metadata(&p) {
                    size += meta.len() as f64;
                    mtime = f64::max(mtime, mtime_ms(&meta));
                }
            }
            out.push(FileInfo { path, size, mtime_ms: mtime });
        }
        out
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
        let _ = db.busy_timeout(std::time::Duration::from_millis(1000));
        let tables: HashSet<String> = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .and_then(|mut s| s.query_map([], |r| r.get::<_, String>(0))?.collect())
            .map_err(|e| e.to_string())?;
        let mut records = Vec::new();
        let mut malformed = 0;
        for table in ["message", "session_message"] {
            if !tables.contains(table) {
                continue;
            }
            let cols: HashSet<String> = db
                .prepare(&format!("PRAGMA table_info({table})"))
                .and_then(|mut s| s.query_map([], |r| r.get::<_, String>(1))?.collect())
                .map_err(|e| e.to_string())?;
            let has_time = cols.contains("time_created");
            let mut filters: Vec<&str> = Vec::new();
            if table == "session_message" {
                filters.push("type IN ('assistant', 'compaction')");
            }
            if has_time {
                filters.push("time_created >= ?1");
            }
            filters.push("typeof(data) = 'text' AND json_valid(data)");
            // Project only the needed fields in SQLite: message bodies can be very large.
            let sql = format!(
                "SELECT id, session_id, {} AS created, json_object('tokens', data -> '$.tokens', 'cost', data -> '$.cost', 'model', data -> '$.model', \
                 'modelID', data -> '$.modelID', 'providerID', data -> '$.providerID', 'time', data -> '$.time', 'id', data -> '$.id', 'sessionID', data -> '$.sessionID') AS data \
                 FROM {table} WHERE {}",
                if has_time { "time_created" } else { "NULL" },
                filters.join(" AND ")
            );
            let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
            let map_row = |r: &rusqlite::Row| -> rusqlite::Result<(String, String, Option<f64>, String)> {
                let text = |i: usize| -> String {
                    match r.get_ref(i) {
                        Ok(rusqlite::types::ValueRef::Text(t)) => String::from_utf8_lossy(t).into_owned(),
                        Ok(rusqlite::types::ValueRef::Integer(n)) => n.to_string(),
                        _ => String::new(),
                    }
                };
                Ok((text(0), text(1), r.get::<_, Option<f64>>(2).unwrap_or(None), text(3)))
            };
            let rows = if has_time { stmt.query_map([since_ms], map_row) } else { stmt.query_map([], map_row) }.map_err(|e| e.to_string())?;
            for row in rows.flatten() {
                let (id, session, created, data) = row;
                match parse_message(&data, &id, &session, created) {
                    Some(rec) if rec.ts >= since_ms => records.push(rec),
                    None if data.is_empty() => malformed += 1,
                    _ => {}
                }
            }
        }
        Ok(ReadResult { records, malformed })
    }
}
