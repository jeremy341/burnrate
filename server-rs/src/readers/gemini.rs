// Gemini CLI local-log reader (package 09).
//
// Format verified from the Gemini CLI session docs and the public CodeBurn
// adapter (`docs/providers/gemini.md`, `src/providers/gemini.ts`):
//   ~/.gemini/tmp/<project>/chats/session-*.json (CLI <= 0.38, one JSON document)
//   ~/.gemini/tmp/<project>/chats/session-*.jsonl (CLI >= 0.39, header + message lines)
// Each `type: "gemini"` message carrying `tokens` and `model` emits one record.
// `tokens.input` includes `tokens.cached` (a subset); thoughts bill at the
// output rate. Read-only: no config, credentials or network access.

use super::{config_dirs, env_path, home, read_text, walk, FileInfo, Source};
use crate::types::{parse_rfc3339_ms, str_of, token_count, ReadResult, Record};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const MAX_FILE: u64 = 64 * 1024 * 1024;

/// Gemini CLI config homes: `GEMINI_CLI_HOME`, then folders configured in Settings
/// (`providers.sources.gemini`), then the XDG/config candidates. Nothing is created;
/// a folder reached twice is read once.
pub fn gemini_homes() -> Vec<PathBuf> {
    gemini_homes_from(
        env_path("GEMINI_CLI_HOME"),
        &super::sources::configured("gemini"),
        config_dirs("gemini"),
        &home(),
    )
}

/// The environment, configured and discovered part of `gemini_homes`, with every input passed in.
fn gemini_homes_from(
    env: Option<PathBuf>,
    configured: &[PathBuf],
    discovered: Vec<PathBuf>,
    home: &Path,
) -> Vec<PathBuf> {
    use super::sources::push_unique;
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(env) = env {
        push_unique(&mut out, env);
    }
    for dir in configured.iter().filter(|d| d.is_dir()) {
        push_unique(&mut out, dir.clone());
    }
    for dir in discovered {
        push_unique(&mut out, dir);
    }
    if out.is_empty() {
        out.push(home.join(".gemini"));
    }
    out
}

/// The project name is the directory two levels above the chat file
/// (`.../tmp/<project>/chats/session-*.json`).
pub fn project_of_file(path: &Path) -> Option<String> {
    let chats = path.parent()?;
    let project = chats.parent()?;
    crate::readers::project::project_from_dir_name(&project.file_name()?.to_string_lossy())
}

fn number(value: Option<&Value>) -> f64 {
    token_count(value)
}

/// Build one `Record` per billable assistant message in a parsed session.
pub fn parse_session(session: &Value, project: Option<&str>) -> Vec<Record> {
    let Some(messages) = session.get("messages").and_then(Value::as_array) else {
        return Vec::new();
    };
    let session_id = str_of(session.get("sessionId"));
    let fallback_ts = str_of(session.get("startTime"));
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    let mut ordinal = 0usize;

    for message in messages {
        if message.get("type").and_then(Value::as_str) != Some("gemini") {
            continue;
        }
        let Some(tokens) = message.get("tokens").filter(|t| t.is_object()) else {
            continue;
        };
        let model = str_of(message.get("model"));
        if model.is_empty() {
            continue;
        }
        let input = number(tokens.get("input"));
        let cached = number(tokens.get("cached")).min(input);
        let output = number(tokens.get("output"));
        let thoughts = number(tokens.get("thoughts"));
        if input == 0.0 && output == 0.0 && thoughts == 0.0 {
            continue;
        }
        let key = format!("gemini:{}:{}", session_id, str_of(message.get("id")));
        let key = if key.ends_with(':') {
            format!("{key}idx-{ordinal}")
        } else {
            key
        };
        ordinal += 1;
        if !seen.insert(key.clone()) {
            continue;
        }
        let stamp = str_of(message.get("timestamp"));
        let stamp = if stamp.is_empty() { fallback_ts } else { stamp };
        let Some(ts) = parse_rfc3339_ms(stamp) else {
            continue;
        };
        let mut r = Record::new("gemini", ts, model, &session_id);
        // Cached is a subset of input; reasoning folds into output so tokens are
        // not counted twice (Record::total_tokens ignores `reasoning`).
        r.uncached = input - cached;
        r.cached = cached;
        r.output = output + thoughts;
        r.reasoning = thoughts.min(r.output);
        r.key = Some(key);
        // CONTRACT_ISSUE: add `project: Option<String>` to types::Record and set
        // it here from `project` (ProjectHint) when the integrator wires it up.
        let _project = project;
        out.push(r);
    }
    out
}

/// JSONL sessions start with a `sessionId`/`startTime` header line and then
/// carry one object per message; `$set` lines are persistence noise.
pub fn parse_jsonl(text: &str) -> Option<Value> {
    let mut session = serde_json::json!({"messages": []});
    let mut found_header = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if obj.get("$set").is_some() {
            continue;
        }
        if obj.get("sessionId").is_some_and(Value::is_string)
            && obj.get("startTime").is_some_and(Value::is_string)
            && !found_header
        {
            session["sessionId"] = obj["sessionId"].clone();
            session["startTime"] = obj["startTime"].clone();
            found_header = true;
        } else if obj.get("id").is_some_and(Value::is_string)
            && obj.get("type").is_some_and(Value::is_string)
        {
            session["messages"].as_array_mut()?.push(obj);
        }
    }
    found_header.then_some(session)
}

