// Codex reader: a port of T3 Code's state machine over `token_count` events (MIT, see NOTICE).
// `token_count` events carry neither model nor service tier, so both are carried forward from the
// most recent `turn_context` and `thread_settings_applied`. Forked sessions copy their parent's
// history right after the session meta; that copy is already billed in the parent.
use super::{config_dirs, env_path, home, lines, walk, FileInfo, Source};
use crate::types::{parse_ts_ms, ReadResult, Record};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// input, cached input, cache write, output, reasoning output, total.
type Cu = [f64; 6];
const KEYS: [&str; 6] = [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
];

fn read_usage(value: Option<&Value>) -> Option<Cu> {
    let raw = value?.as_object()?;
    let input = raw.get("input_tokens")?.as_f64()?;
    let output = raw.get("output_tokens")?.as_f64()?;
    let num = |k: &str, d: f64| raw.get(k).and_then(Value::as_f64).unwrap_or(d);
    let u = [
        input,
        num(KEYS[1], 0.0),
        num(KEYS[2], 0.0),
        output,
        num(KEYS[4], 0.0),
        num(KEYS[5], input + output),
    ];
    let ok = u.iter().all(|v| v.fract() == 0.0 && *v >= 0.0) && u[1] + u[2] <= u[0] && u[4] <= u[3];
    ok.then_some(u)
}

fn speed_of(tier: Option<&Value>) -> u8 {
    match tier.and_then(Value::as_str) {
        Some("priority") | Some("fast") => 1,
        Some("ultrafast") => 2,
        _ => 0,
    }
}

#[derive(Clone)]
struct Attribution {
    ts: f64,
    model: String,
    speed: u8,
}

#[derive(Clone)]
struct Unreported {
    attr: Attribution,
    usage: Cu,
}

struct State {
    model: String,
    speed: u8,
    session: String,
    last_signature: Option<String>,
    last_cumulative: Option<Cu>,
    sequence_start: Option<String>,
    latest_at: Option<f64>,
    unreported: Option<Vec<Unreported>>,
    ledger_active: bool,
    malformed: u32,
    saw_meta: bool,
    suppressing: bool,
    anchor_ms: f64,
}

const FORK_COPY_MAX_GAP_MS: f64 = 1000.0;

fn advance(previous: Option<Cu>, last: &Cu) -> Option<Cu> {
    let p = previous.unwrap_or([0.0; 6]);
    let sum: Cu = std::array::from_fn(|i| p[i] + last[i]);
    // Re-validate through the same checks as a read.
    let json = serde_json::json!({
        "input_tokens": sum[0], "cached_input_tokens": sum[1], "cache_write_input_tokens": sum[2],
        "output_tokens": sum[3], "reasoning_output_tokens": sum[4], "total_tokens": sum[5],
    });
    read_usage(Some(&json))
}

fn date_baseline(s: &mut State, ts: f64) {
    s.latest_at = Some(s.latest_at.map_or(ts, |l| l.max(ts)));
}

fn rebase(s: &mut State, cumulative: Cu, ts: f64) {
    s.last_cumulative = Some(cumulative);
    date_baseline(s, ts);
    s.unreported = None;
    if cumulative[0] + cumulative[3] == 0.0 {
        s.sequence_start = None;
    }
}

/// Bill requests an interrupted turn never reported only when the records since the previous
/// snapshot explain the whole gap.
fn bridged(
    previous: Option<Cu>,
    cumulative: &Cu,
    last: &Cu,
    pending: &Option<Vec<Unreported>>,
) -> Option<Vec<Unreported>> {
    let previous = previous?;
    let pending = pending.as_ref()?;
    for k in 0..6 {
        let total: f64 = pending.iter().map(|r| r.usage[k]).sum();
        if cumulative[k] - previous[k] != total {
            return None;
        }
    }
    let final_req = pending.last()?;
    let rem: Cu = std::array::from_fn(|k| final_req.usage[k] - last[k]);
    let json = serde_json::json!({
        "input_tokens": rem[0], "cached_input_tokens": rem[1], "cache_write_input_tokens": rem[2],
        "output_tokens": rem[3], "reasoning_output_tokens": rem[4], "total_tokens": rem[5],
    });
    let remainder = read_usage(Some(&json))?;
    let mut out: Vec<Unreported> = pending[..pending.len() - 1].to_vec();
    out.push(Unreported {
        attr: final_req.attr.clone(),
        usage: remainder,
    });
    out.retain(|r| r.usage[0] + r.usage[3] > 0.0);
    Some(out)
}

