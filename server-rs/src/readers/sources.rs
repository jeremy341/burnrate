// User-configured local source directories (`providers.sources` in settings).
//
// Burnrate finds each agent's local files by looking in the places that agent normally uses (`~/.claude*`,
// `~/.vibe*`, and the `CLAUDE_CONFIG_DIR` / `VIBE_HOME` environment variables). A person whose files live
// somewhere else (another drive, a synced folder, a second profile in a custom place) lists those folders
// in Settings > Providers, and they are read IN ADDITION to what is discovered automatically.
//
// Precedence for one agent, first wins where only one directory is shown:
//   1. the environment variable (`CLAUDE_CONFIG_DIR`, `VIBE_HOME`)
//   2. directories configured in settings, in the order the user listed them
//   3. automatic discovery (home directory scan, XDG and WSL locations)
// A directory reached more than once is read once. Nothing is created and nothing is written.
//
// Settings are pushed here by `SettingsStore` (on open and after every committed change) so readers stay
// plain functions with no handle on the store. The pure functions below take their inputs as arguments,
// which is what the tests exercise; the process-wide table is only the transport.

use super::home;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

/// Agents whose directories can be configured. Keys of `providers.sources`. Every file-based agent
/// with one discoverable home/data root is listed here; ids match the reader's `provider()` where one
/// exists (`claude` and `vibe` feed the `claudeAgent` and `mistral` providers instead).
pub const SOURCE_IDS: &[&str] = &[
    "claude",
    "vibe",
    "codex",
    "opencode",
    "antigravity",
    "gemini",
    "qwen",
    "goose",
    "crush",
    "copilot",
    "grok",
    "pi",
    "muse",
];
/// A list is capped so a runaway import cannot make every scan walk hundreds of folders.
pub const MAX_PATHS_PER_SOURCE: usize = 20;
/// Longest accepted path string.
pub const MAX_PATH_CHARS: usize = 1024;

type Table = HashMap<String, Vec<PathBuf>>;

fn table() -> &'static RwLock<Table> {
    static TABLE: OnceLock<RwLock<Table>> = OnceLock::new();
    TABLE.get_or_init(|| RwLock::new(Table::new()))
}

/// Why a configured path string is not accepted. The text is shown to the user as is.
pub fn path_problem(raw: &str) -> Option<&'static str> {
    let text = raw.trim();
    if text.is_empty() {
        return Some("a folder path is required");
    }
    if text.chars().count() > MAX_PATH_CHARS {
        return Some("the path is too long");
    }
    if text.chars().any(char::is_control) {
        return Some("the path contains control characters");
    }
    if parse_path_with(text, &home()).is_none() {
        return Some("use an absolute folder path (or one starting with ~)");
    }
    None
}

/// A configured folder as a `PathBuf`: surrounding quotes and spaces are dropped, a leading `~` means the
/// home directory, and anything that is not an absolute path is refused (a relative path would depend on
/// whatever directory the server happens to run from).
pub fn parse_path(raw: &str) -> Option<PathBuf> {
    parse_path_with(raw, &home())
}

fn parse_path_with(raw: &str, home: &Path) -> Option<PathBuf> {
    let mut text = raw.trim();
    // People paste "C:\Users\me\.vibe2" with the quotes Explorer's "Copy as path" adds.
    if text.len() >= 2 && ((text.starts_with('"') && text.ends_with('"')) || (text.starts_with('\'') && text.ends_with('\''))) {
        text = text[1..text.len() - 1].trim();
    }
    if text.is_empty() || text.chars().any(char::is_control) {
        return None;
    }
    let expanded = if text == "~" {
        home.to_path_buf()
    } else if let Some(rest) = text.strip_prefix("~/").or_else(|| text.strip_prefix("~\\")) {
        if home.as_os_str().is_empty() {
            return None;
        }
        home.join(rest)
    } else {
        PathBuf::from(text)
    };
    expanded.is_absolute().then_some(expanded)
}

/// `providers.sources` from a settings document: known agents only, invalid and repeated entries dropped.
pub fn from_settings(settings: &Value) -> Table {
    let mut out = Table::new();
    let Some(map) = settings.pointer("/providers/sources").and_then(Value::as_object) else { return out };
    for id in SOURCE_IDS {
        let Some(list) = map.get(*id).and_then(Value::as_array) else { continue };
        let mut paths: Vec<PathBuf> = Vec::new();
        for item in list.iter().filter_map(Value::as_str).filter_map(parse_path) {
            if !paths.iter().any(|p| same_path(p, &item)) && paths.len() < MAX_PATHS_PER_SOURCE {
                paths.push(item);
            }
        }
        if !paths.is_empty() {
            out.insert((*id).to_string(), paths);
        }
    }
    out
}

