// Transcript readers. Formats and rules derived from T3 Code's usage readers (MIT, see NOTICE).
pub mod antigravity;
pub mod cline;
pub mod codex;
pub mod copilot;
pub mod crush;
pub mod gemini;
pub mod goose;
pub mod opencode;
pub mod others;
pub mod project;
pub mod qwen;
pub mod sources;
pub mod vibe;

use crate::types::{parse_ts_ms, str_of, token_count, ReadResult, Record};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

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

/// Read a text transcript with a hard size cap so a corrupt/huge file cannot
/// exhaust memory. Used by the JSON/JSONL readers added in package 09.
pub fn read_text(path: &Path, max_bytes: u64) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > max_bytes {
        return Err(format!("transcript too large: {} bytes", meta.len()));
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(target_os = "linux")]
fn wsl_user_homes() -> Vec<PathBuf> {
    // UNVERIFIED on Linux: WSL mount points and drive letters vary by setup;
    // a missing mount simply yields no candidates.
    let mut out = Vec::new();
    for drive in ["/mnt/c/Users", "/mnt/d/Users"] {
        if let Ok(entries) = fs::read_dir(drive) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    out.push(entry.path());
                }
            }
        }
    }
    out
}

/// Candidate config directories for an agent, on Windows, Linux and (when
/// running under WSL) the mounted Windows user profile. The first candidate
/// that actually contains data wins in each reader; none of them are created.
pub fn config_dirs(app: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |path: PathBuf| {
        if !out.contains(&path) {
            out.push(path);
        }
    };
    push(home().join(format!(".{app}")));
    if let Some(xdg) = env_path("XDG_CONFIG_HOME") {
        push(xdg.join(app));
    }
    push(home().join(".config").join(app));
    if let Some(xdg) = env_path("XDG_DATA_HOME") {
        push(xdg.join(app));
    }
    push(home().join(".local").join("share").join(app));
    #[cfg(target_os = "macos")]
    {
        // macOS convention: many agents keep their data under Application Support rather than
        // the XDG locations, so look there too.
        push(home().join("Library").join("Application Support").join(app));
    }
    #[cfg(target_os = "linux")]
    {
        // UNVERIFIED on Linux: see wsl_user_homes().
        for user_home in wsl_user_homes() {
            push(user_home.join(format!(".{app}")));
            push(user_home.join(".config").join(app));
            push(user_home.join(".local").join("share").join(app));
        }
    }
    out
}

/// `FileInfo` for a SQLite database, accounting for WAL/SHM churn so a live
/// database is re-read when its committed state changes.
pub fn db_file(path: &Path) -> FileInfo {
    let (mut size, mut mtime): (f64, f64) = (0.0, 0.0);
    for candidate in [path.to_path_buf(), PathBuf::from(format!("{}-wal", path.display())), PathBuf::from(format!("{}-shm", path.display()))] {
        if let Ok(meta) = fs::metadata(&candidate) {
            size += meta.len() as f64;
            mtime = mtime.max(mtime_ms(&meta));
        }
    }
    FileInfo { path: path.to_path_buf(), size, mtime_ms: mtime }
}

pub fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        // Whole milliseconds: the scan cache stores this as JSON, and a fractional f64 does not always
        // survive a text round trip bit-for-bit, which made roughly one file in ten look "changed" on
        // every restart and be parsed again.
        .map_or(0.0, |d| d.as_millis() as f64)
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

/// Cap on decompressed bytes from a compressed transcript: a small `.zst` bomb must not exhaust
/// memory. Plain files are not capped because they are streamed line by line.
const MAX_ZST_BYTES: u64 = 256 * 1024 * 1024;

/// Stops a decompressor after a byte budget and records whether truncation actually happened.
struct Limited<R> {
    inner: R,
    remaining: u64,
    truncated: Arc<AtomicBool>,
}