fn discarded(pending: &Option<Vec<Unreported>>, last: &Cu) -> u32 {
    match pending
        .as_ref()
        .and_then(|p| p.last().map(|f| (p.len(), f)))
    {
        None => 0,
        Some((len, f)) => (len - usize::from(f.usage == *last)) as u32,
    }
}

fn is_forked_meta(p: &Value) -> bool {
    if p.get("forked_from_id").is_some_and(Value::is_string) {
        return true;
    }
    p.pointer("/source/subagent/thread_spawn/parent_thread_id")
        .is_some_and(Value::is_string)
}

fn is_fork_copy(s: &mut State, ts: f64) -> bool {
    if !s.suppressing {
        return false;
    }
    if ts - s.anchor_ms < FORK_COPY_MAX_GAP_MS {
        s.anchor_ms = ts;
        return true;
    }
    s.suppressing = false;
    s.last_signature = None;
    false
}

fn request(s: &State, usage: &Cu, a: &Attribution, key: Option<String>) -> Record {
    let mut r = Record::new("codex", a.ts, &a.model, &s.session);
    // Codex reports `input_tokens` inclusive of the cached portion.
    r.uncached = usage[0] - usage[1] - usage[2];
    r.cached = usage[1];
    r.cache_write = usage[2];
    r.output = usage[3];
    r.reasoning = usage[4];
    r.speed = a.speed;
    r.key = key;
    r
}

fn attribution(s: &State, ts: f64) -> Attribution {
    Attribution {
        ts,
        model: s.model.clone(),
        speed: s.speed,
    }
}

fn signature(u: &Cu) -> String {
    format!("{:?}", u)
}

