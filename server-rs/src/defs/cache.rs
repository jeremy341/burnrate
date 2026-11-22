//! Per-definition poll cache: TTL = poll interval with 20% jitter, exponential backoff on failures
//! and a single in-flight fetch (callers hold the provider's mutex across `get_or_fetch`).
use serde_json::Value;

pub const MAX_BACKOFF_MS: i64 = 15 * 60 * 1000;

#[derive(Default)]
pub struct FetchOutcome {
    pub accounts: Vec<Value>,
    /// True when at least one key's probe failed (429/5xx/network/parse).
    pub failed: bool,
}

pub struct DefCache {
    poll_ms: i64,
    accounts: Vec<Value>,
    fetched_at_ms: i64,
    ttl_ms: i64,
    fail_count: u32,
    backoff_until_ms: i64,
}

impl DefCache {
    pub fn new(poll_seconds: u64) -> DefCache {
        let poll_ms = (poll_seconds.max(60) as i64) * 1000;
        DefCache {
            ttl_ms: jittered(poll_ms),
            poll_ms,
            accounts: Vec::new(),
            fetched_at_ms: i64::MIN,
            fail_count: 0,
            backoff_until_ms: 0,
        }
    }

    fn has_cache(&self) -> bool {
        self.fetched_at_ms != i64::MIN
    }

    fn fresh(&self, now_ms: i64) -> bool {
        self.has_cache() && (now_ms - self.fetched_at_ms) < self.ttl_ms
    }

    pub fn get_or_fetch(&mut self, now_ms: i64, fetch: impl FnOnce() -> FetchOutcome) -> Vec<Value> {
        // While backing off we keep serving the last (possibly stale) result rather than
        // hammering a provider that returned 429/5xx.
        if self.has_cache() && (now_ms < self.backoff_until_ms || self.fresh(now_ms)) {
            return self.accounts.clone();
        }
        let outcome = fetch();
        if outcome.failed {
            self.fail_count = self.fail_count.saturating_add(1);
            let factor = 1i64 << self.fail_count.min(6);
            self.backoff_until_ms = now_ms.saturating_add(self.poll_ms.saturating_mul(factor).min(MAX_BACKOFF_MS));
        } else {
            self.fail_count = 0;
            self.backoff_until_ms = 0;
        }
        self.accounts = outcome.accounts.clone();
        self.fetched_at_ms = now_ms;
        self.ttl_ms = jittered(self.poll_ms);
        outcome.accounts
    }
}

fn jittered(poll_ms: i64) -> i64 {
    // +/- 20% so many definitions started at once do not hit their providers in lockstep.
    let factor = 0.8 + rand::random::<f64>() * 0.4;
    (poll_ms as f64 * factor).max(1000.0) as i64
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn now() -> i64 {
    now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn caches_within_ttl() {
        let mut cache = DefCache::new(300);
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let fetch = || {
            c.fetch_add(1, Ordering::SeqCst);
            FetchOutcome { accounts: vec![json!({"id": "a"})], failed: false }
        };
        assert_eq!(cache.get_or_fetch(1000, fetch).len(), 1);
        assert_eq!(cache.get_or_fetch(1000 + 100, fetch).len(), 1);
        // Only the first call hit the fetcher.
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn refreshes_after_ttl() {
        let mut cache = DefCache::new(300);
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let fetch = || {
            c.fetch_add(1, Ordering::SeqCst);
            FetchOutcome { accounts: vec![], failed: false }
        };
        cache.get_or_fetch(1000, fetch);
        cache.get_or_fetch(1000 + 400_000, fetch);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn backs_off_after_failure() {
        let mut cache = DefCache::new(300);
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let fetch = || {
            c.fetch_add(1, Ordering::SeqCst);
            FetchOutcome { accounts: vec![], failed: true }
        };
        cache.get_or_fetch(1000, fetch);
        // A TTL expiry alone must not retry while backoff is active.
        cache.get_or_fetch(1000 + 400_000, fetch);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
