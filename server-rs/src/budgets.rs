//! Monthly budgets measured from locally recorded spend (docs/CONTRACTS.md section 5).
//!
//! A budget is stored in `<data>/budgets.json` and appears in the limits report as a normal
//! `LimitsAccount` (`budget-<id>`, driver `budget`). The money comes from the engine's own
//! cost records: there is no network call and no provider secret involved.

use crate::engine::{Engine, SummaryInput};
use crate::settings::Settings;
use crate::State;
use chrono::{Datelike, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Which local usage counts towards a budget. Empty lists mean "everything".
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Matcher {
    /// Exact provider ids (`claude`, `codex`, a definition id, ...).
    pub providers: Vec<String>,
    /// Model-name prefixes (`claude-3`, `gpt-4o`, ...).
    pub models: Vec<String>,
}

impl Matcher {
    pub fn matches(&self, provider: &str, model: &str) -> bool {
        (self.providers.is_empty() || self.providers.iter().any(|p| p == provider))
            && (self.models.is_empty() || self.models.iter().any(|m| model.starts_with(m)))
    }
}

/// One user-defined monthly budget. Field names are the wire/storage names.
#[derive(Clone, Debug, PartialEq)]
pub struct Budget {
    pub id: String,
    pub label: String,
    /// Major units (dollars, euros, ...); spend is measured in the same unit by the engine.
    pub monthly_budget: f64,
    pub currency: String,
    /// Day of month on which the budget resets. 1..=28 so every month has that day.
    pub reset_day: u8,
    pub matcher: Matcher,
    pub color: Option<String>,
}

impl Budget {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "id": self.id,
            "label": self.label,
            "monthlyBudget": self.monthly_budget,
            "currency": self.currency,
            "resetDay": self.reset_day,
            "match": {
                "providers": self.matcher.providers,
                "models": self.matcher.models,
            },
        });
        if let Some(color) = &self.color {
            v.as_object_mut().unwrap().insert("color".into(), json!(color));
        }
        v
    }
}

#[derive(Debug)]
pub struct InvalidBudget {
    pub field: String,
}

fn invalid(field: &str) -> InvalidBudget {
    InvalidBudget { field: field.to_string() }
}

fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn valid_color(s: &str) -> bool {
    match s.strip_prefix('#') {
        Some(hex) => matches!(hex.len(), 3 | 6 | 8) && hex.bytes().all(|c| c.is_ascii_hexdigit()),
        None => false,
    }
}

fn string_list(value: Option<&Value>, field: &str) -> Result<Vec<String>, InvalidBudget> {
    let Some(value) = value else { return Ok(Vec::new()) };
    let Some(array) = value.as_array() else { return Err(invalid(field)) };
    let mut out: Vec<String> = Vec::with_capacity(array.len());
    for item in array {
        let Some(text) = item.as_str() else { return Err(invalid(field)) };
        let text = text.trim();
        if text.is_empty() || text.len() > 200 || out.iter().any(|s| s == text) {
            return Err(invalid(field));
        }
        out.push(text.to_string());
    }
    Ok(out)
}

/// Parse and validate a budget. `path_id` is the id from `/api/budgets/<id>`; when present the
/// body may omit `id`, but a mismatching body id is rejected.
pub fn parse_budget(value: &Value, path_id: Option<&str>) -> Result<Budget, InvalidBudget> {
    let obj = value.as_object().ok_or_else(|| invalid("budget"))?;
    let body_id = obj.get("id").and_then(Value::as_str);
    let id = match (path_id, body_id) {
        (Some(path), Some(body)) if path != body => return Err(invalid("id")),
        (Some(path), _) => path,
        (None, Some(body)) => body,
        (None, None) => return Err(invalid("id")),
    }
    .trim()
    .to_string();
    if !valid_id(&id) {
        return Err(invalid("id"));
    }
    let label = obj.get("label").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if label.is_empty() || label.chars().count() > 120 {
        return Err(invalid("label"));
    }
    let monthly_budget = obj.get("monthlyBudget").and_then(Value::as_f64).unwrap_or(f64::NAN);
    if !monthly_budget.is_finite() || monthly_budget <= 0.0 || monthly_budget > 1e12 {
        return Err(invalid("monthlyBudget"));
    }
    // Spend comes from the engine's USD costUsd buckets. The engine is FX-free, so a budget in
    // any other unit would divide a USD amount by a limit in a different currency.
    let currency = obj.get("currency").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if !currency.eq_ignore_ascii_case("USD") {
        return Err(invalid("currency"));
    }
    let currency = "USD".to_string();
    let reset_day = obj.get("resetDay").and_then(Value::as_f64).unwrap_or(f64::NAN);
    if !reset_day.is_finite() || reset_day.fract() != 0.0 || !(1.0..=28.0).contains(&reset_day) {
        return Err(invalid("resetDay"));
    }
    let match_obj = obj.get("match").and_then(Value::as_object).ok_or_else(|| invalid("match"))?;
    let matcher = Matcher {
        providers: string_list(match_obj.get("providers"), "match.providers")?,
        models: string_list(match_obj.get("models"), "match.models")?,
    };
    let color = match obj.get("color") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.trim().is_empty() => None,
        Some(Value::String(s)) if valid_color(s.trim()) => Some(s.trim().to_string()),
        _ => return Err(invalid("color")),
    };
    Ok(Budget { id, label, monthly_budget, currency, reset_day: reset_day as u8, matcher, color })

}

