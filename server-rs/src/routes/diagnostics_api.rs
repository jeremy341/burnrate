//! Diagnostics and opt-in update-check routes, owned by the net-guard-keys package
//! (docs/CONTRACTS.md sections 6-7, docs/work/PACKAGES.md package 05).

use super::Resp;
use crate::{diagnostics, json_response, State};
use serde_json::json;
use tiny_http::{Method, Request};

pub fn handle(state: &State, request: &mut Request, method: &Method, path: &str) -> Option<Resp> {
    match (method, path) {
        // GET /api/diagnostics -> {version, os, arch, dataDir, uptimeSec, memoryMB,
        //                          settingsSizeBytes, cacheSizes, providers:[...]}
        (Method::Get, "/api/diagnostics") => Some(json_response(200, &diagnostics::snapshot(state))),

        // GET /api/update-check -> {current, latest, url, newer}; no network unless opted in.
        (Method::Get, "/api/update-check") => Some(json_response(200, &diagnostics::update_check(state))),

        // POST /api/diagnostics/open-data-dir -> opens our own data folder in the OS file manager.
        (Method::Post, "/api/diagnostics/open-data-dir") => {
            let loopback = request.remote_addr().is_some_and(|addr| addr.ip().is_loopback());
            if !loopback {
                return Some(json_response(403, &json!({"error": "loopback only"})));
            }
            let dir = state.keys.data_dir();
            if !dir.is_dir() {
                return Some(json_response(400, &json!({"error": "data directory not found"})));
            }
            match diagnostics::open_in_file_manager(dir) {
                Ok(()) => Some(json_response(200, &json!({"ok": true}))),
                Err(_) => Some(json_response(500, &json!({"error": "could not open data directory"}))),
            }
        }

        _ => None,
    }
}