fn parse_record(rec: &Value, s: &mut State) -> Vec<Record> {
    let Some(p) = rec.get("payload").filter(|v| v.is_object()) else {
        return Vec::new();
    };
    let payload_type = p.get("type").and_then(Value::as_str);
    let rec_type = rec.get("type").and_then(Value::as_str);

    if rec_type == Some("session_meta") {
        if s.saw_meta {
            return Vec::new();
        }
        s.saw_meta = true;
        if let Some(id) = p
            .get("id")
            .or_else(|| p.get("session_id"))
            .and_then(Value::as_str)
        {
            s.session = id.to_string();
        }
        let ts = parse_ts_ms(rec.get("timestamp"));
        if let (Some(ts), true) = (ts, is_forked_meta(p)) {
            s.suppressing = true;
            s.anchor_ms = ts;
        }
        return Vec::new();
    }
    if rec_type == Some("turn_context") {
        s.ledger_active = false;
        if let Some(m) = p.get("model").and_then(Value::as_str) {
            s.model = m.to_string();
        }
        return Vec::new();
    }
    if rec_type == Some("token_usage_record") {
        let ts = parse_ts_ms(rec.get("timestamp"));
        let usage = read_usage(p.get("usage"));
        let (Some(ts), Some(usage)) = (ts, usage) else {
            return Vec::new();
        };
        if s.model.is_empty() || is_fork_copy(s, ts) {
            return Vec::new();
        }
        if let Some(response_id) = p
            .get("response_id")
            .and_then(Value::as_str)
            .filter(|r| !r.is_empty())
        {
            let pending = s.unreported.take().unwrap_or_default();
            s.ledger_active = true;
            for r in &pending {
                s.last_cumulative = advance(s.last_cumulative, &r.usage);
            }
            s.last_cumulative = advance(s.last_cumulative, &usage);
            date_baseline(s, ts);
            let mut out: Vec<Record> = pending
                .iter()
                .map(|r| request(s, &r.usage, &r.attr, None))
                .collect();
            let key = serde_json::to_string(&serde_json::json!(["codex", s.session, response_id]))
                .unwrap_or_default();
            out.push(request(s, &usage, &attribution(s, ts), Some(key)));
            return out;
        }
        s.ledger_active = false;
        let attr = attribution(s, ts);
        s.unreported
            .get_or_insert_with(Vec::new)
            .push(Unreported { attr, usage });
        return Vec::new();
    }
    if payload_type == Some("thread_settings_applied") {
        if let Some(settings) = p.get("thread_settings").filter(|v| v.is_object()) {
            s.speed = speed_of(settings.get("service_tier"));
        }
        return Vec::new();
    }
    if payload_type != Some("token_count") {
        return Vec::new();
    }
    let Some(info) = p.get("info").filter(|v| v.is_object()) else {
        return Vec::new();
    };
    let Some(ts) = parse_ts_ms(rec.get("timestamp")) else {
        return Vec::new();
    };
    if s.model.is_empty() {
        return Vec::new();
    }
    let last = read_usage(info.get("last_token_usage"));
    let raw_cumulative = info.get("total_token_usage").filter(|v| !v.is_null());
    let has_cumulative = raw_cumulative.is_some();
    let cumulative = if has_cumulative {
        read_usage(raw_cumulative)
    } else {
        None
    };

    if is_fork_copy(s, ts) {
        let sig = last.as_ref().map(signature);
        if let Some(c) = cumulative {
            rebase(s, c, ts);
        } else if !has_cumulative && sig != s.last_signature {
            if let Some(last_value) = last.as_ref() {
                s.last_cumulative = advance(s.last_cumulative, last_value);
                date_baseline(s, ts);
            }
        }
        s.last_signature = sig;
        return Vec::new();
    }
    if s.ledger_active {
        if let Some(c) = cumulative {
            rebase(s, c, ts);
        }
        return Vec::new();
    }
    let previous = s.last_cumulative;
    let latest_at = s.latest_at;
    let pending = s.unreported.clone();
    if let Some(c) = cumulative {
        rebase(s, c, ts);
    }
    let Some(last) = last.filter(|_| !(has_cumulative && cumulative.is_none())) else {
        s.malformed += 1;
        return Vec::new();
    };
    if last[0] + last[3] == 0.0 {
        s.last_signature = None;
        return Vec::new();
    }
    if let (Some(c), Some(pv)) = (cumulative, previous) {
        if c == pv {
            return Vec::new();
        }
    }
    if last[5] != last[0] + last[3] {
        s.malformed += 1;
        return Vec::new();
    }
    let sig = signature(&last);
    let mut unreported: Vec<Unreported> = Vec::new();
    if let Some(c) = cumulative {
        let restarted = c == last;
        let sequence_start =
            serde_json::to_string(&serde_json::json!([ts, last])).unwrap_or_default();
        if restarted && s.sequence_start.as_deref() == Some(sequence_start.as_str()) {
            s.last_cumulative = previous;
            if latest_at.is_none() {
                s.latest_at = None;
            }
            return Vec::new();
        }
        let lowered = previous.is_some_and(|pv| (0..6).any(|k| c[k] < pv[k]));
        let rewound = lowered && latest_at.is_some_and(|l| ts > l);
        let reconciled = if previous.is_none() || rewound {
            let rem = serde_json::json!({
                "input_tokens": c[0] - last[0], "cached_input_tokens": c[1] - last[1], "cache_write_input_tokens": c[2] - last[2],
                "output_tokens": c[3] - last[3], "reasoning_output_tokens": c[4] - last[4], "total_tokens": c[5] - last[5],
            });
            read_usage(Some(&rem)).is_some()
        } else {
            let pv = previous.unwrap();
            (0..6).all(|k| c[k] - pv[k] == last[k])
        };
        if !restarted && !reconciled {
            match bridged(previous, &c, &last, &pending) {
                None => {
                    let replayed = latest_at
                        .is_some_and(|l| ts < l || (ts == l && lowered && c[0] + c[3] > 0.0));
                    if replayed {
                        s.last_cumulative = previous;
                        if pending.is_some() {
                            s.unreported = pending;
                        }
                    }
                    s.malformed += 1;
                    return Vec::new();
                }
                Some(b) => unreported = b,
            }
        } else if !restarted && rewound {
            s.malformed += discarded(&pending, &last);
        }
        if restarted {
            s.sequence_start = Some(sequence_start);
        }
    } else {
        if s.last_signature.as_deref() == Some(sig.as_str()) {
            return Vec::new();
        }
        let Some(advanced) = advance(previous, &last) else {
            s.malformed += 1;
            return Vec::new();
        };
        s.last_cumulative = Some(advanced);
        date_baseline(s, ts);
    }
    s.last_signature = Some(sig);
    let mut out: Vec<Record> = unreported
        .iter()
        .map(|r| request(s, &r.usage, &r.attr, None))
        .collect();
    out.push(request(s, &last, &attribution(s, ts), None));
    out
}

