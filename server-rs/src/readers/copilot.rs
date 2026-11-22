// GitHub Copilot CLI local-log reader (package 09).
//
// Formats verified from the Copilot CLI session-data docs and the public
// CodeBurn adapter (`docs/providers/copilot.md`, `src/providers/copilot.ts`):
//   ~/.copilot/session-state/<id>/events.jsonl
//     - `session.shutdown` carries the authoritative per-model token rollup and
//       `totalNanoAiu` (GitHub's exact credit figure).
//     - `assistant.message` carries per-request output tokens while a session
//       is still live (no rollup yet).
//     - `workspace.yaml` beside the events carries `cwd:` for project attribution.
//   ~/.copilot/session-store.db :: assistant_usage_events
//     - one row per request; `input_tokens` is cache-INCLUSIVE and
//       `total_nano_aiu` is the exact bill. Preferred when present; the two
//       representations are never read together (that would double count).
// Nothing here authenticates, refreshes a token or touches the network.

use super::{db_file, env_path, home, mtime_ms, read_text, walk, FileInfo, Source};
use crate::readers::project::{project_from_cwd, project_from_workspace_yaml};
use crate::types::{parse_rfc3339_ms, str_of, token_count, ReadResult, Record};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const MAX_FILE: u64 = 64 * 1024 * 1024;
const NANO_AIU_PER_CREDIT: f64 = 1_000_000_000.0;
const CREDIT_USD: f64 = 0.01;

/// Copilot homes: `COPILOT_HOME`, then folders configured in Settings (`providers.sources.copilot`),
/// then `~/.copilot`. Nothing is created; a folder reached twice is read once.
fn copilot_homes() -> Vec<PathBuf> {
    copilot_homes_from(env_path("COPILOT_HOME"), &super::sources::configured("copilot"), &home())
}

/// The first home: what the folder display and statusline call "the" Copilot folder.
fn copilot_home() -> PathBuf {
    copilot_homes().into_iter().next().unwrap_or_else(|| home().join(".copilot"))
}

/// The environment, configured and home part of `copilot_homes`, with every input passed in.
fn copilot_homes_from(env: Option<PathBuf>, configured: &[PathBuf], home: &Path) -> Vec<PathBuf> {
    use super::sources::push_unique;
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(env) = env {
        push_unique(&mut out, env);
    }
    for dir in configured.iter().filter(|d| d.is_dir()) {
        push_unique(&mut out, dir.clone());
    }
    push_unique(&mut out, home.join(".copilot"));
    out
}

/// Store databases, in the same order as the homes. `COPILOT_SESSION_STORE_DB` still names one
/// database explicitly and replaces the per-home guesses.
fn store_dbs() -> Vec<PathBuf> {
    match env_path("COPILOT_SESSION_STORE_DB") {
        Some(explicit) => vec![explicit],
        None => copilot_homes().into_iter().map(|home| home.join("session-store.db")).collect(),
    }
}

fn session_state_dirs() -> Vec<PathBuf> {
    copilot_homes().into_iter().map(|home| home.join("session-state")).collect()
}

fn nano_aiu_cost(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n / NANO_AIU_PER_CREDIT * CREDIT_USD)
}

fn event_ts(event: &Value, fallback: f64) -> f64 {
    event
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_rfc3339_ms)
        .unwrap_or(fallback)
}

