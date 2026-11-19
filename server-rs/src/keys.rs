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

impl KeyStore {
    pub fn open(data_dir: &std::path::Path) -> KeyStore {
        let _ = std::fs::create_dir_all(data_dir);
        let master_path = data_dir.join("master.key");
        let master: [u8; 32] = match std::fs::read(&master_path).ok().and_then(|b| b.try_into().ok()) {
            Some(m) => m,
            None => {
                let mut m = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut m);
                let _ = std::fs::write(&master_path, m);
                m
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

    fn save(&self, data: &Map<String, Value>) {
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new((&self.master).into());
        let Ok(mut sealed) = cipher.encrypt(Nonce::from_slice(&nonce), serde_json::to_vec(data).unwrap_or_default().as_slice()) else { return };
        let tag = sealed.split_off(sealed.len() - 16);
        let mut out = nonce.to_vec();
        out.extend_from_slice(&tag);
        out.extend_from_slice(&sealed);
        let _ = std::fs::write(&self.file, out);
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

    pub fn set(&self, provider: &str, name: &str, key: &str) {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut data = self.load();
        let entry = data.entry(provider.to_string()).or_insert_with(|| Value::Object(Map::new()));
        if let Some(o) = entry.as_object_mut() {
            o.insert(name.to_string(), Value::String(key.to_string()));
        }
        self.save(&data);
    }

    pub fn remove(&self, provider: &str, name: &str) {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut data = self.load();
        if let Some(o) = data.get_mut(provider).and_then(Value::as_object_mut) {
            o.remove(name);
        }
        self.save(&data);
    }
}
