// Grok, Pi and Muse Code readers. Formats derived from T3 Code (MIT, see NOTICE).
use super::{env_path, home, lines, walk, FileInfo, Source};
use crate::types::{parse_ts_ms, str_of, token_count, ReadResult, Record};
use serde_json::Value;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------- Grok

const GROK_TICKS_PER_DOLLAR: f64 = 10_000_000_000.0;

fn grok_cost(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
        .filter(|t| t.is_finite() && *t >= 0.0)
        .map(|t| t / GROK_TICKS_PER_DOLLAR)
}

struct GrokTotals {
    input: f64,
    output: f64,
    cached_read: f64,
    cache_creation: f64,
    reasoning: f64,
    cost_ticks: Option<f64>,
}

fn read_grok_totals(v: &Value) -> Option<GrokTotals> {
    v.as_object()?;
    Some(GrokTotals {
        input: token_count(v.get("inputTokens")),
        output: token_count(v.get("outputTokens")),
        cached_read: token_count(v.get("cachedReadTokens")),
        cache_creation: token_count(v.get("cacheCreationTokens")),
        reasoning: token_count(v.get("reasoningTokens")),
        cost_ticks: v
            .get("costUsdTicks")
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite()),
    })
}

/// Grok reports `inputTokens` inclusive of the cached portion, like Codex.
fn apply_grok(r: &mut Record, t: &GrokTotals) {
    r.uncached = (t.input - t.cached_read - t.cache_creation).max(0.0);
    r.cached = t.cached_read;
    r.cache_write = t.cache_creation;
    r.output = t.output;
    r.reasoning = t.reasoning.min(t.output);
}

pub fn parse_grok_line(line: &str) -> Vec<Record> {
    if !line.contains("\"turn_completed\"") {
        return Vec::new();
    }
    let Ok(rec) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let Some(params) = rec.get("params").filter(|v| v.is_object()) else {
        return Vec::new();
    };
    let Some(update) = params.get("update").filter(|v| v.is_object()) else {
        return Vec::new();
    };
    if update.get("sessionUpdate").and_then(Value::as_str) != Some("turn_completed") {
        return Vec::new();
    }
    let Some(usage) = update.get("usage").filter(|v| v.is_object()) else {
        return Vec::new();
    };
    let session = str_of(params.get("sessionId"));
    let prompt_id = update.get("prompt_id").and_then(Value::as_str);
    let mut ts = params
        .pointer("/_meta/agentTimestampMs")
        .and_then(Value::as_f64)
        .filter(|t| t.is_finite());
    if ts.is_none() {
        if let Some(t) = rec
            .get("timestamp")
            .and_then(Value::as_f64)
            .filter(|t| t.is_finite())
        {
            ts = Some(if t > 1e12 { t } else { t * 1000.0 });
        }
    }
    let Some(ts) = ts else { return Vec::new() };
    let Some(top) = read_grok_totals(usage) else {
        return Vec::new();
    };

    let mut entries: Vec<(String, GrokTotals)> = Vec::new();
    if let Some(model_usage) = usage.get("modelUsage").and_then(Value::as_object) {
        for (model, raw) in model_usage {
            if model.is_empty() {
                continue;
            }
            if let Some(t) = read_grok_totals(raw) {
                entries.push((model.clone(), t));
            }
        }
    }
    let make = |model: &str, t: &GrokTotals, reported: Option<f64>| {
        let mut r = Record::new("grok", ts, model, session);
        apply_grok(&mut r, t);
        r.reported = reported;
        r.key = prompt_id.map(|p| format!("{session}:{p}:{}:{model}", ts as i64));
        r
    };
    if entries.is_empty() {
        let r = make(
            "grok",
            &top,
            grok_cost(top.cost_ticks.map(Value::from).as_ref()),
        );
        return if r.total_tokens() == 0.0 {
            Vec::new()
        } else {
            vec![r]
        };
    }
    let top_cost = grok_cost(top.cost_ticks.map(Value::from).as_ref());
    let mut ticked = 0.0;
    let mut unticked = 0.0;
    for (_, t) in &entries {
        let mut probe = Record::new("grok", ts, "", "");
        apply_grok(&mut probe, t);
        let tokens = probe.total_tokens();
        if tokens == 0.0 {
            continue;
        }
        match t.cost_ticks {
            Some(c) => ticked += grok_cost(Some(&Value::from(c))).unwrap_or(0.0),
            None => unticked += tokens,
        }
    }
    let remaining = top_cost.map(|c| (c - ticked).max(0.0));
    let mut out = Vec::new();
    for (model, t) in &entries {
        let mut r = make(model, t, None);
        let tokens = r.total_tokens();
        if tokens == 0.0 {
            continue;
        }
        let mut reported = t.cost_ticks.and_then(|c| grok_cost(Some(&Value::from(c))));
        if reported.is_none() {
            if let (Some(rem), true) = (remaining, unticked > 0.0) {
                reported = Some(rem * (tokens / unticked));
            }
        }
        r.reported = reported;
        out.push(r);
    }
    out
}

