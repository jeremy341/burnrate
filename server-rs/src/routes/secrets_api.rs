//! Generic secret store routes (notification channel URLs/tokens etc.). Values are write-only:
//! `GET` returns only the names that are set, never the secrets themselves.
//! Owned by the net-guard-keys package (docs/CONTRACTS.md section 6).

use super::Resp;
use crate::{json_response, read_body, State};
use serde_json::{json, Value};
use tiny_http::{Method, Request};

/// Scope and name are single URL path segments. Keep them to a conservative, predictable charset.
fn valid_segment(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

fn secret_list(state: &State, scope: &str) -> Value {
    Value::Array(
        state
            .keys
            .secret_names(scope)
            .into_iter()
            .map(|name| json!({"name": name, "set": true}))
            .collect(),
    )
}

pub fn handle(state: &State, request: &mut Request, method: &Method, path: &str) -> Option<Resp> {
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if parts.len() < 3 || parts[0] != "api" || parts[1] != "secrets" {
        return None;
    }
    let scope = parts[2];
    if !valid_segment(scope, 40) {
        return Some(json_response(400, &json!({"error": "invalid scope"})));
    }

    match (method, parts.len()) {
        // GET /api/secrets/<scope> -> [{name, set:true}]
        (Method::Get, 3) => Some(json_response(200, &secret_list(state, scope))),

        // PUT /api/secrets/<scope>/<name> {value} -> values are never returned
        (Method::Put, 4) => {
            let name = parts[3];
            if !valid_segment(name, 64) {
                return Some(json_response(400, &json!({"error": "invalid name"})));
            }
            let Some(body) = read_body(request) else {
                return Some(json_response(400, &json!({"error": "invalid value"})));
            };
            let value = body.get("value").and_then(Value::as_str).unwrap_or("").trim();
            if value.is_empty() || value.len() > 8192 {
                return Some(json_response(400, &json!({"error": "invalid value"})));
            }
            if state.keys.set_secret(scope, name, value) {
                Some(json_response(200, &json!({"ok": true})))
            } else {
                Some(json_response(500, &json!({"error": "storage failed"})))
            }
        }

        // DELETE /api/secrets/<scope>/<name>
        (Method::Delete, 4) => {
            let name = parts[3];
            if !valid_segment(name, 64) {
                return Some(json_response(400, &json!({"error": "invalid name"})));
            }
            if state.keys.remove_secret(scope, name) {
                Some(json_response(200, &json!({"ok": true})))
            } else {
                Some(json_response(404, &json!({"error": "not found"})))
            }
        }

        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_scope_and_name_segments() {
        assert!(valid_segment("alerts", 40));
        assert!(valid_segment("my-scope_2", 40));
        assert!(!valid_segment("", 40));
        assert!(!valid_segment("bad/scope", 40));
        assert!(!valid_segment("a:b", 40));
        assert!(!valid_segment(&"x".repeat(41), 40));
        assert!(valid_segment("discord", 64));
    }
}
