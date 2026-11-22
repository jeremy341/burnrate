// OpenCode reader over its SQLite database (OpenCode 1 `message`, OpenCode 2 `session_message`).
// Derived from T3 Code's OpenCode usage reader (MIT, see NOTICE).
use super::{config_dirs, env_path, home, mtime_ms, FileInfo, Source};
use crate::types::{str_of, token_count, ReadResult, Record};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const GATEWAYS: [&str; 2] = ["opencode", "opencode-go"];

/// OpenCode stores its database under an XDG data dir on Linux and under
/// `~/.local/share` on Windows; `config_dirs` also adds mounted WSL profiles.
/// OpenCode's data directory. Several candidate folders can exist (`~/.opencode` holds the installed binary,
/// `~/.config/opencode` the settings, `~/.local/share/opencode` the database and logins), so prefer the one
/// that actually contains OpenCode data, not merely the first that exists. Folders configured in Settings
/// (`providers.sources.opencode`) are read in addition to the discovered one, in the order listed.
pub fn data_root() -> PathBuf {
    data_roots().into_iter().next().unwrap_or_else(default_root)
}

/// Every folder OpenCode data is read from: configured folders first, then the discovered one.
pub fn data_roots() -> Vec<PathBuf> {
    data_roots_from(&super::sources::configured("opencode"), &config_dirs("opencode"))
}

fn default_root() -> PathBuf {
    env_path("XDG_DATA_HOME")
        .unwrap_or_else(|| home().join(".local").join("share"))
        .join("opencode")
}

/// The configured and discovered part of `data_roots`, with every input passed in.
fn data_roots_from(configured: &[PathBuf], candidates: &[PathBuf]) -> Vec<PathBuf> {
    use super::sources::push_unique;
    let has_data =
        |dir: &PathBuf| dir.join("opencode.db").exists() || dir.join("auth.json").exists() || dir.join("storage").exists();
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in configured.iter().filter(|d| d.is_dir()) {
        push_unique(&mut out, dir.clone());
    }
    if let Some(found) = candidates.iter().find(|dir| has_data(dir)).or_else(|| candidates.iter().find(|dir| dir.exists())) {
        push_unique(&mut out, found.clone());
    }
    out
}

