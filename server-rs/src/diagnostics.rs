//! Diagnostics (version, data dir, sizes, probe timings) and the optional update check.
//! Owned by the net-guard-keys package (docs/CONTRACTS.md sections 6-7).

use crate::{net_guard, State};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// GitHub releases API slug for the opt-in update check.
pub const UPDATE_REPO: &str = "jeremy341/burnrate";

const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

fn started() -> &'static Instant {
    static STARTED: OnceLock<Instant> = OnceLock::new();
    STARTED.get_or_init(Instant::now)
}

#[derive(Clone, Default)]
struct ProbeInfo {
    last_ms: Option<u64>,
    last_error: Option<String>,
}

fn probes() -> &'static Mutex<HashMap<String, ProbeInfo>> {
    static PROBES: OnceLock<Mutex<HashMap<String, ProbeInfo>>> = OnceLock::new();
    PROBES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Records one provider probe so `/api/diagnostics` can show the last timing and error.
/// Error strings are redacted at read time, after all secrets currently in the store are known.
pub fn record_probe(id: &str, duration_ms: u64, error: Option<&str>) {
    let mut map = probes().lock().unwrap_or_else(|e| e.into_inner());
    map.insert(id.to_string(), ProbeInfo { last_ms: Some(duration_ms), last_error: error.map(str::to_string) });
}

fn file_size(path: impl AsRef<Path>) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Resident set size in MB, where it is cheaply available; `None` otherwise.
fn memory_mb() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        // UNVERIFIED on Linux: /proc is not mounted in every sandbox, and 4096 is assumed as page size.
        let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
        let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
        Some(pages * 4096 / (1024 * 1024))
    }
    #[cfg(target_os = "windows")]
    {
        rss_windows()
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

#[cfg(target_os = "windows")]
fn rss_windows() -> Option<u64> {
    use std::ffi::c_void;

    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(process: *mut c_void, counters: *mut ProcessMemoryCounters, cb: u32) -> i32;
    }
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
    }

    let mut counters: ProcessMemoryCounters = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
    let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
    if ok == 0 {
        None
    } else {
        Some((counters.working_set_size / (1024 * 1024)) as u64)
    }
}

/// Opens a directory in the OS file manager. Never called with a user-supplied path: the route
/// passes the server's own data directory and only accepts loopback requests.
pub fn open_in_file_manager(path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe").arg(path).spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(path).spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        // UNVERIFIED on Linux: xdg-open needs a freedesktop session and is not on every distro.
        std::process::Command::new("xdg-open").arg(path).spawn()?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = path;
        return Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no file manager opener"));
    }
    Ok(())
}

/// GET /api/diagnostics payload. Secret values are scrubbed from every string, including
/// recorded provider errors, using both pattern matching and the literal stored values.
pub fn snapshot(state: &State) -> Value {
    let data_dir = state.keys.data_dir();
    let secrets = state.keys.all_secrets();
    let mut cache_sizes = Map::new();
    for name in ["usage-scan-cache.bin", "pricing-cache.json", "history.bin", "budgets.json", "keys.enc"] {
        cache_sizes.insert(name.to_string(), json!(file_size(data_dir.join(name))));
    }

    let recorded = probes().lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut providers: Vec<Value> = state.providers.iter().map(|provider| provider_entry(provider.id(), recorded.get(provider.id()), &secrets)).collect();
    // Keep entries for ids that were recorded but are no longer enabled, so a recent error is not lost.
    let mut known: Vec<&str> = state.providers.iter().map(|p| p.id()).collect();
    for (id, info) in &recorded {
        if !known.contains(&id.as_str()) {
            providers.push(provider_entry(id, Some(info), &secrets));
            known.push(id);
        }
    }

    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "dataDir": data_dir.to_string_lossy(),
        "uptimeSec": started().elapsed().as_secs(),
        "memoryMB": memory_mb(),
        "settingsSizeBytes": file_size(data_dir.join("settings.json")),
        "cacheSizes": cache_sizes,
        "providers": providers,
    })
}

fn provider_entry(id: &str, info: Option<&ProbeInfo>, secrets: &[String]) -> Value {
    let last_error = info
        .and_then(|p| p.last_error.as_deref())
        .map(|error| Value::String(net_guard::redact_with(error, secrets)))
        .unwrap_or(Value::Null);
    json!({
        "id": id,
        "lastProbeMs": info.and_then(|p| p.last_ms),
        "lastError": last_error,
    })
}

fn update_cache() -> &'static Mutex<Option<(Instant, Value)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, Value)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn parse_release(document: &Value) -> Option<(String, String)> {
    let tag = document.get("tag_name")?.as_str()?.trim();
    if tag.is_empty() {
        return None;
    }
    let url = document.get("html_url").and_then(Value::as_str).unwrap_or("").to_string();
    Some((tag.to_string(), url))
}

