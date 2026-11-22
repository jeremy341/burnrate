//! Pure formatting helpers. No I/O, no dependencies beyond std, fully unit-testable.

/// Percentage for display: integer when whole, one decimal otherwise.
pub fn fmt_pct(v: f64) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    if (v - v.round()).abs() < 0.000_001 {
        format!("{}", v.round() as i64)
    } else {
        format!("{v:.1}")
    }
}

/// Short label used by the statusline / Waybar for a window kind.
pub fn short_kind(kind: &str, label: &str) -> String {
    match kind.to_ascii_lowercase().as_str() {
        "session" => "5h".into(),
        "weekly" => "7d".into(),
        "monthly" => "30d".into(),
        _ if !label.is_empty() => label.to_string(),
        _ if !kind.is_empty() => kind.to_string(),
        _ => "win".into(),
    }
}

pub fn join_sep(unicode: bool) -> &'static str {
    if unicode { " │ " } else { " | " }
}

pub fn dash(unicode: bool) -> &'static str {
    if unicode { " – " } else { " - " }
}

/// Days from the Unix epoch for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn parse_uint(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) { None } else { s.parse().ok() }
}

/// Parse an RFC 3339 timestamp (or a bare epoch-seconds number) into Unix seconds.
/// Handles `Z`, numeric offsets, fractional seconds and a space in place of `T`.
/// Deliberately dependency-free (no chrono allowed in this crate).
pub fn parse_timestamp(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    // Bare epoch seconds (used by Claude Code's `resets_at`).
    if s.bytes().all(|b| b.is_ascii_digit() || b == b'-') && s.bytes().any(|b| b.is_ascii_digit()) {
        if let Ok(n) = s.parse::<i64>() {
            return Some(n);
        }
    }
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let year = parse_uint(&s[0..4])?;
    let month = parse_uint(&s[5..7])?;
    let day = parse_uint(&s[8..10])?;
    let hour = parse_uint(&s[11..13])?;
    let min = parse_uint(&s[14..16])?;
    let sec = parse_uint(&s[17..19])?;
    if b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b't' && b[10] != b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || min > 59 || sec > 60 {
        return None;
    }
    let mut t = days_from_civil(year, month, day) * 86400 + hour * 3600 + min * 60 + sec;

    let rest = &s[19..];
    let rb = rest.as_bytes();
    let mut idx = 0;
    if idx < rb.len() && (rb[idx] == b'.' || rb[idx] == b',') {
        idx += 1;
        while idx < rb.len() && rb[idx].is_ascii_digit() { idx += 1; }
    }
    let zone = &rest[idx..];
    match zone.as_bytes().first().copied() {
        Some(b'Z') | Some(b'z') => {}
        Some(sign @ (b'+' | b'-')) => {
            let z = &zone[1..];
            let (hh, mm) = if z.as_bytes().get(2) == Some(&b':') {
                (parse_uint(&z[0..2])?, parse_uint(&z[3..5])?)
            } else if z.len() == 4 {
                (parse_uint(&z[0..2])?, parse_uint(&z[2..4])?)
            } else {
                return None;
            };
            let offset = hh * 3600 + mm * 60;
            if sign == b'+' { t -= offset; } else { t += offset; }
        }
        None => {} // no offset: treat as UTC
        _ => return None,
    }
    Some(t)
}

/// Human-readable countdown: `2d3h`, `3h57m`, `12m`, or `now` when due.
pub fn format_countdown(resets_at: &str, now: i64) -> String {
    let Some(reset) = parse_timestamp(resets_at) else { return "?".into() };
    let delta = reset - now;
    if delta <= 0 {
        return "now".into();
    }
    let days = delta / 86400;
    let hours = (delta % 86400) / 3600;
    let mins = (delta % 3600) / 60;
    if days > 0 {
        format!("{days}d{hours}h")
    } else if hours > 0 {
        format!("{hours}h{mins}m")
    } else {
        format!("{}m", mins.max(1))
    }
}

/// Compact-state rule from contracts section 8, used as a fallback when a
/// server does not provide a `state` field.
pub fn state_from_remaining(remaining: f64) -> &'static str {
    if remaining <= 10.0 { "critical" } else if remaining <= 25.0 { "warn" } else { "ok" }
}

pub fn state_rank(state: &str) -> u8 {
    match state {
        "unavailable" => 4,
        "critical" => 3,
        "warn" => 2,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_formatting() {
        assert_eq!(fmt_pct(27.0), "27");
        assert_eq!(fmt_pct(47.5), "47.5");
        assert_eq!(fmt_pct(f64::NAN), "0");
        assert_eq!(fmt_pct(-3.0), "-3");
    }

    #[test]
    fn kind_shortening() {
        assert_eq!(short_kind("session", "Five hour"), "5h");
        assert_eq!(short_kind("weekly", "Seven day"), "7d");
        assert_eq!(short_kind("monthly", ""), "30d");
        assert_eq!(short_kind("other", "Kernel"), "Kernel");
    }

    #[test]
    fn timestamp_parsing() {
        assert_eq!(parse_timestamp("1970-01-01T03:57:00Z"), Some(3 * 3600 + 57 * 60));
        assert_eq!(parse_timestamp("1970-01-01T05:57:00+02:00"), Some(3 * 3600 + 57 * 60));
        assert_eq!(parse_timestamp("1970-01-01T01:57:00-02:00"), Some(3 * 3600 + 57 * 60));
        assert_eq!(parse_timestamp("1970-01-01 03:57:00.500Z"), Some(14220));
        assert_eq!(parse_timestamp("1234567890"), Some(1234567890));
        assert_eq!(parse_timestamp("not a date"), None);
        assert_eq!(parse_timestamp(""), None);
    }

    #[test]
    fn countdown_formatting() {
        assert_eq!(format_countdown("1970-01-01T03:57:00Z", 0), "3h57m");
        assert_eq!(format_countdown("1970-01-02T03:00:00Z", 0), "1d3h");
        assert_eq!(format_countdown("1970-01-01T00:12:00Z", 0), "12m");
        assert_eq!(format_countdown("1970-01-01T00:00:00Z", 10), "now");
        assert_eq!(format_countdown("garbage", 0), "?");
    }

    #[test]
    fn state_rule() {
        assert_eq!(state_from_remaining(8.0), "critical");
        assert_eq!(state_from_remaining(20.0), "warn");
        assert_eq!(state_from_remaining(60.0), "ok");
        assert!(state_rank("critical") > state_rank("warn"));
    }
}