pub fn parse_message(
    source: &str,
    id: &str,
    session: &str,
    created: Option<f64>,
) -> Option<Record> {
    let message: Value = serde_json::from_str(source).ok()?;
    if let Some(role) = message.get("role").filter(|r| !r.is_null()) {
        if role.as_str() != Some("assistant") {
            return None;
        }
    }
    let usage = message.get("tokens").cloned().unwrap_or(Value::Null);
    let cache = usage.get("cache").cloned().unwrap_or(Value::Null);
    let model_ref = message.get("model").cloned().unwrap_or(Value::Null);
    let model = [
        str_of(model_ref.get("id")),
        str_of(model_ref.get("modelID")),
        str_of(message.get("modelID")),
    ]
    .into_iter()
    .find(|m| !m.is_empty())
    .unwrap_or("");
    let provider_id = [
        str_of(model_ref.get("providerID")),
        str_of(message.get("providerID")),
    ]
    .into_iter()
    .find(|p| !p.is_empty())
    .unwrap_or("");
    let ts = message
        .pointer("/time/created")
        .and_then(Value::as_f64)
        .or(created)?;
    if model.is_empty() || !ts.is_finite() {
        return None;
    }
    let reasoning = token_count(usage.get("reasoning"));
    let mut r = Record::new(
        "opencode",
        ts,
        model,
        if session.is_empty() {
            str_of(message.get("sessionID"))
        } else {
            session
        },
    );
    r.uncached = token_count(usage.get("input"));
    r.cached = token_count(cache.get("read"));
    r.cache_write = token_count(cache.get("write"));
    r.output = token_count(usage.get("output")) + reasoning;
    r.reasoning = reasoning;
    if r.total_tokens() == 0.0 {
        return None;
    }
    let message_id = if id.is_empty() {
        str_of(message.get("id"))
    } else {
        id
    };
    if provider_id == "opencode-go" && !model.contains('/') {
        r.rate_model = Some(format!("opencode_go/{model}"));
    }
    let free = GATEWAYS.contains(&provider_id) && model.ends_with("-free");
    // OpenCode records zero for unknown rates and paid subscriptions alike.
    r.reported = message
        .get("cost")
        .and_then(Value::as_f64)
        .filter(|c| c.is_finite() && (*c > 0.0 || (free && *c == 0.0)));
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
        for root in data_roots() {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let is_db = name.starts_with("opencode")
                    && name.ends_with(".db")
                    && name[8..name.len() - 3]
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
                if !is_db {
                    continue;
                }
                let path = entry.path();
                // A folder reached twice is read once.
                if out.iter().any(|f: &FileInfo| super::sources::same_path(&f.path, &path)) {
                    continue;
                }
                let (mut size, mut mtime) = (0.0, 0.0);
                // The WAL moves on every commit while the main file can stay put.
                for p in [
                    path.clone(),
                    PathBuf::from(format!("{}-wal", path.display())),
                ] {
                    if let Ok(meta) = std::fs::metadata(&p) {
                        size += meta.len() as f64;
                        mtime = f64::max(mtime, mtime_ms(&meta));
                    }
                }
                out.push(FileInfo {
                    path,
                    size,
                    mtime_ms: mtime,
                });
            }
        }
        out
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
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
            let prefix = format!(
                "SELECT id, session_id, {} AS created, json_object('tokens', data -> '$.tokens', 'cost', data -> '$.cost', 'model', data -> '$.model', \
                 'modelID', data -> '$.modelID', 'providerID', data -> '$.providerID', 'time', data -> '$.time', 'id', data -> '$.id', 'sessionID', data -> '$.sessionID') AS data \
                 FROM {table} WHERE ",
                if has_time { "time_created" } else { "NULL" },
            );
            let plain_sql = format!("{prefix}{}", filters.join(" AND "));
            // OpenCode 1's `message` table stores the timestamp inside the JSON (`$.time.created`,
            // epoch ms) and has no `time_created` column. Filter it in SQL so old messages are never
            // parsed. A missing or unexpected time stays in the set for the Rust cutoff to decide.
            let json_time = "(json_extract(data, '$.time.created') >= ?1 OR json_extract(data, '$.time.created') IS NULL)";
            let filtered_sql = format!("{plain_sql} AND {json_time}");
            // If JSON functions are unavailable or the schema differs, fall back to the unfiltered
            // query instead of failing the whole read; the Rust check below is authoritative.
            let (mut stmt, has_time_param) = if has_time {
                (
                    db.prepare(&plain_sql).map_err(|e| e.to_string())?,
                    true,
                )
            } else {
                match db.prepare(&filtered_sql) {
                    Ok(s) => (s, true),
                    Err(_) => (db.prepare(&plain_sql).map_err(|e| e.to_string())?, false),
                }
            };
            let map_row =
                |r: &rusqlite::Row| -> rusqlite::Result<(String, String, Option<f64>, String)> {
                    let text = |i: usize| -> String {
                        match r.get_ref(i) {
                            Ok(rusqlite::types::ValueRef::Text(t)) => {
                                String::from_utf8_lossy(t).into_owned()
                            }
                            Ok(rusqlite::types::ValueRef::Integer(n)) => n.to_string(),
                            _ => String::new(),
                        }
                    };
                    Ok((
                        text(0),
                        text(1),
                        r.get::<_, Option<f64>>(2).unwrap_or(None),
                        text(3),
                    ))
                };
            let rows = if has_time_param {
                stmt.query_map([since_ms], map_row)
            } else {
                stmt.query_map([], map_row)
            }
            .map_err(|e| e.to_string())?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn configured_folders_are_read_in_addition_to_the_discovered_one() {
        let root = std::env::temp_dir().join(format!("burnrate-opencode-roots-{}", std::process::id()));
        fs::create_dir_all(root.join("extra")).unwrap();
        let with_data = root.join("with-data");
        let empty = root.join("empty");
        fs::create_dir_all(&with_data).unwrap();
        fs::create_dir_all(&empty).unwrap();
        fs::write(with_data.join("opencode.db"), "x").unwrap();
        let candidates = [empty.clone(), with_data.clone()];
        // Nothing configured: the candidate that holds data wins, not the first that exists.
        assert_eq!(data_roots_from(&[], &candidates), vec![with_data.clone()]);
        // A configured folder is read first, the discovered one in addition; a repeat is read once.
        assert_eq!(
            data_roots_from(&[root.join("missing"), root.join("extra")], &candidates),
            vec![root.join("extra"), with_data.clone()]
        );
        assert_eq!(data_roots_from(&[with_data.clone()], &candidates), vec![with_data.clone()]);
        assert_eq!(data_roots_from(&[], &[root.join("nothing")]), Vec::<PathBuf>::new());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn message_table_sql_cutoff_keeps_the_same_records() {
        let root = std::env::temp_dir().join(format!("burnrate-opencode-msg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let db = root.join("opencode.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);")
            .unwrap();
        let since = crate::types::parse_rfc3339_ms("2026-11-20T10:00:00Z").unwrap();
        let insert = |id: &str, ms: f64| {
            let data = serde_json::json!({
                "role": "assistant",
                "model": {"id": "gpt-5"},
                "time": {"created": ms},
                "tokens": {"input": 100, "output": 50},
            })
            .to_string();
            conn.execute(
                "INSERT INTO message VALUES (?1, ?2, ?3)",
                rusqlite::params![id, "s1", data],
            )
            .unwrap();
        };
        insert("old", since - 1000.0);
        insert("new", since + 1000.0);
        drop(conn);

        let result = OpenCode.read(&db, since).unwrap();
        assert_eq!(result.records.len(), 1);
        assert_eq!(result.records[0].session, "s1");
        assert_eq!(result.records[0].model, "gpt-5");
        assert_eq!(result.records[0].key.as_deref(), Some("opencode:new"));
        fs::remove_dir_all(&root).unwrap();
    }
}