/// Replace the process-wide table from a full settings document.
pub fn apply_settings(settings: &Value) {
    let next = from_settings(settings);
    *table().write().unwrap_or_else(|e| e.into_inner()) = next;
}

/// Directories the user configured for an agent (empty by default).
pub fn configured(id: &str) -> Vec<PathBuf> {
    table().read().unwrap_or_else(|e| e.into_inner()).get(id).cloned().unwrap_or_default()
}

/// Whether two paths name the same place for the purpose of "read it once". Trailing separators are
/// ignored; on Windows the comparison is case-insensitive like the file system.
pub fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let s = p.components().as_path().to_string_lossy().to_string();
        let s = s.trim_end_matches(['/', '\\']).to_string();
        if cfg!(windows) { s.to_lowercase() } else { s }
    };
    norm(a) == norm(b)
}

/// Push `path` unless the same place is already there.
pub fn push_unique(list: &mut Vec<PathBuf>, path: PathBuf) {
    if !list.iter().any(|p| same_path(p, &path)) {
        list.push(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn abs(name: &str) -> String {
        std::env::temp_dir().join(name).to_string_lossy().to_string()
    }

    #[test]
    fn paths_are_trimmed_unquoted_and_must_be_absolute() {
        let home = std::env::temp_dir().join("burnrate-home");
        let dir = abs("vibe-custom");
        assert_eq!(parse_path_with(&format!("  \"{dir}\"  "), &home), Some(PathBuf::from(&dir)));
        assert_eq!(parse_path_with(&format!("'{dir}'"), &home), Some(PathBuf::from(&dir)));
        assert_eq!(parse_path_with("~", &home), Some(home.clone()));
        assert_eq!(parse_path_with("~/profiles/work", &home), Some(home.join("profiles/work")));
        assert_eq!(parse_path_with("~\\profiles\\work", &home), Some(home.join("profiles\\work")));
        for bad in ["", "   ", "relative/dir", "./dir", "..", "bad\u{0}path", "\"\""] {
            assert_eq!(parse_path_with(bad, &home), None, "{bad:?} must be refused");
        }
    }

    #[test]
    fn path_problem_explains_a_refusal_in_plain_words() {
        assert_eq!(path_problem(&abs("ok")), None);
        assert_eq!(path_problem("  "), Some("a folder path is required"));
        assert_eq!(path_problem("relative"), Some("use an absolute folder path (or one starting with ~)"));
        assert_eq!(path_problem(&"x".repeat(MAX_PATH_CHARS + 1)), Some("the path is too long"));
        assert_eq!(path_problem("a\nb"), Some("the path contains control characters"));
    }

    #[test]
    fn settings_yield_known_agents_only_without_repeats_or_invalid_entries() {
        let one = abs("one");
        let settings = json!({"providers": {"sources": {
            "claude": [one, format!("{one}/"), "relative", 7, abs("two")],
            "vibe": [],
            "codex": [abs("codex-b")],
            "unknown-agent": [abs("ignored")],
        }}});
        let table = from_settings(&settings);
        assert_eq!(table.get("claude"), Some(&vec![PathBuf::from(&one), PathBuf::from(abs("two"))]));
        assert_eq!(table.get("codex"), Some(&vec![PathBuf::from(abs("codex-b"))]));
        assert!(!table.contains_key("vibe"), "an empty list means auto-discovery only");
        assert!(!table.contains_key("unknown-agent"));
        assert!(from_settings(&json!({})).is_empty(), "no `sources` field behaves as the default");
        assert!(from_settings(&json!({"providers": {"sources": "oops"}})).is_empty());
    }

    #[test]
    fn a_list_is_capped() {
        let many: Vec<String> = (0..MAX_PATHS_PER_SOURCE + 5).map(|i| abs(&format!("d{i}"))).collect();
        let table = from_settings(&json!({"providers": {"sources": {"vibe": many}}}));
        assert_eq!(table["vibe"].len(), MAX_PATHS_PER_SOURCE);
    }

    #[test]
    fn the_same_place_is_read_once() {
        let mut list = vec![PathBuf::from(abs("a"))];
        push_unique(&mut list, PathBuf::from(format!("{}/", abs("a"))));
        assert_eq!(list.len(), 1);
        push_unique(&mut list, PathBuf::from(abs("b")));
        assert_eq!(list.len(), 2);
        if cfg!(windows) {
            assert!(same_path(Path::new("C:\\Users\\Me\\.vibe2"), Path::new("c:\\users\\me\\.vibe2\\")));
        }
    }
}
