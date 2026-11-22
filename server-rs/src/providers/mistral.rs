use super::*;

const BASE: &str = "https://api.mistral.ai/v1/billing";

/// Mistral's billing endpoints are documented, so their numbers are `official`.
pub fn usage_to_windows(body: &Value) -> Vec<Window> {
    let vb = body.get("vibe_budget");
    let pct = vb.and_then(|v| v.get("usage_percentage")).and_then(|p| p.as_f64().or_else(|| p.as_str().and_then(|s| s.parse().ok())));
    let (Some(vb), Some(pct)) = (vb, pct.filter(|p| p.is_finite())) else {
        return Vec::new();
    };
    let resets = vb.get("reset_at").and_then(Value::as_str).and_then(crate::types::parse_rfc3339_ms).and_then(iso_ms);
    vec![Window::new("vibe-monthly", "monthly", "Monthly", pct).provenance("official").resets(resets)]
}

fn read_one(name: &str, key: &str) -> Value {
    let head = json!({"id": name, "driver": "mistral", "label": name, "displayName": name});
    let get = |path: &str| agent().get(&format!("{BASE}/{path}")).set("Authorization", &format!("Bearer {key}")).set("Accept", "application/json").call();
    let budget = match get("budget") {
        Ok(res) => res,
        Err(ureq::Error::Status(401 | 403, _)) => return unavailable_account(head, login_expired_message("Mistral")),
        Err(ureq::Error::Status(code, _)) => return unavailable_account(head, format!("Mistral budget unavailable (HTTP {code}).")),
        Err(_) => return unavailable_account(head, "Mistral budget request failed.".into()),
    };
    let body: Value = budget.into_json().unwrap_or(Value::Null);
    let windows = usage_to_windows(&body);
    if windows.is_empty() {
        return unavailable_account(head, "Mistral budget unavailable (HTTP 200).".into());
    }
    let plan = get("subscription").ok().and_then(|r| r.into_json::<Value>().ok()).and_then(|v| v.get("plan_name").and_then(Value::as_str).map(str::to_string));
    let mut head = head;
    if let Some(p) = plan.filter(|p| !p.is_empty()) {
        let mut chars = p.chars();
        let first = chars.next().map(|c| c.to_uppercase().to_string()).unwrap_or_default();
        head["plan"] = json!(format!("{first}{}", chars.as_str().to_lowercase()));
    }
    account_with(head, windows)
}

pub struct Mistral;

impl Provider for Mistral {
    fn id(&self) -> &'static str {
        "mistral"
    }
    fn label(&self) -> &'static str {
        "Mistral"
    }
    fn color(&self) -> &'static str {
        "#e8b923"
    }
    fn auth(&self) -> Auth {
        Auth::ApiKey
    }
    fn key_url(&self) -> Option<String> {
        Some("https://console.mistral.ai/api-keys".into())
    }
    fn hint(&self) -> &'static str {
        "Paste an API key"
    }
    fn read(&self, keys: &KeyStore) -> Vec<Value> {
        keys.list("mistral").iter().map(|(n, k)| read_one(n, k)).collect()
    }
    fn test_key(&self, key: &str) -> Result<(), String> {
        // Mirror `read_one`: a key only passes if the budget response has the field limits need.
        // The subscription/reset fields are optional there, so they are not required here either.
        let response = match agent()
            .get(&format!("{BASE}/budget"))
            .set("Authorization", &format!("Bearer {key}"))
            .set("Accept", "application/json")
            .call()
        {
            Ok(response) => response,
            Err(ureq::Error::Status(code, _)) => return Err(test_status_error(code)),
            Err(_) => return Err("Could not reach the provider".into()),
        };
        let body: Value = response.into_json().map_err(|_| "Could not read the provider's limits".to_string())?;
        match usage_to_windows(&body).first() {
            Some(_) => Ok(()),
            None => Err("Could not read the provider's limits".into()),
        }
    }
}

