//! User-chosen names for accounts that Burnrate discovers rather than stores (a second Claude login,
//! the ChatGPT login, Vibe/Mistral). Saved API-key accounts already have a name the user typed; these
//! have an e-mail or a folder name, which tells two logins of one provider apart poorly.
//!
//! The names live in `account-names.json` next to the other data files, keyed `<provider>/<account>`,
//! and are only ever applied on the way out (limits, provider list). Nothing here touches the
//! provider's own files, and clearing a name brings the discovered one back.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

const MAX_NAME_CHARS: usize = 64;

static NAMES: OnceLock<Mutex<Option<BTreeMap<String, String>>>> = OnceLock::new();

fn file() -> PathBuf {
    crate::budgets::data_dir().join("account-names.json")
}

/// The same account is reported as `claude-foo`, `foo` or `claude` depending on the caller, so Claude
/// ids lose their `claude-` prefix(es) before they become a key.
fn key(provider: &str, id: &str) -> String {
    let mut id = id.trim();
    if provider == "claudeAgent" {
        while let Some(rest) = id.strip_prefix("claude-") {
            id = rest;
        }
    }
    format!("{provider}/{id}")
}

fn load() -> BTreeMap<String, String> {
    std::fs::read_to_string(file())
        .ok()
        .and_then(|text| serde_json::from_str::<BTreeMap<String, String>>(&text).ok())
        .unwrap_or_default()
}

fn with_names<R>(f: impl FnOnce(&mut BTreeMap<String, String>) -> R) -> R {
    let cell = NAMES.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(load))
}

/// A name is 1..=64 characters, no control characters, and not only whitespace.
pub fn valid(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty() && name.chars().count() <= MAX_NAME_CHARS && !name.chars().any(char::is_control)
}

/// Save (or, with an empty `name`, clear) one account's name. False when the name is invalid or the
/// file cannot be written; the in-memory copy is only changed once the write succeeded.
pub fn set(provider: &str, id: &str, name: &str) -> bool {
    let name = name.trim();
    if !name.is_empty() && !valid(name) {
        return false;
    }
    with_names(|names| {
        let mut next = names.clone();
        if name.is_empty() {
            next.remove(&key(provider, id));
        } else {
            next.insert(key(provider, id), name.to_string());
        }
        let path = file();
        let Some(parent) = path.parent() else { return false };
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
        let Ok(text) = serde_json::to_string_pretty(&next) else { return false };
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_err() || std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return false;
        }
        *names = next;
        true
    })
}

pub fn get(provider: &str, id: &str) -> Option<String> {
    with_names(|names| names.get(&key(provider, id)).cloned())
}

/// Put the user's names on a list of account objects (`id` plus `driver`, as limits report them, or
/// `provider` for the provider list). The discovered label is kept as `discoveredLabel`.
pub fn apply(accounts: &mut [Value], provider_hint: Option<&str>) {
    with_names(|names| {
        if names.is_empty() {
            return;
        }
        for account in accounts.iter_mut() {
            let Some(obj) = account.as_object_mut() else { continue };
            let provider = obj
                .get("driver")
                .and_then(Value::as_str)
                .or(provider_hint)
                .unwrap_or("")
                .to_string();
            let id = obj.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let Some(name) = names.get(&key(&provider, &id)).cloned() else { continue };
            if let Some(original) = obj.get("displayName").or_else(|| obj.get("label")).cloned() {
                obj.insert("discoveredLabel".into(), original);
            }
            obj.insert("label".into(), Value::String(name.clone()));
            obj.insert("displayName".into(), Value::String(name));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_ids_collapse_to_one_key() {
        assert_eq!(key("claudeAgent", "claude-foo"), "claudeAgent/foo");
        assert_eq!(key("claudeAgent", "foo"), "claudeAgent/foo");
        assert_eq!(key("claudeAgent", "claude-claude"), "claudeAgent/claude");
        assert_eq!(key("mistral", "work"), "mistral/work");
    }

    #[test]
    fn names_are_checked() {
        assert!(valid("Work account"));
        assert!(!valid("   "));
        assert!(!valid("bad\u{7}name"));
        assert!(!valid(&"x".repeat(65)));
    }
}