/// `session.shutdown` rollup: the only token-bearing record for a completed
/// Copilot session. Returns an empty vec when the event has no usable usage.
pub fn parse_shutdown(
    event: &Value,
    session: &str,
    project: Option<&str>,
    fallback_ts: f64,
) -> Vec<Record> {
    let Some(metrics) = event
        .pointer("/data/modelMetrics")
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let ts = event_ts(event, fallback_ts);
    let mut out = Vec::new();
    for (model, metric) in metrics {
        if model.is_empty() {
            continue;
        }
        let Some(usage) = metric.get("usage").filter(|u| u.is_object()) else {
            continue;
        };
        let input = token_count(usage.get("inputTokens"));
        let cached = token_count(usage.get("cacheReadTokens")).min(input);
        let cache_write = token_count(usage.get("cacheWriteTokens")).min(input - cached);
        let output =
            token_count(usage.get("outputTokens")) + token_count(usage.get("reasoningTokens"));
        let reasoning = token_count(usage.get("reasoningTokens"));
        if input == 0.0 && output == 0.0 {
            continue;
        }
        let mut r = Record::new("copilot", ts, model, session);
        r.uncached = input - cached - cache_write;
        r.cached = cached;
        r.cache_write = cache_write;
        r.output = output;
        r.reasoning = reasoning.min(output);
        r.reported = nano_aiu_cost(metric.get("totalNanoAiu"));
        r.key = Some(format!("copilot:{session}:shutdown:{model}"));
        // CONTRACT_ISSUE: integrator sets Record.project from this ProjectHint.
        let _project = project;
        out.push(r);
    }
    out
}

/// Live-session fallback: `assistant.message` events with an explicit output
/// count. Used only when no shutdown rollup exists for the file.
pub fn parse_live_events(
    events: &[Value],
    session: &str,
    project: Option<&str>,
    fallback_ts: f64,
) -> Vec<Record> {
    let mut model = String::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for event in events {
        match str_of(event.get("type")) {
            "session.start" => {
                if model.is_empty() {
                    model = str_of(event.pointer("/data/selectedModel")).to_string();
                }
            }
            "session.model_change" => model = str_of(event.pointer("/data/newModel")).to_string(),
            "assistant.message" => {
                let output = token_count(event.pointer("/data/outputTokens"));
                if output == 0.0 {
                    continue;
                }
                let id = str_of(event.pointer("/data/messageId"));
                let key = format!("copilot:{session}:message:{id}");
                if !seen.insert(key.clone()) {
                    continue;
                }
                let mut r = Record::new("copilot", event_ts(event, fallback_ts), &model, session);
                r.output = output;
                r.key = Some(key);
                // CONTRACT_ISSUE: integrator sets Record.project from this ProjectHint.
                let _project = project;
                out.push(r);
            }
            _ => {}
        }
    }
    out
}

fn read_events(path: &Path, since_ms: f64) -> Result<ReadResult, String> {
    let text = read_text(path, MAX_FILE)?;
    let events: Vec<Value> = text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .collect();
    let session = path
        .parent()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let project = path
        .parent()
        .and_then(|dir| std::fs::read_to_string(dir.join("workspace.yaml")).ok())
        .and_then(|text| project_from_workspace_yaml(&text));
    let fallback = mtime_ms(&std::fs::metadata(path).map_err(|e| e.to_string())?);
    let mut records: Vec<Record> = events
        .iter()
        .filter(|e| str_of(e.get("type")) == "session.shutdown")
        .flat_map(|e| parse_shutdown(e, &session, project.as_deref(), fallback))
        .collect();
    if records.is_empty() {
        records = parse_live_events(&events, &session, project.as_deref(), fallback);
    }
    records.retain(|r| r.ts >= since_ms);
    Ok(ReadResult {
        records,
        malformed: 0,
    })
}

