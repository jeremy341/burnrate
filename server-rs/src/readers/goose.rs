// Goose CLI local-log reader (package 09).
//
// Verified from the public CodeBurn adapter (`docs/providers/goose.md`,
// `src/providers/goose.ts`) and Goose's session manager:
//   Linux/macOS: $XDG_DATA_HOME/goose/sessions/sessions.db or ~/.local/share/...
//   Windows:     %APPDATA%/Block/goose/sessions/sessions.db
//   sessions(id, working_dir, created_at, updated_at,
//            accumulated_input_tokens, accumulated_output_tokens,
//            provider_name, model_config_json)
// Tokens are read directly from the accumulated columns -- no estimation.
// `updated_at` uses SQLite datetime('now'), i.e. UTC text with no timezone.
// Read-only.

use super::{db_file, env_path, home, FileInfo, Source};
use crate::readers::project::project_from_cwd;
use crate::types::{parse_rfc3339_ms, ReadResult, Record};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Session database locations in precedence order: `GOOSE_PATH_ROOT`, then folders configured in
/// Settings (`providers.sources.goose`), then the platform default. Only paths that point at an
/// existing file are returned by `files()`; nothing is created and a database reached twice is
/// read once.
pub fn db_paths() -> Vec<PathBuf> {
    let home = home();
    db_paths_from(env_path("GOOSE_PATH_ROOT"), &super::sources::configured("goose"), &default_data_dir(&home))
}

/// The goose data folder the platform normally uses: `$XDG_DATA_HOME/goose`, else
/// `~/Library/Application Support/Block/goose` on macOS, `Block/goose` under `APPDATA` on
/// Windows, else `~/.local/share/goose`.
fn default_data_dir(home: &Path) -> PathBuf {
    if let Some(xdg) = env_path("XDG_DATA_HOME") {
        return xdg.join("goose");
    }
    if cfg!(target_os = "macos") {
        return home.join("Library").join("Application Support").join("Block").join("goose");
    }
    if cfg!(windows) {
        let appdata = env_path("APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming"));
        return appdata.join("Block").join("goose");
    }
    home.join(".local").join("share").join("goose")
}

/// The environment, configured and default part of `db_paths`, with every input passed in.
fn db_paths_from(env: Option<PathBuf>, configured: &[PathBuf], default_dir: &Path) -> Vec<PathBuf> {
    use super::sources::push_unique;
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(root) = env {
        push_unique(&mut out, root.join("data").join("sessions").join("sessions.db"));
    }
    for dir in configured.iter().filter(|d| d.is_dir()) {
        // Accept either shape a person pastes: a goose data folder (holding `sessions/`) or a
        // `GOOSE_PATH_ROOT`-style root (holding `data/sessions/`). Existence checks only.
        let data = dir.join("sessions").join("sessions.db");
        let rooted = dir.join("data").join("sessions").join("sessions.db");
        if data.is_file() {
            push_unique(&mut out, data);
        } else if rooted.is_file() {
            push_unique(&mut out, rooted);
        }
    }
    push_unique(&mut out, default_dir.join("sessions").join("sessions.db"));
    out
}

/// The first database location: what the folder display and statusline call "the" Goose database.
pub fn db_path() -> PathBuf {
    db_paths()
        .into_iter()
        .next()
        .unwrap_or_else(|| default_data_dir(&home()).join("sessions").join("sessions.db"))
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
        Ok(rusqlite::types::ValueRef::Text(t)) => {
            String::from_utf8_lossy(t).trim().parse().unwrap_or(0.0)
        }
        _ => 0.0,
    }
}

/// Goose writes `YYYY-MM-DD HH:MM:SS(.fff)` in UTC; read it as such.
pub fn session_ts(raw: &str) -> Option<f64> {
    if let Some(ts) = parse_rfc3339_ms(raw) {
        return Some(ts);
    }
    let bare = raw.trim();
    if bare.len() >= 19 && bare.as_bytes().get(10) == Some(&b' ') {
        let mut iso = bare.to_string();
        iso.replace_range(10..11, "T");
        return parse_rfc3339_ms(&format!("{iso}Z"));
    }
    None
}