// ---------------------------------------------------------------- one-click import from Mistral Vibe
//
// Mistral has no public OAuth/device-code endpoint for third-party apps: Vibe's "Launch browser" sign-in
// (https://docs.mistral.ai/vibe/code/cli/install-setup) is a first-party flow whose protocol and client id
// are undocumented, and `api.mistral.ai` budget calls take an API key. What Vibe does document
// (https://docs.mistral.ai/vibe/code/cli/api-keys-profiles) is where it keeps the `MISTRAL_API_KEY` it
// provisions: the shell environment, `~/.vibe/.env`, or the OS keyring. So the one-click path is an explicit
// "Import from Vibe" that copies that key into Burnrate's own encrypted store after the key is checked
// against the budget endpoint. Nothing here runs on a poll: only the route a click calls.
//
// A second Vibe profile. Vibe keeps one key per user in the OS keyring, so people who run two profiles
// on Windows point a second config directory (`~/.vibe2`) at a per-instance keyring backend that stores
// `{"<service>\0<user>": "<secret>"}` as one JSON object, encrypted with DPAPI for the current user, in
// `<config dir>/keyring.bin`. Every Vibe config directory is therefore also searched for a `.env` and
// (Windows only) a `keyring.bin`, each becoming its own account ("Vibe", "Vibe 2", ...). Which directories:
// `VIBE_HOME`, the folders listed in Settings > Providers > Local sources (`providers.sources.vibe`), and
// every `~/.vibe*` folder (`readers::vibe::vibe_homes`). No directory name is built in here: the keyring
// file is always `<one of those directories>/keyring.bin`. DPAPI blobs only open for the Windows user who
// wrote them, so a file copied from another account or machine is skipped.

use crate::keys::KeyStore;
use crate::readers::vibe::{account_name, vibe_homes};
use crate::readers::home;

/// OS keyring entry Vibe writes (Windows Credential Manager target / macOS service / Secret Service `service`).
const VIBE_KEYRING_SERVICE: &str = "ai.mistral.vibe";
/// The keyring "account" (user name) of that entry, which is also the env var name.
const VIBE_KEYRING_USER: &str = "MISTRAL_API_KEY";
/// Name the first imported key is saved under (the `~/.vibe` profile).
pub const VIBE_ACCOUNT_NAME: &str = "Vibe";
/// File a per-instance DPAPI keyring backend writes inside a Vibe config directory.
const VIBE_KEYRING_FILE: &str = "keyring.bin";
/// A keyring file larger than this is not one: skip it rather than decrypt it.
const MAX_KEYRING_BYTES: u64 = 1024 * 1024;

fn vibe_dir() -> std::path::PathBuf {
    home().join(".vibe")
}

/// Whether Mistral Vibe looks installed here. Checks a directory and an env var only, never a secret,
/// so it is safe on every provider listing.
pub fn vibe_present() -> bool {
    vibe_dir().is_dir() || !vibe_homes().is_empty() || std::env::var(VIBE_KEYRING_USER).is_ok_and(|k| !k.trim().is_empty())
}

/// `MISTRAL_API_KEY=...` from a dotenv file (optional `export`, quotes, comments).
pub fn parse_env_key(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let line = line.trim();
        let line = line.strip_prefix("export ").map_or(line, str::trim_start);
        let (name, value) = line.split_once('=')?;
        if name.trim() != VIBE_KEYRING_USER {
            return None;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        Some(value.trim().to_string()).filter(|v| !v.is_empty())
    })
}

/// A keyring secret is UTF-8 on macOS/Linux and UTF-16LE in a Windows credential blob.
pub fn decode_secret(bytes: &[u8]) -> Option<String> {
    let text = if bytes.len() >= 2 && bytes.len() % 2 == 0 && bytes[1] == 0 {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16(&units).ok()?
    } else {
        String::from_utf8(bytes.to_vec()).ok()?
    };
    Some(text.trim().to_string()).filter(|t| !t.is_empty() && !t.chars().any(char::is_control))
}

