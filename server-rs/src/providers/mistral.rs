use super::*;

const BASE: &str = "https://api.mistral.ai/v1/billing";

fn read_one(name: &str, key: &str) -> Value {
    let head = json!({"id": name, "driver": "mistral", "label": name, "displayName": name});
    let get = |path: &str| agent().get(&format!("{BASE}/{path}")).set("Authorization", &format!("Bearer {key}")).set("Accept", "application/json").call();
    let budget = match get("budget") {
        Ok(res) => res,
        Err(ureq::Error::Status(code, _)) => return unavailable_account(head, format!("Mistral budget unavailable (HTTP {code}).")),
        Err(_) => return unavailable_account(head, "Mistral budget request failed.".into()),
    };
    let body: Value = budget.into_json().unwrap_or(Value::Null);
    let vb = body.get("vibe_budget");
    let pct = vb.and_then(|v| v.get("usage_percentage")).and_then(|p| p.as_f64().or_else(|| p.as_str().and_then(|s| s.parse().ok())));
    let (Some(vb), Some(pct)) = (vb, pct.filter(|p| p.is_finite())) else {
        return unavailable_account(head, "Mistral budget unavailable (HTTP 200).".into());
    };
    let plan = get("subscription").ok().and_then(|r| r.into_json::<Value>().ok()).and_then(|v| v.get("plan_name").and_then(Value::as_str).map(str::to_string));
    let resets = vb.get("reset_at").and_then(Value::as_str).and_then(crate::types::parse_rfc3339_ms).and_then(iso_ms);
    let mut head = head;
    if let Some(p) = plan.filter(|p| !p.is_empty()) {
        let mut chars = p.chars();
        let first = chars.next().map(|c| c.to_uppercase().to_string()).unwrap_or_default();
        head["plan"] = json!(format!("{first}{}", chars.as_str().to_lowercase()));
    }
    account_with(head, vec![Window::new("vibe-monthly", "monthly", "Monthly", pct).resets(resets)])
}

pub struct Mistral;

impl Provider for Mistral {
    fn id(&self) -> &'static str {
        "mistral"
    }
    fn label(&self) -> &'static str {
        "Mistral"
    }
    fn color(&self) -> &'static str {
        "#fa520f"
    }
    fn auth(&self) -> Auth {
        Auth::ApiKey
    }
    fn read(&self, keys: &KeyStore) -> Vec<Value> {
        keys.list("mistral").iter().map(|(n, k)| read_one(n, k)).collect()
    }
}
