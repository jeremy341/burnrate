//! Declarative provider definitions (TOML + JSONPath). Owned by the defs-engine package.
//! Built-in definitions are embedded by build.rs; user definitions live in `<data>/providers.d`.
include!(concat!(env!("OUT_DIR"), "/builtin_defs.rs"));

pub mod cache;
pub mod catalog;
pub mod extract;
pub mod fetch;
pub mod lint;
pub mod mapping;
pub mod model;
pub mod provider;
pub mod user;

#[cfg(test)]
mod fixtures;

use model::{DefStatus, Definition};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

/// The server's data directory (same derivation as lib.rs `run`).
pub fn data_dir() -> PathBuf {
    crate::readers::env_path("BURNRATE_DATA").unwrap_or_else(|| {
        crate::find_web_dir()
            .parent()
            .and_then(|p| p.parent())
            .map_or_else(|| PathBuf::from("data"), |root| root.join("data"))
    })
}

/// Reads the persisted v2 settings file directly so this package does not depend on the exact
/// accessor names of `SettingsStore` (owned by package 01). Missing/corrupt file -> `null`.
pub fn settings_json() -> Value {
    std::fs::read_to_string(data_dir().join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or(Value::Null)
}

fn bool_at(settings: &Value, pointer: &str, default: bool) -> bool {
    settings.pointer(pointer).and_then(Value::as_bool).unwrap_or(default)
}

pub fn custom_definitions_enabled(settings: &Value) -> bool {
    bool_at(settings, "/providers/customDefinitions", true)
}

pub fn experimental_enabled(id: &str, settings: &Value) -> bool {
    bool_at(settings, &format!("/advanced/experimental/{id}"), false)
}

fn override_enabled(id: &str, settings: &Value) -> bool {
    bool_at(settings, &format!("/providers/overrides/{id}/enabled"), true)
}

fn poll_override(id: &str, settings: &Value) -> Option<u64> {
    settings
        .pointer(&format!("/providers/overrides/{id}/pollSeconds"))
        .and_then(Value::as_u64)
        .filter(|n| *n >= 60)
}

fn builtin_ids() -> Vec<String> {
    BUILTIN_DEFS.iter().map(|(id, _)| (*id).to_string()).collect()
}

/// Whether a definition should appear in `/api/providers` and be polled.
pub fn is_enabled(def: &Definition, settings: &Value) -> bool {
    if def.status == DefStatus::Disabled || !override_enabled(&def.id, settings) {
        return false;
    }
    if def.status == DefStatus::Experimental {
        return experimental_enabled(&def.id, settings);
    }
    true
}

pub struct DefEntry {
    pub def: Definition,
    pub source: &'static str,
    pub enabled: bool,
}

/// Every known definition (built-in + user), for the management list endpoint.
pub fn all_definitions() -> Vec<DefEntry> {
    let settings = settings_json();
    let mut out = Vec::new();
    for (_id, src) in BUILTIN_DEFS {
        if let Ok(def) = Definition::parse(src) {
            out.push(DefEntry { enabled: is_enabled(&def, &settings), def, source: "builtin" });
        }
    }
    let builtins = builtin_ids();
    if custom_definitions_enabled(&settings) {
        for (_id, src) in user::load_all(&data_dir()) {
            if let Ok(def) = Definition::parse(&src) {
                // A user definition cannot shadow a built-in id (that would create two adapters).
                if builtins.contains(&def.id) {
                    continue;
                }
                out.push(DefEntry { enabled: is_enabled(&def, &settings), def, source: "user" });
            }
        }
    }
    out.sort_by(|a, b| a.def.id.cmp(&b.def.id));
    out
}

/// Provider-trait adapters for every enabled definition (built-in + user).
pub fn providers() -> Vec<Box<dyn crate::providers::Provider>> {
    let settings = settings_json();
    let mut out: Vec<Box<dyn crate::providers::Provider>> = Vec::new();
    for (_id, src) in BUILTIN_DEFS {
        if let Ok(def) = Definition::parse(src) {
            if is_enabled(&def, &settings) {
                let poll = poll_override(&def.id, &settings).unwrap_or(def.poll_seconds);
                out.push(Box::new(provider::DefProvider::new_with_poll(def, Arc::new(fetch::HttpFetcher), poll)));
            }
        }
    }
    let builtins = builtin_ids();
    if custom_definitions_enabled(&settings) {
        for (_id, src) in user::load_all(&data_dir()) {
            if let Ok(def) = Definition::parse(&src) {
                if builtins.contains(&def.id) {
                    continue;
                }
                if is_enabled(&def, &settings) {
                    let poll = poll_override(&def.id, &settings).unwrap_or(def.poll_seconds);
                    out.push(Box::new(provider::DefProvider::new_with_poll(def, Arc::new(fetch::HttpFetcher), poll)));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn def(status: DefStatus) -> Definition {
        let toml = format!(
            r#"
schema = 1
id = "demo"
label = "Demo"
status = "{}"
auth = "apiKey"
key_hosts = ["api.example.com"]
[[request]]
id = "r"
method = "GET"
url = "https://api.example.com/v1/me"
"#,
            status.as_str()
        );
        Definition::parse(&toml).unwrap()
    }

    #[test]
    fn status_and_experiment_flags() {
        let on = json!({"advanced": {"experimental": {"demo": true}}});
        let off = json!({});
        assert!(is_enabled(&def(DefStatus::Stable), &off));
        assert!(!is_enabled(&def(DefStatus::Experimental), &off));
        assert!(is_enabled(&def(DefStatus::Experimental), &on));
        assert!(!is_enabled(&def(DefStatus::Disabled), &on));
    }

    #[test]
    fn provider_overrides_can_disable() {
        let settings = json!({"providers": {"overrides": {"demo": {"enabled": false}}}});
        assert!(!is_enabled(&def(DefStatus::Stable), &settings));
    }
}