#[cfg(windows)]
fn keyring_secret() -> Option<String> {
    use std::ffi::c_void;
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct CredentialW {
        flags: u32,
        kind: u32,
        target_name: *mut u16,
        comment: *mut u16,
        last_written: FileTime,
        blob_size: u32,
        blob: *mut u8,
        persist: u32,
        attribute_count: u32,
        attributes: *mut c_void,
        target_alias: *mut u16,
        user_name: *mut u16,
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn CredReadW(target: *const u16, kind: u32, flags: u32, out: *mut *mut CredentialW) -> i32;
        fn CredFree(buffer: *mut c_void);
    }
    // Python `keyring` stores `user@service` on newer versions and plain `service` on older ones.
    for target in [format!("{VIBE_KEYRING_USER}@{VIBE_KEYRING_SERVICE}"), VIBE_KEYRING_SERVICE.to_string()] {
        let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
        let mut out: *mut CredentialW = std::ptr::null_mut();
        // SAFETY: `wide` is NUL-terminated; on success `out` points at a credential we only read
        // `blob_size` bytes from, copying them before handing the buffer back to CredFree.
        let secret = unsafe {
            if CredReadW(wide.as_ptr(), 1, 0, &mut out) == 0 || out.is_null() {
                continue;
            }
            let cred = &*out;
            let bytes = if cred.blob.is_null() { Vec::new() } else { std::slice::from_raw_parts(cred.blob, cred.blob_size as usize).to_vec() };
            CredFree(out as *mut c_void);
            decode_secret(&bytes)
        };
        if secret.is_some() {
            return secret;
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn keyring_secret() -> Option<String> {
    let out = std::process::Command::new("security")
        .args(["find-generic-password", "-s", VIBE_KEYRING_SERVICE, "-a", VIBE_KEYRING_USER, "-w"])
        .output()
        .ok()?;
    out.status.success().then(|| decode_secret(&out.stdout)).flatten()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn keyring_secret() -> Option<String> {
    let out = std::process::Command::new("secret-tool")
        .args(["lookup", "service", VIBE_KEYRING_SERVICE, "username", VIBE_KEYRING_USER])
        .output()
        .ok()?;
    out.status.success().then(|| decode_secret(&out.stdout)).flatten()
}

/// One key Vibe holds, where it was found and the account name it is saved under.
#[derive(Clone, PartialEq, Eq)]
struct Candidate {
    source: &'static str,
    account: String,
    key: String,
}

// Never prints the key: a failed `assert_eq!` or a stray `{:?}` must not put a secret in a log.
impl std::fmt::Debug for Candidate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Candidate").field("source", &self.source).field("account", &self.account).field("key", &"<redacted>").finish()
    }
}

/// `{"<service>\u{0}<user>": "<secret>"}` is how the per-instance keyring backend names an entry.
fn keyring_entry_name() -> String {
    format!("{VIBE_KEYRING_SERVICE}\u{0}{VIBE_KEYRING_USER}")
}

/// The Mistral key from a decrypted per-instance keyring (`keyring.bin`) JSON document.
pub fn parse_keyring_json(plain: &[u8]) -> Option<String> {
    let doc: Value = serde_json::from_slice(plain).ok()?;
    let key = doc.as_object()?.get(&keyring_entry_name())?.as_str()?.trim();
    Some(key.to_string()).filter(|k| !k.is_empty() && !k.chars().any(char::is_control))
}

/// Decrypt a Windows DPAPI blob for the current user (`CryptUnprotectData`). `None` on any failure,
/// which includes a blob written by another Windows user or machine. No UI is ever shown.
#[cfg(windows)]
fn dpapi_unprotect(blob: &[u8]) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    #[repr(C)]
    struct DataBlob {
        size: u32,
        data: *mut u8,
    }
    #[link(name = "crypt32")]
    extern "system" {
        fn CryptUnprotectData(input: *const DataBlob, description: *mut *mut u16, entropy: *const DataBlob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, output: *mut DataBlob) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;
    let size = u32::try_from(blob.len()).ok().filter(|n| *n > 0)?;
    let input = DataBlob { size, data: blob.as_ptr() as *mut u8 };
    let mut output = DataBlob { size: 0, data: std::ptr::null_mut() };
    // SAFETY: `input` borrows `blob` for the call and DPAPI only reads it. On success `output` is a
    // LocalAlloc buffer of `size` bytes: it is copied, wiped, then released with LocalFree.
    unsafe {
        let ok = CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut output);
        if ok == 0 || output.data.is_null() {
            return None;
        }
        let plain = std::slice::from_raw_parts(output.data, output.size as usize).to_vec();
        std::ptr::write_bytes(output.data, 0, output.size as usize);
        LocalFree(output.data as *mut c_void);
        Some(plain)
    }
}

/// DPAPI exists only on Windows; a `keyring.bin` elsewhere is left alone.
#[cfg(not(windows))]
fn dpapi_unprotect(_blob: &[u8]) -> Option<Vec<u8>> {
    None
}

/// The key stored in a Vibe config directory's DPAPI keyring file, if there is one and it opens for this user.
fn keyring_file_secret(path: &std::path::Path) -> Option<String> {
    std::fs::metadata(path).ok().filter(|m| m.is_file() && m.len() > 0 && m.len() <= MAX_KEYRING_BYTES)?;
    let blob = std::fs::read(path).ok()?;
    let mut plain = dpapi_unprotect(&blob)?;
    let key = parse_keyring_json(&plain);
    plain.fill(0);
    key
}

/// Keys in each Vibe config directory's `.env` and (Windows) DPAPI keyring file; the account is named
/// after the directory. The directories are whatever the caller lists, never a fixed name.
fn dir_candidates(homes: &[std::path::PathBuf]) -> Vec<Candidate> {
    let mut found = Vec::new();
    for dir in homes {
        let account = account_name(dir);
        if let Some(key) = std::fs::read_to_string(dir.join(".env")).ok().and_then(|c| parse_env_key(&c)) {
            found.push(Candidate { source: "Vibe .env", account: account.clone(), key: key.trim().to_string() });
        }
        if let Some(key) = keyring_file_secret(&dir.join(VIBE_KEYRING_FILE)) {
            found.push(Candidate { source: "Vibe keyring file", account, key: key.trim().to_string() });
        }
    }
    found
}

/// Candidate keys: the shell environment, then each Vibe directory's `.env` and DPAPI keyring file
/// (account named after the directory), then the OS keyring (the first profile).
fn local_candidates() -> Vec<Candidate> {
    let mut found: Vec<Candidate> = Vec::new();
    if let Ok(key) = std::env::var(VIBE_KEYRING_USER) {
        found.push(Candidate { source: "environment", account: VIBE_ACCOUNT_NAME.to_string(), key: key.trim().to_string() });
    }
    found.extend(dir_candidates(&vibe_homes()));
    if let Some(key) = keyring_secret() {
        found.push(Candidate { source: "OS keyring", account: VIBE_ACCOUNT_NAME.to_string(), key: key.trim().to_string() });
    }
    found.retain(|c| c.key.len() >= 8 && c.key.len() <= 4096);
    found
}

#[derive(Debug, PartialEq, Eq)]
pub enum ImportError {
    /// Nothing usable on this computer.
    NoKey,
    /// Mistral answered but did not accept what Vibe holds (the message is safe to show).
    Rejected(String),
}

/// Import every distinct Vibe key that Mistral accepts, one account per Vibe profile. On success returns
/// where the first one came from; the route reports which accounts were added by comparing the key store.
pub fn import_local(keys: &KeyStore) -> Result<&'static str, ImportError> {
    import_from(local_candidates(), &|key| Mistral.test_key(key), keys)
}

