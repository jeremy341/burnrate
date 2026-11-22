//! Budget CRUD: `GET /api/budgets`, `PUT /api/budgets/<id>`, `DELETE /api/budgets/<id>`
//! (docs/CONTRACTS.md section 5). The X-Burnrate/Origin/Host checks already ran in lib.rs.

use super::Resp;
use crate::budgets;
use crate::{json_response, read_body};
use serde_json::json;
use tiny_http::{Method, Request};

pub fn handle(_state: &crate::State, request: &mut Request, method: &Method, path: &str) -> Option<Resp> {
    if path == "/api/budgets" {
        return (*method == Method::Get).then(|| json_response(200, &budgets::list_json()));
    }
    let Some(id) = path.strip_prefix("/api/budgets/") else { return None };
    if id.is_empty() || id.contains('/') || id.contains('?') || id.contains('#') {
        return None;
    }
    match *method {
        Method::Put => {
            let Some(body) = read_body(request) else {
                return Some(json_response(400, &json!({"error": "invalid budget", "field": "body"})));
            };
            match budgets::parse_budget(&body, Some(id)) {
                Err(error) => Some(json_response(400, &json!({"error": "invalid budget", "field": error.field}))),
                Ok(budget) => match budgets::put(budget) {
                    Ok(saved) => Some(json_response(200, &saved.to_json())),
                    Err(_) => Some(json_response(500, &json!({"error": "could not save budget"}))),
                },
            }
        }
        Method::Delete => match budgets::delete(id) {
            Ok(true) => Some(json_response(200, &json!({"ok": true}))),
            Ok(false) => Some(json_response(404, &json!({"error": "budget not found"}))),
            Err(_) => Some(json_response(500, &json!({"error": "could not delete budget"}))),
        },
        _ => None,
    }
}