/// Grok homes: `GROK_HOME`, then folders configured in Settings (`providers.sources.grok`), then
/// `~/.grok`. Nothing is created; a folder reached twice is read once.
fn grok_homes() -> Vec<PathBuf> {
    grok_homes_from(env_path("GROK_HOME"), &super::sources::configured("grok"), &home())
}

/// The environment, configured and home part of `grok_homes`, with every input passed in.
fn grok_homes_from(env: Option<PathBuf>, configured: &[PathBuf], home: &Path) -> Vec<PathBuf> {
    use super::sources::push_unique;
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(env) = env {
        push_unique(&mut out, env);
    }
    for dir in configured.iter().filter(|d| d.is_dir()) {
        push_unique(&mut out, dir.clone());
    }
    push_unique(&mut out, home.join(".grok"));
    out
}

/// The sessions folders under the Grok homes; a home named `sessions` is its sessions folder too.
fn grok_session_dirs() -> Vec<PathBuf> {
    grok_homes().into_iter().map(|home| session_dir_of(&home)).collect()
}

pub struct Grok;

impl Source for Grok {
    fn provider(&self) -> &'static str {
        "grok"
    }
    fn dir(&self) -> PathBuf {
        grok_session_dirs().into_iter().next().unwrap_or_else(|| home().join(".grok").join("sessions"))
    }
    fn files(&self) -> Vec<FileInfo> {
        let mut out = Vec::new();
        // Only updates.jsonl carries usage; skip the large chat history and event logs.
        for dir in grok_session_dirs() {
            walk(&dir, &|n| n == "updates.jsonl", &mut out);
        }
        out
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let mut records = Vec::new();
        for line in lines(path)? {
            records.extend(
                parse_grok_line(&line)
                    .into_iter()
                    .filter(|r| r.ts >= since_ms),
            );
        }
        Ok(ReadResult {
            records,
            malformed: 0,
        })
    }
}

// ---------------------------------------------------------------- Pi

