//! Generic fixture harness. Packages 13-19 drop `server-rs/defs/<id>.toml` plus JSON responses in
//! `server-rs/defs/fixtures/`; this test parses and maps every one of them with an injectable
//! fetcher (never a network call) and checks any `<id>.expect.json` expectations.
use super::fetch::{run_requests, FetchError, Fetcher};
use super::lint::lint;
use super::mapping::map_responses;
use super::model::{Definition, RequestSpec};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

struct FixtureFetcher {
    by_request: HashMap<String, Value>,
    fallback: Option<Value>,
}

impl Fetcher for FixtureFetcher {
    fn fetch(&self, _def: &Definition, req: &RequestSpec, _key: &str) -> Result<Value, FetchError> {
        self.by_request
            .get(&req.id)
            .cloned()
            .or_else(|| self.fallback.clone())
            .ok_or_else(|| FetchError::Parse(format!("no fixture for request '{}'", req.id)))
    }
}

fn defs_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("defs")
}

fn fixtures_dir() -> PathBuf {
    defs_dir().join("fixtures")
}

#[test]
fn every_builtin_definition_parses_and_lints() {
    for (id, src) in super::BUILTIN_DEFS {
        let def = Definition::parse(src).unwrap_or_else(|e| panic!("built-in {id} has invalid TOML: {e}"));
        let errors = lint(&def);
        assert!(errors.is_empty(), "built-in {id} failed lint: {errors:?}");
    }
}

#[test]
fn maps_every_fixture_without_network() {
    // Fixtures are grouped per definition id (ids may contain dashes, so match the longest known id):
    //   <id>.json                 fallback response for every request
    //   <id>-<request-id>.json    response for one request
    //   <id>.expect.json          expectations checked against the mapped account
    let Ok(entries) = std::fs::read_dir(fixtures_dir()) else { return };
    let files: Vec<(String, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|p| {
            let name = p.file_name().and_then(|n| n.to_str())?.to_string();
            (!name.ends_with(".expect.json")).then(|| (name.trim_end_matches(".json").to_string(), p))
        })
        .collect();

    let mut ids: Vec<&str> = super::BUILTIN_DEFS.iter().map(|(id, _)| *id).collect();
    ids.sort_by_key(|id| std::cmp::Reverse(id.len()));

    // Fixtures that belong to no known definition are an authoring mistake: fail loudly instead of skipping them.
    let mut orphans = Vec::new();
    let mut groups: HashMap<&str, Vec<(String, PathBuf)>> = HashMap::new();
    for (stem, path) in files {
        let owner = ids.iter().find(|id| stem == **id || stem.starts_with(&format!("{id}-")) || stem.starts_with(&format!("{id}.")));
        match owner {
            Some(id) => groups.entry(id).or_default().push((stem, path)),
            None => orphans.push(stem),
        }
    }
    assert!(orphans.is_empty(), "fixtures without a matching definition: {orphans:?}");

    for (id, fixtures) in groups {
        let (_, src) = super::BUILTIN_DEFS.iter().find(|(d, _)| *d == id).expect("definition");
        let def = Definition::parse(src).unwrap_or_else(|e| panic!("{id}.toml: {e}"));
        let mut by_request = HashMap::new();
        let mut fallback = None;
        for (stem, path) in &fixtures {
            let value: Value = serde_json::from_slice(&std::fs::read(path).expect("read fixture")).expect("fixture JSON");
            if stem == id {
                fallback = Some(value);
            } else if let Some(req) = stem.strip_prefix(&format!("{id}-")).or_else(|| stem.strip_prefix(&format!("{id}."))) {
                // File names use hyphens; request ids may use underscores.
                by_request.insert(req.replace('-', "_"), value.clone());
                by_request.insert(req.to_string(), value);
            }
        }
        let fetcher = FixtureFetcher { by_request, fallback };
        let responses = run_requests(&def, &fetcher, "fixture-key").unwrap_or_else(|e| panic!("{id}: {e}"));
        let mapped = map_responses(&def, &responses, 1_700_000_000_000);

        let Ok(bytes) = std::fs::read(fixtures_dir().join(format!("{id}.expect.json"))) else { continue };
        let expect: Value = serde_json::from_slice(&bytes).expect("expect JSON");
        if let Some(windows) = expect.get("windows").and_then(Value::as_array) {
            for want in windows {
                let wid = want.get("id").and_then(Value::as_str).unwrap_or("");
                let got = mapped.windows.iter().find(|w| w.get("id").and_then(Value::as_str) == Some(wid));
                let got = got.unwrap_or_else(|| panic!("{id}: missing expected window {wid}"));
                if let Some(pct) = want.get("usedPercent").and_then(Value::as_f64) {
                    assert!((got["usedPercent"].as_f64().unwrap_or(-1.0) - pct).abs() <= 0.01, "{id}: window {wid} percent mismatch");
                }
                if let Some(kind) = want.get("kind").and_then(Value::as_str) {
                    assert_eq!(got["kind"].as_str(), Some(kind), "{id}: window {wid} kind mismatch");
                }
            }
        }
        if let Some(balances) = expect.get("balances").and_then(Value::as_array) {
            for want in balances {
                let bid = want.get("id").and_then(Value::as_str).unwrap_or("");
                let got = mapped.balances.iter().find(|b| b.get("id").and_then(Value::as_str) == Some(bid));
                let got = got.unwrap_or_else(|| panic!("{id}: missing expected balance {bid}"));
                if let Some(amount) = want.get("amount").and_then(Value::as_f64) {
                    assert!((got["amount"].as_f64().unwrap_or(-1.0) - amount).abs() <= 0.01, "{id}: balance {bid} amount mismatch");
                }
            }
        }
    }
}

#[test]
fn handles_null_nan_negative_and_huge_values() {
    let toml = r#"
schema = 1
id = "edge"
label = "Edge"
status = "stable"
auth = "apiKey"
key_hosts = ["api.example.com"]
[[request]]
id = "r"
method = "GET"
url = "https://api.example.com/v1/me"
[[window]]
id = "pct"
kind = "other"
label = "Percent"
from = "r"
used_percent = "$.pct"
[[window]]
id = "ratio"
kind = "monthly"
label = "Ratio"
from = "r"
used = "$.used"
limit = "$.limit"
[[balance]]
id = "amount"
label = "Amount"
kind = "credit"
from = "r"
amount = "$.amount"
"#;
    let def = Definition::parse(toml).unwrap();
    let fixture: Value = serde_json::from_str(r#"{"pct":"NaN","used":-20,"limit":100,"amount":1e300}"#).unwrap();
    let fetcher = FixtureFetcher { by_request: HashMap::new(), fallback: Some(fixture) };
    let responses = run_requests(&def, &fetcher, "k").unwrap();
    let mapped = map_responses(&def, &responses, 0);
    assert!(mapped.windows.iter().all(|w| w["usedPercent"].as_f64().unwrap_or(0.0).is_finite()));
    // "NaN" is not a finite number, so the percent window is dropped rather than read as zero.
    assert!(mapped.windows.iter().all(|w| w["id"] != serde_json::json!("pct")));
    let ratio = mapped.windows.iter().find(|w| w["id"] == serde_json::json!("ratio")).expect("ratio window");
    assert_eq!(ratio["usedPercent"], serde_json::json!(0.0));
}
