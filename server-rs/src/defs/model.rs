//! Data model for declarative provider definitions (contracts section 4).
//!
//! The TOML shape here is the one defined in `docs/CONTRACTS.md` section 4. It is deliberately
//! small: a definition has 1..4 HTTP requests, 0..n percent windows and 0..n money balances.
//! All expressions are JSONPath (RFC 9535) or plain number literals; there is no scripting.
use serde::Deserialize;
use std::collections::HashMap;

fn default_poll() -> u64 {
    300
}

fn default_timeout() -> u64 {
    10
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DefStatus {
    Stable,
    Experimental,
    Disabled,
}

impl DefStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DefStatus::Stable => "stable",
            DefStatus::Experimental => "experimental",
            DefStatus::Disabled => "disabled",
        }
    }
}

/// Where a provider belongs on the Providers screen. Definitions are API-key based, so they are
/// `apiKey` unless they say otherwise; organisation-level billing keys are `admin` and tools with a
/// product login that also accept a key (OpenCode Go) are `agent`.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum DefCategory {
    Agent,
    #[default]
    ApiKey,
    Admin,
    LocalLogs,
}

impl DefCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            DefCategory::Agent => "agent",
            DefCategory::ApiKey => "apiKey",
            DefCategory::Admin => "admin",
            DefCategory::LocalLogs => "localLogs",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    ApiKey,
    None,
}

impl AuthKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthKind::ApiKey => "apiKey",
            AuthKind::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WindowKind {
    Session,
    Weekly,
    Monthly,
    Other,
}

