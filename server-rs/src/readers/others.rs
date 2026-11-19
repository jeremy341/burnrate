// Grok, Pi and Muse Code readers. Formats derived from T3 Code (MIT, see NOTICE).
use super::{env_path, home, lines, walk, FileInfo, Source};
use crate::types::{parse_ts_ms, str_of, token_count, ReadResult, Record};
use serde_json::Value;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------- Grok

const GROK_TICKS_PER_DOLLAR: f64 = 10_000_000_000.0;

fn grok_cost(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|t| t.is_finite() && *t >= 0.0).map(|t| t / GROK_TICKS_PER_DOLLAR)
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
        cost_ticks: v.get("costUsdTicks").and_then(Value::as_f64).filter(|c| c.is_finite()),
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
    let Ok(rec) = serde_json::from_str::<Value>(line) else { return Vec::new() };
    let Some(params) = rec.get("params").filter(|v| v.is_object()) else { return Vec::new() };
    let Some(update) = params.get("update").filter(|v| v.is_object()) else { return Vec::new() };
    if update.get("sessionUpdate").and_then(Value::as_str) != Some("turn_completed") {
        return Vec::new();
    }
    let Some(usage) = update.get("usage").filter(|v| v.is_object()) else { return Vec::new() };
    let session = str_of(params.get("sessionId"));
    let prompt_id = update.get("prompt_id").and_then(Value::as_str);
    let mut ts = params.pointer("/_meta/agentTimestampMs").and_then(Value::as_f64).filter(|t| t.is_finite());
    if ts.is_none() {
        if let Some(t) = rec.get("timestamp").and_then(Value::as_f64).filter(|t| t.is_finite()) {
            ts = Some(if t > 1e12 { t } else { t * 1000.0 });
        }
    }
    let Some(ts) = ts else { return Vec::new() };
    let Some(top) = read_grok_totals(usage) else { return Vec::new() };

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
        let r = make("grok", &top, grok_cost(top.cost_ticks.map(Value::from).as_ref()));
        return if r.total_tokens() == 0.0 { Vec::new() } else { vec![r] };
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

fn grok_home() -> PathBuf {
    env_path("GROK_HOME").unwrap_or_else(|| home().join(".grok"))
}

pub struct Grok;

impl Source for Grok {
    fn provider(&self) -> &'static str {
        "grok"
    }
    fn dir(&self) -> PathBuf {
        grok_home().join("sessions")
    }
    fn files(&self) -> Vec<FileInfo> {
        let mut out = Vec::new();
        // Only updates.jsonl carries usage; skip the large chat history and event logs.
        walk(&self.dir(), &|n| n == "updates.jsonl", &mut out);
        out
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let mut records = Vec::new();
        for line in lines(path)? {
            records.extend(parse_grok_line(&line).into_iter().filter(|r| r.ts >= since_ms));
        }
        Ok(ReadResult { records, malformed: 0 })
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
        let Ok(e) = serde_json::from_str::<Value>(&line) else { continue };
        let kind = e.get("type").and_then(Value::as_str);
        if kind == Some("session") {
            if let Some(id) = e.get("id").and_then(Value::as_str) {
                session = id.to_string();
                continue;
            }
        }
        let (Some(id), Some(timestamp)) = (e.get("id").and_then(Value::as_str), e.get("timestamp").and_then(Value::as_str)) else { continue };
        let source: Option<&Value> = match kind {
            Some("message") => e.get("message").filter(|m| matches!(m.get("role").and_then(Value::as_str), Some("assistant") | Some("toolResult"))),
            Some("usage") | Some("compaction") | Some("branch_summary") => Some(&e),
            _ => None,
        };
        let Some(source) = source else { continue };
        let Some(usage) = source.get("usage").filter(|u| u.is_object()) else { continue };
        let Some(ts) = parse_ts_ms(Some(&Value::from(timestamp))) else { continue };
        let provider = source.get("provider").and_then(Value::as_str);
        let model_name = source.get("model").and_then(Value::as_str);
        let rate_model = match (provider, model_name) {
            (Some(_), Some(m)) => Some(source.get("responseModel").and_then(Value::as_str).unwrap_or(m).to_string()),
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
        r.reported = usage.pointer("/cost/total").and_then(Value::as_f64).filter(|c| c.is_finite() && *c > 0.0);
        r.rate_model = rate_model;
        if r.total_tokens() == 0.0 && r.reported.is_none() {
            continue;
        }
        // Forks keep ids and timestamps; the model keeps short random ids from colliding across sessions.
        r.key = Some(serde_json::to_string(&serde_json::json!(["pi", id, timestamp, model])).unwrap_or_default());
        records.push(r);
    }
    records
}

