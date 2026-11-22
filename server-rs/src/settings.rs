//! Versioned, validated settings store. Source of truth is `data/settings.json`; the browser keeps a
//! write-through mirror only for first paint. Contract: docs/CONTRACTS.md section 2.
//!
//! The file holds a v2 `AppSettings` object (mirroring `src/settings/schema.ts`). The two legacy maps
//! (`usagePriceOverrides`, `usageModelAliases`) are migrated into `usage.*` on open and re-exposed as
//! top-level mirrors on GET so old clients keep working. Writes are atomic (`.tmp` -> rename), keep a
//! `.bak` of the previous version and publish a `settings` hub event.

use crate::hub;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const SETTINGS_SCHEMA_VERSION: u64 = 2;

/// First invalid field in a patch, used by the route to answer
/// `400 {"error":"invalid settings","field":"appearance.themeMode"}`.
#[derive(Clone, Debug)]
pub struct FieldError {
    pub field: String,
    pub message: String,
}

impl FieldError {
    fn new(field: impl Into<String>, message: impl Into<String>) -> Self {
        FieldError { field: field.into(), message: message.into() }
    }
}

/// What the engine needs: per-model prices ([input, output, cacheRead, cacheWrite] per million) and
/// model names. Kept as-is so `state.settings.get()` stays compatible with `engine.rs`.
#[derive(Clone, Default)]
pub struct Settings {
    pub prices: HashMap<String, [Option<f64>; 4]>,
    pub aliases: HashMap<String, String>,
}

