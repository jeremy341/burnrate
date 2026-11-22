//! Definition linting. `validate` never touches the network: it only parses and checks every rule.
use super::extract::{is_json_path, parse_transform, valid_json_path};
use super::model::{AuthKind, Definition};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LintError {
    /// Dotted field path, e.g. `request[0].url` or `window[1].transform[0]`.
    pub field: String,
    pub message: String,
}

fn err(field: impl Into<String>, message: impl Into<String>) -> LintError {
    LintError { field: field.into(), message: message.into() }
}

fn valid_id(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_ref_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 60
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && !host.contains('*')
        && !host.contains('/')
        && !host.contains(char::is_whitespace)
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn host_allowed(host: &str, key_hosts: &[String]) -> bool {
    key_hosts.iter().any(|h| {
        let h = h.trim().to_ascii_lowercase();
        let host = host.trim().to_ascii_lowercase();
        host == h || host.ends_with(&format!(".{h}"))
    })
}

/// Finds `{{...}}` placeholders; only `{{key}}` is allowed (and only for apiKey definitions).
fn check_placeholders(text: &str, field: &str, auth: AuthKind, out: &mut Vec<LintError>) {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'{' && bytes[i + 1] == b'{' {
            if let Some(rest) = text[i + 2..].find("}}") {
                let inner = &text[i + 2..i + 2 + rest];
                if inner != "key" {
                    out.push(err(field, format!("unknown placeholder '{{{{{inner}}}}}'; only {{{{key}}}} is allowed")));
                } else if auth != AuthKind::ApiKey {
                    out.push(err(field, "the {{key}} placeholder requires auth = \"apiKey\""));
                }
                i += 2 + rest + 2;
                continue;
            }
            out.push(err(field, "unclosed placeholder '{{'"));
            break;
        }
        i += 1;
    }
}

