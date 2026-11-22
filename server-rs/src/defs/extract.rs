//! JSONPath extraction, value coercion, the closed transform set and timestamp normalisation.
use super::model::ResetsFormat;
use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::Value;
use serde_json_path::JsonPath;

/// Prefix a JSONPath with `sum:` to aggregate every numeric match instead of taking the first.
/// This lets a definition total arrays (line items, results) without scripting.
const SUM_PREFIX: &str = "sum:";

fn aggregate_path(spec: &str) -> Option<&str> {
    spec.trim().strip_prefix(SUM_PREFIX).map(str::trim)
}

/// True when a spec is a JSONPath expression (optionally `sum:`-prefixed) rather than a literal.
pub fn is_json_path(spec: &str) -> bool {
    let spec = spec.trim();
    aggregate_path(spec).is_some_and(|p| p.starts_with('$')) || spec.starts_with('$')
}

pub fn valid_json_path(spec: &str) -> bool {
    let spec = spec.trim();
    JsonPath::parse(aggregate_path(spec).unwrap_or(spec)).is_ok()
}

/// Numbers may arrive as strings (`"110.00"`). Anything non-finite is rejected, never read as 0.
pub fn parse_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => {
            let f = n.as_f64()?;
            f.is_finite().then_some(f)
        }
        Value::String(s) => {
            let f = s.trim().parse::<f64>().ok()?;
            f.is_finite().then_some(f)
        }
        _ => None,
    }
}

/// Extract the raw value a spec points at (a clone, so callers can inspect null vs missing).
/// A `sum:` prefix sums every numeric JSONPath match; with no prefix the first match is used.
pub fn extract_raw(spec: &str, data: &Value) -> Option<Value> {
    let spec = spec.trim();
    if let Some(path) = aggregate_path(spec) {
        let nodes = JsonPath::parse(path).ok()?.query(data);
        let mut total = 0.0;
        let mut found = false;
        for node in nodes {
            if let Some(number) = parse_number(node) {
                total += number;
                found = true;
            }
        }
        return (found && total.is_finite()).then(|| Value::from(total));
    }
    if spec.starts_with('$') {
        JsonPath::parse(spec).ok()?.query(data).first().cloned()
    } else {
        let f: f64 = spec.parse().ok()?;
        f.is_finite().then(|| Value::from(f))
    }
}