pub fn parse_pi_file(content: impl Iterator<Item = String>) -> Vec<Record> {
    let mut records = Vec::new();
    let mut session = String::new();
    for line in content {
        if !line.contains("\"usage\"") && !line.contains("\"session\"") {
            continue;
        }
        let Ok(e) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let kind = e.get("type").and_then(Value::as_str);
        if kind == Some("session") {
            if let Some(id) = e.get("id").and_then(Value::as_str) {
                session = id.to_string();
                continue;
            }
        }
        let (Some(id), Some(timestamp)) = (
            e.get("id").and_then(Value::as_str),
            e.get("timestamp").and_then(Value::as_str),
        ) else {
            continue;
        };
        let source: Option<&Value> = match kind {
            Some("message") => e.get("message").filter(|m| {
                matches!(
                    m.get("role").and_then(Value::as_str),
                    Some("assistant") | Some("toolResult")
                )
            }),
            Some("usage") | Some("compaction") | Some("branch_summary") => Some(&e),
            _ => None,
        };
        let Some(source) = source else { continue };
        let Some(usage) = source.get("usage").filter(|u| u.is_object()) else {
            continue;
        };
        let Some(ts) = parse_ts_ms(Some(&Value::from(timestamp))) else {
            continue;
        };
        let provider = source.get("provider").and_then(Value::as_str);
        let model_name = source.get("model").and_then(Value::as_str);
        let rate_model = match (provider, model_name) {
            (Some(_), Some(m)) => Some(
                source
                    .get("responseModel")
                    .and_then(Value::as_str)
                    .unwrap_or(m)
                    .to_string(),
            ),
            _ => None,
        };
        // Auxiliary tool and summary records lack model attribution.
        let model = match (provider, &rate_model) {
            (Some(p), Some(r)) => format!("{p}/{r}"),
            _ => "Tools/summaries".to_string(),
        };
        let output = token_count(usage.get("output"));
        let mut r = Record::new("pi", ts, &model, &session);
        // Pi's input and cache counters are already disjoint.
        r.uncached = token_count(usage.get("input"));
        r.cached = token_count(usage.get("cacheRead"));
        r.cache_write = token_count(usage.get("cacheWrite"));
        r.output = output;
        r.reasoning = token_count(usage.get("reasoning")).min(output);
        r.reported = usage
            .pointer("/cost/total")
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite() && *c > 0.0);
        r.rate_model = rate_model;
        if r.total_tokens() == 0.0 && r.reported.is_none() {
            continue;
        }
        // Forks keep ids and timestamps; the model keeps short random ids from colliding across sessions.
        r.key = Some(
            serde_json::to_string(&serde_json::json!(["pi", id, timestamp, model]))
                .unwrap_or_default(),
        );
        records.push(r);
    }
    records
}

/// Pi session folders: `PI_CODING_AGENT_SESSION_DIR`, then `PI_CODING_AGENT_DIR/sessions`, then
/// folders configured in Settings (`providers.sources.pi`), then `~/.pi/agent/sessions`. Nothing
/// is created; a folder reached twice is read once.
fn pi_session_dirs() -> Vec<PathBuf> {
    pi_session_dirs_from(
        env_path("PI_CODING_AGENT_SESSION_DIR"),
        env_path("PI_CODING_AGENT_DIR"),
        &super::sources::configured("pi"),
        &home(),
    )
}

/// The environment, configured and home part of `pi_session_dirs`, with every input passed in.
fn pi_session_dirs_from(
    explicit: Option<PathBuf>,
    agent_dir: Option<PathBuf>,
    configured: &[PathBuf],
    home: &Path,
) -> Vec<PathBuf> {
    use super::sources::push_unique;
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(dir) = explicit {
        push_unique(&mut out, dir);
    }
    if let Some(dir) = agent_dir {
        push_unique(&mut out, dir.join("sessions"));
    }
    for dir in configured.iter().filter(|d| d.is_dir()) {
        // Accept the sessions folder itself, an agent folder (its `sessions` child), or any folder
        // holding the session files directly; `~/.pi` is best pasted as `~/.pi/agent`.
        let sessions = session_dir_of(dir);
        push_unique(&mut out, sessions);
    }
    push_unique(&mut out, home.join(".pi").join("agent").join("sessions"));
    out
}

/// The sessions folder a pasted folder names: the folder itself when it is called `sessions`,
/// otherwise its `sessions` child (an agent folder).
fn session_dir_of(dir: &Path) -> PathBuf {
    if dir.file_name().is_some_and(|n| n == "sessions") {
        dir.to_path_buf()
    } else {
        dir.join("sessions")
    }
}

pub struct Pi;

