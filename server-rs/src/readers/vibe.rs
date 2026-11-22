// Mistral Vibe local-session reader.
//
// Verified on a real install (Windows, Vibe unified session store). Each Vibe config directory
// (`~/.vibe`, any per-instance copy such as `~/.vibe2`, `VIBE_HOME`, or a folder the user listed under
// Settings > Providers > Local sources) keeps
//   logs/session/unified/.session-index.json   { "catalog_version": 1, "entries": [ ... ] }
// and one entry per session (root sessions and sub-agent sessions) with
//   identity.{kind, root_session_id}            kind is "root" or "subagent"
//   metadata.active_model                       the model alias Vibe shows ("glm-5-3", "mistral-large-4-0"); null on sub-agents
//   metadata.completion_catalogue               a JSON *string* whose `model` is the API model id ("zai-glm-5-3")
//   session.id / createdAt / updatedAt          ids and epoch milliseconds
//   session.tokenUsage.{inputTokens, cachedInputTokens, outputTokens, totalTokens}
// `tokenUsage` is cumulative for the session, `inputTokens` already includes the cached part
// (`total = input + output`), and a sub-agent's tokens are NOT folded into its root's, so every
// entry is its own record. `contextUsage` is the current context window, not spend, and is ignored.
// A sub-agent has no model of its own: it inherits its root's.
//
// Limitation: usage is cumulative per session, so one session is attributed to its `updatedAt` day.
// Vibe's own sign-in flow is not touched here; this only reads local files, read-only.
//
// Every session is attributed to the `mistral` provider: Vibe's models (including the GLM models the
// Mistral API fronts) are billed through that account. Cost comes from the shared rate table via the
// API model id; a model with no published rate stays honestly unpriced and still shows its tokens.

use super::{env_path, home, mtime_ms, read_text, FileInfo, Source};
use crate::types::{token_count, ReadResult, Record};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A runaway or corrupt index must not exhaust memory.
const MAX_INDEX_BYTES: u64 = 256 * 1024 * 1024;

const INDEX_RELATIVE: [&str; 4] = ["logs", "session", "unified", ".session-index.json"];

/// Vibe config directories: `VIBE_HOME`, then folders configured in Settings (`providers.sources.vibe`),
/// then `.vibe` / `.vibe<suffix>` folders in the home directory. Nothing is created; discovered folders are
/// sorted so a given machine always lists them in the same order.
pub fn vibe_homes() -> Vec<PathBuf> {
    vibe_homes_from(env_path("VIBE_HOME"), &super::sources::configured("vibe"), &home())
}

fn vibe_homes_from(env: Option<PathBuf>, configured: &[PathBuf], home: &Path) -> Vec<PathBuf> {
    use super::sources::push_unique;
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(env) = env {
        push_unique(&mut out, env);
    }
    for dir in configured.iter().filter(|d| d.is_dir()) {
        push_unique(&mut out, dir.clone());
    }
    if let Ok(entries) = std::fs::read_dir(home) {
        let mut found: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".vibe") && e.path().is_dir())
            .map(|e| e.path())
            .collect();
        found.sort();
        for dir in found {
            push_unique(&mut out, dir);
        }
    }
    out
}

pub fn index_path(vibe_home: &Path) -> PathBuf {
    INDEX_RELATIVE.iter().fold(vibe_home.to_path_buf(), |p, part| p.join(part))
}

/// The account label a Vibe config directory gets in Burnrate: `~/.vibe` is "Vibe", `~/.vibe2` is
/// "Vibe 2", `~/.vibe-work` is "Vibe work". A directory outside the home folder (`VIBE_HOME`) with a
/// different name is "Vibe (<dir name>)".
pub fn account_name(vibe_home: &Path) -> String {
    let name = vibe_home.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    match name.strip_prefix(".vibe") {
        Some("") => "Vibe".to_string(),
        Some(suffix) => {
            let suffix = suffix.trim_matches(|c: char| c == '-' || c == '_' || c == '.');
            if suffix.is_empty() {
                "Vibe".to_string()
            } else {
                format!("Vibe {suffix}")
            }
        }
        None if name.is_empty() => "Vibe".to_string(),
        None => format!("Vibe ({name})"),
    }
}