fn pi_sessions_dir() -> PathBuf {
    if let Some(d) = env_path("PI_CODING_AGENT_SESSION_DIR") {
        return d;
    }
    env_path("PI_CODING_AGENT_DIR").unwrap_or_else(|| home().join(".pi").join("agent")).join("sessions")
}

pub struct Pi;

impl Source for Pi {
    fn provider(&self) -> &'static str {
        "pi"
    }
    fn dir(&self) -> PathBuf {
        pi_sessions_dir()
    }
    fn files(&self) -> Vec<FileInfo> {
        let mut out = Vec::new();
        walk(&self.dir(), &|n| n.ends_with(".jsonl"), &mut out);
        out
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let mut records = parse_pi_file(lines(path)?);
        records.retain(|r| r.ts >= since_ms);
        Ok(ReadResult { records, malformed: 0 })
    }
}

// ---------------------------------------------------------------- Muse

pub fn parse_muse_line(line: &str) -> Vec<Record> {
    if !line.contains("\"model_completed\"") && !line.contains("\"automated_review_completed\"") {
        return Vec::new();
    }
    let Ok(e) = serde_json::from_str::<Value>(line) else { return Vec::new() };
    if e.get("schema_version").and_then(Value::as_i64) != Some(1)
        || e.get("record_type").and_then(Value::as_str) != Some("event")
        || e.get("payload_type").and_then(Value::as_str) != Some("runtime.session")
    {
        return Vec::new();
    }
    let Some(recorded_at) = e.get("recorded_at").and_then(Value::as_i64).filter(|t| *t >= 0) else { return Vec::new() };
    let Some(id) = e.get("id").and_then(Value::as_str) else { return Vec::new() };
    let Some(stream_id) = e.pointer("/stream/id").and_then(Value::as_str) else { return Vec::new() };
    let Some(event) = e.pointer("/payload/event").filter(|v| v.is_object()) else { return Vec::new() };
    if !matches!(event.get("kind").and_then(Value::as_str), Some("model_completed") | Some("automated_review_completed")) {
        return Vec::new();
    }
    let model = match event.get("model") {
        Some(Value::String(s)) => s.clone(),
        Some(v) => str_of(v.get("model_id")).to_string(),
        None => String::new(),
    };
    let Some(usage) = event.get("usage").filter(|u| u.is_object()) else { return Vec::new() };
    if model.is_empty() {
        return Vec::new();
    }
    let input = token_count(usage.get("input_tokens"));
    let cache_read = usage.get("cache_read_tokens").or_else(|| usage.get("cached_input_tokens")).or_else(|| usage.get("cached_tokens"));
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
    let source = e.pointer("/payload/source_run_record_id").and_then(Value::as_str).unwrap_or(id);
    // Envelopes can be copied into another session; the source record identifies the inference.
    r.key = Some(serde_json::to_string(&serde_json::json!(["muse", source])).unwrap_or_default());
    vec![r]
}

fn muse_home() -> PathBuf {
    env_path("MUSE_HOME").unwrap_or_else(|| home().join(".muse"))
}

pub struct Muse;

impl Source for Muse {
    fn provider(&self) -> &'static str {
        "muse"
    }
    fn dir(&self) -> PathBuf {
        muse_home().join("sessions")
    }
    fn files(&self) -> Vec<FileInfo> {
        let mut out = Vec::new();
        walk(&self.dir(), &|n| n == "session.jsonl", &mut out);
        out
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let mut records = Vec::new();
        for line in lines(path)? {
            records.extend(parse_muse_line(&line).into_iter().filter(|r| r.ts >= since_ms));
        }
        Ok(ReadResult { records, malformed: 0 })
    }
}