impl Source for Pi {
    fn provider(&self) -> &'static str {
        "pi"
    }
    fn dir(&self) -> PathBuf {
        pi_session_dirs()
            .into_iter()
            .next()
            .unwrap_or_else(|| home().join(".pi").join("agent").join("sessions"))
    }
    fn files(&self) -> Vec<FileInfo> {
        let mut out = Vec::new();
        for dir in pi_session_dirs() {
            walk(&dir, &|n| n.ends_with(".jsonl"), &mut out);
        }
        out
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let mut records = parse_pi_file(lines(path)?);
        records.retain(|r| r.ts >= since_ms);
        Ok(ReadResult {
            records,
            malformed: 0,
        })
    }
}

// ---------------------------------------------------------------- Muse

pub fn parse_muse_line(line: &str) -> Vec<Record> {
    if !line.contains("\"model_completed\"") && !line.contains("\"automated_review_completed\"") {
        return Vec::new();
    }
    let Ok(e) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    if e.get("schema_version").and_then(Value::as_i64) != Some(1)
        || e.get("record_type").and_then(Value::as_str) != Some("event")
        || e.get("payload_type").and_then(Value::as_str) != Some("runtime.session")
    {
        return Vec::new();
    }
    let Some(recorded_at) = e
        .get("recorded_at")
        .and_then(Value::as_i64)
        .filter(|t| *t >= 0)
    else {
        return Vec::new();
    };
    let Some(id) = e.get("id").and_then(Value::as_str) else {
        return Vec::new();
    };
    let Some(stream_id) = e.pointer("/stream/id").and_then(Value::as_str) else {
        return Vec::new();
    };
    let Some(event) = e.pointer("/payload/event").filter(|v| v.is_object()) else {
        return Vec::new();
    };
    if !matches!(
        event.get("kind").and_then(Value::as_str),
        Some("model_completed") | Some("automated_review_completed")
    ) {
        return Vec::new();
    }
    let model = match event.get("model") {
        Some(Value::String(s)) => s.clone(),
        Some(v) => str_of(v.get("model_id")).to_string(),
        None => String::new(),
    };
    let Some(usage) = event.get("usage").filter(|u| u.is_object()) else {
        return Vec::new();
    };
    if model.is_empty() {
        return Vec::new();
    }
    let input = token_count(usage.get("input_tokens"));
    let cache_read = usage
        .get("cache_read_tokens")
        .or_else(|| usage.get("cached_input_tokens"))
        .or_else(|| usage.get("cached_tokens"));
    let cached = input.min(token_count(cache_read));
    let written = (input - cached).min(token_count(usage.get("cache_write_tokens")));
    let output = token_count(usage.get("output_tokens"));
    // recorded_at is in microseconds.
    let mut r = Record::new("muse", (recorded_at / 1000) as f64, &model, stream_id);
    // Muse's cache counters are subsets of input; reasoning is a subset of output.
    r.uncached = input - cached - written;
    r.cached = cached;
    r.cache_write = written;
    r.output = output;
    r.reasoning = token_count(usage.get("reasoning_tokens")).min(output);
    if r.total_tokens() == 0.0 {
        return Vec::new();
    }
    let source = e
        .pointer("/payload/source_run_record_id")
        .and_then(Value::as_str)
        .unwrap_or(id);
    // Envelopes can be copied into another session; the source record identifies the inference.
    r.key = Some(serde_json::to_string(&serde_json::json!(["muse", source])).unwrap_or_default());
    vec![r]
}

/// Muse homes: `MUSE_HOME`, then folders configured in Settings (`providers.sources.muse`), then
/// Muse's real store (`$XDG_DATA_HOME/muse` or `~/.local/share/muse`, the same home-relative path
/// on Windows, macOS and Linux), and finally `~/.muse` as installed by older releases. Nothing is
/// created; a folder reached twice is read once.
fn muse_homes() -> Vec<PathBuf> {
    muse_homes_from(env_path("MUSE_HOME"), env_path("XDG_DATA_HOME"), &super::sources::configured("muse"), &home())
}