pub struct SettingsStore {
    path: PathBuf,
    raw: Mutex<Value>,
    /// A file with a newer schema version is loaded (defaults filled) but never overwritten.
    read_only: bool,
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/// Mirrors `DEFAULT_SETTINGS` in `src/settings/schema.ts`.
pub fn default_settings() -> Value {
    // `providers.sources` defaults to an empty list for every supported agent id, built from `SOURCE_IDS`
    // so this never drifts from the readers the way a hand-written literal would.
    let mut default_sources = serde_json::Map::new();
    for id in crate::readers::sources::SOURCE_IDS {
        default_sources.insert((*id).to_string(), json!([]));
    }
    json!({
        "schemaVersion": SETTINGS_SCHEMA_VERSION,
        "onboarded": false,
        "general": {
            "launchAtLogin": false,
            "startMinimized": false,
            "closeToTray": true,
            "language": "system",
            "checkForUpdates": false,
            "timestampFormat": "locale",
            "hideSensitive": false
        },
        "appearance": {
            "themeMode": "dark",
            "lightThemeId": null,
            "darkThemeId": "burnrate-dark",
            "customThemes": {},
            // No radius default: the app uses the fixed T3 radius token. A saved radius still loads.
            "density": "comfortable",
            "uiScale": 1,
            "fontFamily": null,
            "monoFontFamily": null,
            "reduceMotion": "system",
            "highContrast": false
        },
        "usage": {
            "defaultView": "limits",
            "defaultPeriod": "7d",
            "refreshIntervalSec": 120,
            "historyDays": 90,
            "refreshOnFocus": true,
            "pollWhenHidden": false,
            "showPaceTick": true,
            "showTimeToEmpty": true,
            "barMode": "remaining",
            "currency": "USD",
            "usagePriceOverrides": {},
            "usageModelAliases": {}
        },
        "providers": {
            "hidden": [],
            "order": [],
            "claudeOAuthProbe": true,
            "customDefinitions": true,
            "overrides": {},
            "sources": serde_json::Value::Object(default_sources)
        },
        "notifications": {
            "enabled": false,
            "desktop": false,
            "sound": false,
            "thresholds": [80, 90, 100],
            "predictRunout": false,
            "notifyOnReset": false,
            "notifyOnExpiredLogin": false,
            "quietHours": { "enabled": false, "start": "22:00", "end": "08:00" },
            "snoozeUntil": null,
            "cooldownMinutes": 30,
            "perProvider": {},
            "channels": {
                "ntfy": { "enabled": false, "configured": false },
                "discord": { "enabled": false, "configured": false },
                "webhook": { "enabled": false, "configured": false }
            }
        },
        "shell": { "tray": true, "globalShortcut": null },
        "advanced": { "localApi": false, "logLevel": "warn", "safeMode": false, "experimental": {} }
    })
}

// ---------------------------------------------------------------------------
// Deep merge: objects merge, arrays and scalars replace, null deletes a key.
// ---------------------------------------------------------------------------

/// Settings whose `null` is a real value ("use the stock theme", "no shortcut"), not a deletion. For every
/// other key, `null` removes it (that is how map entries such as `customThemes.<id>` are deleted).
const NULLABLE_FIELDS: &[&str] = &[
    "appearance.lightThemeId",
    "appearance.darkThemeId",
    "appearance.fontFamily",
    "appearance.monoFontFamily",
    "notifications.snoozeUntil",
    "shell.globalShortcut",
];

pub fn deep_merge(base: &Value, patch: &Value) -> Value {
    deep_merge_at(base, patch, "")
}

fn deep_merge_at(base: &Value, patch: &Value, path: &str) -> Value {
    match (base, patch) {
        (Value::Object(b), Value::Object(p)) => {
            let mut out = b.clone();
            for (key, value) in p {
                let here = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
                if value.is_null() {
                    if NULLABLE_FIELDS.contains(&here.as_str()) {
                        out.insert(key.clone(), Value::Null);
                    } else {
                        out.remove(key);
                    }
                } else if value.is_object() {
                    let empty = Value::Object(Map::new());
                    let current = b.get(key).filter(|value| value.is_object()).unwrap_or(&empty);
                    out.insert(key.clone(), deep_merge_at(current, value, &here));
                } else {
                    out.insert(key.clone(), value.clone());
                }
            }
            Value::Object(out)
        }
        _ => patch.clone(),
    }
}

/// Legacy top-level maps in a patch are folded into `usage.*` before validation/merge.
fn normalize_legacy(patch: &Value) -> Value {
    let mut out = patch.clone();
    let Some(obj) = out.as_object_mut() else { return out };
    for key in ["usagePriceOverrides", "usageModelAliases"] {
        if let Some(value) = obj.remove(key) {
            let usage = obj.entry("usage".to_string()).or_insert_with(|| json!({}));
            if let Some(usage) = usage.as_object_mut() {
                usage.insert(key.to_string(), value);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

fn err(field: &str, message: impl Into<String>) -> FieldError {
    FieldError::new(field, message)
}

fn expect_object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, FieldError> {
    value.as_object().ok_or_else(|| err(path, "expected an object"))
}

fn check_bool(path: &str, value: &Value) -> Result<(), FieldError> {
    if value.is_boolean() { Ok(()) } else { Err(err(path, "expected a boolean")) }
}

fn check_num(path: &str, value: &Value, min: f64, max: f64, integer: bool) -> Result<(), FieldError> {
    let n = value.as_f64().ok_or_else(|| err(path, "expected a number"))?;
    let whole = !integer || n.fract() == 0.0;
    if n.is_finite() && n >= min && n <= max && whole {
        Ok(())
    } else {
        Err(err(path, format!("must be {} between {} and {}", if integer { "an integer" } else { "a number" }, min, max)))
    }
}

fn check_enum(path: &str, value: &Value, allowed: &[&str]) -> Result<(), FieldError> {
    let s = value.as_str().ok_or_else(|| err(path, "expected a string"))?;
    if allowed.contains(&s) {
        Ok(())
    } else {
        Err(err(path, format!("must be one of: {}", allowed.join(", "))))
    }
}

fn check_string(path: &str, value: &Value, min: usize, max: usize) -> Result<(), FieldError> {
    let s = value.as_str().ok_or_else(|| err(path, "expected a string"))?;
    let len = s.chars().count();
    if (min..=max).contains(&len) {
        Ok(())
    } else {
        Err(err(path, format!("length must be between {min} and {max} characters")))
    }
}

fn check_nullable_string(path: &str, value: &Value, min: usize, max: usize) -> Result<(), FieldError> {
    if value.is_null() { Ok(()) } else { check_string(path, value, min, max) }
}

fn check_array<F>(path: &str, value: &Value, mut item: F) -> Result<(), FieldError>
where
    F: FnMut(usize, &Value) -> Result<(), FieldError>,
{
    let array = value.as_array().ok_or_else(|| err(path, "expected an array"))?;
    for (i, v) in array.iter().enumerate() {
        item(i, v)?;
    }
    Ok(())
}

/// A map entry with a `null` value deletes the entry, so its value is not validated.
fn check_string_map<F>(path: &str, value: &Value, mut entry: F) -> Result<(), FieldError>
where
    F: FnMut(&str, &Value) -> Result<(), FieldError>,
{
    for (key, v) in expect_object(value, path)? {
        if v.is_null() { continue; }
        entry(key, v)?;
    }
    Ok(())
}

fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}

fn valid_name(s: &str) -> bool {
    !s.trim().is_empty() && s.chars().count() <= 200
}

fn valid_hhmm(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 5 || b[2] != b':' || !b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit()) {
        return false;
    }
    let hour = u32::from(b[0] - b'0') * 10 + u32::from(b[1] - b'0');
    let minute = u32::from(b[3] - b'0') * 10 + u32::from(b[4] - b'0');
    hour <= 23 && minute <= 59
}

// ---------------------------------------------------------------------------
// Schema-table validation (mirrors src/settings/schema.ts)
// ---------------------------------------------------------------------------

fn validate_general(path: &str, value: &Value) -> Result<(), FieldError> {
    let o = expect_object(value, path)?;
    for field in ["launchAtLogin", "startMinimized", "closeToTray", "checkForUpdates", "hideSensitive"] {
        if let Some(v) = o.get(field) {
            check_bool(&format!("{path}.{field}"), v)?;
        }
    }
    if let Some(v) = o.get("language") {
        check_string(&format!("{path}.language"), v, 1, 64)?;
    }
    if let Some(v) = o.get("timestampFormat") {
        check_enum(&format!("{path}.timestampFormat"), v, &["locale", "12-hour", "24-hour"])?;
    }
    Ok(())
}

fn validate_theme_id(path: &str, value: &Value) -> Result<(), FieldError> {
    if value.is_null() { return Ok(()); }
    let s = value.as_str().ok_or_else(|| err(path, "expected a theme id string or null"))?;
    if valid_id(s) { Ok(()) } else { Err(err(path, "invalid theme id")) }
}

fn validate_colors(path: &str, value: &Value) -> Result<(), FieldError> {
    for (role, color) in expect_object(value, path)? {
        let p = format!("{path}.{role}");
        let s = color.as_str().ok_or_else(|| err(&p, "expected a colour string"))?;
        if s.is_empty() || s.len() > 40 {
            return Err(err(&p, "colour values must be 1-40 characters"));
        }
        // Deliberately a character allowlist, not a colour parser: the client canonicalises to oklch and
        // skips roles it cannot parse (src/themePalette.ts), so the server only has to keep stored values
        // inert (no quotes, `;`, braces, `url(`-style escapes or markup) while allowing hex, rgb/hsl/oklch/
        // color-mix(), named colours and `var(--x)`.
        if !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '#' | '(' | ')' | ',' | '.' | '%' | '/' | '-' | '+')) {
            return Err(err(&p, "colour values may only contain letters, digits and # ( ) , . % / - +"));
        }
    }
    Ok(())
}

fn validate_theme(path: &str, value: &Value) -> Result<(), FieldError> {
    let o = expect_object(value, path)?;
    if let Some(v) = o.get("id") {
        check_string(&format!("{path}.id"), v, 1, 80)?;
        if !v.as_str().is_some_and(valid_id) {
            return Err(err(&format!("{path}.id"), "invalid theme id"));
        }
    }
    if let Some(v) = o.get("label") {
        check_string(&format!("{path}.label"), v, 1, 200)?;
    }
    if let Some(v) = o.get("appearance") {
        check_enum(&format!("{path}.appearance"), v, &["light", "dark"])?;
    }
    if let Some(v) = o.get("colors") {
        validate_colors(&format!("{path}.colors"), v)?;
    }
    if let Some(v) = o.get("variants") {
        let p = format!("{path}.variants");
        for (appearance, colors) in expect_object(v, &p)? {
            if matches!(appearance.as_str(), "light" | "dark") {
                validate_colors(&format!("{p}.{appearance}"), colors)?;
            }
        }
    }
    if let Some(v) = o.get("collection") {
        let p = format!("{path}.collection");
        let collection = expect_object(v, &p)?;
        for field in ["id", "label"] {
            if let Some(x) = collection.get(field) {
                check_string(&format!("{p}.{field}"), x, 1, 200)?;
            }
        }
    }
    for field in ["sidebarArtwork", "managed"] {
        if let Some(v) = o.get(field) {
            check_bool(&format!("{path}.{field}"), v)?;
        }
    }
    if let Some(v) = o.get("css") {
        check_string(&format!("{path}.css"), v, 0, 100_000)?;
    }
    Ok(())
}

fn validate_appearance(path: &str, value: &Value) -> Result<(), FieldError> {
    let o = expect_object(value, path)?;
    if let Some(v) = o.get("themeMode") {
        check_enum(&format!("{path}.themeMode"), v, &["system", "light", "dark"])?;
    }
    for field in ["lightThemeId", "darkThemeId"] {
        if let Some(v) = o.get(field) {
            validate_theme_id(&format!("{path}.{field}"), v)?;
        }
    }
    if let Some(v) = o.get("customThemes") {
        let p = format!("{path}.customThemes");
        check_string_map(&p, v, |id, theme| {
            if !valid_id(id) {
                return Err(err(&format!("{p}.{id}"), "invalid theme id"));
            }
            validate_theme(&format!("{p}.{id}"), theme)
        })?;
    }
    // `radius`, `density` and `uiScale` are deprecated/ignored. Any saved or patched value is
    // tolerated (and kept verbatim) so old files keep loading — it is never read or validated.
    for field in ["fontFamily", "monoFontFamily"] {
        if let Some(v) = o.get(field) {
            check_nullable_string(&format!("{path}.{field}"), v, 0, 200)?;
        }
    }
    if let Some(v) = o.get("reduceMotion") {
        check_enum(&format!("{path}.reduceMotion"), v, &["system", "on", "off"])?;
    }
    if let Some(v) = o.get("highContrast") {
        check_bool(&format!("{path}.highContrast"), v)?;
    }
    Ok(())
}

fn validate_price_map(path: &str, value: &Value) -> Result<(), FieldError> {
    check_string_map(path, value, |model, price| {
        let p = format!("{path}.{model}");
        if !valid_name(model) {
            return Err(err(&p, "invalid model name"));
        }
        let price = expect_object(price, &p)?;
        for field in ["inputCostPerMillionTokens", "outputCostPerMillionTokens"] {
            let v = price.get(field).ok_or_else(|| err(&format!("{p}.{field}"), "missing price"))?;
            check_num(&format!("{p}.{field}"), v, 0.0, 1e6, false)?;
        }
        for field in ["cacheReadCostPerMillionTokens", "cacheWriteCostPerMillionTokens"] {
            if let Some(v) = price.get(field) {
                check_num(&format!("{p}.{field}"), v, 0.0, 1e6, false)?;
            }
        }
        Ok(())
    })
}

fn validate_alias_map(path: &str, value: &Value) -> Result<(), FieldError> {
    check_string_map(path, value, |model, alias| {
        let p = format!("{path}.{model}");
        if !valid_name(model) {
            return Err(err(&p, "invalid model name"));
        }
        let alias = alias.as_str().ok_or_else(|| err(&p, "expected a model alias string"))?;
        if valid_name(alias) { Ok(()) } else { Err(err(&p, "invalid model alias")) }
    })
}

fn validate_usage(path: &str, value: &Value) -> Result<(), FieldError> {
    let o = expect_object(value, path)?;
    if let Some(v) = o.get("defaultView") {
        check_enum(&format!("{path}.defaultView"), v, &["cost", "tokens", "limits"])?;
    }
    // `defaultPeriod` is deprecated/ignored — a saved value is tolerated verbatim.
    if let Some(v) = o.get("refreshIntervalSec") {
        check_num(&format!("{path}.refreshIntervalSec"), v, 30.0, 86_400.0, true)?;
    }
    if let Some(v) = o.get("historyDays") {
        check_num(&format!("{path}.historyDays"), v, 0.0, 3_650.0, true)?;
    }
    for field in ["refreshOnFocus", "pollWhenHidden", "showPaceTick", "showTimeToEmpty"] {
        if let Some(v) = o.get(field) {
            check_bool(&format!("{path}.{field}"), v)?;
        }
    }
    if let Some(v) = o.get("barMode") {
        check_enum(&format!("{path}.barMode"), v, &["remaining", "used"])?;
    }
    if let Some(v) = o.get("currency") {
        check_string(&format!("{path}.currency"), v, 1, 12)?;
    }
    if let Some(v) = o.get("usagePriceOverrides") {
        validate_price_map(&format!("{path}.usagePriceOverrides"), v)?;
    }
    if let Some(v) = o.get("usageModelAliases") {
        validate_alias_map(&format!("{path}.usageModelAliases"), v)?;
    }
    Ok(())
}

fn validate_providers(path: &str, value: &Value) -> Result<(), FieldError> {
    let o = expect_object(value, path)?;
    for field in ["hidden", "order"] {
        if let Some(v) = o.get(field) {
            let p = format!("{path}.{field}");
            check_array(&p, v, |i, item| check_string(&format!("{p}[{i}]"), item, 1, 120))?;
        }
    }
    for field in ["claudeOAuthProbe", "customDefinitions"] {
        if let Some(v) = o.get(field) {
            check_bool(&format!("{path}.{field}"), v)?;
        }
    }
    if let Some(v) = o.get("overrides") {
        let p = format!("{path}.overrides");
        check_string_map(&p, v, |id, override_value| {
            let op = format!("{p}.{id}");
            let ov = expect_object(override_value, &op)?;
            if let Some(x) = ov.get("pollSeconds").filter(|value| !value.is_null()) {
                check_num(&format!("{op}.pollSeconds"), x, 60.0, 86_400.0, true)?;
            }
            if let Some(x) = ov.get("enabled") {
                check_bool(&format!("{op}.enabled"), x)?;
            }
            Ok(())
        })?;
    }
    if let Some(v) = o.get("sources") {
        validate_sources(&format!("{path}.sources"), v)?;
    }
    Ok(())
}

/// `providers.sources`: extra local folders per agent, read in addition to automatic discovery.
fn validate_sources(path: &str, value: &Value) -> Result<(), FieldError> {
    use crate::readers::sources::{path_problem, MAX_PATHS_PER_SOURCE, SOURCE_IDS};
    check_string_map(path, value, |id, list| {
        let p = format!("{path}.{id}");
        if !SOURCE_IDS.contains(&id) {
            return Err(err(&p, format!("unknown source (expected one of: {})", SOURCE_IDS.join(", "))));
        }
        let items = list.as_array().ok_or_else(|| err(&p, "expected a list of folder paths"))?;
        if items.len() > MAX_PATHS_PER_SOURCE {
            return Err(err(&p, "too many folders (the limit is 20)"));
        }
        check_array(&p, list, |i, item| {
            let ip = format!("{p}[{i}]");
            let text = item.as_str().ok_or_else(|| err(&ip, "expected a folder path string"))?;
            path_problem(text).map_or(Ok(()), |problem| Err(err(&ip, problem)))
        })
    })
}

fn validate_thresholds(path: &str, value: &Value) -> Result<(), FieldError> {
    check_array(path, value, |i, item| check_num(&format!("{path}[{i}]"), item, 1.0, 100.0, true))
}

fn validate_notifications(path: &str, value: &Value) -> Result<(), FieldError> {
    let o = expect_object(value, path)?;
    for field in ["enabled", "desktop", "sound", "predictRunout", "notifyOnReset", "notifyOnExpiredLogin"] {
        if let Some(v) = o.get(field) {
            check_bool(&format!("{path}.{field}"), v)?;
        }
    }
    if let Some(v) = o.get("thresholds") {
        validate_thresholds(&format!("{path}.thresholds"), v)?;
    }
    if let Some(v) = o.get("quietHours") {
        let p = format!("{path}.quietHours");
        let quiet = expect_object(v, &p)?;
        if let Some(x) = quiet.get("enabled") {
            check_bool(&format!("{p}.enabled"), x)?;
        }
        for field in ["start", "end"] {
            if let Some(x) = quiet.get(field) {
                let s = x.as_str().ok_or_else(|| err(&format!("{p}.{field}"), "expected HH:MM string"))?;
                if !valid_hhmm(s) {
                    return Err(err(&format!("{p}.{field}"), "expected HH:MM (24-hour)"));
                }
            }
        }
    }
    if let Some(v) = o.get("snoozeUntil") {
        check_nullable_string(&format!("{path}.snoozeUntil"), v, 0, 40)?;
    }
    if let Some(v) = o.get("cooldownMinutes") {
        check_num(&format!("{path}.cooldownMinutes"), v, 0.0, 10_080.0, true)?;
    }
    if let Some(v) = o.get("perProvider") {
        let p = format!("{path}.perProvider");
        check_string_map(&p, v, |id, provider_value| {
            let pp = format!("{p}.{id}");
            let provider = expect_object(provider_value, &pp)?;
            if let Some(x) = provider.get("enabled") {
                check_bool(&format!("{pp}.enabled"), x)?;
            }
            if let Some(x) = provider.get("thresholds").filter(|value| !value.is_null()) {
                validate_thresholds(&format!("{pp}.thresholds"), x)?;
            }
            Ok(())
        })?;
    }
    if let Some(v) = o.get("channels") {
        let p = format!("{path}.channels");
        let channels = expect_object(v, &p)?;
        for channel in ["ntfy", "discord", "webhook"] {
            if let Some(cv) = channels.get(channel) {
                let cp = format!("{p}.{channel}");
                let flags = expect_object(cv, &cp)?;
                for field in ["enabled", "configured"] {
                    if let Some(x) = flags.get(field) {
                        check_bool(&format!("{cp}.{field}"), x)?;
                    }
                }
            }
        }
    }
    Ok(())
}


fn validate_shell(path: &str, value: &Value) -> Result<(), FieldError> {
    let o = expect_object(value, path)?;
    if let Some(v) = o.get("tray") {
        check_bool(&format!("{path}.tray"), v)?;
    }
    if let Some(v) = o.get("globalShortcut") {
        // `null` means "no shortcut"; an empty string is not a shortcut and is rejected.
        check_nullable_string(&format!("{path}.globalShortcut"), v, 1, 100)?;
    }
    Ok(())
}

fn validate_advanced(path: &str, value: &Value) -> Result<(), FieldError> {
    let o = expect_object(value, path)?;
    for field in ["localApi", "safeMode"] {
        if let Some(v) = o.get(field) {
            check_bool(&format!("{path}.{field}"), v)?;
        }
    }
    if let Some(v) = o.get("logLevel") {
        check_enum(&format!("{path}.logLevel"), v, &["error", "warn", "info", "debug"])?;
    }
    // `experimental.*` is deprecated/ignored: any shape or value is tolerated. Readers use
    // `bool_at`/`openvsx_enabled`, which already treat non-booleans as "off".
    Ok(())
}

/// Validates a patch (or imported settings) and returns the first bad field path.
pub fn validate_patch(patch: &Value) -> Result<(), FieldError> {
    let root = expect_object(patch, "")?;
    if let Some(v) = root.get("schemaVersion") {
        if v.as_u64() != Some(SETTINGS_SCHEMA_VERSION) {
            return Err(err("schemaVersion", "unsupported schema version (expected 2)"));
        }
    }
    // Top-level `onboarded` is optional and tolerated verbatim: the onboarding helper reads `true`
    // as done, so an absent or oddly typed value is simply "not done" and never a 400. Unknown
    // top-level keys are likewise preserved by `deep_merge` and not validated.
    const SECTIONS: &[(&str, fn(&str, &Value) -> Result<(), FieldError>)] = &[
        ("general", validate_general),
        ("appearance", validate_appearance),
        ("usage", validate_usage),
        ("providers", validate_providers),
        ("notifications", validate_notifications),
        ("shell", validate_shell),
        ("advanced", validate_advanced),
    ];
    for (name, check) in SECTIONS {
        if let Some(v) = root.get(*name) {
            check(name, v)?;
        }
    }
    // Also accept the legacy mirrors directly (e.g. an imported v1-shaped object).
    if let Some(v) = root.get("usagePriceOverrides") {
        validate_price_map("usagePriceOverrides", v)?;
    }
    if let Some(v) = root.get("usageModelAliases") {
        validate_alias_map("usageModelAliases", v)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Storage: open, migrate, atomic write, corrupt recovery
// ---------------------------------------------------------------------------

fn corrupt_path(path: &Path) -> PathBuf {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".corrupt-{ts}"));
    PathBuf::from(name)
}

fn migrate_v1(value: &Value, mut base: Value) -> Value {
    // Preserve every key (including unknowns), then move the legacy top-level maps into `usage.*`.
    base = deep_merge(&base, value);
    {
        let root = base.as_object_mut().expect("settings root is an object");
        let prices = root.remove("usagePriceOverrides");
        let aliases = root.remove("usageModelAliases");
        let usage = root.entry("usage".to_string()).or_insert_with(|| json!({}));
        let usage = usage.as_object_mut().expect("usage is an object");
        if let Some(prices) = prices {
            usage.insert("usagePriceOverrides".to_string(), prices);
        }
        if let Some(aliases) = aliases {
            usage.insert("usageModelAliases".to_string(), aliases);
        }
    }
    base["schemaVersion"] = json!(SETTINGS_SCHEMA_VERSION);
    base
}

impl SettingsStore {
    /// Opens the store, migrating v1 files and recovering corrupt ones. Never panics on bad input.
    pub fn open(data_dir: &Path) -> SettingsStore {
        let path = data_dir.join("settings.json");
        let mut read_only = false;
        let mut migrated = false;
        let loaded = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(value) => Some(value),
                Err(_) => {
                    let dest = corrupt_path(&path);
                    eprintln!("burnrate: {} is corrupt; moving to {}", path.display(), dest.display());
                    let _ = fs::rename(&path, &dest);
                    None
                }
            },
            Err(_) => None,
        };