impl<R: Read> Read for Limited<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.remaining == 0 {
            let mut probe = [0u8; 1];
            if self.inner.read(&mut probe)? > 0 {
                self.truncated.store(true, Ordering::Relaxed);
            }
            return Ok(0);
        }
        let limit = (buf.len() as u64).min(self.remaining) as usize;
        let read = self.inner.read(&mut buf[..limit])?;
        self.remaining -= read as u64;
        Ok(read)
    }
}

/// Line iterator that counts read/decompression errors instead of silently truncating a file.
struct LineIter<R: Read> {
    reader: BufReader<R>,
    errors: Arc<AtomicU32>,
    truncated: Arc<AtomicBool>,
    buf: Vec<u8>,
}

impl<R: Read> Iterator for LineIter<R> {
    type Item = String;

    fn next(&mut self) -> Option<String> {
        if self.truncated.swap(false, Ordering::Relaxed) {
            self.errors.fetch_add(1, Ordering::Relaxed);
        }
        self.buf.clear();
        match self.reader.read_until(b'\n', &mut self.buf) {
            Ok(0) => None,
            Ok(_) => {
                if self.buf.last() == Some(&b'\n') {
                    self.buf.pop();
                }
                Some(String::from_utf8_lossy(&self.buf).into_owned())
            }
            Err(_) => {
                self.errors.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }
}

/// Lines of a transcript. Plain and compressed files both stream through a buffer; compressed
/// input is additionally capped at `MAX_ZST_BYTES` decompressed bytes. The returned counter tracks
/// I/O/decompression errors and truncation so callers can report them as malformed records.
fn lines_counted(path: &Path) -> Result<(Box<dyn Iterator<Item = String>>, Arc<AtomicU32>), String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let errors = Arc::new(AtomicU32::new(0));
    let truncated = Arc::new(AtomicBool::new(false));
    let raw: Box<dyn Read> = if path.extension().and_then(|e| e.to_str()) == Some("zst") {
        let decoder = zstd::stream::read::Decoder::new(BufReader::with_capacity(1 << 20, file)).map_err(|e| e.to_string())?;
        Box::new(Limited { inner: decoder, remaining: MAX_ZST_BYTES, truncated: truncated.clone() })
    } else {
        Box::new(file)
    };
    let reader = BufReader::with_capacity(1 << 20, raw);
    let iter = LineIter { reader, errors: errors.clone(), truncated, buf: Vec::new() };
    Ok((Box::new(iter), errors))
}

/// Convenience form for readers that do not track malformed records.
pub fn lines(path: &Path) -> Result<Box<dyn Iterator<Item = String>>, String> {
    lines_counted(path).map(|(iter, _)| iter)
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
/// Order: `CLAUDE_CONFIG_DIR`, then directories configured in Settings (`providers.sources.claude`), then
/// automatic discovery. See `sources` for the precedence rules.
pub fn claude_config_dirs() -> Vec<PathBuf> {
    let mut dirs = claude_dirs_from(env_path("CLAUDE_CONFIG_DIR"), &sources::configured("claude"), &home());
    // Linux/WSL: XDG config/data dirs and mounted Windows profiles.
    for candidate in config_dirs("claude") {
        if candidate.join("projects").exists() {
            sources::push_unique(&mut dirs, candidate);
        }
    }
    dirs
}

/// The environment, configured and home-directory part of `claude_config_dirs`, with every input passed in.
fn claude_dirs_from(env: Option<PathBuf>, configured: &[PathBuf], home: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(env) = env {
        sources::push_unique(&mut dirs, env);
    }
    for dir in configured {
        // Accept the `projects` folder itself: that is the folder people see the transcripts in.
        let dir = if dir.file_name().is_some_and(|n| n == "projects") { dir.parent().map_or_else(|| dir.clone(), Path::to_path_buf) } else { dir.clone() };
        if dir.is_dir() {
            sources::push_unique(&mut dirs, dir);
        }
    }
    if let Ok(entries) = fs::read_dir(home) {
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
            sources::push_unique(&mut dirs, d);
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
        let mut malformed = 0u32;
        let (lines, errors) = lines_counted(path)?;
        for line in lines {
            if !line.contains("\"usage\"") {
                continue;
            }
            let parsed = parse_claude_line(&line);
            if parsed.is_empty() && claude_usage_line_is_malformed(&line) {
                malformed += 1;
            }
            records.extend(parsed.into_iter().filter(|r| r.ts >= since_ms));
        }
        Ok(ReadResult { records, malformed: malformed + errors.load(Ordering::Relaxed) })
    }
}

/// True for a line that claims to be an assistant turn with a usage object but produced no record.
fn claude_usage_line_is_malformed(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line) else { return true };
    let Some(obj) = value.as_object() else { return false };
    obj.get("type").and_then(Value::as_str) == Some("assistant")
        && obj.get("message").and_then(Value::as_object).and_then(|m| m.get("usage")).is_some_and(Value::is_object)
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
        // Package 09: additional local-log readers (all behind the same Source trait).
        Box::new(gemini::GeminiCli),
        Box::new(qwen::QwenCode),
        Box::new(copilot::Copilot),
        Box::new(cline::Cline),
        Box::new(cline::Roo),
        Box::new(cline::Kilo),
        Box::new(crush::Crush),
        Box::new(goose::Goose),
        // Mistral Vibe session index (every ~/.vibe* directory), attributed to the `mistral` provider.
        Box::new(vibe::Vibe),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn temp_dir() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("burnrate-readers-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn compressed_and_plain_lines_stream_alike() {
        let dir = temp_dir();
        let text = "first\nsecond\n";
        let plain = dir.join("a.jsonl");
        fs::write(&plain, text).unwrap();
        let compressed = dir.join("a.jsonl.zst");
        fs::write(&compressed, zstd::encode_all(text.as_bytes(), 0).unwrap()).unwrap();
        for path in [&plain, &compressed] {
            let got: Vec<String> = lines(path).unwrap().collect();
            assert_eq!(got, vec!["first", "second"]);
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn claude_reports_unparsable_usage_lines_as_malformed() {
        let dir = temp_dir();
        let path = dir.join("transcript.jsonl");
        let valid = r#"{"type":"assistant","timestamp":"2026-11-20T00:00:00Z","message":{"id":"m1","model":"claude-3","usage":{"input_tokens":10,"output_tokens":5}}}"#;
        let malformed = r#"{"type":"assistant","message":{"usage":{"input_tokens":1}}}"#;
        fs::write(&path, format!("{valid}\n{malformed}\n")).unwrap();
        let result = Claude.read(&path, 0.0).unwrap();
        assert_eq!(result.records.len(), 1);
        assert_eq!(result.malformed, 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn claude_dirs_default_to_home_discovery_and_a_configured_dir_is_added() {
        let root = temp_dir();
        let home = root.join("home");
        let default = home.join(".claude");
        let second = home.join(".claude-work");
        let custom = root.join("elsewhere").join("claude-b");
        for dir in [&default, &second, &custom] {
            fs::create_dir_all(dir.join("projects")).unwrap();
        }
        fs::create_dir_all(home.join(".claude-empty")).unwrap(); // no projects/: not discovered
        // Default behaviour: nothing configured, only the home scan, sorted.
        assert_eq!(claude_dirs_from(None, &[], &home), vec![default.clone(), second.clone()]);
        // A configured directory outside home is read too, after the environment one and before discovery.
        let env = root.join("env-config");
        fs::create_dir_all(&env).unwrap();
        assert_eq!(
            claude_dirs_from(Some(env.clone()), &[custom.clone()], &home),
            vec![env, custom.clone(), default.clone(), second.clone()]
        );
        // The `projects` folder itself is accepted, a missing folder is skipped, a repeat is read once.
        let configured = [custom.join("projects"), root.join("missing"), default.clone()];
        assert_eq!(claude_dirs_from(None, &configured, &home), vec![custom, default, second]);
        fs::remove_dir_all(&root).unwrap();
    }
}