fn import_from(candidates: Vec<Candidate>, test: &dyn Fn(&str) -> Result<(), String>, keys: &KeyStore) -> Result<&'static str, ImportError> {
    if candidates.is_empty() {
        return Err(ImportError::NoKey);
    }
    let mut first_ok: Option<&'static str> = None;
    let mut last = String::new();
    let mut handled: Vec<String> = Vec::new();
    let mut used_names: Vec<String> = Vec::new();
    for c in candidates {
        // The same key reached through two places (environment and keyring) is one account.
        if handled.contains(&c.key) {
            continue;
        }
        handled.push(c.key.clone());
        // Already imported (under any name): nothing to save, and no secret-bearing request.
        if let Some((name, _)) = keys.list("mistral").into_iter().find(|(_, saved)| *saved == c.key) {
            used_names.push(name);
            first_ok.get_or_insert(c.source);
            continue;
        }
        match test(&c.key) {
            Ok(()) => {
                // A different key already claimed this name in this run: never overwrite it.
                let mut name = c.account.clone();
                let mut n = 2;
                while used_names.contains(&name) {
                    name = format!("{} ({n})", c.account);
                    n += 1;
                }
                keys.set("mistral", &name, &c.key);
                used_names.push(name);
                first_ok.get_or_insert(c.source);
            }
            Err(message) => last = message,
        }
    }
    first_ok.ok_or(ImportError::Rejected(last))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn billing_windows_are_labelled_official() {
        let body = json!({"vibe_budget": {"usage_percentage": 12.5, "reset_at": "2026-12-01T00:00:00Z"}});
        let windows = usage_to_windows(&body);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].provenance, Some("official"));
        assert!((windows[0].used - 12.5).abs() < f64::EPSILON);
        assert!(windows[0].resets_at.is_some());
        assert!(usage_to_windows(&json!({})).is_empty());
    }

    #[test]
    fn dotenv_parsing_finds_the_mistral_key() {
        assert_eq!(parse_env_key("OTHER=1\nMISTRAL_API_KEY=abc12345\n").as_deref(), Some("abc12345"));
        assert_eq!(parse_env_key("export MISTRAL_API_KEY=\"quoted-key-1\"").as_deref(), Some("quoted-key-1"));
        assert_eq!(parse_env_key("MISTRAL_API_KEY='single-key-1' ").as_deref(), Some("single-key-1"));
        assert_eq!(parse_env_key("# MISTRAL_API_KEY=commented"), None);
        assert_eq!(parse_env_key("MISTRAL_API_KEY=\n"), None);
        assert_eq!(parse_env_key("NOT_MISTRAL_API_KEY=x12345678"), None);
    }

    #[test]
    fn keyring_secrets_decode_from_windows_utf16_or_utf8() {
        let utf16: Vec<u8> = "key-123456".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decode_secret(&utf16).as_deref(), Some("key-123456"));
        assert_eq!(decode_secret(b"key-123456\n").as_deref(), Some("key-123456"));
        assert_eq!(decode_secret(b""), None);
        assert_eq!(decode_secret(&[0xff, 0xfe, 0xfd]), None);
    }

    fn temp_keys(tag: &str) -> (KeyStore, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("burnrate-mistral-{tag}-{}-{}", std::process::id(), rand::random::<u64>()));
        (KeyStore::open(&dir), dir)
    }

    fn cand(source: &'static str, account: &str, key: &str) -> Candidate {
        Candidate { source, account: account.to_string(), key: key.to_string() }
    }

    #[test]
    fn import_saves_only_a_key_mistral_accepts() {
        let (keys, dir) = temp_keys("import");
        assert_eq!(import_from(Vec::new(), &|_| Ok(()), &keys), Err(ImportError::NoKey));
        let rejected = import_from(vec![cand("OS keyring", "Vibe", "stale-key-0001")], &|_| Err("The key was rejected".into()), &keys);
        assert_eq!(rejected, Err(ImportError::Rejected("The key was rejected".into())));
        assert!(keys.list("mistral").is_empty(), "a rejected key is never saved");
        // The first candidate fails, the second (lower precedence) passes.
        let ok = import_from(
            vec![cand("environment", "Vibe", "bad-key-00001"), cand("Vibe .env", "Vibe", "good-key-0001")],
            &|k| if k == "good-key-0001" { Ok(()) } else { Err("The key was rejected".into()) },
            &keys,
        );
        assert_eq!(ok, Ok("Vibe .env"));
        assert_eq!(keys.list("mistral"), vec![(VIBE_ACCOUNT_NAME.to_string(), "good-key-0001".to_string())]);
        // Importing again is a no-op that makes no request.
        let again = import_from(vec![cand("Vibe .env", "Vibe", "good-key-0001")], &|_| panic!("no request for a key already saved"), &keys);
        assert_eq!(again, Ok("Vibe .env"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_profile_key_is_added_beside_the_first_under_its_own_name() {
        let (keys, dir) = temp_keys("second");
        keys.set("mistral", "Vibe", "first-key-0001");
        let tested = std::cell::RefCell::new(Vec::new());
        let result = import_from(
            vec![cand("OS keyring", "Vibe", "first-key-0001"), cand("Vibe keyring file", "Vibe 2", "second-key-002")],
            &|k| {
                tested.borrow_mut().push(k.to_string());
                Ok(())
            },
            &keys,
        );
        assert_eq!(result, Ok("OS keyring"));
        assert_eq!(*tested.borrow(), vec!["second-key-002".to_string()], "the saved first key is not re-tested");
        let mut saved = keys.list("mistral");
        saved.sort();
        assert_eq!(saved, vec![("Vibe".to_string(), "first-key-0001".to_string()), ("Vibe 2".to_string(), "second-key-002".to_string())]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_different_keys_claiming_one_name_never_overwrite_each_other() {
        let (keys, dir) = temp_keys("collide");
        let result = import_from(vec![cand("environment", "Vibe", "env-key-00001"), cand("OS keyring", "Vibe", "ring-key-0001"), cand("Vibe .env", "Vibe", "env-key-00001")], &|_| Ok(()), &keys);
        assert_eq!(result, Ok("environment"));
        let mut saved = keys.list("mistral");
        saved.sort();
        assert_eq!(saved, vec![("Vibe".to_string(), "env-key-00001".to_string()), ("Vibe (2)".to_string(), "ring-key-0001".to_string())], "a repeated key is one account");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_rejected_profile_key_does_not_block_the_other() {
        let (keys, dir) = temp_keys("partial");
        let result = import_from(
            vec![cand("OS keyring", "Vibe", "old-key-000001"), cand("Vibe keyring file", "Vibe 2", "good-key-0002")],
            &|k| if k == "good-key-0002" { Ok(()) } else { Err("The key was rejected".into()) },
            &keys,
        );
        assert_eq!(result, Ok("Vibe keyring file"));
        assert_eq!(keys.list("mistral"), vec![("Vibe 2".to_string(), "good-key-0002".to_string())]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keyring_json_uses_the_service_nul_user_entry_name() {
        let doc = serde_json::json!({
            "ai.mistral.vibe\u{0}MISTRAL_API_KEY": "  fixture-key-123  ",
            "other.service\u{0}MISTRAL_API_KEY": "not-this-one-9",
        });
        assert_eq!(parse_keyring_json(doc.to_string().as_bytes()).as_deref(), Some("fixture-key-123"));
        assert_eq!(parse_keyring_json(br#"{"ai.mistral.vibe":"no-nul-entry"}"#), None);
        assert_eq!(parse_keyring_json(br#"{"ai.mistral.vibe\u0000MISTRAL_API_KEY":""}"#), None);
        assert_eq!(parse_keyring_json(br#"{"ai.mistral.vibe\u0000MISTRAL_API_KEY":"bad\nkey-123456"}"#), None);
        assert_eq!(parse_keyring_json(b"not json"), None);
        assert_eq!(parse_keyring_json(b"[]"), None);
    }

    #[cfg(windows)]
    fn dpapi_protect_for_test(plain: &[u8]) -> Vec<u8> {
        use std::ffi::c_void;
        #[repr(C)]
        struct DataBlob {
            size: u32,
            data: *mut u8,
        }
        #[link(name = "crypt32")]
        extern "system" {
            fn CryptProtectData(input: *const DataBlob, description: *const u16, entropy: *const DataBlob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, output: *mut DataBlob) -> i32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn LocalFree(memory: *mut c_void) -> *mut c_void;
        }
        let input = DataBlob { size: plain.len() as u32, data: plain.as_ptr() as *mut u8 };
        let mut output = DataBlob { size: 0, data: std::ptr::null_mut() };
        // SAFETY: test-only; the output buffer is copied and freed before returning.
        unsafe {
            assert_ne!(CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), 1, &mut output), 0);
            let blob = std::slice::from_raw_parts(output.data, output.size as usize).to_vec();
            LocalFree(output.data as *mut c_void);
            blob
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_dpapi_keyring_file_opens_for_the_current_user() {
        let dir = std::env::temp_dir().join(format!("burnrate-vibe-dpapi-{}-{}", std::process::id(), rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let plain = serde_json::json!({"ai.mistral.vibe\u{0}MISTRAL_API_KEY": "fixture-key-dpapi"}).to_string();
        let blob = dpapi_protect_for_test(plain.as_bytes());
        assert_eq!(&blob[..4], &[1, 0, 0, 0], "standard DPAPI blob header, like the real keyring.bin");
        assert!(!blob.windows(11).any(|w| w == b"fixture-key"), "the file does not hold the key in clear");
        let file = dir.join("keyring.bin");
        std::fs::write(&file, &blob).unwrap();
        assert_eq!(keyring_file_secret(&file).as_deref(), Some("fixture-key-dpapi"));
        // A corrupted blob, an empty file and a missing file all read as "no key", never a panic.
        let mut broken = blob.clone();
        let mid = broken.len() / 2;
        broken[mid] ^= 0xff;
        std::fs::write(&file, &broken).unwrap();
        assert_eq!(keyring_file_secret(&file), None);
        std::fs::write(&file, b"").unwrap();
        assert_eq!(keyring_file_secret(&file), None);
        assert_eq!(keyring_file_secret(&dir.join("absent.bin")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unsaved_vibe_profile_keeps_the_import_on_offer() {
        // `vibe_homes()` reads the real home directory, so assert the pure name comparison it relies on.
        let saved = vec!["Vibe".to_string()];
        let has = |dir: &str| saved.iter().any(|n| n.eq_ignore_ascii_case(&account_name(std::path::Path::new(dir))));
        assert!(has("/h/.vibe"));
        assert!(!has("/h/.vibe2"));
    }

    fn temp_vibe_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("burnrate-vibe-dirs-{tag}-{}-{}", std::process::id(), rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_key_in_a_custom_directory_is_found_under_that_directorys_name() {
        let root = temp_vibe_root("env");
        let custom = root.join("drive-d").join("my-vibe");
        let default = root.join(".vibe");
        std::fs::create_dir_all(&custom).unwrap();
        std::fs::create_dir_all(&default).unwrap();
        std::fs::write(custom.join(".env"), "MISTRAL_API_KEY=custom-key-0001\n").unwrap();
        std::fs::write(default.join(".env"), "MISTRAL_API_KEY=default-key-001\n").unwrap();
        let found = dir_candidates(&[default.clone(), custom.clone()]);
        assert_eq!(
            found,
            vec![cand("Vibe .env", "Vibe", "default-key-001"), cand("Vibe .env", "Vibe (my-vibe)", "custom-key-0001")],
            "default behaviour for ~/.vibe is unchanged and the custom directory is its own account"
        );
        // Nothing listed means nothing found: no directory name is built in.
        assert!(dir_candidates(&[]).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn candidates_never_print_their_key() {
        let shown = format!("{:?}", cand("Vibe .env", "Vibe", "super-secret-key-1"));
        assert!(!shown.contains("super-secret-key-1"), "Debug output must be redacted: {shown}");
        assert!(shown.contains("Vibe") && shown.contains("<redacted>"));
    }

    #[cfg(windows)]
    #[test]
    fn a_dpapi_keyring_file_in_a_custom_directory_becomes_an_account() {
        let root = temp_vibe_root("dpapi");
        let custom = root.join("profiles").join("vibe-two");
        std::fs::create_dir_all(&custom).unwrap();
        let plain = serde_json::json!({"ai.mistral.vibe\u{0}MISTRAL_API_KEY": "fixture-key-custom"}).to_string();
        std::fs::write(custom.join("keyring.bin"), dpapi_protect_for_test(plain.as_bytes())).unwrap();
        assert_eq!(dir_candidates(&[custom]), vec![cand("Vibe keyring file", "Vibe (vibe-two)", "fixture-key-custom")]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
