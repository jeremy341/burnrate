//! `Provider` trait adapter: one instance per enabled definition.
use super::cache::{now, DefCache, FetchOutcome};
use super::fetch::{run_requests, FetchError, Fetcher};
use super::mapping::map_responses;
use super::model::Definition;
use crate::keys::KeyStore;
use crate::providers::{unavailable_account, Auth, Category, Provider};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

/// A definition-backed provider. The cache mutex is held across the whole network batch, which
/// guarantees never more than one in-flight probe per definition.
pub struct DefProvider {
    def: Definition,
    id: &'static str,
    label: &'static str,
    color: &'static str,
    fetcher: Arc<dyn Fetcher>,
    cache: Mutex<DefCache>,
    /// A definition the user wrote (its id is not one of the embedded built-ins).
    custom: bool,
}

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

impl DefProvider {
    pub fn new(def: Definition, fetcher: Arc<dyn Fetcher>) -> DefProvider {
        let poll_seconds = def.poll_seconds;
        Self::new_with_poll(def, fetcher, poll_seconds)
    }

    /// `poll_seconds` may come from `providers.overrides.<id>.pollSeconds` in settings.
    pub fn new_with_poll(def: Definition, fetcher: Arc<dyn Fetcher>, poll_seconds: u64) -> DefProvider {
        let id = leak(def.id.clone());
        let label = leak(def.label.clone());
        let color = leak(def.color.clone());
        let cache = Mutex::new(DefCache::new(poll_seconds));
        let custom = !super::BUILTIN_DEFS.iter().any(|(builtin, _)| *builtin == def.id);
        DefProvider { def, id, label, color, fetcher, cache, custom }
    }

    fn head(&self, key_name: &str) -> Value {
        let mut head = json!({
            "id": format!("{}-{}", self.id, key_name),
            "driver": self.id,
            "label": key_name,
        });
        if !self.def.plan.is_empty() {
            head["plan"] = json!(self.def.plan);
        }
        if !self.color.is_empty() {
            head["accentColor"] = json!(self.color);
        }
        head
    }

    fn probe(&self, key: &str) -> Result<Value, FetchError> {
        let responses = run_requests(&self.def, self.fetcher.as_ref(), key)?;
        let mapped = map_responses(&self.def, &responses, now());
        let mut limits = json!({"checkedAt": crate::providers::iso_now(), "windows": mapped.windows});
        if !mapped.balances.is_empty() {
            limits["balances"] = json!(mapped.balances);
        }
        let mut account = json!({});
        account["limits"] = limits;
        Ok(account)
    }
}

impl Provider for DefProvider {
    fn id(&self) -> &'static str {
        self.id
    }

    fn label(&self) -> &'static str {
        self.label
    }

    fn color(&self) -> &'static str {
        self.color
    }

    fn auth(&self) -> Auth {
        // Definitions are exposed through the same /api/providers/<id>/keys routes as native
        // API-key providers; `auth = "none"` definitions simply run with an empty key.
        Auth::ApiKey
    }

    fn category(&self) -> Category {
        match self.def.category {
            super::model::DefCategory::Agent => Category::Agent,
            super::model::DefCategory::ApiKey => Category::ApiKey,
            super::model::DefCategory::Admin => Category::Admin,
            super::model::DefCategory::LocalLogs => Category::LocalLogs,
        }
    }

    fn key_url(&self) -> Option<String> {
        (!self.def.key_url.is_empty()).then(|| self.def.key_url.clone())
    }

    fn hint(&self) -> &'static str {
        match self.def.category {
            super::model::DefCategory::Admin => "Needs an organization admin key",
            _ => "Paste an API key",
        }
    }

    fn custom(&self) -> bool {
        self.custom
    }

    fn read(&self, keys: &KeyStore) -> Vec<Value> {
        let saved = keys.list(self.id);
        if saved.is_empty() {
            return Vec::new();
        }
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.get_or_fetch(now(), || {
            let mut accounts = Vec::with_capacity(saved.len());
            let mut failed = false;
            for (name, key) in &saved {
                match self.probe(key) {
                    Ok(mut account) => {
                        let head = self.head(name);
                        if let (Some(dst), Some(src)) = (head.as_object(), account.as_object_mut()) {
                            // Merge the head fields into the probed limits object.
                            for (k, v) in dst {
                                src.insert(k.clone(), v.clone());
                            }
                        }
                        accounts.push(account);
                    }
                    Err(e) => {
                        // 429/5xx and network failures drive exponential backoff; a bad
                        // response body is retried on the normal poll interval instead.
                        failed = failed || e.is_backoff() || matches!(e, FetchError::Network(_));
                        accounts.push(unavailable_account(self.head(name), e.redacted()));
                    }
                }
            }
            FetchOutcome { accounts, failed }
        })
    }

    fn test_key(&self, key: &str) -> Result<(), String> {
        self.probe(key).map(|_| ()).map_err(|e| e.redacted())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn def() -> Definition {
        Definition::parse(
            r##"
schema = 1
id = "demo"
label = "Demo"
color = "#123456"
status = "stable"
auth = "apiKey"
key_hosts = ["api.example.com"]
[[request]]
id = "r"
method = "GET"
url = "https://api.example.com/v1/me"
[[window]]
id = "w"
kind = "monthly"
label = "Month"
from = "r"
used = "$.used"
limit = "$.limit"
"##,
        )
        .unwrap()
    }

    struct Fixture;
    impl Fetcher for Fixture {
        fn fetch(&self, _d: &Definition, _r: &super::super::model::RequestSpec, _k: &str) -> Result<Value, FetchError> {
            Ok(json!({"used": 10.0, "limit": 100.0}))
        }
    }

    #[test]
    fn provider_metadata_is_stable() {
        let p = DefProvider::new(def(), Arc::new(Fixture));
        assert_eq!(Provider::id(&p), "demo");
        assert_eq!(p.label(), "Demo");
        assert_eq!(p.color(), "#123456");
        assert!(p.auth() == Auth::ApiKey);
        assert!(p.test_key("secret").is_ok());
    }
}