/// Account names of Vibe profiles that hold a key file of their own (a `.env`, or on Windows a DPAPI
/// `keyring.bin`) and are not among the `saved` account names. Existence checks only; no secret is read.
/// A profile that keeps its key in the shared OS keyring has no file and is covered by the first import.
pub fn pending_accounts(homes: &[PathBuf], saved: &[String]) -> Vec<String> {
    homes
        .iter()
        .filter(|dir| dir.join(".env").is_file() || (cfg!(windows) && dir.join("keyring.bin").is_file()))
        .map(|dir| account_name(dir))
        .filter(|name| !saved.iter().any(|s| s.eq_ignore_ascii_case(name)))
        .collect()
}

/// `pending_accounts` over every Vibe directory on this computer.
pub fn unimported_accounts(saved: &[String]) -> Vec<String> {
    pending_accounts(&vibe_homes(), saved)
}

fn session_id(entry: &Value) -> Option<String> {
    let id = entry
        .pointer("/session/id")
        .and_then(Value::as_str)
        .or_else(|| entry.get("session_id").and_then(Value::as_str))
        .or_else(|| entry.pointer("/identity/session_id").and_then(Value::as_str))?;
    Some(id.trim().to_string()).filter(|id| !id.is_empty())
}

fn root_id(entry: &Value) -> Option<String> {
    entry
        .pointer("/identity/root_session_id")
        .or_else(|| entry.pointer("/session/rootSessionId"))
        .or_else(|| entry.pointer("/metadata/root_session_id"))
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The API model id Vibe resolved the alias to (`completion_catalogue` is a JSON string).
fn catalogue_model(entry: &Value) -> Option<String> {
    let raw = entry.pointer("/metadata/completion_catalogue")?;
    let parsed;
    let object = match raw {
        Value::String(text) => {
            parsed = serde_json::from_str::<Value>(text).ok()?;
            &parsed
        }
        other => other,
    };
    object.get("model").and_then(Value::as_str).map(|m| m.trim().to_string()).filter(|m| !m.is_empty())
}

fn active_model(entry: &Value) -> Option<String> {
    entry.pointer("/metadata/active_model").and_then(Value::as_str).map(|m| m.trim().to_string()).filter(|m| !m.is_empty())
}

/// Display model and the id to price it by. The alias `glm-5-3` has no published rate but the API id
/// `zai-glm-5-3` does, so the API id is the rate model whenever it differs from the alias.
fn model_of(entry: &Value) -> Option<(String, Option<String>)> {
    let model = active_model(entry).or_else(|| catalogue_model(entry))?;
    let mut rate = catalogue_model(entry).filter(|m| !m.eq_ignore_ascii_case(&model));
    if rate.is_none() && model.to_lowercase().starts_with("glm-") {
        rate = Some(format!("zai-{}", model.to_lowercase()));
    }
    Some((model, rate))
}

fn epoch_ms(value: Option<&Value>) -> Option<f64> {
    let n = value.and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0)?;
    // Seconds (10 digits) from a hand-edited index; Vibe itself writes milliseconds.
    Some(if n < 1e11 { n * 1000.0 } else { n })
}

/// Parse one session index. Returns the records and the number of entries that claim to be a
/// session but cannot be turned into one (no id, or a token block that is not an object).
pub fn parse_index(text: &str, since_ms: f64) -> Result<ReadResult, String> {
    let doc: Value = serde_json::from_str(text).map_err(|e| format!("unreadable session index: {e}"))?;
    let entries = doc.get("entries").and_then(Value::as_array).ok_or_else(|| "session index has no entries list".to_string())?;
    // Sub-agents inherit their root's model, so index the roots first.
    let mut roots: HashMap<String, (String, Option<String>)> = HashMap::new();
    for entry in entries {
        if let (Some(id), Some(model)) = (session_id(entry), model_of(entry)) {
            roots.insert(id, model);
        }
    }
    let mut records = Vec::new();
    let mut malformed = 0u32;
    for entry in entries {
        let Some(id) = session_id(entry) else {
            malformed += 1;
            continue;
        };
        let usage = match entry.pointer("/session/tokenUsage") {
            None | Some(Value::Null) => continue, // a session that has not made a request yet
            Some(u) if u.is_object() => u,
            Some(_) => {
                malformed += 1;
                continue;
            }
        };
        let input = token_count(usage.get("inputTokens"));
        let cached = token_count(usage.get("cachedInputTokens")).min(input);
        let output = token_count(usage.get("outputTokens"));
        if input == 0.0 && output == 0.0 {
            continue;
        }
        let Some(ts) = epoch_ms(entry.pointer("/session/updatedAt")).or_else(|| epoch_ms(entry.pointer("/session/createdAt"))) else {
            malformed += 1;
            continue;
        };
        if ts < since_ms {
            continue;
        }
        let (model, rate_model) = model_of(entry)
            .or_else(|| root_id(entry).and_then(|root| roots.get(&root).cloned()))
            .unwrap_or_else(|| ("unknown".to_string(), None));
        let mut r = Record::new("mistral", ts, &model, &id);
        r.rate_model = rate_model;
        // `inputTokens` includes the cached part; the record keeps the two apart.
        r.uncached = input - cached;
        r.cached = cached;
        r.output = output;
        r.key = Some(format!("vibe:{id}"));
        records.push(r);
    }
    Ok(ReadResult { records, malformed })
}

