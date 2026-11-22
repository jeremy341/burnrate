//! Open VSX theme discovery proxy (docs/CONTRACTS.md section 3, package 02).
//!
//! Everything in here is opt-in: the route layer checks
//! `advanced.experimental.openVsx` before any of these functions is called.
//! Outbound requests are restricted to `open-vsx.org` via `crate::net_guard::check_url`,
//! time-limited to 10 s, size-capped (512 KiB for JSON, 5 MiB for a VSIX) and
//! sanitised so no untrusted fields reach the browser.
//!
//! Search response shape (see also the final summary):
//! `{ "extensions": [{ id, publisher, extensionName, name, description,
//!                     version, downloadCount, iconUrl }, ...] }`
//! `id` is `namespace.name` and is exactly what `GET /api/themes/openvsx/download?id=`
//! accepts. The download endpoint fetches the extension detail from Open VSX,
//! validates `files.download` against the same host allow-list, then streams the
//! raw VSIX bytes back with a 5 MiB cap.

use serde_json::{json, Value};
use std::fmt;
use std::io::Read;
use std::time::Duration;

const OPENVSX_BASE: &str = "https://open-vsx.org";
const OPENVSX_HOST: &str = "open-vsx.org";
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_JSON_BYTES: usize = 512 * 1024;
pub const MAX_DOWNLOAD_BYTES: usize = 5 * 1024 * 1024;
const MAX_RESULTS: usize = 16;

#[derive(Debug, PartialEq, Eq)]
pub enum FetchError {
    Invalid(String),
    Upstream(String),
    TooLarge,
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FetchError::Invalid(msg) => write!(f, "invalid: {msg}"),
            FetchError::Upstream(msg) => write!(f, "upstream: {msg}"),
            FetchError::TooLarge => write!(f, "response too large"),
        }
    }
}

/// The opt-in is off unless `advanced.experimental.openVsx === true`.
pub fn openvsx_enabled(settings: &Value) -> bool {
    settings
        .pointer("/advanced/experimental/openVsx")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn agent(allow_local: bool) -> ureq::Agent {
    // Never route theme discovery through a system proxy: we want a single,
    // auditable connection to the allow-listed host. Redirects are disabled so an
    // allow-listed host cannot pivot the request to a host we never validated, and
    // the resolver re-checks the address set at connect time.
    ureq::AgentBuilder::new()
        .try_proxy_from_env(false)
        .timeout(TIMEOUT)
        .redirects(0)
        .resolver(crate::net_guard::GuardedResolver { allow_local })
        .build()
}

/// GET `url`, reading at most `max_bytes + 1` bytes so an oversized response can be
/// rejected without ever buffering it. Returns the body and its Content-Type.
pub fn fetch_capped(url: &str, max_bytes: usize) -> Result<(Vec<u8>, String), FetchError> {
    fetch_capped_with(url, max_bytes, false)
}

/// `allow_local` is only ever set by tests that own the loopback stub server.
fn fetch_capped_with(url: &str, max_bytes: usize, allow_local: bool) -> Result<(Vec<u8>, String), FetchError> {
    let response = agent(allow_local)
        .get(url)
        .call()
        .map_err(|e| FetchError::Upstream(e.to_string()))?;
    if (300..400).contains(&response.status()) {
        return Err(FetchError::Upstream("redirect refused".into()));
    }
    let content_type = response
        .header("Content-Type")
        .unwrap_or("application/octet-stream")
        .to_string();
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| FetchError::Upstream(e.to_string()))?;
    if bytes.len() > max_bytes {
        return Err(FetchError::TooLarge);
    }
    Ok((bytes, content_type))
}

fn build_url(base: &str, path: &str, pairs: &[(&str, &str)]) -> String {
    let mut url = url::Url::parse(base)
        .unwrap_or_else(|_| url::Url::parse(OPENVSX_BASE).expect("valid base url"));
    url.set_path(path);
    if !pairs.is_empty() {
        let mut query = url.query_pairs_mut();
        for (key, value) in pairs {
            query.append_pair(key, value);
        }
    } else {
        url.set_query(None);
    }
    url.to_string()
}

