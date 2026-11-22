//! EWMA burn-rate predictor for the "predict run-out" alert rule (docs/CONTRACTS.md section 10).
//!
//! Pure math only: no I/O and no wall-clock access, so it is exhaustively unit-testable.
//! The caller supplies the current time in milliseconds.

/// How many recent samples to keep for the EWMA (at 2-minute polls this is about 4 hours).
pub const MAX_SAMPLES: usize = 120;
/// A prediction needs at least this much history ("at least 10 minutes of data" in the contract).
pub const MIN_HISTORY_MS: i64 = 10 * 60 * 1000;
/// Default smoothing factor for the exponentially weighted moving average.
pub const DEFAULT_ALPHA: f64 = 0.35;

/// Appends `(now_ms, used_percent)` to `samples`, ignoring a sample at an identical timestamp and
/// keeping the buffer bounded at `MAX_SAMPLES`. Returns true when a sample was added.
pub fn record(samples: &mut Vec<(i64, f64)>, now_ms: i64, used: f64) -> bool {
    if !used.is_finite() {
        return false;
    }
    if samples.last().is_some_and(|(t, _)| *t == now_ms) {
        return false;
    }
    samples.push((now_ms, used.clamp(0.0, 100.0)));
    if samples.len() > MAX_SAMPLES {
        let excess = samples.len() - MAX_SAMPLES;
        samples.drain(0..excess);
    }
    true
}

/// True when the sample window covers at least `MIN_HISTORY_MS` and has two points.
pub fn has_enough_history(samples: &[(i64, f64)], now_ms: i64) -> bool {
    samples.len() >= 2
        && samples
            .first()
            .is_some_and(|(first_ms, _)| now_ms.saturating_sub(*first_ms) >= MIN_HISTORY_MS)
}

/// Burn rate in percentage points per minute, as an exponentially weighted moving average of the
/// per-interval rates. Downward/zero intervals count as zero (a refilling window is not burning).
pub fn ewma_rate(samples: &[(i64, f64)], alpha: f64) -> f64 {
    if samples.len() < 2 {
        return 0.0;
    }
    let a = alpha.clamp(0.0, 1.0);
    let mut rate = 0.0;
    let mut primed = false;
    for pair in samples.windows(2) {
        let minutes = (pair[1].0 - pair[0].0) as f64 / 60_000.0;
        if minutes <= 0.0 {
            continue;
        }
        let instant = ((pair[1].1 - pair[0].1) / minutes).max(0.0);
        if primed {
            rate = a * instant + (1.0 - a) * rate;
        } else {
            rate = instant;
            primed = true;
        }
    }
    if rate.is_finite() {
        rate
    } else {
        0.0
    }
}

/// Milliseconds until `used` reaches 100 percent at `rate_per_min`, or None when there is no
/// positive burn or the window is already exhausted.
pub fn exhaustion_in_ms(used: f64, rate_per_min: f64) -> Option<i64> {
    if !rate_per_min.is_finite() || rate_per_min <= 0.0 || !used.is_finite() || used >= 100.0 {
        return None;
    }
    let minutes = (100.0 - used) / rate_per_min;
    if !minutes.is_finite() || minutes < 0.0 {
        return None;
    }
    Some((minutes * 60_000.0) as i64)
}

/// Whether a run-out warning should fire: enough history, a positive EWMA burn rate, and projected
/// exhaustion strictly before the window's reset time.
pub fn should_warn(
    samples: &[(i64, f64)],
    now_ms: i64,
    used: f64,
    resets_at_ms: Option<i64>,
    alpha: f64,
) -> bool {
    if !has_enough_history(samples, now_ms) {
        return false;
    }
    let Some(reset_ms) = resets_at_ms else {
        return false;
    };
    if reset_ms <= now_ms {
        return false;
    }
    let Some(remaining_ms) = exhaustion_in_ms(used, ewma_rate(samples, alpha)) else {
        return false;
    };
    now_ms.saturating_add(remaining_ms) < reset_ms
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_700_000_000_000;

    #[test]
    fn record_bounds_samples_and_skips_duplicate_timestamps() {
        let mut samples = Vec::new();
        assert!(record(&mut samples, T0, 10.0));
        assert!(!record(&mut samples, T0, 20.0), "same timestamp is ignored");
        assert!(!record(&mut samples, T0, f64::NAN), "non-finite is ignored");
        for i in 1..=MAX_SAMPLES + 10 {
            assert!(record(&mut samples, T0 + i as i64 * 60_000, i as f64));
        }
        assert_eq!(samples.len(), MAX_SAMPLES);
        assert_eq!(samples.first().unwrap().0, T0 + 11 * 60_000);
    }

    #[test]
    fn has_enough_history_requires_ten_minutes_and_two_points() {
        let one = vec![(T0, 5.0)];
        assert!(!has_enough_history(&one, T0 + MIN_HISTORY_MS));
        let two = vec![(T0, 5.0), (T0 + 60_000, 10.0)];
        assert!(!has_enough_history(&two, T0 + MIN_HISTORY_MS - 1));
        assert!(has_enough_history(&two, T0 + MIN_HISTORY_MS));
    }

    #[test]
    fn ewma_rate_handles_constant_rising_falling_and_empty() {
        assert_eq!(ewma_rate(&[], 0.35), 0.0);
        assert_eq!(ewma_rate(&[(T0, 10.0)], 0.35), 0.0);
        // 10 points in 20 minutes => 3 points/minute.
        let rising: Vec<(i64, f64)> = (0..10).map(|i| (T0 + i * 2 * 60_000, 10.0 + i as f64 * 6.0)).collect();
        let rate = ewma_rate(&rising, 1.0);
        assert!((rate - 3.0).abs() < 1e-9, "expected 3.0, got {rate}");
        // Falling windows never produce a burn rate.
        let falling = [(T0, 90.0), (T0 + 5 * 60_000, 40.0)];
        assert_eq!(ewma_rate(&falling, 0.35), 0.0);
        // A zero alpha keeps the first observed rate.
        assert!((ewma_rate(&rising, 0.0) - 3.0).abs() < 1e-9);
    }

    #[test]
    fn exhaustion_and_should_warn_table() {
        let reset_ms = T0 + 30 * 60_000;
        let samples = vec![(T0, 80.0), (T0 + 5 * 60_000, 85.0), (T0 + 11 * 60_000, 91.0)];
        // rate ~1/min, used 91 => ~9 minutes to empty, before the 30-minute reset.
        assert!(should_warn(&samples, T0 + 11 * 60_000, 91.0, Some(reset_ms), 0.35));
        // No reset known => never warn.
        assert!(!should_warn(&samples, T0 + 11 * 60_000, 91.0, None, 0.35));
        // Reset already passed => never warn.
        assert!(!should_warn(&samples, T0 + 11 * 60_000, 91.0, Some(T0), 0.35));
        // Too little history => never warn.
        assert!(!should_warn(&samples[1..], T0 + 11 * 60_000, 91.0, Some(reset_ms), 0.35));
        // No burn (flat samples) => never warn.
        let flat = [(T0, 50.0), (T0 + 11 * 60_000, 50.0)];
        assert!(!should_warn(&flat, T0 + 11 * 60_000, 50.0, Some(reset_ms), 0.35));
        assert_eq!(exhaustion_in_ms(50.0, 0.0), None);
        assert_eq!(exhaustion_in_ms(100.0, 1.0), None);
        assert_eq!(exhaustion_in_ms(50.0, 1.0), Some(50 * 60_000));
    }
}