// ---- Storage ---------------------------------------------------------------------------------

fn quarantine(path: &Path) {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let _ = fs::rename(path, path.with_extension(format!("json.corrupt-{ts}")));
}

struct BudgetFile {
    path: PathBuf,
    budgets: Vec<Budget>,
}

impl BudgetFile {
    fn open(path: PathBuf) -> BudgetFile {
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return BudgetFile { path, budgets: Vec::new() },
            Err(_) => {
                quarantine(&path);
                return BudgetFile { path, budgets: Vec::new() };
            }
        };
        let parsed = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| match v { Value::Array(items) => Some(items), _ => None })
            .and_then(|items| items.iter().map(|item| parse_budget(item, None)).collect::<Result<Vec<_>, _>>().ok());
        match parsed {
            Some(budgets) => BudgetFile { path, budgets },
            None => {
                // Never silently reset a broken file: keep it for inspection and start empty.
                quarantine(&path);
                BudgetFile { path, budgets: Vec::new() }
            }
        }
    }

    fn save(&self) -> Result<(), String> {
        let list = Value::Array(self.budgets.iter().map(Budget::to_json).collect());
        let bytes = serde_json::to_vec_pretty(&list).map_err(|e| e.to_string())?;
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        if self.path.exists() {
            let _ = fs::copy(&self.path, self.path.with_extension("json.bak"));
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }

    fn put(&mut self, budget: Budget) -> Result<Budget, String> {
        self.budgets.retain(|existing| existing.id != budget.id);
        self.budgets.push(budget.clone());
        self.budgets.sort_by(|a, b| a.id.cmp(&b.id));
        self.save()?;
        Ok(budget)
    }

    fn delete(&mut self, id: &str) -> Result<bool, String> {
        let before = self.budgets.len();
        self.budgets.retain(|b| b.id != id);
        if self.budgets.len() == before {
            return Ok(false);
        }
        self.save()?;
        Ok(true)
    }
}

static FILE: OnceLock<Mutex<BudgetFile>> = OnceLock::new();

pub(crate) fn data_dir() -> PathBuf {
    if let Some(dir) = crate::readers::env_path("BURNRATE_DATA") {
        return dir;
    }
    // Same default as `run()` in lib.rs: `<project>/data`.
    crate::find_web_dir()
        .parent()
        .and_then(Path::parent)
        .map_or_else(|| PathBuf::from("data"), |root| root.join("data"))
}

fn file() -> &'static Mutex<BudgetFile> {
    FILE.get_or_init(|| Mutex::new(BudgetFile::open(data_dir().join("budgets.json"))))
}

fn lock_file() -> std::sync::MutexGuard<'static, BudgetFile> {
    file().lock().unwrap_or_else(|e| e.into_inner())
}

pub fn list() -> Vec<Budget> {
    lock_file().budgets.clone()
}

pub fn list_json() -> Value {
    Value::Array(list().iter().map(Budget::to_json).collect())
}

pub fn put(budget: Budget) -> Result<Budget, String> {
    lock_file().put(budget)
}

pub fn delete(id: &str) -> Result<bool, String> {
    lock_file().delete(id)
}

// ---- Time window -----------------------------------------------------------------------------