/// Lints a parsed definition in full. Returns errors in a stable, user-facing order.
pub fn lint(def: &Definition) -> Vec<LintError> {
    let mut out = Vec::new();

    if def.schema != 1 {
        out.push(err("schema", "only schema = 1 is supported"));
    }
    if !valid_id(&def.id, 40) {
        out.push(err("id", "id must be 1..40 characters of [a-z0-9-]"));
    }
    if def.label.trim().is_empty() || def.label.len() > 80 {
        out.push(err("label", "label must be 1..80 characters"));
    }
    if !def.color.is_empty() && (!def.color.starts_with('#') || def.color.len() > 32) {
        out.push(err("color", "color must be a #rrggbb hex value"));
    }
    if !def.docs.is_empty() && !def.docs.starts_with("https://") {
        out.push(err("docs", "docs must be an https URL"));
    }
    if !def.key_url.is_empty() && (!def.key_url.starts_with("https://") || def.key_url.len() > 300 || def.key_url.chars().any(|c| c.is_whitespace() || c.is_control())) {
        out.push(err("key_url", "key_url must be an https URL (the page where the key is created)"));
    }
    if def.auth == AuthKind::ApiKey && def.key_hosts.is_empty() {
        out.push(err("key_hosts", "key_hosts is required when auth = \"apiKey\""));
    }
    for (i, host) in def.key_hosts.iter().enumerate() {
        if !valid_host(host) {
            out.push(err(format!("key_hosts[{i}]"), "key_hosts entries must be host names without a scheme or path"));
        }
    }
    if def.poll_seconds < 60 {
        out.push(err("poll_seconds", "poll_seconds must be at least 60"));
    }

    if def.request.is_empty() || def.request.len() > 4 {
        out.push(err("request", "a definition needs between 1 and 4 [[request]] blocks"));
    }
    let mut req_ids = std::collections::HashSet::new();
    for (i, req) in def.request.iter().enumerate() {
        let base = format!("request[{i}]");
        if !valid_ref_id(&req.id) {
            out.push(err(format!("{base}.id"), "request id must be 1..60 characters of [A-Za-z0-9_-]"));
        } else if !req_ids.insert(req.id.clone()) {
            out.push(err(format!("{base}.id"), format!("duplicate request id '{}'", req.id)));
        }
        if req.method != "GET" && req.method != "POST" {
            out.push(err(format!("{base}.method"), "method must be GET or POST"));
        }
        if !(1..=60).contains(&req.timeout_seconds) {
            out.push(err(format!("{base}.timeout_seconds"), "timeout_seconds must be between 1 and 60"));
        }
        let parsed = match url::Url::parse(&req.url) {
            Ok(u) => Some(u),
            Err(_) => {
                out.push(err(format!("{base}.url"), "url must be a valid absolute URL"));
                None
            }
        };
        if let Some(u) = &parsed {
            if u.scheme() != "https" {
                out.push(err(format!("{base}.url"), "only https URLs are allowed"));
            }
            if u.username() != "" || u.password().is_some() {
                out.push(err(format!("{base}.url"), "url must not contain credentials"));
            }
            let host = u.host_str().unwrap_or("");
            if host.is_empty() {
                out.push(err(format!("{base}.url"), "url must contain a host"));
            } else if def.auth == AuthKind::ApiKey && !host_allowed(host, &def.key_hosts) {
                out.push(err(format!("{base}.url"), format!("host '{host}' is not in key_hosts")));
            }
        }
        check_placeholders(&req.url, &format!("{base}.url"), def.auth, &mut out);
        for (name, value) in &req.headers {
            check_placeholders(name, &format!("{base}.headers"), def.auth, &mut out);
            check_placeholders(value, &format!("{base}.headers.{name}"), def.auth, &mut out);
        }
        check_placeholders(&req.body, &format!("{base}.body"), def.auth, &mut out);
        if req.method == "POST" && !req.body.is_empty() {
            match serde_json::from_str::<serde_json::Value>(&req.body) {
                Ok(v) if !v.is_object() && !v.is_array() => {
                    out.push(err(format!("{base}.body"), "POST body must be a JSON object or array"));
                }
                Err(_) => out.push(err(format!("{base}.body"), "POST body must be valid JSON")),
                _ => {}
            }
        }
    }

    let mut window_ids = std::collections::HashSet::new();
    for (i, w) in def.window.iter().enumerate() {
        let base = format!("window[{i}]");
        if !valid_ref_id(&w.id) {
            out.push(err(format!("{base}.id"), "window id must be 1..60 characters of [A-Za-z0-9_-]"));
        } else if !window_ids.insert(w.id.clone()) {
            out.push(err(format!("{base}.id"), format!("duplicate window id '{}'", w.id)));
        }
        if w.label.trim().is_empty() || w.label.len() > 80 {
            out.push(err(format!("{base}.label"), "label must be 1..80 characters"));
        }
        if !req_ids.contains(&w.from) {
            out.push(err(format!("{base}.from"), format!("unknown request id '{}'", w.from)));
        }
        let has_pct = w.used_percent.is_some();
        let has_used = w.used.is_some() && w.limit.is_some();
        let has_remaining = w.remaining.is_some() && w.limit.is_some();
        if !has_pct && !has_used && !has_remaining {
            out.push(err(&base, "window needs used_percent, or used + limit, or remaining + limit"));
        }
        for (field, spec) in [
            ("used_percent", &w.used_percent),
            ("used", &w.used),
            ("remaining", &w.remaining),
            ("limit", &w.limit),
            ("resets_at", &w.resets_at),
        ] {
            if let Some(spec) = spec {
                if spec.trim().is_empty() {
                    out.push(err(format!("{base}.{field}"), "expression must not be empty"));
                } else if is_json_path(spec) && !valid_json_path(spec) {
                    out.push(err(format!("{base}.{field}"), "invalid JSONPath expression"));
                }
            }
        }
        if w.resets_at_format.is_some() && w.resets_at.is_none() {
            out.push(err(format!("{base}.resets_at_format"), "resets_at_format requires resets_at"));
        }
        if let Some(mins) = w.window_minutes {
            if !mins.is_finite() || mins < 0.0 {
                out.push(err(format!("{base}.window_minutes"), "window_minutes must be a non-negative number"));
            }
        }
        check_skip_if_null(&w.skip_if_null, &base, &[
            ("used_percent", w.used_percent.is_some()),
            ("used", w.used.is_some()),
            ("remaining", w.remaining.is_some()),
            ("limit", w.limit.is_some()),
            ("resets_at", w.resets_at.is_some()),
        ], &mut out);
        check_transforms(&w.transform, &format!("{base}.transform"), &mut out);
    }

    let mut balance_ids = std::collections::HashSet::new();
    for (i, b) in def.balance.iter().enumerate() {
        let base = format!("balance[{i}]");
        if !valid_ref_id(&b.id) {
            out.push(err(format!("{base}.id"), "balance id must be 1..60 characters of [A-Za-z0-9_-]"));
        } else if !balance_ids.insert(b.id.clone()) {
            out.push(err(format!("{base}.id"), format!("duplicate balance id '{}'", b.id)));
        }
        if b.label.trim().is_empty() || b.label.len() > 80 {
            out.push(err(format!("{base}.label"), "label must be 1..80 characters"));
        }
        if !req_ids.contains(&b.from) {
            out.push(err(format!("{base}.from"), format!("unknown request id '{}'", b.from)));
        }
        match &b.amount {
            Some(spec) if !spec.trim().is_empty() => {
                if is_json_path(spec) && !valid_json_path(spec) {
                    out.push(err(format!("{base}.amount"), "invalid JSONPath expression"));
                }
            }
            _ => out.push(err(format!("{base}.amount"), "balance amount is required")),
        }
        for (field, spec) in [("limit", &b.limit)] {
            if let Some(spec) = spec {
                if is_json_path(spec) && !valid_json_path(spec) {
                    out.push(err(format!("{base}.{field}"), "invalid JSONPath expression"));
                }
            }
        }
        if let Some(currency) = &b.currency {
            match currency {
                super::model::CurrencySpec::Literal(s) if s.trim().is_empty() || s.len() > 16 => {
                    out.push(err(format!("{base}.currency"), "currency literal must be 1..16 characters"));
                }
                super::model::CurrencySpec::Path { path } if !valid_json_path(path) => {
                    out.push(err(format!("{base}.currency.path"), "invalid JSONPath expression"));
                }
                _ => {}
            }
        }
        check_transforms(&b.transform, &format!("{base}.transform"), &mut out);
    }

    out
}