pub struct Vibe;

impl Source for Vibe {
    fn provider(&self) -> &'static str {
        "mistral"
    }
    fn dir(&self) -> PathBuf {
        vibe_homes().first().cloned().unwrap_or_else(|| home().join(".vibe")).join("logs").join("session").join("unified")
    }
    fn files(&self) -> Vec<FileInfo> {
        vibe_homes()
            .iter()
            .map(|h| index_path(h))
            .filter_map(|path| {
                let meta = std::fs::metadata(&path).ok().filter(|m| m.is_file())?;
                Some(FileInfo { size: meta.len() as f64, mtime_ms: mtime_ms(&meta), path })
            })
            .collect()
    }
    fn read(&self, path: &Path, since_ms: f64) -> Result<ReadResult, String> {
        parse_index(&read_text(path, MAX_INDEX_BYTES)?, since_ms)
    }
    /// A copied profile directory repeats the same session ids: keep one copy.
    fn shared_sessions(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("burnrate-vibe-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(id: &str, kind: &str, root: &str, model: Option<&str>, catalogue: Option<&str>, usage: Value, updated: i64) -> Value {
        let catalogue = catalogue.map(|m| json!({"endpoint": "https://api.mistral.ai/v1/models", "model": m}).to_string());
        json!({
            "identity": {"kind": kind, "root_session_id": root, "session_id": id},
            "metadata": {"active_model": model, "completion_catalogue": catalogue},
            "session": {"id": id, "createdAt": updated - 5_000, "updatedAt": updated, "tokenUsage": usage,
                         "contextUsage": {"cachedInputTokens": 1, "inputTokens": 2, "outputTokens": 3, "totalTokens": 5}},
        })
    }

    fn index(entries: Vec<Value>) -> String {
        json!({"catalog_version": 1, "entries": entries}).to_string()
    }

    const NOV_20: i64 = 1_795_000_000_000;

    #[test]
    fn a_root_session_becomes_a_mistral_record_with_cached_split_out() {
        let usage = json!({"cachedInputTokens": 600, "inputTokens": 1000, "outputTokens": 50, "totalTokens": 1050});
        let text = index(vec![entry("s1", "root", "s1", Some("glm-5-3"), Some("zai-glm-5-3"), usage, NOV_20)]);
        let result = parse_index(&text, 0.0).unwrap();
        assert_eq!(result.malformed, 0);
        let r = &result.records[0];
        assert_eq!(r.provider, "mistral");
        assert_eq!(r.model, "glm-5-3");
        assert_eq!(r.rate_model.as_deref(), Some("zai-glm-5-3"), "priced by the API id the alias resolves to");
        assert_eq!((r.uncached, r.cached, r.output), (400.0, 600.0, 50.0));
        assert_eq!(r.total_tokens(), 1050.0, "equals Vibe's own totalTokens");
        assert_eq!(r.ts, NOV_20 as f64);
        assert_eq!(r.key.as_deref(), Some("vibe:s1"));
    }

    #[test]
    fn a_subagent_inherits_its_roots_model_and_is_counted_on_top() {
        let big = json!({"cachedInputTokens": 0, "inputTokens": 100, "outputTokens": 10, "totalTokens": 110});
        let small = json!({"cachedInputTokens": 20, "inputTokens": 50, "outputTokens": 5, "totalTokens": 55});
        let text = index(vec![
            entry("child-1", "subagent", "root", None, None, small, NOV_20),
            entry("root", "root", "root", Some("zai-glm-5-3-flash"), None, big, NOV_20),
        ]);
        let result = parse_index(&text, 0.0).unwrap();
        assert_eq!(result.records.len(), 2);
        let child = result.records.iter().find(|r| r.session == "child-1").unwrap();
        assert_eq!(child.model, "zai-glm-5-3-flash", "child listed before its root still resolves");
        assert_eq!(result.records.iter().map(Record::total_tokens).sum::<f64>(), 165.0);
    }

    #[test]
    fn glm_alias_without_a_catalogue_falls_back_to_the_zai_api_id() {
        let usage = json!({"cachedInputTokens": 0, "inputTokens": 10, "outputTokens": 1, "totalTokens": 11});
        let text = index(vec![entry("s1", "root", "s1", Some("glm-5-3"), None, usage, NOV_20)]);
        let r = &parse_index(&text, 0.0).unwrap().records[0];
        assert_eq!(r.rate_model.as_deref(), Some("zai-glm-5-3"));
    }

    #[test]
    fn a_model_whose_alias_is_the_api_id_needs_no_rate_model() {
        let usage = json!({"cachedInputTokens": 0, "inputTokens": 10, "outputTokens": 1, "totalTokens": 11});
        let text = index(vec![entry("s1", "root", "s1", Some("mistral-large-4-0"), Some("mistral-large-4-0"), usage, NOV_20)]);
        let r = &parse_index(&text, 0.0).unwrap().records[0];
        assert_eq!(r.rate_model, None);
    }

    #[test]
    fn empty_stale_and_broken_entries_are_handled() {
        let used = json!({"cachedInputTokens": 0, "inputTokens": 10, "outputTokens": 1, "totalTokens": 11});
        let zero = json!({"cachedInputTokens": 0, "inputTokens": 0, "outputTokens": 0, "totalTokens": 0});
        let mut no_id = entry("x", "root", "x", Some("m"), None, used.clone(), NOV_20);
        no_id["session"].as_object_mut().unwrap().remove("id");
        no_id["identity"].as_object_mut().unwrap().remove("session_id");
        let mut bad_usage = entry("bad", "root", "bad", Some("m"), None, json!({}), NOV_20);
        bad_usage["session"]["tokenUsage"] = json!("oops");
        let mut not_started = entry("new", "root", "new", Some("m"), None, json!({}), NOV_20);
        not_started["session"].as_object_mut().unwrap().remove("tokenUsage");
        let text = index(vec![
            entry("old", "root", "old", Some("m"), None, used.clone(), NOV_20 - 1_000_000),
            entry("zero", "root", "zero", Some("m"), None, zero, NOV_20),
            entry("keep", "root", "keep", Some("m"), None, used, NOV_20),
            no_id,
            bad_usage,
            not_started,
        ]);
        let result = parse_index(&text, NOV_20 as f64 - 1000.0).unwrap();
        assert_eq!(result.records.iter().map(|r| r.session.as_str()).collect::<Vec<_>>(), vec!["keep"]);
        assert_eq!(result.malformed, 2, "no id and a non-object tokenUsage are malformed; unstarted and empty sessions are not");
        assert!(parse_index("{not json", 0.0).is_err());
        assert!(parse_index("{}", 0.0).is_err());
    }

    #[test]
    fn an_orphan_subagent_is_kept_as_an_unpriced_unknown_model() {
        let usage = json!({"cachedInputTokens": 0, "inputTokens": 10, "outputTokens": 1, "totalTokens": 11});
        let r = &parse_index(&index(vec![entry("c", "subagent", "gone", None, None, usage, NOV_20)]), 0.0).unwrap().records[0];
        assert_eq!(r.model, "unknown");
    }

    #[test]
    fn account_names_follow_the_directory() {
        assert_eq!(account_name(Path::new("/home/u/.vibe")), "Vibe");
        assert_eq!(account_name(Path::new("/home/u/.vibe2")), "Vibe 2");
        assert_eq!(account_name(Path::new("/home/u/.vibe-work")), "Vibe work");
        assert_eq!(account_name(Path::new("/srv/profile")), "Vibe (profile)");
    }

    #[test]
    fn only_profiles_with_their_own_key_file_and_no_saved_account_are_pending() {
        let root = temp_dir();
        let first = root.join(".vibe");
        let second = root.join(".vibe2");
        let third = root.join(".vibe-work");
        for dir in [&first, &second, &third] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(second.join(".env"), "MISTRAL_API_KEY=fixture-key-0000\n").unwrap();
        std::fs::write(third.join(".env"), "MISTRAL_API_KEY=fixture-key-1111\n").unwrap();
        let homes = vec![first, second, third];
        // `.vibe` has no key file (its key is in the shared OS keyring), so it is never "pending".
        assert_eq!(pending_accounts(&homes, &["Vibe".to_string()]), vec!["Vibe 2".to_string(), "Vibe work".to_string()]);
        assert_eq!(pending_accounts(&homes, &["Vibe".to_string(), "vibe 2".to_string(), "Vibe work".to_string()]), Vec::<String>::new());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn glm_and_mistral_sessions_are_priced_through_the_shared_rate_table() {
        // LiteLLM files these under `mistral/<api id>`; the alias step exposes the bare id.
        let table = crate::pricing::parse_rate_table(&json!({
            "mistral/zai-glm-5-3": {"input_cost_per_token": 1e-6, "output_cost_per_token": 4e-6, "cache_read_input_token_cost": 1e-7},
            "mistral/mistral-large-4-0": {"input_cost_per_token": 2e-6, "output_cost_per_token": 6e-6},
        }));
        let used = json!({"cachedInputTokens": 500_000, "inputTokens": 1_000_000, "outputTokens": 100_000, "totalTokens": 1_100_000});
        let text = index(vec![
            entry("a", "root", "a", Some("glm-5-3"), Some("zai-glm-5-3"), used.clone(), NOV_20),
            entry("b", "root", "b", Some("mistral-large-4-0"), Some("mistral-large-4-0"), used.clone(), NOV_20),
            entry("c", "root", "c", Some("some-new-model"), None, used, NOV_20),
        ]);
        let records = parse_index(&text, 0.0).unwrap().records;
        let priced: Vec<_> = records.iter().map(|r| crate::pricing::price(&table, r, None)).collect();
        // 500k fresh in + 500k cached + 100k out at the GLM rates.
        assert!((priced[0].cost - (0.5 + 0.05 + 0.4)).abs() < 1e-9, "alias priced by its API id: {}", priced[0].cost);
        assert_eq!(priced[0].source, crate::pricing::CostSource::ModelPriced);
        assert_eq!(priced[1].source, crate::pricing::CostSource::ModelPriced);
        // No published rate: tokens stay, cost is honestly unpriced rather than a made-up number.
        assert_eq!(priced[2].source, crate::pricing::CostSource::Unpriced);
        assert_eq!(records[2].total_tokens(), 1_100_000.0);
    }

    #[test]
    fn reads_an_index_file_through_the_source() {
        let dir = temp_dir();
        let path = index_path(&dir);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let usage = json!({"cachedInputTokens": 5, "inputTokens": 25, "outputTokens": 5, "totalTokens": 30});
        std::fs::write(&path, index(vec![entry("s1", "root", "s1", Some("mistral-large-4-0"), None, usage, NOV_20)])).unwrap();
        let result = Vibe.read(&path, 0.0).unwrap();
        assert_eq!(result.records.len(), 1);
        assert_eq!(result.records[0].cached, 5.0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn vibe_homes_default_to_home_discovery_and_a_configured_dir_is_added() {
        let root = temp_dir();
        let home = root.join("home");
        let first = home.join(".vibe");
        let custom = root.join("drive-d").join("vibe-profile");
        for dir in [&first, &custom] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(home.join(".vibe-file"), "not a directory").unwrap();
        assert_eq!(vibe_homes_from(None, &[], &home), vec![first.clone()], "default behaviour: the home scan only");
        let env = root.join("vibe-home");
        std::fs::create_dir_all(&env).unwrap();
        assert_eq!(vibe_homes_from(Some(env.clone()), &[custom.clone(), root.join("missing")], &home), vec![env, custom.clone(), first.clone()]);
        assert_eq!(vibe_homes_from(None, &[first.clone(), custom.clone()], &home), vec![first, custom]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn sessions_in_a_configured_directory_are_listed_and_read() {
        let root = temp_dir();
        let custom = root.join("elsewhere").join("my-vibe");
        let path = index_path(&custom);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let usage = json!({"cachedInputTokens": 0, "inputTokens": 40, "outputTokens": 2, "totalTokens": 42});
        std::fs::write(&path, index(vec![entry("s9", "root", "s9", Some("mistral-large-4-0"), None, usage, NOV_20)])).unwrap();
        let homes = vibe_homes_from(None, &[custom.clone()], &root.join("empty-home"));
        assert_eq!(homes, vec![custom.clone()]);
        let indexes: Vec<PathBuf> = homes.iter().map(|h| index_path(h)).filter(|p| p.is_file()).collect();
        assert_eq!(indexes, vec![path.clone()]);
        let result = Vibe.read(&indexes[0], 0.0).unwrap();
        assert_eq!(result.records.len(), 1);
        assert_eq!(result.records[0].total_tokens(), 42.0);
        assert_eq!(account_name(&custom), "Vibe (my-vibe)");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