/// The environment, configured and home part of `muse_homes`, with every input passed in.
fn muse_homes_from(env: Option<PathBuf>, xdg: Option<PathBuf>, configured: &[PathBuf], home: &Path) -> Vec<PathBuf> {
    use super::sources::push_unique;
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(env) = env {
        push_unique(&mut out, env);
    }
    for dir in configured.iter().filter(|d| d.is_dir()) {
        push_unique(&mut out, dir.clone());
    }
    if let Some(dir) = xdg {
        push_unique(&mut out, dir.join("muse"));
    }
    push_unique(&mut out, home.join(".local").join("share").join("muse"));
    push_unique(&mut out, home.join(".muse"));
    out
}

/// The sessions folders under the Muse homes; a home named `sessions` is its sessions folder too.
fn muse_session_dirs() -> Vec<PathBuf> {
    muse_homes().into_iter().map(|home| session_dir_of(&home)).collect()
}

pub struct Muse;

impl Source for Muse {
    fn provider(&self) -> &'static str {
        "muse"
    }
    fn dir(&self) -> PathBuf {
        muse_session_dirs().into_iter().next().unwrap_or_else(|| home().join(".muse").join("sessions"))
    }
    fn files(&self) -> Vec<FileInfo> {
        let mut out = Vec::new();
        for dir in muse_session_dirs() {
            walk(&dir, &|n| n == "session.jsonl", &mut out);
        }
        out
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let mut records = Vec::new();
        for line in lines(path)? {
            records.extend(
                parse_muse_line(&line)
                    .into_iter()
                    .filter(|r| r.ts >= since_ms),
            );
        }
        Ok(ReadResult {
            records,
            malformed: 0,
        })
    }
}


// ---------------------------------------------------------------- Local log stats

/// What Pi's and Muse's own files on this computer say, counted without inventing a number: the
/// session logs found (one file is one session for both), the newest of them, and the folder that
/// holds the newest log. `None` when unseen or the provider has no countable log.
pub fn local_log_stats(id: &str) -> Option<crate::providers::LocalLogStats> {
    match id {
        "pi" => local_log_stats_in(&|n| n.ends_with(".jsonl"), &pi_session_dirs()),
        "muse" => local_log_stats_in(&|n| n == "session.jsonl", &muse_session_dirs()),
        _ => None,
    }
}

