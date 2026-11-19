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
        windows.push(Window::new(id, "monthly", label, used).resets(resets_at.clone()).mins((mins > 0.0).then_some(mins)));
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
    fn read(&self, keys: &KeyStore) -> Vec<Value> {
        keys.list("cursor").iter().map(|(n, k)| read_one(n, k)).collect()
    }
}
