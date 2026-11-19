// Transcript readers. Formats and rules derived from T3 Code's usage readers (MIT, see NOTICE).
pub mod antigravity;
pub mod codex;
pub mod opencode;
pub mod others;

use crate::types::{parse_ts_ms, str_of, token_count, ReadResult, Record};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

pub struct FileInfo {
    pub path: PathBuf,
    pub size: f64,
    pub mtime_ms: f64,
}

pub trait Source: Send + Sync {
    fn provider(&self) -> &'static str;
    /// Directory shown as the source's location.
    fn dir(&self) -> PathBuf;
    fn files(&self) -> Vec<FileInfo>;
    /// Parse one file (or the whole database when `path` is the database).
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String>;
    /// The same session can sit in more than one file (for example moved to an archive): keep one copy.
    fn shared_sessions(&self) -> bool {
        false
    }
}

pub fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

pub fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).map(PathBuf::from)
}

pub fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

pub fn walk(root: &Path, accept: &dyn Fn(&str) -> bool, out: &mut Vec<FileInfo>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk(&path, accept, out);
        } else if path.file_name().and_then(|n| n.to_str()).is_some_and(accept) {
            out.push(FileInfo { path, size: meta.len() as f64, mtime_ms: mtime_ms(&meta) });
        }
    }
}

/// Lines of a transcript. Plain files stream through a buffer so a multi-hundred-megabyte log never
/// sits in memory whole; compressed archives are inflated one file at a time.
pub fn lines(path: &Path) -> Result<Box<dyn Iterator<Item = String>>, String> {
    if path.extension().and_then(|e| e.to_str()) == Some("zst") {
        let data = fs::read(path).map_err(|e| e.to_string())?;
        let text = zstd::decode_all(&data[..]).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&text).into_owned();
        let lines: Vec<String> = text.split('\n').map(str::to_string).collect();
        return Ok(Box::new(lines.into_iter()));
    }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut buf = Vec::new();
    Ok(Box::new(std::iter::from_fn(move || {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => None,
            Ok(_) => {
                if buf.last() == Some(&b'\n') {
                    buf.pop();
                }
                Some(String::from_utf8_lossy(&buf).into_owned())
            }
        }
    })))
}

// ---------------------------------------------------------------- Claude

const CLAUDE_SYNTHETIC: &str = "<synthetic>";

fn cache_creation_1h(usage: &Value) -> f64 {
    usage
        .get("cache_creation")
        .filter(|v| v.is_object())
        .map(|split| token_count(split.get("ephemeral_1h_input_tokens")))
        .unwrap_or(0.0)
}

pub fn parse_claude_line(line: &str) -> Vec<Record> {
    if !line.contains("\"usage\"") {
        return Vec::new();
    }
    let Ok(rec) = serde_json::from_str::<Value>(line) else { return Vec::new() };
    if rec.get("type").and_then(Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    let Some(message) = rec.get("message").filter(|v| v.is_object()) else { return Vec::new() };
    let Some(usage) = message.get("usage").filter(|v| v.is_object()) else { return Vec::new() };
    let Some(ts) = parse_ts_ms(rec.get("timestamp")) else { return Vec::new() };
    let model = str_of(message.get("model"));
    if model.is_empty() || model == CLAUDE_SYNTHETIC {
        return Vec::new();
    }
    let message_id = message.get("id").and_then(Value::as_str);
    let request_id = rec.get("requestId").and_then(Value::as_str);
    let key = if message_id.is_none() && request_id.is_none() {
        None
    } else {
        Some(format!("{}:{}", message_id.unwrap_or(""), request_id.unwrap_or("")))
    };
    let session = str_of(rec.get("sessionId"));
    let mut exec = Record::new("claude", ts, model, session);
    exec.uncached = token_count(usage.get("input_tokens"));
    exec.cached = token_count(usage.get("cache_read_input_tokens"));
    exec.cache_write = token_count(usage.get("cache_creation_input_tokens"));
    exec.output = token_count(usage.get("output_tokens"));
    exec.cache_1h = cache_creation_1h(usage);
    exec.reported = rec.get("costUSD").and_then(Value::as_f64).filter(|c| c.is_finite());
    exec.speed = if usage.get("speed").and_then(Value::as_str) == Some("fast") { 1 } else { 0 };
    exec.key = key.clone();
    let mut out = vec![exec.clone()];
    // Advisor calls run on another model at their own rates and only appear in `iterations`.
    if let Some(iterations) = usage.get("iterations").and_then(Value::as_array) {
        for (index, it) in iterations.iter().enumerate() {
            if it.get("type").and_then(Value::as_str) != Some("advisor_message") {
                continue;
            }
            let adv_model = str_of(it.get("model"));
            if adv_model.is_empty() || adv_model == CLAUDE_SYNTHETIC {
                continue;
            }
            let mut r = Record::new("claude", ts, adv_model, session);
            r.uncached = token_count(it.get("input_tokens"));
            r.cached = token_count(it.get("cache_read_input_tokens"));
            r.cache_write = token_count(it.get("cache_creation_input_tokens"));
            r.output = token_count(it.get("output_tokens"));
            r.cache_1h = cache_creation_1h(it);
            r.speed = exec.speed;
            r.key = key.as_ref().map(|k| format!("{k}:advisor:{index}"));
            out.push(r);
        }
    }
    out
}

/// Claude Code keeps one config directory per account (`~/.claude`, `~/.claude-work`, ...).
pub fn claude_config_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(env) = env_path("CLAUDE_CONFIG_DIR") {
        dirs.push(env);
    }
    if let Ok(entries) = fs::read_dir(home()) {
        let mut found: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                (name == ".claude" || name.starts_with(".claude-")) && e.path().join("projects").exists()
            })
            .map(|e| e.path())
            .collect();
        found.sort();
        for d in found {
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
    }
    dirs
}

pub struct Claude;

impl Source for Claude {
    fn provider(&self) -> &'static str {
        "claude"
    }
    fn dir(&self) -> PathBuf {
        claude_config_dirs().first().cloned().unwrap_or_else(|| home().join(".claude")).join("projects")
    }
    fn files(&self) -> Vec<FileInfo> {
        let mut out = Vec::new();
        for dir in claude_config_dirs() {
            walk(&dir.join("projects"), &|n| n.ends_with(".jsonl"), &mut out);
        }
        out
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let mut records = Vec::new();
        for line in lines(path)? {
            records.extend(parse_claude_line(&line).into_iter().filter(|r| r.ts >= since_ms));
        }
        Ok(ReadResult { records, malformed: 0 })
    }
}

pub fn all() -> Vec<Box<dyn Source>> {
    vec![
        Box::new(Claude),
        Box::new(codex::Codex),
        Box::new(opencode::OpenCode),
        Box::new(antigravity::Antigravity),
        Box::new(others::Grok),
        Box::new(others::Pi),
        Box::new(others::Muse),
    ]
}