pub fn parse_file(content: impl Iterator<Item = String>) -> ReadResult {
    let mut s = State {
        model: String::new(),
        speed: 0,
        session: String::new(),
        last_signature: None,
        last_cumulative: None,
        sequence_start: None,
        latest_at: None,
        unreported: None,
        ledger_active: false,
        malformed: 0,
        saw_meta: false,
        suppressing: false,
        anchor_ms: 0.0,
    };
    let mut records: Vec<Record> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in content {
        let relevant = [
            "\"token_count\"",
            "\"token_usage_record\"",
            "\"turn_context\"",
            "\"thread_settings_applied\"",
            "\"session_meta\"",
        ]
        .iter()
        .any(|m| line.contains(m));
        if !relevant {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        for r in parse_record(&rec, &mut s) {
            if let Some(k) = &r.key {
                if !seen.insert(k.clone()) {
                    continue;
                }
            }
            records.push(r);
        }
    }
    ReadResult {
        records,
        malformed: s.malformed,
    }
}

/// Codex config roots: `CODEX_HOME`, then folders configured in Settings (`providers.sources.codex`),
/// then XDG config/data dirs and mounted Windows profiles under WSL. Only discovered roots that
/// already hold sessions are returned so an empty candidate never hides a real one; `~/.codex` is the
/// last fallback. Nothing is created; a folder reached twice is read once.
pub fn codex_homes() -> Vec<PathBuf> {
    codex_homes_from(
        env_path("CODEX_HOME"),
        &super::sources::configured("codex"),
        config_dirs("codex"),
        &home(),
    )
}

/// The environment, configured and discovered part of `codex_homes`, with every input passed in.
fn codex_homes_from(
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
        // Accept the `sessions` folder itself: that is the folder people see the transcripts in.
        let dir = if dir.file_name().is_some_and(|n| n == "sessions") {
            dir.parent().map_or_else(|| dir.clone(), Path::to_path_buf)
        } else {
            dir.clone()
        };
        if dir.is_dir() {
            push_unique(&mut out, dir);
        }
    }
    for dir in discovered {
        if dir.join("sessions").exists() || dir.join("archived_sessions").exists() {
            push_unique(&mut out, dir);
        }
    }
    if out.is_empty() {
        out.push(home.join(".codex"));
    }
    out
}

fn codex_home() -> PathBuf {
    codex_homes()
        .first()
        .cloned()
        .unwrap_or_else(|| home().join(".codex"))
}

pub struct Codex;

impl Source for Codex {
    fn provider(&self) -> &'static str {
        "codex"
    }
    fn dir(&self) -> PathBuf {
        codex_home().join("sessions")
    }
    fn shared_sessions(&self) -> bool {
        true
    }
    fn files(&self) -> Vec<FileInfo> {
        let accept = |n: &str| n.ends_with(".jsonl") || n.ends_with(".jsonl.zst");
        let mut out = Vec::new();
        for root in codex_homes() {
            walk(&root.join("sessions"), &accept, &mut out);
            walk(&root.join("archived_sessions"), &accept, &mut out);
        }
        out
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        let mut result = parse_file(lines(path)?);
        result.records.retain(|r| r.ts >= since_ms);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn homes_prefer_environment_then_configured_then_discovery_with_no_repeats() {
        let root = std::env::temp_dir().join(format!("burnrate-codex-homes-{}", std::process::id()));
        let env = root.join("env-codex");
        let configured = root.join("elsewhere").join("sessions");
        let discovered = root.join("home").join(".codex");
        for dir in [env.clone(), configured.parent().unwrap().to_path_buf(), discovered.clone()] {
            fs::create_dir_all(dir.join("sessions")).unwrap();
        }
        let mut discovered_dirs = vec![discovered.clone(), root.join("home").join(".config").join("codex")];
        discovered_dirs.push(discovered.parent().unwrap().join(".codex-dupe"));
        // Environment first, a configured `sessions` folder is accepted, discovery adds the rest.
        let got = codex_homes_from(
            Some(env.clone()),
            &[configured.clone()],
            discovered_dirs.clone(),
            &root.join("nothing"),
        );
        assert_eq!(got, vec![env.clone(), configured.parent().unwrap().to_path_buf(), discovered.clone()]);
        // A configured folder reached twice with discovery is read once.
        let got = codex_homes_from(None, &[discovered.clone()], discovered_dirs, &root.join("nothing"));
        assert_eq!(got, vec![discovered.clone()]);
        // Nothing anywhere: the classic `~/.codex` fallback.
        let got = codex_homes_from(None, &[], vec![], &root.join("home"));
        assert_eq!(got, vec![root.join("home").join(".codex")]);
        fs::remove_dir_all(&root).unwrap();
    }
}