        let mut raw = default_settings();
        if let Some(value) = loaded {
            match value.get("schemaVersion").and_then(Value::as_u64) {
                Some(SETTINGS_SCHEMA_VERSION) => {
                    raw = deep_merge(&raw, &value);
                }
                Some(_other) => {
                    // Unknown future version: fill defaults for reading but never overwrite the file.
                    eprintln!("burnrate: {} has an unsupported schema version; loading read-only", path.display());
                    raw = deep_merge(&raw, &value);
                    read_only = true;
                }
                None => {
                    raw = migrate_v1(&value, raw);
                    migrated = true;
                }
            }
        }
        raw["schemaVersion"] = json!(SETTINGS_SCHEMA_VERSION);
        crate::readers::sources::apply_settings(&raw);
        let store = SettingsStore { path, raw: Mutex::new(raw), read_only };
        if migrated && !store.read_only {
            let current = store.raw.lock().expect("settings lock poisoned").clone();
            let _ = store.write(&current);
        }
        store
    }

    /// Full settings plus the legacy top-level mirrors (`GET /api/settings`).
    pub fn raw(&self) -> Value {
        let current = self.raw.lock().unwrap_or_else(|e| e.into_inner());
        with_mirrors(&current)
    }

    /// Full v2 `AppSettings` without mirrors or secrets (for export).
    pub fn export(&self) -> Value {
        let settings = self.raw.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let exported_at = chrono::Utc::now().to_rfc3339();
        json!({
            "app": "burnrate",
            "schemaVersion": SETTINGS_SCHEMA_VERSION,
            "exportedAt": exported_at,
            "settings": settings
        })
    }

    /// Engine view (prices/aliases). Kept deliberately small and stable for `engine.rs`.
    pub fn get(&self) -> Settings {
        let raw = self.raw.lock().unwrap_or_else(|e| e.into_inner());
        let mut settings = Settings::default();
        if let Some(prices) = raw.pointer("/usage/usagePriceOverrides").and_then(Value::as_object) {
            for (model, price) in prices {
                let number = |key: &str| price.get(key).and_then(Value::as_f64);
                settings.prices.insert(
                    model.clone(),
                    [
                        number("inputCostPerMillionTokens"),
                        number("outputCostPerMillionTokens"),
                        number("cacheReadCostPerMillionTokens"),
                        number("cacheWriteCostPerMillionTokens"),
                    ],
                );
            }
        }
        if let Some(aliases) = raw.pointer("/usage/usageModelAliases").and_then(Value::as_object) {
            for (model, target) in aliases {
                if let Some(target) = target.as_str() {
                    settings.aliases.insert(model.clone(), target.to_string());
                }
            }
        }
        settings
    }

    fn write(&self, value: &Value) -> Result<(), String> {
        if self.read_only {
            return Err("settings file has an unsupported schema version; refusing to overwrite".to_string());
        }
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent).map_err(|e| format!("cannot create data directory: {e}"))?;
        if self.path.exists() {
            let backup = self.path.with_extension("json.bak");
            let _ = fs::copy(&self.path, backup);
        }
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(value).map_err(|e| format!("cannot serialize settings: {e}"))?;
        fs::write(&tmp, bytes).map_err(|e| format!("cannot write temporary settings file: {e}"))?;
        // rename() replaces the destination atomically on both Windows and Unix.
        fs::rename(&tmp, &self.path).map_err(|e| format!("cannot commit settings file: {e}"))?;
        Ok(())
    }

    /// Atomic read-modify-write under the lock, so concurrent patches cannot lose updates.
    fn commit<F>(&self, change: F) -> Result<Value, FieldError>
    where
        F: FnOnce(&Value) -> Result<Value, FieldError>,
    {
        let mut guard = self.raw.lock().unwrap_or_else(|e| e.into_inner());
        let next = change(&guard)?;
        self.write(&next).map_err(|message| FieldError::new("settings", message))?;
        *guard = next.clone();
        drop(guard);
        crate::readers::sources::apply_settings(&next);
        hub::publish("settings", next.clone());
        Ok(with_mirrors(&next))
    }

    /// PATCH /api/settings.
    pub fn patch(&self, patch: &Value) -> Result<Value, FieldError> {
        let patch = normalize_legacy(patch);
        validate_patch(&patch)?;
        self.commit(|current| Ok(deep_merge(current, &patch)))
    }

    /// POST /api/settings/import. `mode` is "merge" (default) or "replace".
    pub fn import(&self, settings: &Value, mode: &str) -> Result<Value, FieldError> {
        let settings = normalize_legacy(settings);
        validate_patch(&settings)?;
        match mode {
            "merge" => self.commit(|current| Ok(deep_merge(current, &settings))),
            "replace" => self.commit(|_| Ok(deep_merge(&default_settings(), &settings))),
            _ => Err(FieldError::new("mode", "must be \"merge\" or \"replace\"")),
        }
    }

    /// POST /api/settings/reset. `scope` is "all" or "section".
    pub fn reset(&self, scope: &str, section: Option<&str>) -> Result<Value, FieldError> {
        match scope {
            "all" => self.commit(|_| Ok(default_settings())),
            "section" => {
                let section = section.ok_or_else(|| FieldError::new("section", "required when scope is \"section\""))?;
                const SECTIONS: &[&str] = &["general", "appearance", "usage", "providers", "notifications", "shell", "advanced"];
                if !SECTIONS.contains(&section) {
                    return Err(FieldError::new("section", "unknown settings section"));
                }
                let defaults = default_settings();
                let default_section = defaults.get(section).cloned().expect("section exists in defaults");
                self.commit(move |current| {
                    let mut next = current.clone();
                    next.as_object_mut().expect("settings root is an object").insert(section.to_string(), default_section.clone());
                    Ok(next)
                })
            }
            _ => Err(FieldError::new("scope", "must be \"all\" or \"section\"")),
        }
    }
}

