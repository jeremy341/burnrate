// Crush TUI local-log reader (package 09).
//
// Verified against the public CodeBurn adapter (`docs/providers/crush.md`) and
// charmbracelet/crush v0.66.1 migrations:
//   registry: $XDG_DATA_HOME/crush/projects.json (or %LOCALAPPDATA%)
//   per project: <project.path>/<project.data_dir|".crush">/crush.db
//   sessions(id, parent_session_id, prompt_tokens, completion_tokens, cost,
//            updated_at, created_at)  -- timestamps are Unix SECONDS
//   messages(session_id, model)       -- dominant model per session
// `cost` is already dollars. Child sessions are skipped (their cost rolls up
// into the parent). Read-only.

use super::{db_file, env_path, home, FileInfo, Source};
use crate::readers::project::project_from_cwd;
use crate::types::{ReadResult, Record};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Registry locations in precedence order: `CRUSH_GLOBAL_DATA`, then folders configured in Settings
/// (`providers.sources.crush`), then the platform default. Only registries naming existing project
/// databases are read; nothing is created and a registry reached twice is read once.
pub fn registries() -> Vec<PathBuf> {
    let home = home();
    registries_from(env_path("CRUSH_GLOBAL_DATA"), &super::sources::configured("crush"), &default_data_dir(&home))
}

/// The crush global-data folder the platform normally uses: `$XDG_DATA_HOME/crush`, else
/// `%LOCALAPPDATA%\crush` on Windows, else `~/.local/share/crush`.
fn default_data_dir(home: &Path) -> PathBuf {
    if let Some(xdg) = env_path("XDG_DATA_HOME") {
        return xdg.join("crush");
    }
    if cfg!(windows) {
        let local =
            env_path("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local"));
        return local.join("crush");
    }
    home.join(".local").join("share").join("crush")
}

/// The environment, configured and default part of `registries`, with every input passed in.
fn registries_from(env: Option<PathBuf>, configured: &[PathBuf], default_dir: &Path) -> Vec<PathBuf> {
    use super::sources::push_unique;
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(dir) = env {
        push_unique(&mut out, dir.join("projects.json"));
    }
    for dir in configured {
        // Accept the `projects.json` file itself too: that is the thing people copy around.
        let dir = if dir.file_name().is_some_and(|n| n == "projects.json") {
            dir.parent().map_or_else(|| dir.clone(), Path::to_path_buf)
        } else {
            dir.clone()
        };
        let registry = dir.join("projects.json");
        // Only an existing registry is read: a missing or non-matching entry is skipped.
        if registry.is_file() {
            push_unique(&mut out, registry);
        }
    }
    push_unique(&mut out, default_dir.join("projects.json"));
    out
}

/// The first registry location: what the folder display and statusline call "the" Crush folder.
pub fn registry_path() -> PathBuf {
    registries()
        .into_iter()
        .next()
        .unwrap_or_else(|| default_data_dir(&home()).join("projects.json"))
}

fn project_entries(document: &Value) -> Vec<Value> {
    if let Some(projects) = document.get("projects").and_then(Value::as_array) {
        return projects.clone();
    }
    if let Some(array) = document.as_array() {
        return array.clone();
    }
    if let Some(object) = document.as_object() {
        return object.values().cloned().collect();
    }
    Vec::new()
}

/// Enumerate the per-project databases named by the global registries.
pub fn databases() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for registry in registries() {
        let Ok(text) = std::fs::read_to_string(&registry) else {
            continue;
        };
        let Ok(document) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        for entry in project_entries(&document) {
            let Some(path) = entry.get("path").and_then(Value::as_str) else {
                continue;
            };
            let data_dir = entry
                .get("data_dir")
                .and_then(Value::as_str)
                .filter(|d| !d.is_empty())
                .unwrap_or(".crush");
            let db = Path::new(path).join(data_dir).join("crush.db");
            if db.is_file() && !out.contains(&db) {
                out.push(db);
            }
        }
    }
    out
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