/// Numeric comparison of `v1.2.3` style versions. A prerelease of the same version is not newer.
fn version_newer(candidate: &str, current: &str) -> bool {
    fn parts(version: &str) -> Vec<u64> {
        let trimmed = version.trim().trim_start_matches(|c| c == 'v' || c == 'V');
        let numeric = trimmed.split(['-', '+']).next().unwrap_or(trimmed);
        numeric.split('.').map(|part| part.parse::<u64>().unwrap_or(0)).collect()
    }
    let candidate = parts(candidate);
    let current = parts(current);
    for i in 0..candidate.len().max(current.len()) {
        let a = candidate.get(i).copied().unwrap_or(0);
        let b = current.get(i).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    false
}

fn fetch_latest_release() -> Option<Value> {
    let url = format!("https://api.github.com/repos/{UPDATE_REPO}/releases/latest");
    let url = net_guard::check_url(&url, Some("api.github.com"), false).ok()?;
    // No redirects and a connect-time address check: a validated GitHub host must not be able to
    // pivot the update check (or its User-Agent) to a host net_guard never approved.
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(5))
        .redirects(0)
        .try_proxy_from_env(false)
        .resolver(net_guard::GuardedResolver { allow_local: false })
        .build();
    let response = agent
        .get(&url)
        .set("User-Agent", "burnrate-update-check")
        .set("Accept", "application/vnd.github+json")
        .call()
        .ok()?;
    if (300..400).contains(&response.status()) {
        return None;
    }
    let body = response.into_string().ok()?;
    serde_json::from_str::<Value>(&body).ok()
}

/// GET /api/update-check payload. Contacts GitHub only when the user opted in; the result is
/// cached for six hours so repeated opens of the About panel do not hit the network.
pub fn update_check(state: &State) -> Value {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let empty = || json!({"current": current, "latest": Value::Null, "url": Value::Null, "newer": false});
    let enabled = state
        .settings
        .raw()
        .pointer("/general/checkForUpdates")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !enabled {
        return empty();
    }

    let cached = update_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|(at, _)| at.elapsed() < CACHE_TTL)
        .map(|(_, value)| value.clone());
    if let Some(value) = cached {
        return value;
    }

    let value = match fetch_latest_release().and_then(|doc| parse_release(&doc)) {
        Some((latest, url)) => json!({"current": current, "latest": latest, "url": url, "newer": version_newer(&latest, &current)}),
        None => empty(),
    };
    // A failed check is deliberately not cached: the next open can retry.
    if value.get("latest").is_some_and(|v| !v.is_null()) {
        *update_cache().lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), value.clone()));
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;
    use crate::keys::KeyStore;
    use crate::settings::SettingsStore;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    fn test_state() -> (State, PathBuf) {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        let dir = std::env::temp_dir().join(format!("burnrate-diag-test-{}-{}-{}", std::process::id(), NEXT_DIR.fetch_add(1, Ordering::Relaxed), nonce));
        let _ = std::fs::create_dir_all(&dir);
        let state = State {
            port: 13805,
            web_dir: dir.clone(),
            keys: KeyStore::open(&dir),
            settings: SettingsStore::open(&dir),
            engine: Engine::new(dir.clone()),
            providers: crate::providers::all(),
        };
        (state, dir)
    }

    #[test]
    fn snapshot_has_the_documented_shape_and_redacts_errors() {
        let (state, dir) = test_state();
        let secret = "ntfy-token-do-not-leak-12345";
        assert!(state.keys.set_secret("alerts", "ntfy", secret));
        record_probe("claudeAgent", 42, Some("failed with ntfy-token-do-not-leak-12345 (401)"));
        record_probe("retired-provider", 7, None);

        let value = snapshot(&state);
        for field in ["version", "os", "arch", "dataDir", "uptimeSec", "memoryMB", "settingsSizeBytes", "cacheSizes", "providers"] {
            assert!(value.get(field).is_some(), "missing field {field}");
        }
        assert_eq!(value["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(value["os"], std::env::consts::OS);
        assert!(value["cacheSizes"].is_object());
        let providers = value["providers"].as_array().expect("providers array");
        let claude = providers.iter().find(|p| p["id"] == "claudeAgent").expect("claude probe");
        assert_eq!(claude["lastProbeMs"], 42);
        let error = claude["lastError"].as_str().expect("redacted error");
        assert!(!error.contains(secret), "secret leaked into diagnostics: {error}");
        assert!(error.contains("[redacted]"));
        let retired = providers.iter().find(|p| p["id"] == "retired-provider").expect("retained probe");
        assert_eq!(retired["lastProbeMs"], 7);
        assert!(retired["lastError"].is_null());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_comparison_handles_prefixes_suffixes_and_missing_parts() {
        assert!(version_newer("v1.2.4", "1.2.3"));
        assert!(version_newer("1.3.0", "1.2.9"));
        assert!(version_newer("2.0.0", "1.99.99"));
        assert!(!version_newer("1.2.3", "v1.2.3"));
        assert!(!version_newer("v1.2.3-beta.1", "1.2.3"));
        assert!(!version_newer("1.2", "1.2.0"));
        assert!(version_newer("1.2.0.1", "1.2.0"));
    }

    #[test]
    fn release_parsing_uses_the_github_fields() {
        let doc = json!({"tag_name": " v1.4.0 ", "html_url": "https://github.com/jeremy341/burnrate/releases/tag/v1.4.0"});
        assert_eq!(parse_release(&doc), Some(("v1.4.0".to_string(), "https://github.com/jeremy341/burnrate/releases/tag/v1.4.0".to_string())));
        assert_eq!(parse_release(&json!({"html_url": "x"})), None);
        assert_eq!(parse_release(&json!({"tag_name": "   "})), None);
    }

    #[test]
    fn update_check_is_disabled_by_default() {
        let (state, dir) = test_state();
        let value = update_check(&state);
        assert_eq!(value["current"], env!("CARGO_PKG_VERSION"));
        assert!(value["latest"].is_null());
        assert_eq!(value["newer"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_size_reports_zero_for_a_missing_file() {
        let (_, dir) = test_state();
        assert_eq!(file_size(dir.join("does-not-exist")), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
