// Qwen Code local-log reader (package 09).
//
// Formats verified from the Qwen Code data-privacy docs and the public
// CodeBurn adapter (`docs/providers/qwen.md`, `src/providers/qwen.ts`):
//   $QWEN_DATA_DIR or ~/.qwen/projects/<project>/chats/*.jsonl
//   ~/.qwen/logs/sessions/<projectId>/<sessionId>/segments/*.jsonl (newer layout)
// Tokens come from `usageMetadata`; cached tokens are a subset of the prompt.
// Dedupe is per `<sessionId>:<uuid>` because resumed sessions repeat turns.

use super::{env_path, home, read_text, walk, FileInfo, Source};
use crate::types::{parse_rfc3339_ms, str_of, token_count, ReadResult, Record};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const MAX_FILE: u64 = 64 * 1024 * 1024;
const THOUGHTS_IN_CANDIDATES: [&str; 3] = ["openai", "openai-responses", "qwen-oauth"];

/// Qwen data roots: `QWEN_DATA_DIR`, then folders configured in Settings (`providers.sources.qwen`),
/// then `~/.qwen`. Nothing is created; a folder reached twice is read once.
pub fn data_roots() -> Vec<PathBuf> {
    data_roots_from(env_path("QWEN_DATA_DIR"), &super::sources::configured("qwen"), &home())
}

/// The environment, configured and home part of `data_roots`, with every input passed in.
fn data_roots_from(env: Option<PathBuf>, configured: &[PathBuf], home: &Path) -> Vec<PathBuf> {
    use super::sources::push_unique;
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(env) = env {
        push_unique(&mut out, env);
    }
    for dir in configured.iter().filter(|d| d.is_dir()) {
        push_unique(&mut out, dir.clone());
    }
    push_unique(&mut out, home.join(".qwen"));
    out
}

/// The first data root: what the folder display and statusline call "the" Qwen folder.
pub fn data_root() -> PathBuf {
    data_roots()
        .into_iter()
        .next()
        .unwrap_or_else(|| home().join(".qwen"))
}

/// Qwen encodes the project in the parent directory name; the documented
/// convention drops a leading `-` and keeps the last dash-separated segment.
pub fn project_of_file(path: &Path) -> Option<String> {
    let chats = path.parent()?;
    // Newer layout: logs/sessions/<projectId>/<sessionId>/segments/<run>.jsonl
    let holder = if chats.file_name().is_some_and(|n| n == "segments") {
        chats.parent()?.parent()?
    } else {
        chats.parent()?
    };
    let name = holder.file_name()?.to_string_lossy().to_string();
    let trimmed = name.strip_prefix('-').unwrap_or(&name);
    let last = trimmed.rsplit('-').next().unwrap_or(trimmed);
    crate::readers::project::project_from_dir_name(if last.is_empty() { trimmed } else { last })
}

fn number(value: Option<&Value>) -> f64 {
    token_count(value)
}

/// Parse one JSONL chat file. `fallback_ts_ms` comes from the file mtime and
/// is used when a record has no usable timestamp.
pub fn parse_file(text: &str, fallback_ts_ms: f64, project: Option<&str>) -> Vec<Record> {
    let mut records = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut auth_type: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let kind = str_of(entry.get("type"));
        if kind == "user" {
            auth_type = entry
                .pointer("/executionContext/authType")
                .and_then(Value::as_str)
                .map(str::to_string);
            continue;
        }
        if kind != "assistant" {
            continue;
        }
        let Some(usage) = entry.get("usageMetadata").filter(|u| u.is_object()) else {
            continue;
        };
        let prompt = number(usage.get("promptTokenCount"));
        let candidates = number(usage.get("candidatesTokenCount"));
        if prompt == 0.0 && candidates == 0.0 {
            continue;
        }
        let thoughts = number(usage.get("thoughtsTokenCount"));
        let total = number(usage.get("totalTokenCount"));
        let cached = number(usage.get("cachedContentTokenCount")).min(prompt);
        let (output, reasoning) =
            billed_output(candidates, thoughts, total, prompt, auth_type.as_deref());

        let session = str_of(entry.get("sessionId"));
        let uuid = str_of(entry.get("uuid"));
        let key = format!("qwen:{session}:{uuid}");
        if !seen.insert(key.clone()) {
            continue;
        }
        let ts = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_ms)
            .unwrap_or(fallback_ts_ms);
        let model = {
            let m = str_of(entry.get("model"));
            if m.is_empty() {
                "qwen-auto"
            } else {
                m
            }
        };
        let mut r = Record::new("qwen", ts, model, &session);
        r.uncached = prompt - cached;
        r.cached = cached;
        r.output = output;
        r.reasoning = reasoning;
        r.key = Some(key);
        // CONTRACT_ISSUE: integrator sets Record.project from this ProjectHint.
        let _project = project;
        records.push(r);
    }
    records
}

/// Decide whether thoughts are billed separately from `candidatesTokenCount`.
/// Qwen reports them inside candidates on the OpenAI-compatible, Responses and
/// Qwen OAuth backends; elsewhere they are additive. The total-token band is a
/// more reliable hint when present.
fn billed_output(
    candidates: f64,
    thoughts: f64,
    total: f64,
    prompt: f64,
    auth_type: Option<&str>,
) -> (f64, f64) {
    let derived = total - prompt;
    let separate = if total > 0.0 && derived >= candidates && derived <= candidates + thoughts {
        derived > candidates
    } else {
        !auth_type.is_some_and(|a| THOUGHTS_IN_CANDIDATES.contains(&a))
    };
    let output = if separate {
        candidates + thoughts
    } else {
        candidates
    };
    (output, thoughts.min(output))
}

