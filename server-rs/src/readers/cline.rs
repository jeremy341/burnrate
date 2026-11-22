// Cline / Roo / Kilo local-log readers (package 09).
//
// Layout verified from the public CodeBurn adapters (`docs/providers/cline.md`,
// `kilo-code.md`, `vscode-cline-parser.md`) and the extensions' storage layout:
//   <VS Code globalStorage>/<extension-id>/tasks/<taskId>/ui_messages.json
//   ~/.cline/data/tasks/<taskId>/ui_messages.json (Cline home data)
// Each `api_req_started` entry carries a JSON string in `text` with
// `tokensIn`, `tokensOut`, `cacheReads`, `cacheWrites` and optional `cost`.
// The model is read from `<model>...</model>` in api_conversation_history.json.
// Read-only: no extension settings, credentials or network access.

use super::{env_path, home, read_text, walk, FileInfo, Source};
use crate::readers::project::project_from_cwd;
use crate::types::{parse_rfc3339_ms, str_of, token_count, ReadResult, Record};
use serde_json::Value;
use std::path::{Path, PathBuf};

const MAX_FILE: u64 = 32 * 1024 * 1024;
const EXTENSIONS: [(&str, &str, &str); 3] = [
    ("saoudrizwan.claude-dev", "cline", "cline-auto"),
    ("rooveterinaryinc.roo-cline", "roo", "roo-auto"),
    ("kilocode.kilo-code", "kilo", "kilo-auto"),
];

fn vscode_roots() -> Vec<PathBuf> {
    let mut global = Vec::new();
    if let Some(config) = env_path("XDG_CONFIG_HOME") {
        global.push(config.join("Code").join("User").join("globalStorage"));
        global.push(
            config
                .join("Code - Insiders")
                .join("User")
                .join("globalStorage"),
        );
        global.push(config.join("VSCodium").join("User").join("globalStorage"));
    } else {
        let base = if cfg!(windows) {
            env_path("APPDATA").unwrap_or_else(|| home().join("AppData").join("Roaming"))
        } else if cfg!(target_os = "macos") {
            home().join("Library").join("Application Support")
        } else {
            home().join(".config")
        };
        global.push(base.join("Code").join("User").join("globalStorage"));
        global.push(
            base.join("Code - Insiders")
                .join("User")
                .join("globalStorage"),
        );
        global.push(base.join("VSCodium").join("User").join("globalStorage"));
    }
    global
}

fn task_roots() -> Vec<(PathBuf, &'static str)> {
    let mut out = Vec::new();
    for root in vscode_roots() {
        for (ext, provider, _) in EXTENSIONS {
            out.push((root.join(ext).join("tasks"), provider));
        }
    }
    out.push((home().join(".cline").join("data").join("tasks"), "cline"));
    out
}

pub fn default_model(provider: &str) -> &'static str {
    EXTENSIONS
        .iter()
        .find(|(_, id, _)| *id == provider)
        .map_or("cline-auto", |(_, _, model)| *model)
}

/// Extract the `<model>...</model>` tag Cline writes into the conversation
/// history, falling back to the auto model when absent.
pub fn model_from_history(text: &str, provider: &str) -> String {
    if let Some(start) = text.find("<model>") {
        let rest = &text[start + "<model>".len()..];
        if let Some(end) = rest.find("</model>") {
            let model = rest[..end].trim();
            if !model.is_empty() {
                return model.to_string();
            }
        }
    }
    default_model(provider).to_string()
}

fn entry_ts(entry: &Value, fallback: f64) -> f64 {
    if let Some(n) = entry.get("ts").and_then(Value::as_f64) {
        return if n > 1e12 { n } else { n * 1000.0 };
    }
    if let Some(s) = entry
        .get("ts")
        .and_then(Value::as_str)
        .and_then(parse_rfc3339_ms)
    {
        return s;
    }
    fallback
}

/// Parse one task's `ui_messages.json` stream.
pub fn parse_messages(text: &str, provider: &str, task: &str, fallback_ts: f64) -> Vec<Record> {
    let document: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let entries = document
        .as_array()
        .or_else(|| document.get("uiMessages").and_then(Value::as_array))
        .or_else(|| document.get("messages").and_then(Value::as_array));
    let Some(entries) = entries else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        if str_of(entry.get("type")) != "api_req_started" {
            continue;
        }
        let Some(text) = entry.get("text").and_then(Value::as_str) else {
            continue;
        };
        let Ok(usage) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        let tokens_in = token_count(usage.get("tokensIn"));
        let tokens_out = token_count(usage.get("tokensOut"));
        let cached = token_count(usage.get("cacheReads"));
        let cache_write = token_count(usage.get("cacheWrites"));
        if tokens_in == 0.0 && tokens_out == 0.0 {
            continue;
        }
        let mut r = Record::new(provider, entry_ts(entry, fallback_ts), "", task);
        // Cline's tokensIn/cacheReads/cacheWrites are disjoint counters.
        r.uncached = tokens_in;
        r.cached = cached;
        r.cache_write = cache_write;
        r.output = tokens_out;
        r.reported = usage
            .get("cost")
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite() && *c > 0.0);
        r.key = Some(format!("{provider}:{task}:{index}"));
        // CONTRACT_ISSUE: integrator sets Record.project from this ProjectHint.
        let _project = usage
            .get("cwd")
            .and_then(Value::as_str)
            .and_then(project_from_cwd);
        out.push(r);
    }
    out
}

