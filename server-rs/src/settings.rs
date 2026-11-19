use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// What the engine needs: per-model prices ([input, output, cacheRead, cacheWrite] per million) and model names.
#[derive(Clone, Default)]
pub struct Settings {
    pub prices: HashMap<String, [Option<f64>; 4]>,
    pub aliases: HashMap<String, String>,
}

pub struct SettingsStore {
    path: PathBuf,
    raw: Mutex<Value>,
}

fn price(v: &Value) -> bool {
    v.as_f64().is_some_and(|n| n.is_finite() && (0.0..1e6).contains(&n))
}

fn valid_price(p: &Value) -> bool {
    let Some(o) = p.as_object() else { return false };
    price(o.get("inputCostPerMillionTokens").unwrap_or(&Value::Null))
        && price(o.get("outputCostPerMillionTokens").unwrap_or(&Value::Null))
        && o.get("cacheReadCostPerMillionTokens").map_or(true, price)
        && o.get("cacheWriteCostPerMillionTokens").map_or(true, price)
}

fn valid_name(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= 200
}

impl SettingsStore {
    pub fn open(data_dir: &std::path::Path) -> SettingsStore {
        let path = data_dir.join("settings.json");
        let loaded = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let get = |k: &str| loaded.as_ref().and_then(|v| v.get(k)).filter(|v| v.is_object()).cloned().unwrap_or_else(|| json!({}));
        let raw = json!({"usagePriceOverrides": get("usagePriceOverrides"), "usageModelAliases": get("usageModelAliases")});
        SettingsStore { path, raw: Mutex::new(raw) }
    }

    pub fn raw(&self) -> Value {
        self.raw.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn get(&self) -> Settings {
        let raw = self.raw();
        let mut s = Settings::default();
        if let Some(prices) = raw.get("usagePriceOverrides").and_then(Value::as_object) {
            for (model, p) in prices {
                let f = |k: &str| p.get(k).and_then(Value::as_f64);
                s.prices.insert(
                    model.clone(),
                    [f("inputCostPerMillionTokens"), f("outputCostPerMillionTokens"), f("cacheReadCostPerMillionTokens"), f("cacheWriteCostPerMillionTokens")],
                );
            }
        }
        if let Some(aliases) = raw.get("usageModelAliases").and_then(Value::as_object) {
            for (model, target) in aliases {
                if let Some(t) = target.as_str() {
                    s.aliases.insert(model.clone(), t.to_string());
                }
            }
        }
        s
    }

    /// `null` removes an entry. Invalid entries reject the whole patch.
    pub fn patch(&self, patch: &Value) -> Option<Value> {
        let mut guard = self.raw.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = guard.clone();
        for (key, check) in [("usagePriceOverrides", true), ("usageModelAliases", false)] {
            let Some(changes) = patch.get(key).and_then(Value::as_object) else { continue };
            let target: &mut Map<String, Value> = next.get_mut(key)?.as_object_mut()?;
            for (model, value) in changes {
                if !valid_name(model) {
                    return None;
                }
                if value.is_null() {
                    target.remove(model);
                } else if check && valid_price(value) {
                    target.insert(model.clone(), value.clone());
                } else if !check && value.as_str().is_some_and(valid_name) {
                    target.insert(model.clone(), value.clone());
                } else {
                    return None;
                }
            }
        }
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&self.path, serde_json::to_vec_pretty(&next).ok()?).ok()?;
        *guard = next.clone();
        Some(next)
    }
}