fn cell_text(row: &rusqlite::Row, index: usize) -> String {
    match row.get_ref(index) {
        Ok(rusqlite::types::ValueRef::Text(t)) => String::from_utf8_lossy(t).into_owned(),
        Ok(rusqlite::types::ValueRef::Integer(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn dominant_model(db: &Connection, session: &str) -> String {
    db.prepare("SELECT model FROM messages WHERE session_id = ?1 AND model IS NOT NULL GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1")
        .ok()
        .and_then(|mut stmt| stmt.query_row([session], |row| row.get::<_, String>(0)).ok())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn project_for_db(path: &Path) -> Option<String> {
    path.parent()?
        .parent()?
        .file_name()
        .and_then(|n| project_from_cwd(&n.to_string_lossy()))
}

pub struct Crush;

impl Source for Crush {
    fn provider(&self) -> &'static str {
        "crush"
    }
    fn dir(&self) -> PathBuf {
        registry_path().parent().map_or_else(
            || home().join(".local").join("share").join("crush"),
            Path::to_path_buf,
        )
    }
    fn files(&self) -> Vec<FileInfo> {
        databases().iter().map(|db| db_file(db)).collect()
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        let _ = db.busy_timeout(std::time::Duration::from_millis(1000));
        let selects = [
            "SELECT id, prompt_tokens, completion_tokens, cost, COALESCE(updated_at, created_at), parent_session_id FROM sessions",
            "SELECT id, prompt_tokens, completion_tokens, cost, COALESCE(updated_at, created_at), NULL FROM sessions",
        ];
        let mut stmt = None;
        for sql in selects {
            if let Ok(prepared) = db.prepare(sql) {
                stmt = Some(prepared);
                break;
            }
        }
        let mut stmt = stmt.ok_or_else(|| "unsupported crush schema".to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    cell_text(row, 0),
                    cell_f64(row, 1),
                    cell_f64(row, 2),
                    cell_f64(row, 3),
                    cell_f64(row, 4),
                    cell_text(row, 5),
                ))
            })
            .map_err(|e| e.to_string())?;
        let project = project_for_db(path);
        let mut records = Vec::new();
        for row in rows.flatten() {
            let (id, prompt, completion, cost, seconds, parent) = row;
            if !parent.is_empty() {
                continue;
            }
            if prompt == 0.0 && completion == 0.0 && cost == 0.0 {
                continue;
            }
            // Crush writes strftime('%s','now'): seconds, despite a misleading
            // schema comment. Multiplying by 1000 is required.
            let ts = seconds * 1000.0;
            if ts < since_ms {
                continue;
            }
            let mut r = Record::new("crush", ts, &dominant_model(&db, &id), &id);
            r.uncached = prompt;
            r.output = completion;
            r.reported = (cost > 0.0).then_some(cost);
            r.key = Some(format!("crush:{id}"));
            // CONTRACT_ISSUE: integrator sets Record.project from this ProjectHint.
            let _project = project.as_deref();
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

    fn temp_project() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "burnrate-crush-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let project = root.join("myrepo");
        fs::create_dir_all(project.join(".crush")).unwrap();
        let registry = root.join("projects.json");
        fs::write(&registry, serde_json::to_vec(&serde_json::json!({"projects":[{"id":"p1","path":project.to_string_lossy(),"data_dir":".crush"}]})).unwrap()).unwrap();
        (root, project)
    }

    #[test]
    fn reads_crush_session_fixture() {
        let (root, project) = temp_project();
        let db = project.join(".crush").join("crush.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL, updated_at INTEGER, created_at INTEGER); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, model TEXT);").unwrap();
        conn.execute(
            "INSERT INTO sessions VALUES ('s1',NULL,1000,200,0.25,1763623200,1763623100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions VALUES ('child','s1',50,10,0.01,1763623200,1763623100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages VALUES ('m','s1','gemini-2.5-pro')",
            [],
        )
        .unwrap();
        drop(conn);
        let result = Crush.read(&db, 0.0).unwrap();
        assert_eq!(result.records.len(), 1);
        let r = &result.records[0];
        assert_eq!(r.model, "gemini-2.5-pro");
        assert_eq!(r.uncached, 1000.0);
        assert_eq!(r.output, 200.0);
        assert_eq!(r.reported, Some(0.25));
        assert_eq!(r.ts, 1763623200.0 * 1000.0);
        assert_eq!(project_for_db(&db).as_deref(), Some("myrepo"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn project_entries_accept_all_shapes() {
        assert_eq!(
            project_entries(&serde_json::json!({"projects":[1,2]})).len(),
            2
        );
        assert_eq!(project_entries(&serde_json::json!([1, 2])).len(), 2);
        assert_eq!(project_entries(&serde_json::json!({"a":1,"b":2})).len(), 2);
        assert!(project_entries(&serde_json::json!(null)).is_empty());
    }

    #[test]
    fn every_registry_is_read_and_a_repeat_is_read_once() {
        let root = std::env::temp_dir().join(format!(
            "burnrate-crush-registries-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let default_registry = root.join("default").join("projects.json");
        fs::create_dir_all(default_registry.parent().unwrap()).unwrap();
        // A configured folder without the registry file is skipped; a `projects.json` file itself is
        // accepted, like the `projects` folder is for Claude.
        let configured_dir = root.join("elsewhere");
        let configured_registry = configured_dir.join("projects.json");
        fs::create_dir_all(&configured_dir).unwrap();
        fs::write(&configured_registry, serde_json::to_vec(&serde_json::json!({"projects":[]})).unwrap()).unwrap();
        let empty = root.join("empty-folder");
        fs::create_dir_all(&empty).unwrap();
        // Default behaviour: the platform default only.
        assert_eq!(registries_from(None, &[], &root.join("default")), vec![default_registry.clone()]);
        // Environment first, configured after, default last; a repeat read once.
        let env = root.join("env-data");
        assert_eq!(
            registries_from(Some(env.clone()), &[empty.clone()], &root.join("default")),
            vec![env.join("projects.json"), default_registry.clone()]
        );
        assert_eq!(
            registries_from(None, &[configured_registry.clone(), configured_dir.clone(), default_registry.clone()], &root.join("default")),
            vec![configured_registry.clone(), default_registry.clone()]
        );
        fs::remove_dir_all(&root).unwrap();
    }
}