impl WindowKind {
    pub fn as_str(self) -> &'static str {
        match self {
            WindowKind::Session => "session",
            WindowKind::Weekly => "weekly",
            WindowKind::Monthly => "monthly",
            WindowKind::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BalanceKind {
    Credit,
    Spend,
    Cap,
}

impl BalanceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            BalanceKind::Credit => "credit",
            BalanceKind::Spend => "spend",
            BalanceKind::Cap => "cap",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResetsFormat {
    Iso8601,
    UnixS,
    UnixMs,
    SecondsFromNow,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    Official,
    Unofficial,
    Statusline,
    Local,
    Estimated,
}

impl Provenance {
    pub fn as_str(self) -> &'static str {
        match self {
            Provenance::Official => "official",
            Provenance::Unofficial => "unofficial",
            Provenance::Statusline => "statusline",
            Provenance::Local => "local",
            Provenance::Estimated => "estimated",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RequestSpec {
    pub id: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: String,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    /// Optional requests (e.g. a management-only `/credits` endpoint) are skipped on failure.
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WindowSpec {
    pub id: String,
    pub kind: WindowKind,
    pub label: String,
    /// Id of the request whose response feeds this window.
    pub from: String,
    /// A percent already computed by the provider (JSONPath or number literal).
    #[serde(default)]
    pub used_percent: Option<String>,
    /// Used amount together with `limit` -> usedPercent = used / limit * 100.
    #[serde(default)]
    pub used: Option<String>,
    /// Remaining amount together with `limit` -> usedPercent = (limit - remaining) / limit * 100.
    #[serde(default)]
    pub remaining: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
    #[serde(default)]
    pub resets_at: Option<String>,
    #[serde(default)]
    pub resets_at_format: Option<ResetsFormat>,
    #[serde(default)]
    pub window_minutes: Option<f64>,
    /// Window field names whose extraction must yield a non-null value, otherwise skip the window.
    #[serde(default)]
    pub skip_if_null: Vec<String>,
    /// Closed-set transforms applied to the final percentage.
    #[serde(default)]
    pub transform: Vec<String>,
    #[serde(default)]
    pub provenance: Option<Provenance>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum CurrencySpec {
    Literal(String),
    Path { path: String },
}

#[derive(Debug, Clone, Deserialize)]
pub struct BalanceSpec {
    pub id: String,
    pub label: String,
    pub kind: BalanceKind,
    pub from: String,
    #[serde(default)]
    pub amount: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
    #[serde(default)]
    pub currency: Option<CurrencySpec>,
    #[serde(default)]
    pub transform: Vec<String>,
    #[serde(default)]
    pub provenance: Option<Provenance>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Definition {
    pub schema: u32,
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub color: String,
    pub status: DefStatus,
    /// Providers screen group: `agent` | `apiKey` (default) | `admin` | `localLogs`.
    #[serde(default)]
    pub category: DefCategory,
    #[serde(default)]
    pub docs: String,
    /// Page where the user creates the key (https), shown as "Open the page to get your key".
    #[serde(default)]
    pub key_url: String,
    pub auth: AuthKind,
    #[serde(default)]
    pub key_hosts: Vec<String>,
    #[serde(default = "default_poll")]
    pub poll_seconds: u64,
    #[serde(default)]
    pub plan: String,
    #[serde(default)]
    pub request: Vec<RequestSpec>,
    #[serde(default)]
    pub window: Vec<WindowSpec>,
    #[serde(default)]
    pub balance: Vec<BalanceSpec>,
}

impl Definition {
    pub fn parse(toml_text: &str) -> Result<Definition, toml::de::Error> {
        toml::from_str(toml_text)
    }
}

/// The JSON preview returned by `POST /api/defs/validate`.
pub fn preview(def: &Definition) -> serde_json::Value {
    serde_json::json!({
        "id": def.id,
        "label": def.label,
        "color": def.color,
        "status": def.status.as_str(),
        "category": def.category.as_str(),
        "auth": def.auth.as_str(),
        "docs": def.docs,
        "keyUrl": def.key_url,
        "keyHosts": def.key_hosts,
        "pollSeconds": def.poll_seconds,
        "plan": def.plan,
        "requests": def.request.iter().map(|r| serde_json::json!({
            "id": r.id, "method": r.method, "url": r.url, "optional": r.optional,
            "timeoutSeconds": r.timeout_seconds,
        })).collect::<Vec<_>>(),
        "windows": def.window.iter().map(|w| serde_json::json!({
            "id": w.id, "kind": w.kind.as_str(), "label": w.label, "from": w.from,
        })).collect::<Vec<_>>(),
        "balances": def.balance.iter().map(|b| serde_json::json!({
            "id": b.id, "kind": b.kind.as_str(), "label": b.label, "from": b.from,
        })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r##"
schema = 1
id = "openrouter"
label = "OpenRouter"
color = "#6467f2"
status = "stable"
docs = "https://openrouter.ai/docs/api-reference/limits"
auth = "apiKey"
key_hosts = ["openrouter.ai"]
poll_seconds = 300
plan = "OpenRouter key"

[[request]]
id = "key"
method = "GET"
url = "https://openrouter.ai/api/v1/key"
headers = { Authorization = "Bearer {{key}}" }
timeout_seconds = 10

[[window]]
id = "key_limit"
kind = "monthly"
label = "Key limit"
from = "key"
used = "$.data.usage"
limit = "$.data.limit"
resets_at = "$.data.limit_reset"
resets_at_format = "iso8601"
skip_if_null = ["limit"]
provenance = "official"

[[balance]]
id = "credits"
label = "Credits"
kind = "credit"
from = "key"
amount = "$.data.limit_remaining"
limit = "$.data.limit"
currency = "USD"
provenance = "official"
"##;

    #[test]
    fn parses_contract_example() {
        let def = Definition::parse(SAMPLE).expect("sample TOML must parse");
        assert_eq!(def.id, "openrouter");
        assert_eq!(def.auth, AuthKind::ApiKey);
        assert_eq!(def.request.len(), 1);
        assert_eq!(def.window.len(), 1);
        assert_eq!(def.balance.len(), 1);
        assert_eq!(def.window[0].kind, WindowKind::Monthly);
        assert_eq!(def.poll_seconds, 300);
        // Omitted `category` means a plain API-key provider.
        assert_eq!(def.category, DefCategory::ApiKey);
    }

    #[test]
    fn category_is_parsed_and_rejects_unknown_values() {
        let admin = format!("category = \"admin\"
{SAMPLE}");
        // `category` after the tables would belong to the last table, so put it at the top level.
        let def = Definition::parse(&admin).expect("category parses");
        assert_eq!(def.category, DefCategory::Admin);
        assert_eq!(def.category.as_str(), "admin");
        assert!(Definition::parse(&format!("category = \"nonsense\"
{SAMPLE}")).is_err());
    }
}
