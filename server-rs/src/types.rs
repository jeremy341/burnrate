use serde_json::Value;

/// One billed request, as read from a transcript.
#[derive(Clone, Debug)]
pub struct Record {
    pub provider: String,
    pub ts: f64,
    pub model: String,
    pub rate_model: Option<String>,
    pub session: String,
    pub uncached: f64,
    pub cached: f64,
    pub cache_write: f64,
    pub output: f64,
    pub reasoning: f64,
    /// The part of `cache_write` written with a 1-hour TTL.
    pub cache_1h: f64,
    pub reported: Option<f64>,
    /// 0 standard, 1 fast, 2 ultrafast.
    pub speed: u8,
    pub key: Option<String>,
}

impl Record {
    pub fn new(provider: &str, ts: f64, model: &str, session: &str) -> Record {
        Record {
            provider: provider.to_string(),
            ts,
            model: model.to_string(),
            rate_model: None,
            session: session.to_string(),
            uncached: 0.0,
            cached: 0.0,
            cache_write: 0.0,
            output: 0.0,
            reasoning: 0.0,
            cache_1h: 0.0,
            reported: None,
            speed: 0,
            key: None,
        }
    }

    pub fn total_tokens(&self) -> f64 {
        // Reasoning is a subset of output and must not be added again.
        self.uncached + self.cached + self.cache_write + self.output
    }
}

pub struct ReadResult {
    pub records: Vec<Record>,
    pub malformed: u32,
}

/// A non-negative whole token count; anything else counts as zero.
pub fn token_count(v: Option<&Value>) -> f64 {
    match v.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n > 0.0 => n.trunc(),
        _ => 0.0,
    }
}

/// RFC 3339 timestamp to epoch milliseconds.
pub fn parse_rfc3339_ms(s: &str) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis() as f64)
}

pub fn parse_ts_ms(v: Option<&Value>) -> Option<f64> {
    parse_rfc3339_ms(v?.as_str()?)
}

pub fn str_of(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or("")
}