/// The two local-time boundaries of the monthly cycle containing `now_ms`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cycle {
    /// Inclusive start of the cycle, epoch ms.
    pub start_ms: i64,
    /// Exclusive end (the next reset), epoch ms.
    pub next_reset_ms: i64,
}

/// Some zones shift at midnight; walk forward to the first real instant of that day.
fn midnight(tz: &Tz, year: i32, month: u32, day: u32) -> i64 {
    for hour in [0, 1, 2, 6, 12] {
        if let Some(at) = tz.with_ymd_and_hms(year, month, day, hour, 0, 0).single() {
            return at.timestamp_millis();
        }
    }
    Utc.with_ymd_and_hms(year, month, day, 0, 0, 0).single().map_or(0, |at| at.timestamp_millis())
}

fn previous_month(year: i32, month: u32) -> (i32, u32) {
    if month == 1 { (year - 1, 12) } else { (year, month - 1) }
}

pub fn cycle(now_ms: i64, reset_day: u8, tz: Tz) -> Cycle {
    let local = tz.timestamp_millis_opt(now_ms).single().unwrap_or_else(|| {
        let utc = Utc.timestamp_millis_opt(now_ms).single().unwrap_or_else(Utc::now);
        tz.from_utc_datetime(&utc.naive_utc())
    });
    let day = reset_day.clamp(1, 28) as u32;
    // `local.day() >= day` means this month's reset already happened (or is happening now).
    let (year, month) = (local.year(), local.month());
    let (next_year, next_month) = if local.day() >= day {
        if month == 12 { (year + 1, 1) } else { (year, month + 1) }
    } else {
        (year, month)
    };
    let next_reset_ms = midnight(&tz, next_year, next_month, day);
    let (start_year, start_month) = previous_month(next_year, next_month);
    Cycle { start_ms: midnight(&tz, start_year, start_month, day), next_reset_ms }
}

/// Usage percentage of a spend against its budget, clamped to 0..100.
pub fn used_percent(spend: f64, monthly_budget: f64) -> f64 {
    if !monthly_budget.is_finite() || monthly_budget <= 0.0 {
        return 0.0;
    }
    let pct = spend / monthly_budget * 100.0;
    if !pct.is_finite() {
        0.0
    } else {
        pct.clamp(0.0, 100.0)
    }
}

fn local_fmt(tz: &Tz, ms: i64, format: &str) -> String {
    tz.timestamp_millis_opt(ms).single().map_or_else(String::new, |at| at.format(format).to_string())
}

/// Sum the cost of engine summary buckets matching a budget. Pure so it can be tested with a
/// hand-written summary. Hour bounds are `YYYY-MM-DDTHH:00` strings in the summary's time zone.
pub fn sum_costs(summary: &Value, matcher: &Matcher, since_hour: Option<&str>, until_hour: Option<&str>) -> f64 {
    let Some(buckets) = summary.get("buckets").and_then(Value::as_array) else { return 0.0 };
    let mut total = 0.0;
    for bucket in buckets {
        let provider = bucket.get("provider").and_then(Value::as_str).unwrap_or("");
        let model = bucket.get("model").and_then(Value::as_str).unwrap_or("");
        if !matcher.matches(provider, model) {
            continue;
        }
        let hour = bucket.get("hourStart").and_then(Value::as_str);
        if let (Some(h), Some(value)) = (since_hour, hour) {
            if value < h {
                continue;
            }
        }
        if let (Some(h), Some(value)) = (until_hour, hour) {
            if value > h {
                continue;
            }
        }
        if let Some(cost) = bucket.get("costUsd").and_then(Value::as_f64) {
            if cost.is_finite() {
                total += cost;
            }
        }
    }
    if total.is_finite() { total.max(0.0) } else { 0.0 }
}

/// Local cost reader over the engine's public `summary` API. `Engine`/`Engine::summary` are not
/// modified: the hourly buckets it already produces are filtered and summed here.
pub struct CostReader<'a> {
    engine: &'a Engine,
    settings: &'a Settings,
    time_zone: &'a str,
}