fn cell_text(row: &rusqlite::Row, index: usize) -> String {
    match row.get_ref(index) {
        Ok(rusqlite::types::ValueRef::Text(t)) => String::from_utf8_lossy(t).into_owned(),
        Ok(rusqlite::types::ValueRef::Integer(n)) => n.to_string(),
        Ok(rusqlite::types::ValueRef::Real(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn cell_f64(row: &rusqlite::Row, index: usize) -> f64 {
    match row.get_ref(index) {
        Ok(rusqlite::types::ValueRef::Integer(n)) => n as f64,
        Ok(rusqlite::types::ValueRef::Real(n)) => n,
        Ok(rusqlite::types::ValueRef::Text(t)) => String::from_utf8_lossy(t)
            .trim()
            .parse::<f64>()
            .unwrap_or(0.0),
        _ => 0.0,
    }
}

/// Accept epoch seconds, milliseconds, microseconds, nanoseconds and RFC 3339.
fn store_ts(raw: &str) -> Option<f64> {
    if let Some(ts) = parse_rfc3339_ms(raw) {
        return Some(ts);
    }
    let n: f64 = raw.trim().parse().ok()?;
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    Some(if n > 1e15 {
        n / 1e6
    } else if n > 1e12 {
        n
    } else {
        n * 1000.0
    })
}

/// Columns are kept in a fixed order across the three accepted schemas so one
/// mapper handles stores with and without the newer billing columns.
const STORE_SELECTS: [&str; 3] = [
    "SELECT e.id, e.session_id, e.model, e.input_tokens, e.cache_read_tokens, e.cache_write_tokens, e.reasoning_tokens, e.created_at, e.output_tokens, e.total_nano_aiu, s.cwd, s.repository FROM assistant_usage_events e LEFT JOIN sessions s ON s.id = e.session_id",
    "SELECT e.id, e.session_id, e.model, e.input_tokens, e.cache_read_tokens, e.cache_write_tokens, e.reasoning_tokens, e.created_at, NULL, NULL, s.cwd, s.repository FROM assistant_usage_events e LEFT JOIN sessions s ON s.id = e.session_id",
    "SELECT e.id, e.session_id, e.model, e.input_tokens, e.cache_read_tokens, e.cache_write_tokens, e.reasoning_tokens, e.created_at, NULL, NULL, NULL, NULL FROM assistant_usage_events e",
];

fn read_store(path: &Path, since_ms: f64) -> Result<ReadResult, String> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let _ = db.busy_timeout(std::time::Duration::from_millis(1000));
    let mut stmt = None;
    for sql in STORE_SELECTS {
        if let Ok(prepared) = db.prepare(sql) {
            stmt = Some(prepared);
            break;
        }
    }
    let mut stmt = stmt.ok_or_else(|| "unsupported session-store schema".to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                cell_text(row, 0),
                cell_text(row, 1),
                cell_text(row, 2),
                cell_f64(row, 3),
                cell_f64(row, 4),
                cell_f64(row, 5),
                cell_f64(row, 6),
                cell_text(row, 7),
                cell_f64(row, 8),
                cell_f64(row, 9),
                cell_text(row, 10),
                cell_text(row, 11),
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut seen: HashSet<String> = HashSet::new();
    let mut records = Vec::new();
    for row in rows.flatten() {
        let (
            id,
            session,
            model,
            input,
            cached,
            cache_write,
            reasoning,
            created,
            output,
            nano_aiu,
            cwd,
            repository,
        ) = row;
        let Some(ts) = store_ts(&created) else {
            continue;
        };
        if ts < since_ms {
            continue;
        }
        let key = format!("copilot-store:{id}");
        if !seen.insert(key.clone()) {
            continue;
        }
        let cached = cached.min(input);
        let cache_write = cache_write.min(input - cached);
        // A store row may leave output to its paired assistant.message; those
        // cases are skipped rather than double counted.
        if input == 0.0 && output == 0.0 {
            continue;
        }
        let mut r = Record::new("copilot", ts, &model, &session);
        r.uncached = input - cached - cache_write;
        r.cached = cached;
        r.cache_write = cache_write;
        r.output = output;
        r.reasoning = reasoning.min(output);
        if nano_aiu > 0.0 {
            r.reported = Some(nano_aiu / NANO_AIU_PER_CREDIT * CREDIT_USD);
        }
        r.key = Some(key);
        // CONTRACT_ISSUE: integrator sets Record.project from this ProjectHint.
        let dir = if cwd.is_empty() { repository } else { cwd };
        let _project = project_from_cwd(&dir);
        records.push(r);
    }
    Ok(ReadResult {
        records,
        malformed: 0,
    })
}

pub struct Copilot;

impl Source for Copilot {
    fn provider(&self) -> &'static str {
        "copilot"
    }
    fn dir(&self) -> PathBuf {
        copilot_home()
    }
    fn files(&self) -> Vec<FileInfo> {
        let stores: Vec<PathBuf> = store_dbs().into_iter().filter(|path| path.is_file()).collect();
        // Store rows are authoritative and cover every request, so prefer them
        // over the session rollups entirely when the database is present.
        if !stores.is_empty() {
            return stores.into_iter().map(|db| db_file(&db)).collect();
        }
        let mut out = Vec::new();
        for dir in session_state_dirs() {
            walk(&dir, &|name| name == "events.jsonl", &mut out);
        }
        out
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        if path.extension().and_then(|e| e.to_str()) == Some("db") {
            read_store(path, since_ms)
        } else {
            read_events(path, since_ms)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "burnrate-copilot-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn env_then_configured_then_home_and_a_repeat_is_read_once() {
        let root = temp_dir();
        let home = root.join("home");
        let custom = root.join("elsewhere").join(".copilot");
        fs::create_dir_all(&custom).unwrap();
        let default = home.join(".copilot");
        // Default behaviour: the classic `~/.copilot` only.
        assert_eq!(copilot_homes_from(None, &[], &home), vec![default.clone()]);
        // The environment first, a configured folder second, `~/.copilot` last; a repeat read once.
        let env = root.join("env-copilot");
        assert_eq!(
            copilot_homes_from(Some(env.clone()), &[root.join("missing"), custom.clone()], &home),
            vec![env, custom, default.clone()]
        );
        assert_eq!(copilot_homes_from(None, &[default.clone()], &home), vec![default]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn shutdown_rollup_is_cache_inclusive() {
        let event = serde_json::json!({
            "type": "session.shutdown",
            "timestamp": "2026-11-20T10:00:00Z",
            "data": {"modelMetrics": {"gpt-5-mini": {
                "usage": {"inputTokens": 1000, "outputTokens": 200, "cacheReadTokens": 600, "cacheWriteTokens": 100, "reasoningTokens": 20},
                "totalNanoAiu": 5_000_000_000.0
            }}}
        });
        let records = parse_shutdown(&event, "s1", Some("proj"), 0.0);
        assert_eq!(records.len(), 1);
        let r = &records[0];
        assert_eq!(r.uncached, 300.0);
        assert_eq!(r.cached, 600.0);
        assert_eq!(r.cache_write, 100.0);
        assert_eq!(r.output, 220.0);
        assert_eq!(r.reported, Some(0.05));
    }

    #[test]
    fn live_events_fall_back_to_output_only() {
        let events: Vec<Value> = [
            serde_json::json!({"type":"session.start","data":{"selectedModel":"gpt-5"}}),
            serde_json::json!({"type":"assistant.message","timestamp":"2026-11-20T10:00:00Z","data":{"messageId":"m1","outputTokens":42}}),
        ].to_vec();
        let records = parse_live_events(&events, "s2", None, 0.0);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].output, 42.0);
        assert_eq!(records[0].model, "gpt-5");
    }

    #[test]
    fn reads_session_store_fixture() {
        let dir = temp_dir();
        let db = dir.join("session-store.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT); CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, created_at TEXT, output_tokens INTEGER, total_nano_aiu REAL);").unwrap();
        conn.execute(
            "INSERT INTO sessions VALUES ('s','/home/me/dev/app',NULL)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO assistant_usage_events VALUES (1,'s','gpt-5',500,100,50,10,'2026-11-20T10:00:00Z',80,2000000000.0)", []).unwrap();
        drop(conn);
        let result = read_store(&db, 0.0).unwrap();
        assert_eq!(result.records.len(), 1);
        let r = &result.records[0];
        assert_eq!(r.uncached, 350.0);
        assert_eq!(r.cached, 100.0);
        assert_eq!(r.output, 80.0);
        assert_eq!(r.reported, Some(0.02));
        fs::remove_dir_all(&dir).unwrap();
    }
}
