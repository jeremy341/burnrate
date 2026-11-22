//! User definitions in `<data>/providers.d/*.toml`, written atomically by the management routes.
use super::lint::lint;
use super::model::Definition;
use std::path::{Path, PathBuf};

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("providers.d")
}

fn valid_file_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// (id, TOML source) of every parseable user definition, sorted by id.
pub fn load_all(data_dir: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir(data_dir)) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("toml") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
        if !valid_file_id(&id) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        match Definition::parse(&text) {
            Ok(def) if lint(&def).is_empty() && def.id == id => out.push((id, text)),
            _ => {}
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Validates and atomically writes `<data>/providers.d/<id>.toml`.
pub fn save(data_dir: &Path, id: &str, toml_text: &str) -> Result<Definition, String> {
    if !valid_file_id(id) {
        return Err("invalid definition id".into());
    }
    let def = Definition::parse(toml_text).map_err(|e| format!("invalid TOML: {e}"))?;
    let errors = lint(&def);
    if let Some(first) = errors.first() {
        return Err(format!("{}: {}", first.field, first.message));
    }
    if def.id != id {
        return Err(format!("definition id '{}' does not match '{id}'", def.id));
    }
    let folder = dir(data_dir);
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let final_path = folder.join(format!("{id}.toml"));
    let tmp = folder.join(format!("{id}.toml.tmp"));
    std::fs::write(&tmp, toml_text).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp, &final_path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(def)
}

pub fn remove(data_dir: &Path, id: &str) -> bool {
    if !valid_file_id(id) {
        return false;
    }
    std::fs::remove_file(dir(data_dir).join(format!("{id}.toml"))).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("burnrate-defs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    const TOML: &str = r#"
schema = 1
id = "demo"
label = "Demo"
status = "stable"
auth = "apiKey"
key_hosts = ["api.example.com"]
[[request]]
id = "r"
method = "GET"
url = "https://api.example.com/v1/me"
"#;

    #[test]
    fn save_load_remove_roundtrip() {
        let root = temp_dir("roundtrip");
        save(&root, "demo", TOML).unwrap();
        let loaded = load_all(&root);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].0, "demo");
        assert!(remove(&root, "demo"));
        assert!(load_all(&root).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_id_mismatch_and_bad_paths() {
        let root = temp_dir("reject");
        assert!(save(&root, "other", TOML).is_err());
        assert!(save(&root, "../escape", TOML).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
