// Embeds every defs/*.toml (except files starting with `_`) so adding a provider definition is "drop a file".
use std::{env, fs, path::PathBuf};

fn main() {
    let dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("defs");
    println!("cargo:rerun-if-changed=defs");
    let mut entries: Vec<(String, PathBuf)> = fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "toml"))
                .filter(|p| !p.file_name().unwrap().to_string_lossy().starts_with('_'))
                .map(|p| (p.file_stem().unwrap().to_string_lossy().to_string(), p))
                .collect()
        })
        .unwrap_or_default();
    entries.sort();
    let mut out = String::from("/// (id, TOML source) of every built-in provider definition.\npub const BUILTIN_DEFS: &[(&str, &str)] = &[\n");
    for (id, path) in entries {
        out.push_str(&format!("    ({:?}, include_str!({:?})),\n", id, path.to_string_lossy().replace('\\', "/")));
    }
    out.push_str("];\n");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("builtin_defs.rs"), out).unwrap();
}