/// Canonical Open VSX theme search URL for a given base (the base is a constant in
/// production and a loopback stub in tests).
pub fn search_url(base: &str, query: &str) -> String {
    let size = MAX_RESULTS.to_string();
    build_url(
        base,
        "/api/-/search",
        &[
            ("query", query),
            ("category", "Themes"),
            ("sortBy", "downloadCount"),
            ("sortOrder", "desc"),
            ("size", &size),
        ],
    )
}

fn valid_part(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= 63
        && part.as_bytes().iter().enumerate().all(|(i, c)| {
            c.is_ascii_alphanumeric() || (i > 0 && matches!(c, b'-' | b'_'))
        })
}

/// Strict `namespace.name` validation. No slashes, dots inside a part, percent
/// escapes or path traversal can slip through - the id becomes a URL path.
pub fn valid_extension_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    let Some((namespace, name)) = id.split_once('.') else {
        return false;
    };
    valid_part(namespace) && valid_part(name)
}

pub fn detail_url(base: &str, id: &str) -> Option<String> {
    if !valid_extension_id(id) {
        return None;
    }
    let (namespace, name) = id.split_once('.')?;
    Some(build_url(base, &format!("/api/{namespace}/{name}"), &[]))
}

fn host_allowed(host: &str, allow_local: bool) -> bool {
    let host = host.to_ascii_lowercase();
    if host == OPENVSX_HOST || host.ends_with(&format!(".{OPENVSX_HOST}")) {
        return true;
    }
    // `allow_local` is only ever set by tests that own the loopback stub server.
    allow_local && matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// Accept only an https URL on the allow-listed host (or, in tests, an http URL on
/// loopback). Credentials in the URL are always refused.
pub fn trusted_asset_url(value: &Value, allow_local: bool) -> Option<String> {
    let raw = value.as_str()?;
    let url = url::Url::parse(raw).ok()?;
    let https = url.scheme() == "https";
    let local_http = allow_local && url.scheme() == "http";
    if !(https || local_http) {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if !host_allowed(url.host_str().unwrap_or(""), allow_local) {
        return None;
    }
    Some(url.to_string())
}

pub fn download_url_from_detail(detail: &Value, allow_local: bool) -> Option<String> {
    let files = detail.get("files")?;
    trusted_asset_url(files.get("download")?, allow_local)
}

/// Strip everything the client does not need for a theme search result, and keep
/// only ids that are safe to pass back to the download endpoint.
pub fn sanitize_search(value: &Value) -> Value {
    let Some(items) = value.get("extensions").and_then(Value::as_array) else {
        return json!({ "extensions": [] });
    };
    let mut extensions = Vec::new();
    for item in items {
        let Some(namespace) = item.get("namespace").and_then(Value::as_str) else {
            continue;
        };
        let Some(extension_name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let id = format!("{namespace}.{extension_name}");
        if !valid_extension_id(&id) {
            continue;
        }
        let display_name = item
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .unwrap_or(extension_name);
        // Only keep an icon URL if it points at the allow-listed host over https.
        let icon_url = item
            .get("iconUrl")
            .and_then(|icon| trusted_asset_url(icon, false))
            .map_or(Value::Null, Value::String);
        extensions.push(json!({
            "id": id,
            "publisher": namespace,
            "extensionName": extension_name,
            "name": display_name,
            "description": item.get("description").and_then(Value::as_str).unwrap_or(""),
            "version": item.get("version").and_then(Value::as_str).unwrap_or(""),
            "downloadCount": item.get("downloadCount").and_then(Value::as_u64).unwrap_or(0),
            "iconUrl": icon_url,
        }));
        if extensions.len() >= MAX_RESULTS {
            break;
        }
    }
    json!({ "extensions": extensions })
}

fn search_with_url<F>(url: &str, fetch: F) -> Result<Value, FetchError>
where
    F: Fn(&str, usize) -> Result<(Vec<u8>, String), FetchError>,
{
    let (bytes, _) = fetch(url, MAX_JSON_BYTES)?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| FetchError::Upstream("malformed search response".into()))?;
    Ok(sanitize_search(&value))
}

/// Production search: net_guard validates the fixed, allow-listed URL first.
pub fn search(query: &str) -> Result<Value, FetchError> {
    let url = crate::net_guard::check_url(&search_url(OPENVSX_BASE, query), Some(OPENVSX_HOST), false)
        .map_err(FetchError::Invalid)?;
    search_with_url(&url, fetch_capped)
}

pub struct Downloaded {
    pub bytes: Vec<u8>,
    pub filename: String,
}

/// Generic download flow used by both production and the loopback-stub tests.
fn download_from<F>(base: &str, id: &str, allow_local: bool, fetch: F) -> Result<Downloaded, FetchError>
where
    F: Fn(&str, usize) -> Result<(Vec<u8>, String), FetchError>,
{
    if !valid_extension_id(id) {
        return Err(FetchError::Invalid("bad extension id".into()));
    }
    let detail_url = detail_url(base, id).ok_or_else(|| FetchError::Invalid("bad id".into()))?;
    let (detail_bytes, _) = fetch(&detail_url, MAX_JSON_BYTES)?;
    let detail: Value = serde_json::from_slice(&detail_bytes)
        .map_err(|_| FetchError::Upstream("malformed detail response".into()))?;
    let file_url = download_url_from_detail(&detail, allow_local)
        .ok_or_else(|| FetchError::Invalid("unsafe download url".into()))?;
    let (bytes, _) = fetch(&file_url, MAX_DOWNLOAD_BYTES)?;
    let version = detail
        .get("version")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .unwrap_or("")
        .to_string();
    let extension_name = id.split_once('.').map(|(_, name)| name).unwrap_or("theme");
    let filename = if version.is_empty() {
        format!("{extension_name}.vsix")
    } else {
        format!("{extension_name}-{version}.vsix")
    };
    Ok(Downloaded { bytes, filename })
}

/// Production download: both the detail request and the file request pass through
/// net_guard with the `open-vsx.org` host bound.
pub fn download(id: &str) -> Result<Downloaded, FetchError> {
    download_from(
        OPENVSX_BASE,
        id,
        false,
        |url, max| {
            let checked = crate::net_guard::check_url(url, Some(OPENVSX_HOST), false)
                .map_err(FetchError::Invalid)?;
            fetch_capped(&checked, max)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread::JoinHandle;

    /// Test-only fetcher that allows loopback stubs; production callers use `fetch_capped`.
    fn fetch_local(url: &str, max: usize) -> Result<(Vec<u8>, String), FetchError> {
        fetch_capped_with(url, max, true)
    }

    /// Minimal loopback HTTP stub serving `expected` requests. `build` receives the
    /// stub's base URL so canned bodies can reference it (e.g. a VSIX file URL).
    /// Only test code ever sets `allow_local`.
    fn stub_server<F>(expected: usize, build: F) -> (String, JoinHandle<()>)
    where
        F: Fn(&str) -> Vec<(&'static str, Vec<u8>)> + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback stub");
        let addr = listener.local_addr().expect("stub address");
        let base = format!("http://{addr}");
        let routes: Vec<(String, Vec<u8>)> = build(&base)
            .into_iter()
            .map(|(path, body)| (path.to_string(), body))
            .collect();
        let handle = std::thread::spawn(move || {
            for _ in 0..expected {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut buf = [0u8; 8192];
                let read = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..read]);
                let path = request.split_whitespace().nth(1).unwrap_or("/");
                let matched = routes.iter().find(|(prefix, _)| path.starts_with(prefix));
                let (status, body) = match matched {
                    Some((_, body)) => ("200 OK", body.clone()),
                    None => ("404 Not Found", b"not found".to_vec()),
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
                let _ = stream.flush();
            }
        });
        (base, handle)
    }

    #[test]
    fn opt_in_is_off_until_explicitly_enabled() {
        assert!(!openvsx_enabled(&json!({})));
        assert!(!openvsx_enabled(&json!({ "advanced": { "experimental": { "openVsx": false } } })));
        assert!(!openvsx_enabled(&json!({ "advanced": { "experimental": { "openVsx": "yes" } } })));
        assert!(openvsx_enabled(&json!({ "advanced": { "experimental": { "openVsx": true } } })));
    }

    #[test]
    fn search_url_is_canonical_and_encoded() {
        let url = search_url(OPENVSX_BASE, "github theme");
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.host_str(), Some("open-vsx.org"));
        assert_eq!(parsed.path(), "/api/-/search");
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert!(pairs.contains(&("query".into(), "github theme".into())));
        assert!(pairs.contains(&("category".into(), "Themes".into())));
        assert!(pairs.contains(&("sortBy".into(), "downloadCount".into())));
        assert!(pairs.contains(&("size".into(), "16".into())));
    }

    #[test]
    fn extension_ids_are_strict() {
        assert!(valid_extension_id("demo.theme"));
        assert!(valid_extension_id("github.github-vscode-theme"));
        assert!(!valid_extension_id("demo"));
        assert!(!valid_extension_id(".theme"));
        assert!(!valid_extension_id("demo."));
        assert!(!valid_extension_id("demo.theme.extra"));
        assert!(!valid_extension_id("demo/../theme"));
        assert!(!valid_extension_id("demo%2etheme"));
        assert!(detail_url(OPENVSX_BASE, "demo.theme").unwrap().ends_with("/api/demo/theme"));
        assert!(detail_url(OPENVSX_BASE, "../secret").is_none());
    }

    #[test]
    fn asset_urls_are_host_restricted() {
        assert!(trusted_asset_url(&json!("https://open-vsx.org/api/a/file.vsix"), false).is_some());
        assert!(trusted_asset_url(&json!("https://cdn.open-vsx.org/file.vsix"), false).is_some());
        assert!(trusted_asset_url(&json!("https://evil.example/file.vsix"), false).is_none());
        assert!(trusted_asset_url(&json!("http://open-vsx.org/file.vsix"), false).is_none());
        assert!(trusted_asset_url(&json!("https://user@open-vsx.org/file.vsix"), false).is_none());
        assert!(trusted_asset_url(&json!("http://127.0.0.1:1234/file.vsix"), false).is_none());
        assert!(trusted_asset_url(&json!("http://127.0.0.1:1234/file.vsix"), true).is_some());
    }

    #[test]
    fn net_guard_gate_rejects_non_https_in_production() {
        // With the current stub this checks the https-only rule; the final
        // net_guard (package 05) additionally binds the host to open-vsx.org.
        assert!(crate::net_guard::check_url("https://open-vsx.org/api/-/search", Some("open-vsx.org"), false).is_ok());
        assert!(crate::net_guard::check_url("http://127.0.0.1:1234/api", Some("open-vsx.org"), false).is_err());
    }

    #[test]
    fn sanitize_search_strips_untrusted_fields_and_caps_results() {
        let mut extensions = Vec::new();
        for i in 0..20 {
            extensions.push(json!({
                "namespace": "demo",
                "name": format!("theme-{i}"),
                "displayName": format!("Theme {i}"),
                "description": "nice",
                "version": "1.0.0",
                "downloadCount": i,
                "iconUrl": "https://evil.example/icon.png",
                "secretToken": "must-not-leak",
                "files": { "download": "https://evil.example/x.vsix" },
            }));
        }
        extensions.push(json!({ "namespace": "../bad", "name": "theme" }));
        let sanitized = sanitize_search(&json!({ "extensions": extensions, "totalSize": 999 }));
        let list = sanitized.get("extensions").unwrap().as_array().unwrap();
        assert_eq!(list.len(), MAX_RESULTS);
        let first = &list[0];
        assert_eq!(first.get("id").unwrap(), "demo.theme-0");
        assert_eq!(first.get("name").unwrap(), "Theme 0");
        assert!(first.get("iconUrl").unwrap().is_null());
        assert!(first.get("secretToken").is_none());
        assert!(first.get("files").is_none());
        assert!(sanitized.get("totalSize").is_none());
    }

    #[test]
    fn bad_search_payload_yields_empty_list() {
        assert_eq!(sanitize_search(&json!({})), json!({ "extensions": [] }));
        assert_eq!(sanitize_search(&json!({"extensions": "no"})), json!({ "extensions": [] }));
    }

    #[test]
    fn fetch_capped_reads_from_loopback_stub_and_enforces_cap() {
        let (base, server) = stub_server(1, |_| vec![("/small", b"hello stub".to_vec())]);
        let (bytes, _) = fetch_local(&format!("{base}/small"), 1024).unwrap();
        assert_eq!(bytes, b"hello stub");
        server.join().unwrap();

        let (base, server) = stub_server(1, |_| vec![("/big", vec![b'x'; 4096])]);
        assert_eq!(fetch_local(&format!("{base}/big"), 128), Err(FetchError::TooLarge));
        server.join().unwrap();
    }

    #[test]
    fn search_flow_through_loopback_stub() {
        let payload = json!({ "extensions": [
            { "namespace": "demo", "name": "theme", "displayName": "Demo Theme",
              "description": "A theme", "version": "1.0.0", "downloadCount": 7,
              "iconUrl": "https://open-vsx.org/api/icon.png", "junk": 1 }
        ] });
        let (base, server) = stub_server(1, move |_| {
            vec![("/api/-/search", payload.to_string().into_bytes())]
        });
        let result = search_with_url(&format!("{base}/api/-/search"), fetch_local).unwrap();
        let list = result.get("extensions").unwrap().as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].get("id").unwrap(), "demo.theme");
        assert_eq!(list[0].get("downloadCount").unwrap(), 7);
        assert!(list[0].get("junk").is_none());
        assert_eq!(
            list[0].get("iconUrl").unwrap().as_str().unwrap(),
            "https://open-vsx.org/api/icon.png"
        );
        server.join().unwrap();
    }

    #[test]
    fn download_flow_through_loopback_stub_uses_allow_local() {
        let (base, server) = stub_server(2, |base| {
            let detail = json!({
                "namespace": "demo", "name": "theme", "version": "1.2.3",
                "files": { "download": format!("{base}/file.vsix") }
            });
            vec![
                ("/api/demo/theme", detail.to_string().into_bytes()),
                ("/file.vsix", b"vsix bytes".to_vec()),
            ]
        });
        let downloaded = download_from(&base, "demo.theme", true, fetch_local).unwrap();
        assert_eq!(downloaded.bytes, b"vsix bytes");
        assert_eq!(downloaded.filename, "theme-1.2.3.vsix");
        server.join().unwrap();
    }

    #[test]
    fn fetch_refuses_redirects_instead_of_following_them() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback stub");
        let addr = listener.local_addr().expect("stub address");
        let server = std::thread::spawn(move || {
            // Only one request is served: if the client followed the Location there would be no
            // second accept, and the test would fail on the result/error assertion.
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let head = "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/attacker\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(head.as_bytes());
        });
        let result = fetch_local(&format!("http://{addr}/start"), 1024);
        assert!(
            matches!(&result, Err(FetchError::Upstream(msg)) if msg.contains("redirect")),
            "expected a redirect refusal, got {result:?}"
        );
        server.join().unwrap();
    }

    #[test]
    fn download_rejects_unsafe_urls_and_ids() {
        // A loopback file URL is refused without allow_local.
        let detail = json!({ "files": { "download": "http://127.0.0.1:1234/file.vsix" } });
        assert!(download_url_from_detail(&detail, false).is_none());
        assert!(download_url_from_detail(&detail, true).is_some());
        // Foreign hosts are always refused, even in tests.
        let foreign = json!({ "files": { "download": "https://evil.example/x.vsix" } });
        assert!(download_url_from_detail(&foreign, true).is_none());
        // No host at all / no detail section.
        assert!(download_url_from_detail(&json!({}), true).is_none());
        assert!(download_from("http://127.0.0.1:1", "bad/id", true, fetch_local).is_err());
    }
}