pub fn extract_number(spec: &str, data: &Value) -> Option<f64> {
    parse_number(&extract_raw(spec, data)?)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Transform {
    Multiply(f64),
    Divide(f64),
    Add(f64),
    Min(f64),
    Max(f64),
    Clamp(f64, f64),
    Invert,
    Round(u32),
}

/// Parses one transform from the closed set. `None` means "not a recognised transform".
pub fn parse_transform(s: &str) -> Option<Transform> {
    let s = s.trim();
    if s == "invert" {
        return Some(Transform::Invert);
    }
    let (name, args) = s.split_once(':')?;
    let nums: Vec<f64> = args.split(':').map(|p| p.trim().parse::<f64>().ok()).collect::<Option<Vec<_>>>()?;
    if nums.iter().any(|n| !n.is_finite()) {
        return None;
    }
    match name {
        "multiply" if nums.len() == 1 => Some(Transform::Multiply(nums[0])),
        "divide" if nums.len() == 1 && nums[0] != 0.0 => Some(Transform::Divide(nums[0])),
        "add" if nums.len() == 1 => Some(Transform::Add(nums[0])),
        "min" if nums.len() == 1 => Some(Transform::Min(nums[0])),
        "max" if nums.len() == 1 => Some(Transform::Max(nums[0])),
        "clamp" if nums.len() == 2 && nums[0] <= nums[1] => Some(Transform::Clamp(nums[0], nums[1])),
        "round" if nums.len() == 1 && nums[0] >= 0.0 && nums[0] <= 12.0 && nums[0].fract() == 0.0 => Some(Transform::Round(nums[0] as u32)),
        _ => None,
    }
}

/// Applies transforms in order. A bad transform or a non-finite intermediate rejects the value.
pub fn apply_transforms(value: f64, transforms: &[String]) -> Option<f64> {
    let mut n = value;
    if !n.is_finite() {
        return None;
    }
    for t in transforms {
        n = match parse_transform(t)? {
            Transform::Multiply(k) => n * k,
            Transform::Divide(k) => n / k,
            Transform::Add(k) => n + k,
            Transform::Min(k) => n.min(k),
            Transform::Max(k) => n.max(k),
            Transform::Clamp(a, b) => n.clamp(a, b),
            Transform::Invert => 100.0 - n,
            Transform::Round(p) => {
                let scale = 10f64.powi(p as i32);
                (n * scale).round() / scale
            }
        };
        if !n.is_finite() {
            return None;
        }
    }
    Some(n)
}

/// Normalises an extracted reset value to an RFC 3339 timestamp.
pub fn reset_time(raw: Option<Value>, format: Option<ResetsFormat>, now_ms: i64) -> Option<String> {
    let raw = raw?;
    let ms = match format.unwrap_or(ResetsFormat::Iso8601) {
        ResetsFormat::Iso8601 => {
            let text = raw.as_str()?.trim();
            crate::types::parse_rfc3339_ms(text)? as i64
        }
        ResetsFormat::UnixS => {
            let secs = parse_number(&raw)?;
            Utc.timestamp_opt(secs as i64, 0).single()?.timestamp_millis()
        }
        ResetsFormat::UnixMs => parse_number(&raw)? as i64,
        ResetsFormat::SecondsFromNow => now_ms + (parse_number(&raw)? * 1000.0) as i64,
    };
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_paths_and_literals() {
        let data = json!({"data": {"usage": "12.5", "limit": 50, "nil": null}});
        assert_eq!(extract_number("$.data.usage", &data), Some(12.5));
        assert_eq!(extract_number("$.data.limit", &data), Some(50.0));
        assert_eq!(extract_number("7.25", &data), Some(7.25));
        assert_eq!(extract_number("$.data.nil", &data), None);
        assert_eq!(extract_number("$.data.missing", &data), None);
    }

    #[test]
    fn sum_prefix_aggregates_arrays_and_lints() {
        let data = json!({"data": [{"amount": "10"}, {"amount": 5}, {"amount": "bad"}, {"amount": 2.5}]});
        assert_eq!(extract_number("sum:$.data[*].amount", &data), Some(17.5));
        // Without the prefix the old first-match behaviour is unchanged.
        assert_eq!(extract_number("$.data[*].amount", &data), Some(10.0));
        assert_eq!(extract_number("sum:$.data[*].missing", &data), None);
        assert!(is_json_path("sum:$.data[*].amount"));
        assert!(valid_json_path("sum:$.data[*].amount"));
        assert!(!valid_json_path("sum:$..["));
    }

    #[test]
    fn rejects_non_finite_numbers() {
        assert_eq!(parse_number(&json!("NaN")), None);
        assert_eq!(parse_number(&json!("inf")), None);
        assert_eq!(parse_number(&json!({"n": 1})), None);
    }

    #[test]
    fn transform_edge_cases() {
        assert_eq!(apply_transforms(25.0, &["multiply:0.01".into()]), Some(0.25));
        assert_eq!(apply_transforms(101.0, &["clamp:0:100".into()]), Some(100.0));
        assert_eq!(apply_transforms(-5.0, &["clamp:0:100".into()]), Some(0.0));
        assert_eq!(apply_transforms(30.0, &["invert".into()]), Some(70.0));
        assert_eq!(apply_transforms(1.23456, &["round:2".into()]), Some(1.23));
        assert_eq!(apply_transforms(10.0, &["divide:0".into()]), None);
        assert_eq!(apply_transforms(10.0, &["nonsense:1".into()]), None);
        assert_eq!(apply_transforms(10.0, &["add:abc".into()]), None);
        assert_eq!(apply_transforms(1e308, &["multiply:10".into()]), None);
    }

    #[test]
    fn reset_formats() {
        assert_eq!(reset_time(Some(json!("2026-01-02T03:04:05Z")), None, 0).is_some(), true);
        assert_eq!(reset_time(Some(json!(1_700_000_000)), Some(ResetsFormat::UnixS), 0).is_some(), true);
        assert_eq!(reset_time(Some(json!(1_700_000_000_000i64)), Some(ResetsFormat::UnixMs), 0).is_some(), true);
        assert_eq!(reset_time(Some(json!(600)), Some(ResetsFormat::SecondsFromNow), 1_000_000).is_some(), true);
        assert_eq!(reset_time(None, None, 0), None);
    }
}
