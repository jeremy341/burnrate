//! Open VSX theme proxy routes (docs/CONTRACTS.md section 3, package 02).
//! Both endpoints are opt-in via `advanced.experimental.openVsx`; without it they
//! answer 403 before touching the network.

use super::Resp;
use crate::themes::{self, FetchError};
use crate::{json_response, query, State};
use serde_json::json;
use tiny_http::{Header, Method, Request, Response, StatusCode};

const SEARCH_PATH: &str = "/api/themes/openvsx/search";
const DOWNLOAD_PATH: &str = "/api/themes/openvsx/download";
const MAX_QUERY_LEN: usize = 128;

pub fn handle(state: &State, request: &mut Request, method: &Method, path: &str) -> Option<Resp> {
    if *method != Method::Get || (path != SEARCH_PATH && path != DOWNLOAD_PATH) {
        return None;
    }
    let settings = state.settings.raw();
    if !themes::openvsx_enabled(&settings) {
        return Some(json_response(403, &json!({ "error": "disabled" })));
    }
    let params = query(request.url());
    Some(if path == SEARCH_PATH {
        handle_search(&params)
    } else {
        handle_download(&params)
    })
}

fn handle_search(params: &std::collections::HashMap<String, String>) -> Resp {
    let Some(query) = params.get("q").map(String::as_str) else {
        return json_response(400, &json!({ "error": "invalid query" }));
    };
    let query = query.trim();
    if query.is_empty() || query.len() > MAX_QUERY_LEN {
        return json_response(400, &json!({ "error": "invalid query" }));
    }
    match themes::search(query) {
        Ok(result) => json_response(200, &result),
        Err(error) => upstream_error(error, "search failed"),
    }
}

fn handle_download(params: &std::collections::HashMap<String, String>) -> Resp {
    let Some(id) = params.get("id").map(String::as_str) else {
        return json_response(400, &json!({ "error": "invalid id" }));
    };
    if !themes::valid_extension_id(id) {
        return json_response(400, &json!({ "error": "invalid id" }));
    }
    match themes::download(id) {
        Ok(downloaded) => binary_response(200, &downloaded.bytes, &downloaded.filename),
        Err(error) => upstream_error(error, "download failed"),
    }
}

fn upstream_error(error: FetchError, message: &str) -> Resp {
    // Do not echo upstream text back to the browser (it may contain a URL with
    // user input). Log it locally instead.
    eprintln!("themes proxy: {message}: {error}");
    let status = match error {
        FetchError::Invalid(_) => 400,
        FetchError::TooLarge => 413,
        FetchError::Upstream(_) => 502,
    };
    json_response(status, &json!({ "error": message }))
}

fn binary_response(status: u16, bytes: &[u8], filename: &str) -> Resp {
    // Force an octet-stream and strip path/quote characters from the filename so
    // nothing upstream can inject a header or a download path.
    let safe_name: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe_name = if safe_name.is_empty() { "theme.vsix".to_string() } else { safe_name };
    Response::from_data(bytes.to_vec())
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", "application/octet-stream").expect("valid header"))
        .with_header(
            Header::from_bytes("Content-Disposition", format!("attachment; filename=\"{safe_name}\""))
                .expect("valid header"),
        )
        .with_header(Header::from_bytes("Cache-Control", "no-store").expect("valid header"))
}
