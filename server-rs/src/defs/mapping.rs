//! Pure response -> window/balance mapping. No I/O here; fixtures exercise this directly.
use super::extract::{apply_transforms, extract_number, extract_raw, reset_time};
use super::model::{CurrencySpec, Definition, Provenance};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug, Default, Clone)]
pub struct Mapped {
    pub windows: Vec<Value>,
    pub balances: Vec<Value>,
}

fn provenance(p: Option<Provenance>) -> &'static str {
    p.unwrap_or(Provenance::Official).as_str()
}

/// Maps the recorded responses (keyed by request id) onto the UI's `UsageWindow` / `UsageBalance`
/// shapes. Null/missing `skip_if_null` fields and non-finite numbers simply drop the item: an empty
/// result is legitimate (e.g. a key without a cap), not a probe failure.
pub fn map_responses(def: &Definition, responses: &HashMap<String, Value>, now_ms: i64) -> Mapped {
    let mut out = Mapped::default();

    for w in &def.window {
        let Some(data) = responses.get(&w.from) else { continue };

        let skipped = w.skip_if_null.iter().any(|field| {
            let spec = match field.as_str() {
                "used_percent" => w.used_percent.as_ref(),
                "used" => w.used.as_ref(),
                "remaining" => w.remaining.as_ref(),
                "limit" => w.limit.as_ref(),
                "resets_at" => w.resets_at.as_ref(),
                _ => None,
            };
            match spec {
                None => true,
                Some(spec) => match extract_raw(spec, data) {
                    None => true,
                    Some(Value::Null) => true,
                    Some(_) => false,
                },
            }
        });
        if skipped {
            continue;
        }

        let pct = if let Some(spec) = &w.used_percent {
            extract_number(spec, data)
        } else if let (Some(used), Some(limit)) = (&w.used, &w.limit) {
            match (extract_number(used, data), extract_number(limit, data)) {
                (Some(u), Some(l)) if l != 0.0 => Some(u / l * 100.0),
                _ => None,
            }
        } else if let (Some(remaining), Some(limit)) = (&w.remaining, &w.limit) {
            match (extract_number(remaining, data), extract_number(limit, data)) {
                (Some(r), Some(l)) if l != 0.0 => Some((l - r) / l * 100.0),
                _ => None,
            }
        } else {
            None
        };
        let Some(pct) = pct.and_then(|p| apply_transforms(p, &w.transform)) else { continue };
        let pct = pct.clamp(0.0, 100.0);

        let resets_at = w
            .resets_at
            .as_ref()
            .and_then(|spec| extract_raw(spec, data))
            .and_then(|raw| reset_time(Some(raw), w.resets_at_format, now_ms));

        let mut window = json!({
            "id": w.id,
            "kind": w.kind.as_str(),
            "label": w.label,
            "usedPercent": pct,
            "provenance": provenance(w.provenance),
        });
        let obj = window.as_object_mut().unwrap();
        if let Some(at) = resets_at {
            obj.insert("resetsAt".into(), json!(at));
        }
        if let Some(mins) = w.window_minutes.filter(|m| m.is_finite() && *m >= 0.0) {
            // Both spellings are emitted: the limits report uses windowDurationMins while the
            // compact status contract (section 8) calls it windowMinutes.
            obj.insert("windowDurationMins".into(), json!(mins));
            obj.insert("windowMinutes".into(), json!(mins));
        }
        out.windows.push(window);
    }

    for b in &def.balance {
        let Some(data) = responses.get(&b.from) else { continue };
        let Some(raw_amount) = b.amount.as_ref().and_then(|spec| extract_number(spec, data)) else { continue };
        let Some(amount) = apply_transforms(raw_amount, &b.transform) else { continue };

        let currency = match &b.currency {
            Some(CurrencySpec::Literal(s)) => s.clone(),
            Some(CurrencySpec::Path { path }) => extract_raw(path, data)
                .and_then(|v| match v {
                    Value::String(s) => Some(s),
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                })
                .unwrap_or_else(|| "USD".into()),
            None => "USD".into(),
        };

        let mut balance = json!({
            "id": b.id,
            "label": b.label,
            "kind": b.kind.as_str(),
            "amount": amount,
            "currency": currency,
            "provenance": provenance(b.provenance),
        });
        if let Some(limit) = b.limit.as_ref().and_then(|spec| extract_number(spec, data)) {
            balance.as_object_mut().unwrap().insert("limit".into(), json!(limit));
        }
        out.balances.push(balance);
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn def(extra: &str) -> Definition {
        Definition::parse(&format!(
            r#"
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
[[window]]
id = "w"
kind = "monthly"
label = "Month"
from = "r"
used = "$.used"
limit = "$.limit"
{extra}
[[balance]]
id = "credits"
label = "Credits"
kind = "credit"
from = "r"
amount = "$.credits"
currency = {{ path = "$.currency" }}
"#
        ))
        .unwrap()
    }

    fn responses() -> HashMap<String, Value> {
        let mut m = HashMap::new();
        m.insert("r".into(), json!({"used": 25.0, "limit": 100.0, "credits": "12.50", "currency": "EUR"}));
        m
    }

    #[test]
    fn maps_used_and_limit() {
        let mapped = map_responses(&def(""), &responses(), 0);
        assert_eq!(mapped.windows[0]["usedPercent"], json!(25.0));
        assert_eq!(mapped.balances[0]["amount"], json!(12.5));
        assert_eq!(mapped.balances[0]["currency"], json!("EUR"));
        assert_eq!(mapped.windows[0]["provenance"], json!("official"));
    }

    #[test]
    fn maps_remaining_and_percent_and_transforms() {
        let d = def("transform = [\"multiply:2\"]");
        let mapped = map_responses(&d, &responses(), 0);
        assert_eq!(mapped.windows[0]["usedPercent"], json!(50.0));
    }

    #[test]
    fn skip_if_null_drops_window() {
        let d = def("skip_if_null = [\"limit\"]");
        let mut r = responses();
        r.insert("r".into(), json!({"used": 25.0, "limit": null}));
        assert!(map_responses(&d, &r, 0).windows.is_empty());
    }

    #[test]
    fn negative_and_huge_values_are_clamped() {
        let mut r = responses();
        r.insert("r".into(), json!({"used": -10.0, "limit": 100.0, "credits": 1e12}));
        let mapped = map_responses(&def(""), &r, 0);
        assert_eq!(mapped.windows[0]["usedPercent"], json!(0.0));
    }
}
