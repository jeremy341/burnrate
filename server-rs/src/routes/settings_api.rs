//! Settings API (docs/CONTRACTS.md section 2).
//! GET/PATCH /api/settings, POST /api/settings/{export,import,reset}.
//! The generic `read_body` helper caps at 16 KiB, but a single theme CSS may be 100 000 chars,
//! so this route reads the body itself with a 1 MiB cap.

use super::Resp;
use crate::settings::FieldError;
use crate::{json_response, State};
use serde_json::{json, Value};
use std::io::Read;
use tiny_http::{Method, Request};

const MAX_BODY: u64 = 1024 * 1024;

fn read_body_capped(request: &mut Request) -> Option<Value> {
    let mut body = Vec::new();
    request.as_reader().take(MAX_BODY + 1).read_to_end(&mut body).ok()?;
    if body.len() as u64 > MAX_BODY {
        return None;
    }
    if body.is_empty() {
        return Some(json!({}));
    }
    serde_json::from_slice(&body).ok()
}

fn bad_body() -> Resp {
    json_response(400, &json!({"error": "invalid settings", "field": "body", "message": "body too large or not valid JSON"}))
}

fn invalid(error: &FieldError) -> Resp {
    json_response(400, &json!({"error": "invalid settings", "field": error.field, "message": error.message}))
}

pub fn handle(state: &State, request: &mut Request, method: &Method, path: &str) -> Option<Resp> {
    let result = match (method, path) {
        (&Method::Get, "/api/settings") => json_response(200, &state.settings.raw()),
        (&Method::Patch, "/api/settings") => {
            let Some(body) = read_body_capped(request) else { return Some(bad_body()) };
            let patch = body.get("patch").cloned().unwrap_or_else(|| json!({}));
            match state.settings.patch(&patch) {
                Ok(next) => json_response(200, &next),
                Err(error) => invalid(&error),
            }
        }
        (&Method::Post, "/api/settings/export") => json_response(200, &state.settings.export()),
        (&Method::Post, "/api/settings/import") => {
            let Some(body) = read_body_capped(request) else { return Some(bad_body()) };
            let settings = body.get("settings").cloned().unwrap_or_else(|| json!({}));
            let mode = body.get("mode").and_then(Value::as_str).unwrap_or("merge");
            match state.settings.import(&settings, mode) {
                Ok(next) => json_response(200, &next),
                Err(error) => invalid(&error),
            }
        }
        (&Method::Post, "/api/settings/reset") => {
            let Some(body) = read_body_capped(request) else { return Some(bad_body()) };
            let scope = body.get("scope").and_then(Value::as_str).unwrap_or("all");
            let section = body.get("section").and_then(Value::as_str);
            match state.settings.reset(scope, section) {
                Ok(next) => json_response(200, &next),
                Err(error) => invalid(&error),
            }
        }
        _ => return None,
    };
    Some(result)
}
