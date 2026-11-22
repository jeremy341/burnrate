//! Management routes for declarative provider definitions (contracts section 4).
use super::Resp;
use crate::defs::{catalog, fetch, lint, model::Definition, user};
use crate::keys::KeyStore;
use crate::{json_response, State};
use serde_json::{json, Value};
use std::io::Read;
use tiny_http::{Method, Request};

const MAX_BODY: usize = 1024 * 1024;

fn read_body(request: &mut Request) -> Option<Value> {
    let mut body = Vec::new();
    request.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut body).ok()?;
    if body.len() > MAX_BODY {
        return None;
    }
    if body.is_empty() {
        return Some(json!({}));
    }
    serde_json::from_slice(&body).ok()
}

fn error(status: u16, message: &str) -> Resp {
    json_response(status, &json!({"error": message}))
}

/// Parses a definition supplied as TOML inside a request body.
fn definition_from(body: &Value) -> Result<(Definition, Vec<lint::LintError>), Resp> {
    let text = body.get("toml").and_then(Value::as_str).unwrap_or("");
    if text.trim().is_empty() {
        return Err(error(400, "missing toml"));
    }
    match Definition::parse(text) {
        Ok(def) => {
            let errors = lint::lint(&def);
            Ok((def, errors))
        }
        Err(e) => Err(json_response(200, &json!({
            "ok": false,
            "errors": [{"field": "toml", "message": e.to_string()}],
        }))),
    }
}

/// Case-insensitive set comparison of `key_hosts`, ignoring a trailing dot.
fn same_hosts(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let normalise = |hosts: &[String]| -> Vec<String> {
        let mut out: Vec<String> = hosts.iter().map(|h| h.trim().trim_end_matches('.').to_ascii_lowercase()).collect();
        out.sort();
        out
    };
    normalise(a) == normalise(b)
}

/// Resolve the definition to test. A definition supplied as TOML is untrusted: the stored key is
/// selected by `def.id`, so a crafted TOML could reuse a real provider's id while pointing
/// `key_hosts` at an attacker-controlled host and exfiltrate that key. Only accept a TOML whose id
/// names a registered definition and whose `key_hosts` are exactly that definition's host set.
fn find_definition(body: &Value) -> Result<Definition, Resp> {
    if let Some(toml) = body.get("toml").and_then(Value::as_str) {
        let def = Definition::parse(toml).map_err(|_| error(400, "invalid definition"))?;
        let trusted = crate::defs::all_definitions().into_iter().find(|entry| entry.def.id == def.id);
        return match trusted {
            Some(entry) if same_hosts(&entry.def.key_hosts, &def.key_hosts) => Ok(def),
            _ => Err(error(403, "definition id and key_hosts must match a registered definition")),
        };
    }
    let id = body.get("id").and_then(Value::as_str).ok_or_else(|| error(400, "missing id"))?;
    crate::defs::all_definitions()
        .into_iter()
        .find(|entry| entry.def.id == id)
        .map(|entry| entry.def)
        .ok_or_else(|| error(404, "unknown definition"))
}

fn key_for(keys: &KeyStore, def: &Definition, name: &str) -> Option<String> {
    keys.list(&def.id).into_iter().find(|(n, _)| n == name).map(|(_, k)| k)
}

