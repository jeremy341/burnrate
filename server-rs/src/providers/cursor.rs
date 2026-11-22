use super::*;

const ENDPOINT: &str = "https://api2.cursor.sh";

pub fn usage_to_windows(response: &Value) -> Vec<Window> {
    let number = |k: &str| response.get(k).and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
    let end = number("billingCycleEnd").unwrap_or(0.0);
    let start = number("billingCycleStart").unwrap_or(0.0);
    let resets_at = (end > 0.0).then(|| iso_ms(end)).flatten();
    let mins = if resets_at.is_some() && start > 0.0 { ((end - start) / 60_000.0).round() } else { 0.0 };
    let mut windows = Vec::new();
    for (id, label) in [("totalPercentUsed", "Overall"), ("autoPercentUsed", "Cursor Models"), ("apiPercentUsed", "Other Models")] {
        let Some(used) = response.pointer(&format!("/planUsage/{id}")).and_then(Value::as_f64).filter(|u| u.is_finite()) else { continue };
        // Cursor's dashboard billing endpoint is documented: `official`.
        windows.push(Window::new(id, "monthly", label, used).provenance("official").resets(resets_at.clone()).mins((mins > 0.0).then_some(mins)));
    }
    windows
}

fn read_one(name: &str, api_key: &str) -> Value {
    let head = json!({"id": name, "driver": "cursor", "label": name, "displayName": name});
    let fail = |m: String| unavailable_account(head.clone(), format!("Cursor usage unavailable ({m})."));
    // Trade the user's API key for the access token Cursor's dashboard RPC accepts.
    let exchange = agent().post(&format!("{ENDPOINT}/auth/exchange_user_api_key")).set("Authorization", &format!("Bearer {api_key}")).send_json(json!({}));
    let token = match exchange {
        Ok(res) => res.into_json::<Value>().ok().and_then(|v| v.get("accessToken").and_then(Value::as_str).map(str::to_string)),
        Err(ureq::Error::Status(401 | 403, _)) => return unavailable_account(head.clone(), login_expired_message("Cursor")),
        Err(ureq::Error::Status(code, _)) => return fail(format!("HTTP {code}")),
        Err(_) => return fail("error".into()),
    };
    let Some(token) = token else { return fail("no token".into()) };
    let res = agent()
        .post(&format!("{ENDPOINT}/aiserver.v1.DashboardService/GetCurrentPeriodUsage"))
        .set("Authorization", &format!("Bearer {token}"))
        .set("connect-protocol-version", "1")
        .set("x-cursor-client-type", "cli")
        .send_json(json!({}));
    match res {
        Ok(res) => match res.into_json::<Value>() {
            Ok(body) => {
                let windows = usage_to_windows(&body);
                if windows.is_empty() {
                    let mut a = head.clone();
                    a["limits"] = json!({"checkedAt": iso_now(), "windows": [], "unavailable": {"reason": "unsupported"}});
                    a
                } else {
                    account_with(head.clone(), windows)
                }
            }
            Err(e) => fail(e.to_string()),
        },
        Err(ureq::Error::Status(code, _)) => fail(format!("HTTP {code}")),
        Err(_) => fail("error".into()),
    }
}

pub struct Cursor;

impl Provider for Cursor {
    fn id(&self) -> &'static str {
        "cursor"
    }
    fn label(&self) -> &'static str {
        "Cursor"
    }
    fn color(&self) -> &'static str {
        "#8b8b8b"
    }
    fn auth(&self) -> Auth {
        Auth::ApiKey
    }
    // Cursor is an agent you use, but Burnrate reads its limits with an API key (no local login to detect).
    fn category(&self) -> Category {
        Category::Agent
    }
    fn key_url(&self) -> Option<String> {
        Some("https://cursor.com/dashboard?tab=integrations".into())
    }
    fn hint(&self) -> &'static str {
        "Paste a Cursor API key"
    }
    fn read(&self, keys: &KeyStore) -> Vec<Value> {
        keys.list("cursor").iter().map(|(n, k)| read_one(n, k)).collect()
    }
    fn test_key(&self, key: &str) -> Result<(), String> {
        // The exchange endpoint is Cursor's real key check; it never stores or logs the key.
        // A 200 without an accessToken cannot drive `read_one`, so it is not a passing test.
        let response = match agent()
            .post(&format!("{ENDPOINT}/auth/exchange_user_api_key"))
            .set("Authorization", &format!("Bearer {key}"))
            .send_json(json!({}))
        {
            Ok(response) => response,
            Err(ureq::Error::Status(code, _)) => return Err(test_status_error(code)),
            Err(_) => return Err("Could not reach the provider".into()),
        };
        match response.into_json::<Value>() {
            Ok(body) if body.get("accessToken").and_then(Value::as_str).is_some_and(|t| !t.trim().is_empty()) => Ok(()),
            Ok(_) => Err("Could not read the provider's limits".into()),
            Err(_) => Err("Could not reach the provider".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cursor_windows_are_labelled_official() {
        let body = json!({"billingCycleStart": 1782000000000.0, "billingCycleEnd": 1784589600000.0, "planUsage": {"totalPercentUsed": 20.0}});
        let windows = usage_to_windows(&body);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].provenance, Some("official"));
        assert!(windows[0].resets_at.is_some());
    }
}