/// The counting part of `local_log_stats`, with the file test and candidate folders passed in.
fn local_log_stats_in(accept: &dyn Fn(&str) -> bool, dirs: &[PathBuf]) -> Option<crate::providers::LocalLogStats> {
    // The folder to open is the one holding the newest log, so an empty first candidate does not
    // point "Open data folder" at a folder with nothing in it. With no logs at all, the first
    // existing candidate is still an honest answer (the agent's folder is there, just unused).
    let mut folder = dirs.iter().find(|d| d.is_dir())?.clone();
    let mut sessions = 0usize;
    let mut last_used_ms: Option<f64> = None;
    for dir in dirs {
        let mut files = Vec::new();
        walk(dir, accept, &mut files);
        sessions += files.len();
        if let Some(newest) = files.iter().map(|f| f.mtime_ms).reduce(f64::max) {
            if last_used_ms.is_none_or(|t| newest > t) {
                last_used_ms = Some(newest);
                folder = dir.clone();
            }
        }
    }
    Some(crate::providers::LocalLogStats {
        sessions: sessions.min(u32::MAX as usize) as u32,
        last_used_ms,
        folder,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("burnrate-others-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn env_then_configured_then_home_and_a_repeat_is_read_once() {
        let root = temp_dir("homes");
        let home = root.join("home");
        let custom = root.join("elsewhere").join("agent-data");
        fs::create_dir_all(&custom).unwrap();
        let default = |agent: &str| home.join(format!(".{agent}"));
        let muse_store = home.join(".local").join("share").join("muse");
        // Grok keeps the classic shape: env, then configured, then `~/.grok`.
        let grok_env = root.join("env-grok");
        assert_eq!(
            grok_homes_from(Some(grok_env.clone()), &[root.join("missing"), custom.clone()], &home),
            vec![grok_env, custom.clone(), default("grok")]
        );
        // Muse's real store comes before the `~/.muse` of older releases; XDG moves it.
        let muse_env = root.join("env-muse");
        assert_eq!(
            muse_homes_from(Some(muse_env.clone()), None, &[root.join("missing"), custom.clone()], &home),
            vec![muse_env, custom, muse_store.clone(), default("muse")]
        );
        let xdg = root.join("xdg-data");
        assert_eq!(
            muse_homes_from(None, Some(xdg.clone()), &[], &home),
            vec![xdg.join("muse"), muse_store.clone(), default("muse")]
        );
        // A default folder named in the list is read once, not twice.
        assert_eq!(grok_homes_from(None, &[default("grok")], &home), vec![default("grok")]);
        fs::create_dir_all(&muse_store).unwrap();
        assert_eq!(muse_homes_from(None, None, &[muse_store.clone()], &home), vec![muse_store, default("muse")]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn local_stats_count_sessions_newest_file_and_the_folder_holding_them() {
        let root = temp_dir("stats");
        let empty = root.join("agent").join("sessions");
        fs::create_dir_all(&empty).unwrap();
        let sessions = root.join("elsewhere").join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(sessions.join("a-older.jsonl"), "{}\n").unwrap();
        fs::write(sessions.join("b.jsonl"), "{}\n").unwrap();
        fs::write(sessions.join("notes.txt"), "not a session\n").unwrap();
        let missing = root.join("missing");
        // The folder shown is the one with the logs, not an earlier empty candidate.
        let stats =
            local_log_stats_in(&|n| n.ends_with(".jsonl"), &[missing.clone(), empty.clone(), sessions.clone()]).unwrap();
        assert_eq!(stats.sessions, 2);
        assert_eq!(stats.folder, sessions);
        assert!(stats.last_used_ms.is_some_and(|t| t > 0.0));
        // No logs anywhere: the first existing folder is still honest, with zero sessions.
        let empty_stats = local_log_stats_in(&|n| n.ends_with(".jsonl"), &[missing.clone(), empty.clone()]).unwrap();
        assert_eq!(empty_stats.sessions, 0);
        assert_eq!(empty_stats.folder, empty);
        assert!(empty_stats.last_used_ms.is_none());
        // Nothing found: no stats, nothing invented. A provider without a countable log reports none.
        assert!(local_log_stats_in(&|n| n.ends_with(".jsonl"), &[missing]).is_none());
        assert!(local_log_stats("claude").is_none(), "no countable log outside Pi and Muse today");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn pi_accepts_the_agent_or_sessions_folder_itself() {
        let root = temp_dir("pi");
        let home = root.join("home");
        let agent = root.join("elsewhere").join("agent");
        let sessions = agent.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let pi_default = home.join(".pi").join("agent").join("sessions");
        // Default behaviour: the classic `~/.pi/agent/sessions` only.
        assert_eq!(pi_session_dirs_from(None, None, &[], &home), vec![pi_default.clone()]);
        // The explicit sessions dir wins; the agent dir's `sessions` child reaches it once; the
        // platform default stays last even when it does not exist (nothing is created for it).
        assert_eq!(
            pi_session_dirs_from(Some(sessions.clone()), Some(agent.clone()), &[agent.clone()], &home),
            vec![sessions.clone(), pi_default.clone()]
        );
        // A configured agent folder resolves its `sessions` child before the platform default.
        assert_eq!(
            pi_session_dirs_from(None, Some(agent.clone()), &[root.join("missing")], &home),
            vec![sessions.clone(), pi_default.clone()]
        );
        fs::remove_dir_all(&root).unwrap();
    }
}
