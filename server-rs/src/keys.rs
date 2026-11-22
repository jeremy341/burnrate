use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;

/// API keys are encrypted at rest (AES-256-GCM) with a per-install master key kept next to them. The
/// file layout (12-byte nonce, 16-byte tag, ciphertext) is the same as the TypeScript server's.
/// This keeps keys out of plain text; it is not a substitute for an OS keychain. Keys are write-only
/// through the HTTP API.
pub struct KeyStore {
    master: [u8; 32],
    file: PathBuf,
    lock: Mutex<()>,
}

/// Write `bytes` to `path`, replacing it, with owner-only permissions where the OS has them (0600 on
/// Unix). On Windows the per-user profile directory ACL is what protects the file.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)
}

/// Create `path` with `bytes` only if it does not exist yet. Written to a temp file first and linked
/// into place so readers never observe a partial file.
fn create_private_new(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("key.tmp{}", std::process::id()));
    write_private(&tmp, bytes)?;
    let linked = std::fs::hard_link(&tmp, path);
    let _ = std::fs::remove_file(&tmp);
    linked
}

impl KeyStore {
    pub fn open(data_dir: &std::path::Path) -> KeyStore {
        let _ = std::fs::create_dir_all(data_dir);
        let master_path = data_dir.join("master.key");
        let read_master = |path: &std::path::Path| -> Option<[u8; 32]> { std::fs::read(path).ok().and_then(|b| b.try_into().ok()) };
        let master: [u8; 32] = match read_master(&master_path) {
            Some(m) => m,
            None => {
                let mut m = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut m);
                // Create-if-absent, atomically and owner-only: a crash cannot leave a short master.key
                // (which would silently orphan keys.enc), and a concurrent first start adopts the winner.
                match create_private_new(&master_path, &m) {
                    Ok(()) => m,
                    Err(_) => read_master(&master_path).unwrap_or(m),
                }
            }
        };
        KeyStore { master, file: data_dir.join("keys.enc"), lock: Mutex::new(()) }
    }

    fn load(&self) -> Map<String, Value> {
        let Ok(raw) = std::fs::read(&self.file) else { return Map::new() };
        if raw.len() < 28 {
            return Map::new();
        }
        let (nonce, rest) = raw.split_at(12);
        let (tag, body) = rest.split_at(16);
        // The `aes-gcm` crate expects the tag after the ciphertext.
        let mut joined = body.to_vec();
        joined.extend_from_slice(tag);
        let cipher = Aes256Gcm::new((&self.master).into());
        cipher
            .decrypt(Nonce::from_slice(nonce), joined.as_slice())
            .ok()
            .and_then(|plain| serde_json::from_slice::<Value>(&plain).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }

    /// Write to a temporary file and rename into place so a crash cannot leave a partial key
    /// store. Returns false if encryption, the write, or the rename fails.
    fn save(&self, data: &Map<String, Value>) -> bool {
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new((&self.master).into());
        let Ok(mut sealed) = cipher.encrypt(Nonce::from_slice(&nonce), serde_json::to_vec(data).unwrap_or_default().as_slice()) else { return false };
        let tag = sealed.split_off(sealed.len() - 16);
        let mut out = nonce.to_vec();
        out.extend_from_slice(&tag);
        out.extend_from_slice(&sealed);
        let tmp = self.file.with_extension("enc.tmp");
        if write_private(&tmp, &out).is_err() {
            return false;
        }
        if std::fs::rename(&tmp, &self.file).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return false;
        }
        true
    }

    /// Saved accounts of a provider as (name, key).
    pub fn list(&self, provider: &str) -> Vec<(String, String)> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.load()
            .get(provider)
            .and_then(Value::as_object)
            .map(|o| o.iter().filter_map(|(n, k)| k.as_str().map(|k| (n.clone(), k.to_string()))).collect())
            .unwrap_or_default()
    }

    pub fn names(&self, provider: &str) -> Vec<String> {
        self.list(provider).into_iter().map(|(n, _)| n).collect()
    }

    pub fn set(&self, provider: &str, name: &str, key: &str) -> bool {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut data = self.load();
        let entry = data.entry(provider.to_string()).or_insert_with(|| Value::Object(Map::new()));
        if let Some(o) = entry.as_object_mut() {
            o.insert(name.to_string(), Value::String(key.to_string()));
        }
        self.save(&data)
    }

    pub fn remove(&self, provider: &str, name: &str) -> bool {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut data = self.load();
        if let Some(o) = data.get_mut(provider).and_then(Value::as_object_mut) {
            o.remove(name);
        }
        self.save(&data)
    }

    /// Rename a saved account while keeping its key. Fails when `old` is missing, `new` exists,
    /// or the encrypted store could not be persisted. Keys stay encrypted at rest.
    pub fn rename(&self, provider: &str, old: &str, new: &str) -> bool {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut data = self.load();
        let Some(o) = data.get_mut(provider).and_then(Value::as_object_mut) else { return false };
        if !o.contains_key(old) || o.contains_key(new) {
            return false;
        }
        let Some(key) = o.remove(old) else { return false };
        o.insert(new.to_string(), key);
        self.save(&data)
    }

    /// Whether an account name is already used by this provider. Used to report a rename
    /// conflict (409) separately from a missing account (404).
    pub fn name_exists(&self, provider: &str, name: &str) -> bool {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.load()
            .get(provider)
            .and_then(Value::as_object)
            .is_some_and(|o| o.contains_key(name))
    }

    /// The data directory this store lives in. Diagnostics and the open-folder route use it.
    pub fn data_dir(&self) -> &std::path::Path {
        self.file.parent().unwrap_or_else(|| std::path::Path::new("."))
    }

    // Generic secrets (notification channel URLs/tokens) live in the same AES-GCM file, under
    // a `secret:<scope>` namespace. They are write-only through the HTTP API: there is no route
    // that returns a value, only the names that are set.

    fn secret_scope(scope: &str) -> String {
        format!("secret:{scope}")
    }

    pub fn set_secret(&self, scope: &str, name: &str, value: &str) -> bool {
        self.set(&Self::secret_scope(scope), name, value)
    }

    pub fn remove_secret(&self, scope: &str, name: &str) -> bool {
        self.remove(&Self::secret_scope(scope), name)
    }

    pub fn secret_names(&self, scope: &str) -> Vec<String> {
        self.names(&Self::secret_scope(scope))
    }

    /// Read a secret for internal use (e.g. a notification channel sender). Never expose this
    /// through an HTTP route; callers must redact it from any error or diagnostic output.
    pub fn get_secret(&self, scope: &str, name: &str) -> Option<String> {
        self.list(&Self::secret_scope(scope)).into_iter().find(|(n, _)| n == name).map(|(_, value)| value)
    }

    /// All stored secret values, used to scrub literal values from diagnostics output.
    pub fn all_secrets(&self) -> Vec<String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.load()
            .iter()
            .filter(|(scope, _)| scope.starts_with("secret:"))
            .filter_map(|(_, value)| value.as_object())
            .flat_map(|entry| entry.values().filter_map(Value::as_str).map(str::to_string))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    fn temp_store() -> (KeyStore, PathBuf) {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        let dir = std::env::temp_dir().join(format!("burnrate-keys-test-{}-{}-{}", std::process::id(), NEXT_DIR.fetch_add(1, Ordering::Relaxed), nonce));
        let _ = std::fs::create_dir_all(&dir);
        (KeyStore::open(&dir), dir)
    }

    fn cleanup(dir: &std::path::Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn master_key_is_created_once_and_reused_across_opens() {
        let (store, dir) = temp_store();
        store.set("mistral", "a", "key-persisted-123456");
        let master = std::fs::read(dir.join("master.key")).expect("master key");
        assert_eq!(master.len(), 32);
        // No temp file left behind by the create-if-absent write.
        let leftovers = std::fs::read_dir(&dir).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().contains(".tmp")).count();
        assert_eq!(leftovers, 0);
        // A second open (restart) must adopt the same master and still decrypt.
        let reopened = KeyStore::open(&dir);
        assert_eq!(std::fs::read(dir.join("master.key")).unwrap(), master);
        assert_eq!(reopened.list("mistral"), vec![("a".to_string(), "key-persisted-123456".to_string())]);
        cleanup(&dir);
    }

    #[test]
    fn renames_an_account_and_keeps_the_key_encrypted() {
        let (store, dir) = temp_store();
        store.set("mistral", "old", "sk-secret-value-123456");
        assert!(store.rename("mistral", "old", "new"));
        assert_eq!(store.list("mistral"), vec![("new".to_string(), "sk-secret-value-123456".to_string())]);
        let raw = std::fs::read(dir.join("keys.enc")).expect("encrypted key file");
        assert!(!raw.windows(b"sk-secret-value-123456".len()).any(|w| w == b"sk-secret-value-123456".as_slice()));
        cleanup(&dir);
    }

    #[test]
    fn rename_fails_when_the_new_name_is_taken() {
        let (store, dir) = temp_store();
        store.set("cursor", "old", "key-old-123456");
        store.set("cursor", "new", "key-new-123456");
        assert!(!store.rename("cursor", "old", "new"));
        assert_eq!(store.names("cursor"), vec!["old".to_string(), "new".to_string()]);
        assert_eq!(store.list("cursor")[0].1, "key-old-123456");
        assert_eq!(store.list("cursor")[1].1, "key-new-123456");
        cleanup(&dir);
    }

    #[test]
    fn rename_fails_when_the_old_name_is_missing() {
        let (store, dir) = temp_store();
        store.set("mistral", "existing", "key-existing-123456");
        assert!(!store.rename("mistral", "missing", "new"));
        assert_eq!(store.list("mistral"), vec![("existing".to_string(), "key-existing-123456".to_string())]);
        cleanup(&dir);
    }

    #[test]
    fn save_failure_is_reported_and_leaves_no_temp_file() {
        let (store, dir) = temp_store();
        // A directory at the destination makes the atomic rename fail on every platform.
        let destination = dir.join("keys.enc");
        std::fs::create_dir(&destination).expect("blocker directory");
        assert!(!store.set("mistral", "name", "key-value-123456"));
        assert!(!store.remove("mistral", "name"));
        assert!(!store.rename("mistral", "name", "other"));
        assert!(!dir.join("keys.enc.tmp").exists(), "temporary file should be cleaned up");
        cleanup(&dir);
    }

    #[test]
    fn secrets_are_scoped_encrypted_and_write_only() {
        let (store, dir) = temp_store();
        assert!(store.set_secret("alerts", "ntfy", "https://ntfy.example/token"));
        assert!(store.set_secret("alerts", "discord", "discord-webhook-secret-1234"));
        assert!(store.set_secret("other", "ntfy", "another-secret-5678"));
        let mut names = store.secret_names("alerts");
        names.sort();
        assert_eq!(names, vec!["discord".to_string(), "ntfy".to_string()]);
        assert_eq!(store.get_secret("alerts", "ntfy").as_deref(), Some("https://ntfy.example/token"));
        assert_eq!(store.get_secret("other", "ntfy").as_deref(), Some("another-secret-5678"));
        assert_eq!(store.get_secret("alerts", "missing"), None);
        assert!(store.secret_names("unknown").is_empty());

        // Neither the value nor its scope is visible in the encrypted file.
        let raw = std::fs::read(dir.join("keys.enc")).expect("encrypted key file");
        for needle in [b"discord-webhook-secret-1234".as_slice(), b"https://ntfy.example/token", b"secret:alerts"] {
            assert!(!raw.windows(needle.len()).any(|w| w == needle));
        }

        let mut values = store.all_secrets();
        values.sort();
        assert_eq!(values, vec!["another-secret-5678", "discord-webhook-secret-1234", "https://ntfy.example/token"]);

        assert!(store.remove_secret("alerts", "ntfy"));
        assert_eq!(store.secret_names("alerts"), vec!["discord".to_string()]);
        assert_eq!(store.get_secret("alerts", "ntfy"), None);
        assert_eq!(store.get_secret("other", "ntfy").as_deref(), Some("another-secret-5678"));
        cleanup(&dir);
    }

    #[test]
    fn secret_names_do_not_collide_with_provider_keys() {
        let (store, dir) = temp_store();
        store.set("mistral", "main", "sk-provider-key-1234");
        store.set_secret("alerts", "main", "secret-value-1234");
        assert_eq!(store.list("mistral"), vec![("main".to_string(), "sk-provider-key-1234".to_string())]);
        assert_eq!(store.get_secret("alerts", "main").as_deref(), Some("secret-value-1234"));
        assert_eq!(store.all_secrets(), vec!["secret-value-1234".to_string()]);
        cleanup(&dir);
    }
}