fn check_skip_if_null(fields: &[String], base: &str, present: &[(&str, bool)], out: &mut Vec<LintError>) {
    for (i, field) in fields.iter().enumerate() {
        if !present.iter().any(|(name, ok)| *name == field && *ok) {
            out.push(err(format!("{base}.skip_if_null[{i}]"), format!("'{field}' is not an expression on this window")));
        }
    }
}

fn check_transforms(transforms: &[String], base: &str, out: &mut Vec<LintError>) {
    for (i, t) in transforms.iter().enumerate() {
        if parse_transform(t).is_none() {
            out.push(err(format!("{base}[{i}]"), format!("unknown transform '{t}'")));
        }
    }
}

/// Convenience: parse a TOML string and lint it. Parse errors are returned as one lint error.
#[allow(dead_code)]
pub fn validate_toml(text: &str) -> Result<Vec<LintError>, LintError> {
    match Definition::parse(text) {
        Ok(def) => Ok(lint(&def)),
        Err(e) => Err(err("toml", e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"
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
[[window]]
id = "w"
kind = "monthly"
label = "Month"
from = "r"
used = "$.data.used"
limit = "$.data.limit"
"#;

    #[test]
    fn accepts_valid_definition() {
        let def = Definition::parse(GOOD).unwrap();
        assert!(lint(&def).is_empty(), "{:?}", lint(&def));
    }

    #[test]
    fn catches_required_rules() {
        let cases = [
            ("key_hosts = [\"api.example.com\"]", "key_hosts = []", "key_hosts"),
            ("https://api.example.com/v1/me", "http://api.example.com/v1/me", "request[0].url"),
            ("key_hosts = [\"api.example.com\"]", "key_hosts = [\"other.com\"]", "request[0].url"),
            ("id = \"demo\"", "id = \"Bad_Id\"", "id"),
            ("method = \"GET\"", "method = \"PATCH\"", "method"),
            ("used = \"$.data.used\"", "used = \"$..[\"", "invalid"),
        ];
        for (from, to, needle) in cases {
            let text = GOOD.replace(from, to).replace("{{key}}", "");
            let errors = validate_toml(&text).unwrap_or_else(|e| vec![e]);
            assert!(errors.iter().any(|e| e.field.contains(needle) || e.message.contains(needle)), "{needle}: {errors:?}");
        }
    }

    #[test]
    fn catches_bad_placeholders_and_transforms() {
        let text = GOOD.replace(
            "url = \"https://api.example.com/v1/me\"",
            "url = \"https://api.example.com/v1/me?x={{token}}\"",
        ).replace("limit = \"$.data.limit\"", "limit = \"$.data.limit\"\ntransform = [\"bogus:1\"]");
        let errors = validate_toml(&text).unwrap();
        assert!(errors.iter().any(|e| e.message.contains("unknown placeholder")));
        assert!(errors.iter().any(|e| e.message.contains("unknown transform")));
    }
}
