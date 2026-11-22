//! History routes (docs/CONTRACTS.md section 9).
//! `GET /api/history` -> `{ series: [{ accountId, windowId, points: [[tsMs, usedPercent], ...] }] }`
//! `DELETE /api/history` clears the store.

use super::Resp;
use crate::history::{self, Query};
use crate::{json_response, query, State};
use serde_json::{json, Value};
use tiny_http::{Method, Request};

pub fn handle(state: &State, request: &mut Request, method: &Method, path: &str) -> Option<Resp> {
    if path != "/api/history" {
        return None;
    }
    match method {
        Method::Get => {
            let q = query(request.url());
            let since_ms = q.get("since").and_then(|s| parse_iso(s)).unwrap_or(i64::MIN);
            let until_ms = q.get("until").and_then(|s| parse_iso(s)).unwrap_or_else(now_ms);
            let step_secs = q
                .get("step")
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(300)
                .clamp(1, 86_400);
            let query = Query {
                since_ms,
                until_ms,
                account: q.get("account").filter(|s| !s.is_empty()).cloned(),
                window: q.get("window").filter(|s| !s.is_empty()).cloned(),
                step_secs,
            };
            let series: Vec<Value> = history::read(state, &query)
                .into_iter()
                .map(|s| {
                    let points: Vec<Value> = s.points.into_iter().map(|(ts, value)| json!([ts, value])).collect();
                    json!({"accountId": s.account_id, "windowId": s.window_id, "points": points})
                })
                .collect();
            Some(json_response(200, &json!({"series": series})))
        }
        Method::Delete => {
            history::clear();
            Some(json_response(200, &json!({"ok": true})))
        }
        _ => None,
    }
}

/// Accepts RFC 3339 timestamps and bare `YYYY-MM-DD` days.
fn parse_iso(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(dt.timestamp_millis());
    }
    if value.len() == 10 && value.as_bytes().get(4) == Some(&b'-') && value.as_bytes().get(7) == Some(&b'-') {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&format!("{}T00:00:00Z", value)) {
            return Some(dt.timestamp_millis());
        }
    }
    None
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso_and_day_inputs() {
        assert_eq!(parse_iso(""), None);
        assert_eq!(parse_iso("not-a-date"), None);
        assert_eq!(parse_iso("2024-01-02T03:04:05Z"), Some(1704164645000));
        assert_eq!(parse_iso("2024-01-02"), Some(1704153600000));
        assert_eq!(parse_iso(" 2024-01-02T03:04:05+00:00 "), Some(1704164645000));
    }
}