fn with_mirrors(settings: &Value) -> Value {
    let mut out = settings.clone();
    let prices = settings.pointer("/usage/usagePriceOverrides").cloned().unwrap_or_else(|| json!({}));
    let aliases = settings.pointer("/usage/usageModelAliases").cloned().unwrap_or_else(|| json!({}));
    if let Some(root) = out.as_object_mut() {
        root.insert("usagePriceOverrides".to_string(), prices);
        root.insert("usageModelAliases".to_string(), aliases);
    }
    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    #[test]
    fn poll_interval_reset_preserves_other_overrides_and_ignores_missing_entries() {
        let dir = temp_dir();
        let store = SettingsStore::open(&dir);
        store.patch(&json!({
            "providers": {"overrides": {"codex": {"enabled": false, "pollSeconds": 120}}}
        })).unwrap();
        let updated = store.patch(&json!({
            "providers": {"overrides": {
                "codex": {"pollSeconds": null},
                "missing": {"pollSeconds": null}
            }}
        })).unwrap();
        assert_eq!(updated["providers"]["overrides"]["codex"], json!({"enabled": false}));
        assert!(updated.pointer("/providers/overrides/missing/pollSeconds").is_none());
        cleanup(&dir);
    }

    #[test]
    fn provider_threshold_reset_keeps_the_provider_enabled_flag() {
        let dir = temp_dir();
        let store = SettingsStore::open(&dir);
        store.patch(&json!({
            "notifications": {"perProvider": {"codex": {"enabled": false, "thresholds": [88]}}}
        })).unwrap();
        let updated = store.patch(&json!({
            "notifications": {"perProvider": {"codex": {"thresholds": null}}}
        })).unwrap();
        assert_eq!(updated["notifications"]["perProvider"]["codex"], json!({"enabled": false}));
        cleanup(&dir);
    }

    #[test]
    fn shell_shortcut_rejects_empty_but_accepts_null() {
        assert!(validate_shell("shell", &json!({"globalShortcut": null})).is_ok());
        assert!(validate_shell("shell", &json!({"globalShortcut": "Ctrl+Shift+B"})).is_ok());
        assert!(validate_shell("shell", &json!({"globalShortcut": ""})).is_err());
    }


    #[test]
    fn theme_colours_stay_inert() {
        for ok in ["#fff", "rgb(1, 2, 3)", "oklch(62% 0.2 250 / 0.5)", "var(--accent)", "color-mix(in oklch, red 50%, blue)"] {
            assert!(validate_colors("c", &json!({"accent": ok})).is_ok(), "{ok}");
        }
        for bad in ["red;}body{x", "url(x)\"", "<script>", "a'b", ""] {
            assert!(validate_colors("c", &json!({"accent": bad})).is_err(), "{bad}");
        }
    }

    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::thread;

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("burnrate-settings-{}-{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn defaults_match_the_schema() {
        let d = default_settings();
        assert_eq!(d["schemaVersion"], 2);
        assert_eq!(d["appearance"]["darkThemeId"], "burnrate-dark");
        assert!(d["appearance"].get("radius").is_none(), "radius has no default");
        assert_eq!(d["notifications"]["enabled"], false);
        assert_eq!(d["notifications"]["thresholds"], json!([80, 90, 100]));
        assert_eq!(d["usage"]["refreshIntervalSec"], 120);
        assert_eq!(d["advanced"]["logLevel"], "warn");
    }

    #[test]
    fn validation_accepts_a_valid_patch_and_reports_first_bad_field() {
        let good = json!({
            "appearance": { "radius": 0.75, "themeMode": "dark", "highContrast": true },
            "usage": { "refreshIntervalSec": 60, "usageModelAliases": { "gpt-x": "gpt-y" } },
            "advanced": { "experimental": { "openVsx": true } },
            "schemaVersion": 2
        });
        validate_patch(&good).unwrap();

        let cases = [
            (json!({"appearance": {"themeMode": "neon"}}), "appearance.themeMode"),
            (json!({"usage": {"refreshIntervalSec": 10}}), "usage.refreshIntervalSec"),
            (json!({"notifications": {"quietHours": {"start": "25:00"}}}), "notifications.quietHours.start"),
            (json!({"general": {"hideSensitive": "yes"}}), "general.hideSensitive"),
            (json!({"usage": {"usagePriceOverrides": {"m": {"inputCostPerMillionTokens": -1, "outputCostPerMillionTokens": 1}}}}), "usage.usagePriceOverrides.m.inputCostPerMillionTokens"),
        ];
        for (patch, field) in cases {
            let error = validate_patch(&patch).unwrap_err();
            assert_eq!(error.field, field, "wrong field for patch {patch}");
        }
    }

    #[test]
    fn deprecated_keys_are_tolerated_with_any_value() {
        // Saved/patched values for ignored keys must never produce a validation error.
        let weird = json!({
            "onboarded": "not-a-bool",
            "appearance": {"radius": "wide", "density": 9, "uiScale": -4},
            "advanced": {"experimental": {"openVsx": "yes", "anything": [1, 2, 3]}}
        });
        validate_patch(&weird).unwrap();

        let dir = temp_dir();
        let store = SettingsStore::open(&dir);
        let saved = store.patch(&weird).unwrap();
        assert_eq!(saved["onboarded"], "not-a-bool");
        assert_eq!(saved["appearance"]["radius"], "wide");
        assert_eq!(saved["advanced"]["experimental"]["anything"], json!([1, 2, 3]));
        // The normal boolean write is accepted too, and defaults start at false.
        assert_eq!(default_settings()["onboarded"], false);
        assert_eq!(store.patch(&json!({"onboarded": true})).unwrap()["onboarded"], true);
        cleanup(&dir);
    }

    #[test]
    fn saved_deprecated_values_survive_a_restart() {
        let dir = temp_dir();
        fs::write(
            dir.join("settings.json"),
            json!({
                "schemaVersion": 2,
                "appearance": {"radius": 0.9, "density": "spacious"},
                "advanced": {"experimental": {"openVsx": true}}
            }).to_string(),
        ).unwrap();
        let store = SettingsStore::open(&dir);
        let raw = store.raw();
        assert_eq!(raw["appearance"]["radius"], 0.9);
        assert_eq!(raw["appearance"]["density"], "spacious");
        assert_eq!(raw["advanced"]["experimental"]["openVsx"], true);
        cleanup(&dir);
    }

    #[test]
    fn validation_rejects_wrong_types_and_bad_theme_css() {
        assert!(validate_patch(&json!({"general": {"hideSensitive": "yes"}})).is_err());
        assert!(validate_patch(&json!({"notifications": {"thresholds": [80, 101]}})).is_err());
        let mut theme = json!({"id": "custom", "label": "Custom", "appearance": "dark", "colors": {"canvas": "#000000"}});
        theme["css"] = json!("x".repeat(100_001));
        let patch = json!({"appearance": {"customThemes": {"custom": theme}}});
        assert_eq!(validate_patch(&patch).unwrap_err().field, "appearance.customThemes.custom.css");
        assert!(validate_patch(&json!({"appearance": {"customThemes": {"Bad Id": {"id": "Bad Id"}}}})).is_err());
    }

    #[test]
    fn deep_merge_objects_arrays_and_null() {
        let base = json!({"a": {"x": 1, "y": 2}, "b": [1, 2], "c": "keep", "d": 4});
        let patch = json!({"a": {"y": 3, "z": 4}, "b": [9], "c": null, "e": 5});
        assert_eq!(deep_merge(&base, &patch), json!({"a": {"x": 1, "y": 3, "z": 4}, "b": [9], "d": 4, "e": 5}));
    }

    #[test]
    fn null_is_stored_for_nullable_fields_and_deletes_map_entries() {
        let dir = temp_dir();
        let store = SettingsStore::open(&dir);
        // Choosing the stock theme must stick: the default dark theme must not come back.
        let next = store.patch(&json!({"appearance": {"darkThemeId": null}})).unwrap();
        assert!(next["appearance"]["darkThemeId"].is_null());
        let reopened = SettingsStore::open(&dir);
        assert!(reopened.raw()["appearance"]["darkThemeId"].is_null(), "null must survive a restart");
        // Map entries are still deleted by null.
        store.patch(&json!({"usage": {"usageModelAliases": {"m": "alias"}}})).unwrap();
        let after = store.patch(&json!({"usage": {"usageModelAliases": {"m": null}}})).unwrap();
        assert!(after["usageModelAliases"].get("m").is_none());
        cleanup(&dir);
    }

    #[test]
    fn patch_merges_validates_and_writes_atomically() {
        let dir = temp_dir();
        let store = SettingsStore::open(&dir);
        let next = store.patch(&json!({"appearance": {"radius": 0.75}, "usage": {"usageModelAliases": {"m": "alias"}}})).unwrap();
        assert_eq!(next["appearance"]["radius"], 0.75);
        assert_eq!(next["usagePriceOverrides"], json!({}));
        assert_eq!(next["usageModelAliases"]["m"], "alias");

        let on_disk: Value = serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(on_disk["schemaVersion"], 2);
        assert_eq!(on_disk["appearance"]["radius"], 0.75);
        assert!(on_disk.get("usageModelAliases").is_none(), "mirrors must not be persisted");
        assert!(!dir.join("settings.json.tmp").exists(), "tmp file must be renamed away");

        // A rejected patch leaves the file untouched. (radius 99 is tolerated now — it is ignored.)
        assert!(store.patch(&json!({"appearance": {"themeMode": "neon"}})).is_err());
        let after: Value = serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(after, on_disk);

        // The second successful write leaves a .bak of the previous version.
        store.patch(&json!({"shell": {"tray": false}})).unwrap();
        assert!(dir.join("settings.json.bak").exists());
        cleanup(&dir);
    }

    #[test]
    fn legacy_patch_maps_are_accepted() {
        let dir = temp_dir();
        let store = SettingsStore::open(&dir);
        let price = json!({"inputCostPerMillionTokens": 1.5, "outputCostPerMillionTokens": 2.5});
        let next = store.patch(&json!({"usagePriceOverrides": {"m": price.clone()}, "usageModelAliases": {"x": "y"}})).unwrap();
        assert_eq!(next["usage"]["usagePriceOverrides"]["m"], price);
        assert_eq!(next["usagePriceOverrides"], json!({"m": price}));
        assert_eq!(store.get().prices["m"][0], Some(1.5));
        assert_eq!(store.get().aliases["x"], "y");
        cleanup(&dir);
    }

    #[test]
    fn migrates_v1_file_to_v2() {
        let dir = temp_dir();
        fs::write(
            dir.join("settings.json"),
            json!({"usagePriceOverrides": {"m": {"inputCostPerMillionTokens": 3, "outputCostPerMillionTokens": 4}}, "usageModelAliases": {"a": "b"}}).to_string(),
        )
        .unwrap();
        let store = SettingsStore::open(&dir);
        let raw = store.raw();
        assert_eq!(raw["schemaVersion"], 2);
        assert_eq!(raw["usage"]["usagePriceOverrides"]["m"]["inputCostPerMillionTokens"], 3);
        assert_eq!(raw["usagePriceOverrides"]["m"]["outputCostPerMillionTokens"], 4);
        assert_eq!(raw["general"]["closeToTray"], true, "defaults filled on migration");
        assert_eq!(store.get().aliases["a"], "b");

        let persisted: Value = serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(persisted["schemaVersion"], 2, "migration was persisted");
        assert!(persisted.get("usagePriceOverrides").is_none());
        cleanup(&dir);
    }

    #[test]
    fn corrupt_file_is_moved_and_defaults_are_used() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        fs::write(&path, "{not valid json").unwrap();
        let store = SettingsStore::open(&dir);
        assert_eq!(store.raw()["schemaVersion"], 2);
        assert_eq!(store.raw()["advanced"]["logLevel"], "warn");
        assert!(!path.exists());
        let moved: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("settings.json.corrupt-"))
            .collect();
        assert_eq!(moved.len(), 1);
        assert_eq!(fs::read_to_string(moved[0].path()).unwrap(), "{not valid json");
        cleanup(&dir);
    }

    #[test]
    fn concurrent_patches_are_serialized() {
        let dir = temp_dir();
        let store = Arc::new(SettingsStore::open(&dir));
        let mut handles = Vec::new();
        for i in 0..12 {
            let store = Arc::clone(&store);
            handles.push(thread::spawn(move || {
                let mut experimental = Map::new();
                experimental.insert(format!("key{i}"), json!(true));
                let patch = json!({
                    "advanced": {"experimental": experimental},
                    "providers": {"order": [format!("p{i}")]}
                });
                store.patch(&patch).unwrap();
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        let raw = store.raw();
        let experimental = raw["advanced"]["experimental"].as_object().unwrap();
        for i in 0..12 {
            assert_eq!(experimental[&format!("key{i}")], true);
        }
        assert_eq!(raw["providers"]["order"].as_array().unwrap().len(), 1, "arrays replace");
        cleanup(&dir);
    }

    #[test]
    fn import_and_reset() {
        let dir = temp_dir();
        let store = SettingsStore::open(&dir);
        store.patch(&json!({"appearance": {"darkThemeId": "custom-dark"}})).unwrap();

        let imported = store.import(&json!({"schemaVersion": 2, "shell": {"tray": false}}), "merge").unwrap();
        assert_eq!(imported["appearance"]["darkThemeId"], "custom-dark", "merge keeps existing fields");
        assert_eq!(imported["shell"]["tray"], false);

        let replaced = store.import(&json!({"schemaVersion": 2, "general": {"language": "fr"}}), "replace").unwrap();
        assert_eq!(replaced["general"]["language"], "fr");
        assert_eq!(replaced["appearance"]["darkThemeId"], "burnrate-dark", "replace restores defaults for absent fields");

        assert!(store.import(&json!({}), "nonsense").is_err());
        assert_eq!(store.reset("section", Some("appearance")).unwrap()["appearance"]["darkThemeId"], "burnrate-dark");
        assert_eq!(store.reset("section", Some("appearance")).unwrap()["general"]["language"], "fr", "section reset leaves other sections untouched");
        assert!(store.reset("section", Some("bogus")).is_err());
        assert!(store.reset("section", None).is_err());
        let all = store.reset("all", None).unwrap();
        assert_eq!(all["general"]["language"], "system");
        assert_eq!(all["shell"]["tray"], true);
        cleanup(&dir);
    }

    #[test]
    fn local_sources_default_to_empty_lists_and_validate_folder_paths() {
        let d = default_settings();
        // Every supported agent id has an empty default list; the default is auto-discovery only.
        let sources = d["providers"]["sources"].as_object().unwrap();
        assert_eq!(sources.len(), crate::readers::sources::SOURCE_IDS.len());
        for id in crate::readers::sources::SOURCE_IDS {
            assert_eq!(sources[*id], json!([]), "an id the readers know must have a default");
        }
        assert!(crate::readers::sources::from_settings(&d).is_empty(), "default behaviour is auto-discovery only");
        let folder = std::env::temp_dir().join("custom-vibe").to_string_lossy().to_string();
        validate_patch(&json!({"providers": {"sources": {"vibe": [folder], "claude": []}}})).unwrap();
        validate_patch(&json!({"providers": {"sources": {"vibe": ["~/vibe-two"]}}})).unwrap();
        // A source id added later validates like the original two.
        let codex_folder = std::env::temp_dir().join("custom-codex").to_string_lossy().to_string();
        validate_patch(&json!({"providers": {"sources": {"codex": [codex_folder], "goose": ["~/goose-two"]}}})).unwrap();
        let cases = [
            (json!({"providers": {"sources": {"codex": ["relative/dir"]}}}), "providers.sources.codex[0]"),
            (json!({"providers": {"sources": {"vibe": ["relative/dir"]}}}), "providers.sources.vibe[0]"),
            (json!({"providers": {"sources": {"vibe": [""]}}}), "providers.sources.vibe[0]"),
            (json!({"providers": {"sources": {"vibe": [7]}}}), "providers.sources.vibe[0]"),
            (json!({"providers": {"sources": {"vibe": "oops"}}}), "providers.sources.vibe"),
            (json!({"providers": {"sources": {"nope": []}}}), "providers.sources.nope"),
            (json!({"providers": {"sources": "oops"}}), "providers.sources"),
        ];
        for (patch, field) in cases {
            assert_eq!(validate_patch(&patch).unwrap_err().field, field, "{patch}");
        }
        let too_many: Vec<String> = (0..21).map(|i| std::env::temp_dir().join(format!("d{i}")).to_string_lossy().to_string()).collect();
        assert_eq!(validate_patch(&json!({"providers": {"sources": {"claude": too_many}}})).unwrap_err().field, "providers.sources.claude");
    }

    #[test]
    fn a_saved_source_folder_survives_a_restart_and_is_replaced_not_merged() {
        let dir = temp_dir();
        let a = std::env::temp_dir().join("burnrate-src-a").to_string_lossy().to_string();
        let b = std::env::temp_dir().join("burnrate-src-b").to_string_lossy().to_string();
        let store = SettingsStore::open(&dir);
        store.patch(&json!({"providers": {"sources": {"vibe": [a.clone(), b.clone()]}}})).unwrap();
        // Removing one folder sends the shorter list: arrays replace, and the other agent's list is untouched.
        let next = store.patch(&json!({"providers": {"sources": {"vibe": [b.clone()]}}})).unwrap();
        assert_eq!(next["providers"]["sources"]["vibe"], json!([b.clone()]));
        assert_eq!(next["providers"]["sources"]["claude"], json!([]));
        assert_eq!(next["providers"]["sources"]["codex"], json!([]));
        let reopened = SettingsStore::open(&dir);
        let table = crate::readers::sources::from_settings(&reopened.raw());
        assert_eq!(table.get("vibe"), Some(&vec![std::path::PathBuf::from(&b)]));
        // A settings file written before this field existed loads with the empty default.
        let legacy = json!({"schemaVersion": 2, "providers": {"hidden": ["x"]}});
        let merged = deep_merge(&default_settings(), &legacy);
        let merged_sources = merged["providers"]["sources"].as_object().unwrap();
        assert_eq!(merged_sources.len(), crate::readers::sources::SOURCE_IDS.len());
        for id in crate::readers::sources::SOURCE_IDS {
            assert_eq!(merged_sources[*id], json!([]), "an old file gains every default id");
        }
        cleanup(&dir);
    }
}