fn model_of(config: &str, provider: &str) -> String {
    let name = serde_json::from_str::<Value>(config)
        .ok()
        .and_then(|v| {
            v.get("model_name")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    if !name.is_empty() {
        name
    } else if provider.is_empty() {
        "unknown".to_string()
    } else {
        provider.to_string()
    }
}

pub struct Goose;

impl Source for Goose {
    fn provider(&self) -> &'static str {
        "goose"
    }
    fn dir(&self) -> PathBuf {
        db_paths()
            .into_iter()
            .next()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .unwrap_or_else(db_path)
    }
    fn files(&self) -> Vec<FileInfo> {
        db_paths()
            .into_iter()
            .filter(|path| path.is_file())
            .map(|path| db_file(&path))
            .collect()
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        let _ = db.busy_timeout(std::time::Duration::from_millis(1000));
        let mut stmt = db.prepare("SELECT id, working_dir, created_at, updated_at, accumulated_input_tokens, accumulated_output_tokens, provider_name, CAST(model_config_json AS TEXT) FROM sessions").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    cell_text(row, 0),
                    cell_text(row, 1),
                    cell_text(row, 2),
                    cell_text(row, 3),
                    cell_f64(row, 4),
                    cell_f64(row, 5),
                    cell_text(row, 6),
                    cell_text(row, 7),
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut records = Vec::new();
        for row in rows.flatten() {
            let (id, working_dir, created, updated, input, output, provider, config) = row;
            if input == 0.0 && output == 0.0 {
                continue;
            }
            let stamp = if updated.is_empty() {
                &created
            } else {
                &updated
            };
            let Some(ts) = session_ts(stamp) else {
                continue;
            };
            if ts < since_ms {
                continue;
            }
            let mut r = Record::new("goose", ts, &model_of(&config, &provider), &id);
            r.uncached = input;
            r.output = output;
            r.key = Some(format!("goose:{id}"));
            // CONTRACT_ISSUE: integrator sets Record.project from this ProjectHint.
            let _project = if working_dir.is_empty() {
                None
            } else {
                project_from_cwd(&working_dir)
            };
            records.push(r);
        }
        Ok(ReadResult {
            records,
            malformed: 0,
        })
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
            "burnrate-goose-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_naive_utc_timestamp() {
        let ts = session_ts("2026-11-20 10:00:00").unwrap();
        let expected = parse_rfc3339_ms("2026-11-20T10:00:00Z").unwrap();
        assert_eq!(ts, expected);
        assert!(session_ts("not a date").is_none());
    }

    #[test]
    fn env_then_configured_then_default_and_a_repeat_is_read_once() {
        let root = temp_dir();
        let default_dir = root.join("goose-data");
        let default_db = default_dir.join("sessions").join("sessions.db");
        fs::create_dir_all(default_db.parent().unwrap()).unwrap();
        fs::write(&default_db, "x").unwrap();
        // Default behaviour: the platform default only.
        assert_eq!(db_paths_from(None, &[], &default_dir), vec![default_db.clone()]);
        // The environment first, a configured data folder and a GOOSE_PATH_ROOT-style folder both
        // accepted, the default after; the same database reached twice is listed once.
        let env_root = root.join("env-root");
        let configured_data = root.join("elsewhere").join("goose");
        let configured_root = root.join("another-root");
        // A goose data folder holds `sessions/sessions.db`; a `GOOSE_PATH_ROOT` root holds `data/sessions/`.
        for folder in [configured_data.join("sessions"), configured_root.join("data").join("sessions")] {
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join("sessions.db"), "x").unwrap();
        }
        assert_eq!(
            db_paths_from(Some(env_root.clone()), &[configured_data.clone(), configured_root.clone()], &default_dir),
            vec![
                env_root.join("data").join("sessions").join("sessions.db"),
                configured_data.join("sessions").join("sessions.db"),
                configured_root.join("data").join("sessions").join("sessions.db"),
                default_db.clone(),
            ]
        );
        assert_eq!(
            db_paths_from(None, &[default_dir.clone()], &default_dir),
            vec![default_db.clone()]
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reads_goose_session_fixture() {
        let dir = temp_dir();
        let db = dir.join("sessions.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, working_dir TEXT, created_at TEXT, updated_at TEXT, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER, provider_name TEXT, model_config_json TEXT);").unwrap();
        conn.execute("INSERT INTO sessions VALUES ('s1','chat','/home/me/dev/app','2026-11-20 09:00:00','2026-11-20 10:00:00',1200,300,'openai','{\"model_name\":\"gpt-5-mini\"}')", []).unwrap();
        drop(conn);
        let result = Goose.read(&db, 0.0).unwrap();
        assert_eq!(result.records.len(), 1);
        let r = &result.records[0];
        assert_eq!(r.model, "gpt-5-mini");
        assert_eq!(r.uncached, 1200.0);
        assert_eq!(r.output, 300.0);
        assert_eq!(r.session, "s1");
        fs::remove_dir_all(&dir).unwrap();
    }
}
