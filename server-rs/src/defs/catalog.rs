//! Serves the models.dev-derived provider catalog built by package 20.
use serde_json::Value;

const CATALOG_SOURCE: &str = include_str!("../../defs/catalog.json");

pub fn catalog() -> Value {
    serde_json::from_str::<Value>(CATALOG_SOURCE).unwrap_or_else(|_| serde_json::json!([]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_an_array() {
        assert!(catalog().is_array());
    }

    #[test]
    fn definition_entries_carry_status_and_category_that_match_the_toml() {
        let catalog = catalog();
        let defs = crate::defs::all_definitions();
        for entry in catalog.as_array().unwrap() {
            let id = entry["id"].as_str().unwrap();
            if entry["hasDefinition"] == true {
                let def = defs.iter().find(|d| d.def.id == id && d.source == "builtin").unwrap_or_else(|| panic!("{id} has no definition"));
                assert_eq!(entry["status"], def.def.status.as_str(), "{id} status");
                assert_eq!(entry["category"], def.def.category.as_str(), "{id} category");
            } else {
                assert!(entry.get("status").is_none() && entry.get("category").is_none(), "{id}: status/category only for definitions");
            }
        }
        let admin = catalog.as_array().unwrap().iter().find(|e| e["id"] == "anthropic-admin").unwrap();
        assert_eq!(admin["category"], "admin");
    }
}