fn is_chat_file(name: &str) -> bool {
    name.ends_with(".jsonl")
}

pub struct QwenCode;

impl Source for QwenCode {
    fn provider(&self) -> &'static str {
        "qwen"
    }
    fn dir(&self) -> PathBuf {
        data_root().join("projects")
    }
    fn files(&self) -> Vec<FileInfo> {
        let mut out = Vec::new();
        for root in data_roots() {
            walk(&root.join("projects"), &is_chat_file, &mut out);
            // Newer layout: logs/sessions/<projectId>/<sessionId>/segments/*.jsonl
            walk(&root.join("logs").join("sessions"), &is_chat_file, &mut out);
        }
        out
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let text = read_text(path, MAX_FILE)?;
        let fallback = super::mtime_ms(&std::fs::metadata(path).map_err(|e| e.to_string())?);
        let mut records = parse_file(&text, fallback, project_of_file(path).as_deref());
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
            "burnrate-qwen-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_usage_metadata() {
        let text = concat!(
            "{\"type\":\"user\",\"uuid\":\"u1\",\"sessionId\":\"s\",\"executionContext\":{\"authType\":\"qwen-oauth\"}}\n",
            "{\"type\":\"assistant\",\"uuid\":\"a1\",\"sessionId\":\"s\",\"model\":\"qwen3-coder\",\"timestamp\":\"2026-11-20T10:00:00Z\",\"usageMetadata\":{\"promptTokenCount\":1000,\"candidatesTokenCount\":200,\"thoughtsTokenCount\":50,\"cachedContentTokenCount\":300,\"totalTokenCount\":1250}}\n"
        );
        let records = parse_file(text, 0.0, Some("proj"));
        assert_eq!(records.len(), 1);
        let r = &records[0];
        assert_eq!(r.uncached, 700.0);
        assert_eq!(r.cached, 300.0);
        // totalTokenCount (1250) - prompt (1000) shows thoughts are additive
        // here, so output carries them once and reasoning stays a subset.
        assert_eq!(r.output, 250.0);
        assert_eq!(r.reasoning, 50.0);
        assert_eq!(r.key.as_deref(), Some("qwen:s:a1"));
    }

    #[test]
    fn additive_thoughts_on_unknown_backend() {
        let text = "{\"type\":\"assistant\",\"uuid\":\"a\",\"sessionId\":\"s\",\"model\":\"qwen\",\"timestamp\":\"2026-11-20T10:00:00Z\",\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":20,\"thoughtsTokenCount\":5}}\n";
        let records = parse_file(text, 0.0, None);
        assert_eq!(records[0].output, 25.0);
        assert_eq!(records[0].reasoning, 5.0);
    }

    #[test]
    fn dedupes_repeated_uuid() {
        let line = "{\"type\":\"assistant\",\"uuid\":\"a\",\"sessionId\":\"s\",\"model\":\"qwen\",\"timestamp\":\"2026-11-20T10:00:00Z\",\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":2}}\n";
        let text = format!("{line}{line}");
        assert_eq!(parse_file(&text, 0.0, None).len(), 1);
    }

    #[test]
    fn reader_finds_both_layouts() {
        let dir = temp_dir();
        let a = dir.join("projects").join("-work-proj").join("chats");
        fs::create_dir_all(&a).unwrap();
        fs::write(a.join("session-1.jsonl"), "{\"type\":\"assistant\",\"uuid\":\"a\",\"sessionId\":\"s\",\"model\":\"qwen\",\"timestamp\":\"2026-11-20T10:00:00Z\",\"usageMetadata\":{\"promptTokenCount\":5,\"candidatesTokenCount\":1}}\n").unwrap();
        let b = dir
            .join("logs")
            .join("sessions")
            .join("p1")
            .join("s1")
            .join("segments");
        fs::create_dir_all(&b).unwrap();
        fs::write(b.join("run-1.jsonl"), "{\"type\":\"assistant\",\"uuid\":\"b\",\"sessionId\":\"s1\",\"model\":\"qwen\",\"timestamp\":\"2026-11-20T10:00:00Z\",\"usageMetadata\":{\"promptTokenCount\":7,\"candidatesTokenCount\":2}}\n").unwrap();
        let mut files = Vec::new();
        walk(&dir.join("projects"), &is_chat_file, &mut files);
        walk(
            &dir.join("logs").join("sessions"),
            &is_chat_file,
            &mut files,
        );
        assert_eq!(files.len(), 2);
        assert_eq!(
            project_of_file(&a.join("session-1.jsonl")).as_deref(),
            Some("proj")
        );
        assert_eq!(
            project_of_file(&b.join("run-1.jsonl")).as_deref(),
            Some("p1")
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn env_then_configured_then_home_and_a_repeat_is_read_once() {
        let root = temp_dir();
        let home = root.join("home");
        let custom = root.join("elsewhere").join("qwen");
        fs::create_dir_all(&custom).unwrap();
        let default = home.join(".qwen");
        // Default behaviour: the classic `~/.qwen` only.
        assert_eq!(data_roots_from(None, &[], &home), vec![default.clone()]);
        // The environment first, a configured folder second, `~/.qwen` last; a repeat read once.
        let env = root.join("env-qwen");
        assert_eq!(
            data_roots_from(Some(env.clone()), &[root.join("missing"), custom.clone()], &home),
            vec![env, custom, default.clone()]
        );
        assert_eq!(data_roots_from(None, &[default.clone()], &home), vec![default]);
        fs::remove_dir_all(&root).unwrap();
    }
}