pub fn handle(state: &State, request: &mut Request, method: &Method, path: &str) -> Option<Resp> {
    // GET /api/defs
    if path == "/api/defs" && *method == Method::Get {
        let list: Vec<Value> = crate::defs::all_definitions()
            .into_iter()
            .map(|e| {
                json!({
                    "id": e.def.id,
                    "label": e.def.label,
                    "color": e.def.color,
                    "status": e.def.status.as_str(),
                    "category": e.def.category.as_str(),
                    "auth": e.def.auth.as_str(),
                    "docs": e.def.docs,
                    "keyUrl": e.def.key_url,
                    "keyHosts": e.def.key_hosts,
                    "pollSeconds": e.def.poll_seconds,
                    "plan": e.def.plan,
                    "source": e.source,
                    "enabled": e.enabled,
                    "requests": e.def.request.len(),
                    "windows": e.def.window.len(),
                    "balances": e.def.balance.len(),
                })
            })
            .collect();
        return Some(json_response(200, &json!(list)));
    }

    // GET /api/defs/catalog
    if path == "/api/defs/catalog" && *method == Method::Get {
        return Some(json_response(200, &catalog::catalog()));
    }

    // POST /api/defs/validate -- pure parse + lint, never contacts the network.
    if path == "/api/defs/validate" && *method == Method::Post {
        let Some(body) = read_body(request) else { return Some(error(400, "invalid body")) };
        let (def, errors) = match definition_from(&body) {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        };
        let ok = errors.is_empty();
        let mut result = json!({
            "ok": ok,
            "errors": errors.iter().map(|e| json!({"field": e.field, "message": e.message})).collect::<Vec<_>>(),
        });
        if ok {
            result["preview"] = crate::defs::model::preview(&def);
        }
        return Some(json_response(200, &result));
    }

    // POST /api/defs/test -- runs the definition once with a stored key, no cache, no writes.
    if path == "/api/defs/test" && *method == Method::Post {
        let Some(body) = read_body(request) else { return Some(error(400, "invalid body")) };
        let def = match find_definition(&body) {
            Ok(def) => def,
            Err(resp) => return Some(resp),
        };
        let lint_errors = lint::lint(&def);
        if !lint_errors.is_empty() {
            return Some(json_response(400, &json!({
                "error": "invalid definition",
                "errors": lint_errors.iter().map(|e| json!({"field": e.field, "message": e.message})).collect::<Vec<_>>(),
            })));
        }
        let key_name = body.get("keyName").and_then(Value::as_str).unwrap_or("");
        let Some(key) = key_for(&state.keys, &def, key_name) else { return Some(error(400, "unknown key")) };
        match fetch::run_requests(&def, &fetch::HttpFetcher, &key) {
            Err(e) => return Some(json_response(200, &json!({"ok": false, "error": e.redacted()}))),
            Ok(responses) => {
                let mapped = crate::defs::mapping::map_responses(&def, &responses, crate::defs::cache::now());
                let mut limits = json!({"checkedAt": crate::providers::iso_now(), "windows": mapped.windows});
                if !mapped.balances.is_empty() {
                    limits["balances"] = json!(mapped.balances);
                }
                let mut account = json!({
                    "id": format!("{}-{}", def.id, key_name),
                    "driver": def.id,
                    "label": key_name,
                    "limits": limits,
                });
                if !def.plan.is_empty() {
                    account["plan"] = json!(def.plan);
                }
                let mut result = json!({"ok": true, "account": account});
                if let (Some(obj), Some(acc)) = (result.as_object_mut(), account.as_object()) {
                    for (k, v) in acc {
                        if k != "ok" && k != "account" {
                            obj.insert(k.clone(), v.clone());
                        }
                    }
                }
                return Some(json_response(200, &result));
            }
        }
    }

    // PUT /api/defs/user/<id>
    if path.starts_with("/api/defs/user/") && *method == Method::Put {
        let id = path.trim_start_matches("/api/defs/user/");
        let Some(body) = read_body(request) else { return Some(error(400, "invalid body")) };
        let text = body.get("toml").and_then(Value::as_str).unwrap_or("");
        match user::save(&crate::defs::data_dir(), id, text) {
            Ok(def) => return Some(json_response(200, &json!({"ok": true, "id": def.id}))),
            Err(e) => return Some(json_response(400, &json!({"ok": false, "error": crate::net_guard::redact(&e)}))),
        }
    }

    // DELETE /api/defs/user/<id>
    if path.starts_with("/api/defs/user/") && *method == Method::Delete {
        let id = path.trim_start_matches("/api/defs/user/");
        return Some(if user::remove(&crate::defs::data_dir(), id) {
            json_response(200, &json!({"ok": true}))
        } else {
            error(404, "unknown user definition")
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn openrouter_toml(key_hosts: &str) -> String {
        format!(
            r#"
schema = 1
id = "openrouter"
label = "Test"
status = "stable"
auth = "apiKey"
key_hosts = {key_hosts}
"#
        )
    }

    #[test]
    fn test_definition_rejects_untrusted_key_hosts_for_a_known_id() {
        // A crafted TOML reusing a real provider's id must not be able to redirect its stored key.
        let body = json!({"toml": openrouter_toml(r#"["attacker.example"]"#)});
        assert!(find_definition(&body).is_err());
        // The registered host set is accepted.
        let body = json!({"toml": openrouter_toml(r#"["openrouter.ai"]"#)});
        let def = find_definition(&body).ok().expect("registered definition");
        assert_eq!(def.id, "openrouter");
    }

    #[test]
    fn test_definition_rejects_an_unregistered_id() {
        // No registered definition (and therefore no legitimately stored key) for this id.
        let body = json!({"toml": r#"
schema = 1
id = "not-a-provider"
label = "Test"
status = "stable"
auth = "apiKey"
key_hosts = ["attacker.example"]
"#});
        assert!(find_definition(&body).is_err());
    }

    #[test]
    fn same_hosts_ignores_case_and_trailing_dot_but_not_membership() {
        assert!(same_hosts(&["OpenRouter.AI.".to_string()], &["openrouter.ai".to_string()]));
        assert!(!same_hosts(&["OpenRouter.AI.".to_string()], &["attacker.example".to_string()]));
        assert!(!same_hosts(&["a".to_string(), "b".to_string()], &["a".to_string()]));
    }
}