impl<'a> CostReader<'a> {
    pub fn new(engine: &'a Engine, settings: &'a Settings, time_zone: &'a str) -> CostReader<'a> {
        CostReader { engine, settings, time_zone }
    }

    /// Cost in the engine's currency (USD) between two epoch-ms instants.
    pub fn cost_between(&self, matcher: &Matcher, since_ms: i64, until_ms: i64) -> f64 {
        if until_ms <= since_ms {
            return 0.0;
        }
        // engine.summary() warns once when the name is invalid; fall back to UTC here too so
        // both the summary and the hour filters use the same anchor.
        let (tz, _) = crate::engine::time_zone_or_utc(self.time_zone);
        // The first scan of a run can still be going; give it a moment so spend does not read low, but never
        // hold up the limits report for a cold scan (the engine answers from what it has after the timeout).
        let summary = self.engine.summary_settled(
            &SummaryInput {
                since_day: local_fmt(&tz, since_ms, "%Y-%m-%d"),
                until_day: local_fmt(&tz, until_ms, "%Y-%m-%d"),
                time_zone: self.time_zone.to_string(),
                hourly: true,
                since_time: Some(since_ms as f64),
                until_time: Some(until_ms as f64),
            },
            self.settings,
            std::time::Duration::from_millis(1500),
        );
        sum_costs(
            &summary,
            matcher,
            Some(&local_fmt(&tz, since_ms, "%Y-%m-%dT%H:00")),
            Some(&local_fmt(&tz, until_ms, "%Y-%m-%dT%H:00")),
        )
    }
}

/// Convenience form using UTC (the default budget anchor, see research/03 section 5.4).
#[allow(dead_code)] // public API for other packages / the integrator
pub fn cost_between(engine: &Engine, settings: &Settings, matcher: &Matcher, since_ms: i64, until_ms: i64) -> f64 {
    CostReader::new(engine, settings, "UTC").cost_between(matcher, since_ms, until_ms)
}

// ---- Limits report ---------------------------------------------------------------------------

fn account(reader: &CostReader<'_>, tz: Tz, budget: &Budget, now_ms: i64) -> Value {
    let cycle = cycle(now_ms, budget.reset_day, tz);
    let spend = reader.cost_between(&budget.matcher, cycle.start_ms, now_ms);
    let reset_at = crate::providers::iso_ms(cycle.next_reset_ms as f64);
    let mut window = json!({
        "id": "budget-monthly",
        "kind": "monthly",
        "label": "Monthly",
        "usedPercent": used_percent(spend, budget.monthly_budget),
        "windowDurationMins": (cycle.next_reset_ms - cycle.start_ms) as f64 / 60_000.0,
        "resetsAt": reset_at,
        "provenance": "local",
    });
    {
        let fields = window.as_object_mut().unwrap();
        if !budget.matcher.providers.is_empty() {
            fields.insert("providerIds".into(), json!(budget.matcher.providers));
        }
        if !budget.matcher.models.is_empty() {
            fields.insert("modelIds".into(), json!(budget.matcher.models));
        }
    }
    let mut head = json!({
        "id": format!("budget-{}", budget.id),
        "driver": "budget",
        "label": budget.label,
        "displayName": budget.label,
        "plan": "Budget",
    });
    if let Some(color) = &budget.color {
        head.as_object_mut().unwrap().insert("accentColor".into(), json!(color));
    }
    head["limits"] = json!({
        "checkedAt": crate::providers::iso_now(),
        "windows": [window],
        "balances": [{
            "id": "spend",
            "label": "Spend",
            "kind": "spend",
            "amount": spend,
            "limit": budget.monthly_budget,
            "currency": budget.currency,
            "resetsAt": reset_at,
            "provenance": "local",
        }],
    });
    head
}

/// One synthetic `LimitsAccount` per configured budget. Called by `limits_report`.
pub fn accounts(state: &State) -> Vec<Value> {
    let budgets = list();
    if budgets.is_empty() {
        return Vec::new();
    }
    let settings = state.settings.get();
    let reader = CostReader::new(&state.engine, &settings, "UTC");
    let now_ms = Utc::now().timestamp_millis();
    budgets.iter().map(|b| account(&reader, chrono_tz::UTC, b, now_ms)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> TempDir {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "burnrate-budget-{}-{}-{}",
                name,
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn ms(year: i32, month: u32, day: u32, hour: u32) -> i64 {
        Utc.with_ymd_and_hms(year, month, day, hour, 0, 0).unwrap().timestamp_millis()
    }

    fn ms_min(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        Utc.with_ymd_and_hms(year, month, day, hour, minute, 0).unwrap().timestamp_millis()
    }

    #[test]
    fn reset_day_month_ends_leap_years_and_year_rollover() {
        let utc = chrono_tz::UTC;
        // Leap day: the 29th is still inside the cycle that started on the 1st.
        assert_eq!(cycle(ms(2024, 2, 29, 12), 1, utc), Cycle { start_ms: ms(2024, 2, 1, 0), next_reset_ms: ms(2024, 3, 1, 0) });
        // A 31st-day "now" with a reset on the 28th stays in the same cycle.
        assert_eq!(cycle(ms(2023, 1, 31, 12), 28, utc), Cycle { start_ms: ms(2023, 1, 28, 0), next_reset_ms: ms(2023, 2, 28, 0) });
        // Across a year boundary.
        assert_eq!(cycle(ms(2024, 12, 31, 12), 15, utc), Cycle { start_ms: ms(2024, 12, 15, 0), next_reset_ms: ms(2025, 1, 15, 0) });
        // Exactly on the reset instant belongs to the new cycle.
        assert_eq!(cycle(ms(2024, 3, 1, 0), 1, utc), Cycle { start_ms: ms(2024, 3, 1, 0), next_reset_ms: ms(2024, 4, 1, 0) });
        // February in a non-leap year has a 28th but no 29th; resetDay is capped at 28.
        assert_eq!(cycle(ms(2023, 2, 15, 0), 28, utc).next_reset_ms, ms(2023, 2, 28, 0));
        assert_eq!(cycle(ms(2023, 3, 1, 0), 28, utc).next_reset_ms, ms(2023, 3, 28, 0));
    }

    #[test]
    fn reset_day_timezones() {
        // 02:00 UTC is 11:00 in Tokyo on 1 March: the March cycle has just started.
        let tokyo: Tz = "Asia/Tokyo".parse().unwrap();
        assert_eq!(
            cycle(ms(2024, 3, 1, 2), 1, tokyo),
            Cycle { start_ms: ms(2024, 2, 29, 15), next_reset_ms: ms(2024, 3, 31, 15) }
        );
        // The same instant in Los Angeles is still 29 February: February's cycle is current.
        let la: Tz = "America/Los_Angeles".parse().unwrap();
        assert_eq!(
            cycle(ms(2024, 3, 1, 2), 1, la),
            Cycle { start_ms: ms(2024, 2, 1, 8), next_reset_ms: ms(2024, 3, 1, 8) }
        );
        // Half-hour offsets: 00:00 local is not 00:00 UTC.
        let india: Tz = "Asia/Kolkata".parse().unwrap();
        assert_eq!(cycle(ms(2024, 3, 1, 2), 1, india).start_ms, ms_min(2024, 2, 29, 18, 30));
    }

    #[test]
    fn matcher_semantics() {
        let all = Matcher::default();
        assert!(all.matches("claude", "claude-3-opus"));
        assert!(all.matches("anything", "anything"));
        let m = Matcher { providers: vec!["claude".into(), "codex".into()], models: vec!["claude-3".into(), "gpt-4".into()] };
        assert!(m.matches("claude", "claude-3-opus"));
        assert!(m.matches("codex", "gpt-4o"));
        assert!(!m.matches("mistral", "claude-3-opus"));
        assert!(!m.matches("claude", "gpt-3.5"));
        let providers_only = Matcher { providers: vec!["claude".into()], models: Vec::new() };
        assert!(providers_only.matches("claude", "any-model"));
        assert!(!providers_only.matches("codex", "any-model"));
    }

    #[test]
    fn percent_clamp() {
        assert_eq!(used_percent(25.0, 100.0), 25.0);
        assert_eq!(used_percent(150.0, 100.0), 100.0);
        assert_eq!(used_percent(-3.0, 100.0), 0.0);
        assert_eq!(used_percent(1.0, 0.0), 0.0);
        assert_eq!(used_percent(f64::NAN, 100.0), 0.0);
        assert_eq!(used_percent(10.0, f64::NAN), 0.0);
        assert_eq!(used_percent(f64::INFINITY, 10.0), 0.0);
    }

    #[test]
    fn sum_costs_empty_and_filtered() {
        let empty = json!({"buckets": []});
        assert_eq!(sum_costs(&empty, &Matcher::default(), None, None), 0.0);
        let summary = json!({"buckets": [
            {"provider": "claude", "model": "claude-3-opus", "hourStart": "2024-03-01T10:00", "costUsd": 12.5},
            {"provider": "codex", "model": "gpt-4o", "hourStart": "2024-03-01T11:00", "costUsd": 3.0},
            {"provider": "claude", "model": "claude-3-haiku", "hourStart": "2024-02-29T23:00", "costUsd": 7.0},
            {"provider": "claude", "model": "claude-3-opus", "hourStart": "2024-03-02T01:00", "costUsd": f64::NAN}
        ]});
        assert_eq!(sum_costs(&summary, &Matcher::default(), None, None), 22.5);
        let claude = Matcher { providers: vec!["claude".into()], models: Vec::new() };
        assert_eq!(sum_costs(&summary, &claude, None, None), 19.5);
        let opus = Matcher { providers: Vec::new(), models: vec!["claude-3-opus".into()] };
        assert_eq!(sum_costs(&summary, &opus, None, None), 12.5);
        // Only the cycle hours [10:00, 11:00] count.
        assert_eq!(sum_costs(&summary, &Matcher::default(), Some("2024-03-01T10:00"), Some("2024-03-01T11:00")), 15.5);
    }

    #[test]
    fn budget_validation() {
        let base = json!({
            "id": "work", "label": "Work", "monthlyBudget": 50.0, "currency": "USD",
            "resetDay": 28, "match": {"providers": ["claude"], "models": ["claude-3"]}
        });
        let budget = parse_budget(&base, None).unwrap();
        assert_eq!(budget.id, "work");
        assert_eq!(budget.to_json(), base);
        assert!(parse_budget(&base, Some("other")).is_err());
        let from_path = parse_budget(&base, Some("work")).unwrap();
        assert_eq!(from_path, budget);
        let mut bad = base.clone();
        bad["resetDay"] = json!(29);
        assert_eq!(parse_budget(&bad, None).unwrap_err().field, "resetDay");
        bad = base.clone();
        bad["monthlyBudget"] = json!(-1);
        assert_eq!(parse_budget(&bad, None).unwrap_err().field, "monthlyBudget");
        bad = base.clone();
        bad["match"]["models"] = json!(["ok", 5]);
        assert_eq!(parse_budget(&bad, None).unwrap_err().field, "match.models");
        bad = base.clone();
        bad["color"] = json!("red");
        assert_eq!(parse_budget(&bad, None).unwrap_err().field, "color");
        // Spend is always USD, so a budget in another currency is rejected rather than dividing
        // a USD amount by a limit in another unit.
        for other in ["EUR", "GBP", "JPY", ""] {
            bad = base.clone();
            bad["currency"] = json!(other);
            assert_eq!(parse_budget(&bad, None).unwrap_err().field, "currency");
        }
        bad = base.clone();
        bad["currency"] = json!("usd");
        assert_eq!(parse_budget(&bad, None).unwrap().currency, "USD");
    }

    #[test]
    fn store_round_trip_delete_and_corrupt_recovery() {
        let dir = TempDir::new("store");
        let path = dir.path().join("budgets.json");
        let mut store = BudgetFile::open(path.clone());
        assert!(store.budgets.is_empty());
        let a = parse_budget(&json!({
            "id":"a", "label":"A", "monthlyBudget":10, "currency":"USD", "resetDay":1, "match":{}
        }), None).unwrap();
        let b = parse_budget(&json!({
            "id":"b", "label":"B", "monthlyBudget":20, "currency":"USD", "resetDay":28, "match":{"models":["gpt"]}, "color":"#abc"
        }), None).unwrap();
        store.put(b.clone()).unwrap();
        store.put(a.clone()).unwrap();
        assert_eq!(store.budgets.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        let reloaded = BudgetFile::open(path.clone());
        assert_eq!(reloaded.budgets, vec![a, b]);
        assert!(path.with_extension("json.bak").exists());
        let mut reloaded = reloaded;
        assert!(reloaded.delete("a").unwrap());
        assert!(!reloaded.delete("a").unwrap());
        assert_eq!(BudgetFile::open(path.clone()).budgets.len(), 1);
        fs::write(&path, b"{not json").unwrap();
        let recovered = BudgetFile::open(path.clone());
        assert!(recovered.budgets.is_empty());
        assert!(!path.exists());
        assert!(fs::read_dir(dir.path()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains("corrupt")));
    }
}