pub struct Cline;
pub struct Roo;
pub struct Kilo;

macro_rules! cline_source {
    ($name:ident, $id:expr) => {
        impl Source for $name {
            fn provider(&self) -> &'static str {
                $id
            }
            fn dir(&self) -> PathBuf {
                task_roots()
                    .into_iter()
                    .find(|(dir, provider)| dir.exists() && *provider == $id)
                    .map_or_else(|| home().join(format!(".{}-data", $id)), |(dir, _)| dir)
            }
            fn files(&self) -> Vec<FileInfo> {
                let mut out = Vec::new();
                for (root, provider) in task_roots() {
                    if provider == $id {
                        walk(&root, &|name| name == "ui_messages.json", &mut out);
                    }
                }
                out
            }
            fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
                let text = read_text(path, MAX_FILE)?;
                let fallback =
                    super::mtime_ms(&std::fs::metadata(path).map_err(|e| e.to_string())?);
                let task = path
                    .parent()
                    .and_then(Path::file_name)
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let history = path.with_file_name("api_conversation_history.json");
                let model = std::fs::read_to_string(&history)
                    .ok()
                    .map(|h| model_from_history(&h, $id))
                    .unwrap_or_else(|| default_model($id).to_string());
                let mut records = parse_messages(&text, $id, &task, fallback);
                for r in &mut records {
                    r.model = model.clone();
                }
                records.retain(|r| r.ts >= since_ms);
                Ok(ReadResult {
                    records,
                    malformed: 0,
                })
            }
        }
    };
}

cline_source!(Cline, "cline");
cline_source!(Roo, "roo");
cline_source!(Kilo, "kilo");

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "burnrate-cline-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_api_req_started_entries() {
        let text = serde_json::json!([
            {"type":"api_req_started","ts":1763623200000.0,"text":"{\"tokensIn\":100,\"tokensOut\":50,\"cacheReads\":40,\"cacheWrites\":10,\"cost\":0.012}"},
            {"type":"user_message","text":"ignored"}
        ]).to_string();
        let records = parse_messages(&text, "cline", "task-1", 0.0);
        assert_eq!(records.len(), 1);
        let r = &records[0];
        assert_eq!(r.uncached, 100.0);
        assert_eq!(r.cached, 40.0);
        assert_eq!(r.cache_write, 10.0);
        assert_eq!(r.output, 50.0);
        assert_eq!(r.reported, Some(0.012));
        assert_eq!(r.key.as_deref(), Some("cline:task-1:0"));
    }

    #[test]
    fn extracts_model_from_history() {
        assert_eq!(
            model_from_history(
                "[{\"type\":\"user\",\"content\":\"<model>claude-sonnet-4-5</model>\"}]",
                "cline"
            ),
            "claude-sonnet-4-5"
        );
        assert_eq!(model_from_history("no tag", "roo"), "roo-auto");
    }

    #[test]
    fn reader_reads_task_fixture() {
        let dir = temp_dir();
        let task = dir.join("tasks").join("t1");
        fs::create_dir_all(&task).unwrap();
        fs::write(task.join("ui_messages.json"), "[{\"type\":\"api_req_started\",\"ts\":1763623200000,\"text\":\"{\\\"tokensIn\\\":10,\\\"tokensOut\\\":2}\"}]").unwrap();
        fs::write(
            task.join("api_conversation_history.json"),
            "<model>gpt-5</model>",
        )
        .unwrap();
        let file = task.join("ui_messages.json");
        let mut records = parse_messages(&fs::read_to_string(&file).unwrap(), "cline", "t1", 0.0);
        assert_eq!(records.len(), 1);
        records[0].model = model_from_history(
            &fs::read_to_string(task.join("api_conversation_history.json")).unwrap(),
            "cline",
        );
        assert_eq!(records[0].model, "gpt-5");
        fs::remove_dir_all(&dir).unwrap();
    }
}