pub struct GeminiCli;

impl Source for GeminiCli {
    fn provider(&self) -> &'static str {
        "gemini"
    }
    fn dir(&self) -> PathBuf {
        gemini_homes()
            .first()
            .cloned()
            .unwrap_or_else(|| home().join(".gemini"))
            .join("tmp")
    }
    fn files(&self) -> Vec<FileInfo> {
        let mut out = Vec::new();
        for root in gemini_homes() {
            let tmp = root.join("tmp");
            let Ok(projects) = std::fs::read_dir(&tmp) else {
                continue;
            };
            for project in projects.flatten() {
                if project.path().is_dir() {
                    walk(
                        &project.path().join("chats"),
                        &|n| {
                            n.starts_with("session-")
                                && (n.ends_with(".json") || n.ends_with(".jsonl"))
                        },
                        &mut out,
                    );
                }
            }
        }
        out
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let text = read_text(path, MAX_FILE)?;
        let session = if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            parse_jsonl(&text)
        } else {
            let parsed: Option<Value> = serde_json::from_str(&text).ok();
            parsed.filter(|v| v.get("messages").is_some() && v.get("sessionId").is_some())
        };
        let project = project_of_file(path);
        let mut records = session
            .map(|s| parse_session(&s, project.as_deref()))
            .unwrap_or_default();
        records.retain(|r| r.ts >= since_ms);
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
            "burnrate-gemini-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_single_json_session() {
        let raw = serde_json::json!({
            "sessionId": "s1",
            "startTime": "2026-11-20T10:00:00Z",
            "messages": [
                {"type": "user", "content": "hi", "timestamp": "2026-11-20T10:00:00Z"},
                {"id": "m1", "type": "gemini", "model": "gemini-2.5-pro", "timestamp": "2026-11-20T10:01:00Z",
                 "tokens": {"input": 1200, "cached": 200, "output": 300, "thoughts": 50}}
            ]
        });
        let records = parse_session(&raw, Some("myproj"));
        assert_eq!(records.len(), 1);
        let r = &records[0];
        assert_eq!(r.provider, "gemini");
        assert_eq!(r.model, "gemini-2.5-pro");
        assert_eq!(r.uncached, 1000.0);
        assert_eq!(r.cached, 200.0);
        assert_eq!(r.output, 350.0);
        assert_eq!(r.reasoning, 50.0);
        assert_eq!(r.session, "s1");
        assert_eq!(r.key.as_deref(), Some("gemini:s1:m1"));
    }

    #[test]
    fn parses_jsonl_session_and_dedupes() {
        let text = concat!(
            "{\"sessionId\":\"s2\",\"startTime\":\"2026-11-20T11:00:00Z\"}\n",
            "{\"id\":\"m1\",\"type\":\"gemini\",\"model\":\"gemini-2.5-flash\",\"timestamp\":\"2026-11-20T11:01:00Z\",\"tokens\":{\"input\":10,\"output\":5}}\n",
            "{\"$set\":{\"foo\":1}}\n",
            "{\"id\":\"m1\",\"type\":\"gemini\",\"model\":\"gemini-2.5-flash\",\"timestamp\":\"2026-11-20T11:01:00Z\",\"tokens\":{\"input\":10,\"output\":5}}\n"
        );
        let session = parse_jsonl(text).unwrap();
        assert_eq!(parse_session(&session, None).len(), 1);
    }

    #[test]
    fn env_then_configured_then_discovery_and_a_repeat_is_read_once() {
        let root = temp_dir();
        let home = root.join("home");
        let custom = root.join("elsewhere").join("gemini");
        fs::create_dir_all(&custom).unwrap();
        let default = home.join(".gemini");
        let discovered = vec![default.clone(), home.join(".config").join("gemini")];
        // Default behaviour: nothing configured, discovery only.
        assert_eq!(gemini_homes_from(None, &[], discovered.clone(), &home), discovered);
        // The environment first, a configured folder second, discovery after; a repeat read once.
        let env = root.join("env-home");
        assert_eq!(
            gemini_homes_from(Some(env.clone()), &[root.join("missing"), custom.clone()], discovered.clone(), &home),
            vec![env, custom, default.clone(), home.join(".config").join("gemini")]
        );
        assert_eq!(
            gemini_homes_from(None, &[default.clone()], discovered, &home),
            vec![default, home.join(".config").join("gemini")]
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reader_reads_fixture_from_temp_dir() {
        let dir = temp_dir();
        let chats = dir.join("tmp").join("demo").join("chats");
        fs::create_dir_all(&chats).unwrap();
        let file = chats.join("session-abc.json");
        fs::write(&file, serde_json::to_vec(&serde_json::json!({
            "sessionId": "abc",
            "startTime": "2026-11-20T12:00:00Z",
            "messages": [{"id":"m","type":"gemini","model":"gemini-2.5-pro","timestamp":"2026-11-20T12:01:00Z","tokens":{"input":100,"output":20}}]
        })).unwrap()).unwrap();
        assert_eq!(project_of_file(&file).as_deref(), Some("demo"));
        let result = GeminiCli.read(&file, 0.0).unwrap();
        assert_eq!(result.records.len(), 1);
        assert_eq!(result.records[0].uncached, 100.0);
        let files = {
            let mut out = Vec::new();
            walk(&dir.join("tmp"), &|n| n.ends_with(".json"), &mut out);
            out
        };
        assert_eq!(files.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}
