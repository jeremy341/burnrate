//! HTTP execution and the injectable fetcher used by tests. No network call is ever made from a
//! unit test: tests supply a fetcher that returns fixture JSON.
use super::model::{Definition, RequestSpec};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;

pub const MAX_BODY: u64 = 256 * 1024;

#[derive(Debug)]
pub enum FetchError {
    /// 429 or 5xx (drives exponential backoff).
    Http(u16),
    Parse(String),
    Network(String),
    /// Refused by a safety rule: bad scheme/host, redirect, too large, bad placeholder.
    Refused(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Http(code) => write!(f, "HTTP {code}"),
            FetchError::Parse(msg) => write!(f, "invalid response: {msg}"),
            FetchError::Network(msg) => write!(f, "network error: {msg}"),
            FetchError::Refused(msg) => write!(f, "request refused: {msg}"),
        }
    }
}

impl FetchError {
    /// Messages returned to the UI or stored in `unavailable` must never contain a key.
    pub fn redacted(&self) -> String {
        crate::net_guard::redact(&self.to_string())
    }

    pub fn is_backoff(&self) -> bool {
        matches!(self, FetchError::Http(429) | FetchError::Http(500..=599))
    }
}

pub trait Fetcher: Send + Sync {
    fn fetch(&self, def: &Definition, req: &RequestSpec, key: &str) -> Result<Value, FetchError>;
}

/// Executes an entire definition once with one key, in request order.
pub fn run_requests(def: &Definition, fetcher: &dyn Fetcher, key: &str) -> Result<HashMap<String, Value>, FetchError> {
    let mut responses = HashMap::new();
    for req in &def.request {
        match fetcher.fetch(def, req, key) {
            Ok(value) => {
                responses.insert(req.id.clone(), value);
            }
            Err(_e) if req.optional => {
                // A failed optional request (e.g. a management-only credits endpoint) is skipped.
                responses.insert(req.id.clone(), Value::Null);
            }
            Err(e) => return Err(e),
        }
    }
    Ok(responses)
}

fn host_allowed(host: &str, key_hosts: &[String]) -> bool {
    key_hosts.iter().any(|h| {
        let h = h.trim().to_ascii_lowercase();
        let host = host.trim().to_ascii_lowercase();
        host == h || host.ends_with(&format!(".{h}"))
    })
}

fn substitute(text: &str, key: &str) -> Result<String, FetchError> {
    let out = text.replace("{{key}}", key);
    if out.contains("{{") || out.contains("}}") {
        return Err(FetchError::Refused("unsupported placeholder in request".into()));
    }
    Ok(out)
}

/// The real HTTP fetcher. Every request passes through `net_guard` immediately before it is sent.
pub struct HttpFetcher;

impl Fetcher for HttpFetcher {
    fn fetch(&self, def: &Definition, req: &RequestSpec, key: &str) -> Result<Value, FetchError> {
        let url = substitute(&req.url, key)?;
        let headers: Result<Vec<(String, String)>, FetchError> = req
            .headers
            .iter()
            .map(|(k, v)| Ok((substitute(k, key)?, substitute(v, key)?)))
            .collect();
        let headers = headers?;
        let body = substitute(&req.body, key)?;

        let parsed = url::Url::parse(&url).map_err(|_| FetchError::Refused("invalid url".into()))?;
        let host = parsed.host_str().unwrap_or("").to_string();
        if host.is_empty() {
            return Err(FetchError::Refused("url has no host".into()));
        }
        // The key may only reach hosts in key_hosts (exact or subdomain). For key-less definitions
        // bind to the URL's own host so net_guard still blocks private/metadata addresses.
        let bound_host = if def.key_hosts.is_empty() {
            host.clone()
        } else if host_allowed(&host, &def.key_hosts) {
            def.key_hosts
                .iter()
                .find(|h| host.eq_ignore_ascii_case(h.trim()) || host.to_ascii_lowercase().ends_with(&format!(".{}", h.trim().to_ascii_lowercase())))
                .cloned()
                .unwrap_or_else(|| host.clone())
        } else {
            return Err(FetchError::Refused("url host is not in key_hosts".into()));
        };
        let checked = crate::net_guard::check_url(&url, Some(&bound_host), false).map_err(FetchError::Refused)?;

        let timeout = Duration::from_secs(req.timeout_seconds.clamp(1, 60));
        // Refuse redirects at the agent level: a redirect could move the key to an unvalidated host.
        // GuardedResolver re-validates the DNS answers at connect time and dials exactly those addresses,
        // so a name that flips to a private address after `check_url` cannot reach the keyed request.
        // The environment proxy is disabled so the resolver sees the real target host.
        let agent = ureq::AgentBuilder::new()
            .timeout(timeout)
            .redirects(0)
            .try_proxy_from_env(false)
            .resolver(crate::net_guard::GuardedResolver { allow_local: false })
            .build();
        let mut request = if req.method == "POST" {
            agent.post(&checked)
        } else {
            agent.get(&checked)
        };
        for (name, value) in &headers {
            request = request.set(name, value);
        }
        let response = if req.method == "POST" {
            request.send_string(&body)
        } else {
            request.call()
        };
        let response = match response {
            Ok(r) => r,
            Err(ureq::Error::Status(code, _)) if (300..400).contains(&code) => {
                return Err(FetchError::Refused("redirect refused".into()));
            }
            Err(ureq::Error::Status(code, _)) => return Err(FetchError::Http(code)),
            Err(e) => return Err(FetchError::Network(e.to_string())),
        };
        // Defence in depth: even if ureq followed an internal redirect, verify the final host.
        let final_host = url::Url::parse(response.get_url())
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default();
        let final_hosts: Vec<String> = if def.key_hosts.is_empty() { vec![host.clone()] } else { def.key_hosts.clone() };
        if !host_allowed(&final_host, &final_hosts) {
            return Err(FetchError::Refused("redirect to a different host refused".into()));
        }

        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(MAX_BODY + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| FetchError::Network(e.to_string()))?;
        if bytes.len() as u64 > MAX_BODY {
            return Err(FetchError::Refused("response body exceeds 256 KiB".into()));
        }
        serde_json::from_slice::<Value>(&bytes).map_err(|e| FetchError::Parse(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::defs::model::Definition;
    use serde_json::json;

    fn def() -> Definition {
        Definition::parse(
            r#"
schema = 1
id = "demo"
label = "Demo"
status = "stable"
auth = "apiKey"
key_hosts = ["api.example.com"]
[[request]]
id = "r"
method = "GET"
url = "https://api.example.com/v1/me"
headers = { Authorization = "Bearer {{key}}" }
"#,
        )
        .unwrap()
    }

    struct Fixture(Value);
    impl Fetcher for Fixture {
        fn fetch(&self, _d: &Definition, _r: &RequestSpec, _k: &str) -> Result<Value, FetchError> {
            Ok(self.0.clone())
        }
    }

    #[test]
    fn injectable_fetcher_runs_without_network() {
        let responses = run_requests(&def(), &Fixture(json!({"ok": true})), "secret").unwrap();
        assert_eq!(responses["r"]["ok"], json!(true));
    }

    #[test]
    fn optional_request_failure_is_skipped() {
        let mut d = def();
        d.request[0].optional = true;
        struct Fails;
        impl Fetcher for Fails {
            fn fetch(&self, _d: &Definition, _r: &RequestSpec, _k: &str) -> Result<Value, FetchError> {
                Err(FetchError::Http(403))
            }
        }
        let responses = run_requests(&d, &Fails, "secret").unwrap();
        assert!(responses["r"].is_null());
    }
}
