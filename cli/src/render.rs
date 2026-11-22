//! Turns a parsed `Status` into the various one-line / JSON outputs.

use crate::format;
use crate::model::Status;
use serde_json::{json, Value};

pub fn version_string() -> String {
    format!("burnrate {}", env!("CARGO_PKG_VERSION"))
}

/// `status`: one segment per selected (account, window), e.g.
/// `Claude Kernel 27% used - resets 3h57m`.
pub fn status_line(
    status: &Status,
    provider: Option<&str>,
    kind: Option<&str>,
    unicode: bool,
    now: i64,
) -> String {
    let pairs = status.selected(provider, kind);
    if pairs.is_empty() {
        return "no usage data".into();
    }
    let sep = format::join_sep(unicode);
    let dash = format::dash(unicode);
    pairs
        .iter()
        .map(|(account, window)| {
            let short = format::short_kind(&window.kind, &window.label);
            let mut name = if account.label.is_empty() { short.clone() } else { account.label.clone() };
            // When several windows are shown, disambiguate with the short kind
            // ("5h", "7d", ...). A single window keeps the clean account label.
            if pairs.len() > 1 && !short.is_empty() && !name.contains(&short) {
                name = format!("{name} {short}");
            }
            let mut line = format!("{} {}% used", name, format::fmt_pct(window.used));
            if let Some(reset) = &window.resets_at {
                line.push_str(&format!("{dash}resets {}", format::format_countdown(reset, now)));
            }
            line
        })
        .collect::<Vec<_>>()
        .join(sep)
}

/// `statusline`: `5h 47% - 7d 36%` from the session and weekly windows of one
/// account (the worst one when known, otherwise the first with a session).
pub fn statusline_line(status: &Status, unicode: bool) -> String {
    let account = status
        .worst
        .as_ref()
        .and_then(|w| status.accounts.iter().find(|a| a.id == w.account_id))
        .or_else(|| status.accounts.iter().find(|a| a.windows.iter().any(|x| x.kind.eq_ignore_ascii_case("session"))))
        .or_else(|| status.accounts.first());

    let mut parts: Vec<String> = Vec::new();
    if let Some(account) = account {
        for kind in ["session", "weekly"] {
            if let Some(window) = account.windows.iter().find(|w| w.kind.eq_ignore_ascii_case(kind)) {
                parts.push(format!(
                    "{} {}%",
                    format::short_kind(&window.kind, &window.label),
                    format::fmt_pct(window.used)
                ));
            }
        }
    }
    if parts.is_empty() {
        if let Some(window) = status.worst_window().or_else(|| status.accounts.first().and_then(|a| a.windows.first())) {
            parts.push(format!(
                "{} {}%",
                format::short_kind(&window.kind, &window.label),
                format::fmt_pct(window.used)
            ));
        }
    }
    if parts.is_empty() { "no data".into() } else { parts.join(format::dash(unicode)) }
}

/// `waybar`: a Waybar `custom` module object.
pub fn waybar_json(status: &Status, now: i64) -> Value {
    let window = status.worst_window();
    let (text, class, percentage) = match window {
        Some(w) => {
            let pct = w.used.clamp(0.0, 100.0);
            (
                format!("{} {}%", format::short_kind(&w.kind, &w.label), format::fmt_pct(w.used)),
                w.state.clone(),
                pct.round() as u32,
            )
        }
        None => ("BR".into(), "ok".into(), 0u32),
    };

    let mut tooltip = vec!["Burnrate".to_string()];
    for account in &status.accounts {
        tooltip.push(account.label.clone());
        for w in &account.windows {
            let mut row = format!(
                "  {}: {}% used ({}% left)",
                format::short_kind(&w.kind, &w.label),
                format::fmt_pct(w.used),
                format::fmt_pct(w.remaining),
            );
            if let Some(reset) = &w.resets_at {
                row.push_str(&format!(" - resets {}", format::format_countdown(reset, now)));
            }
            tooltip.push(row);
        }
        if let Some(msg) = &account.unavailable {
            tooltip.push(format!("  unavailable: {msg}"));
        }
    }
    for notice in &status.notices {
        tooltip.push(notice.clone());
    }
    if status.accounts.iter().any(|a| a.unavailable.is_some()) {
        tooltip.push("note: some accounts are unavailable".into());
    }

    let class = if status.accounts.iter().any(|a| a.unavailable.is_some()) {
        "unavailable".to_string()
    } else if class.is_empty() {
        "ok".to_string()
    } else {
        class
    };

    json!({
        "text": text,
        "tooltip": tooltip.join("\n"),
        "class": class,
        "percentage": percentage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Status {
        Status::parse(r#"{
          "checkedAt":"x",
          "accounts":[{"id":"a","provider":"claudeAgent","label":"Claude Kernel","windows":[
            {"id":"five_hour","kind":"session","label":"5h","usedPercent":27,"remainingPercent":73,"resetsAt":"1970-01-01T03:57:00Z","state":"ok"},
            {"id":"seven_day","kind":"weekly","label":"7d","usedPercent":47,"remainingPercent":53,"state":"ok"}
          ]}],
          "worst":{"accountId":"a","provider":"claudeAgent","windowId":"five_hour","label":"5h","remainingPercent":73,"resetsAt":"1970-01-01T03:57:00Z"}
        }"#).unwrap()
    }

    #[test]
    fn status_line_single_window() {
        let s = sample();
        let line = status_line(&s, None, Some("session"), false, 0);
        assert_eq!(line, "Claude Kernel 27% used - resets 3h57m");
    }

    #[test]
    fn status_line_unicode_and_multiple() {
        let s = sample();
        let line = status_line(&s, None, None, true, 0);
        assert!(line.contains("5h"));
        assert!(line.contains("7d"));
        assert!(line.contains("│"));
        assert_eq!(status_line(&s, Some("nope"), None, false, 0), "no usage data");
    }

    #[test]
    fn statusline_line_format() {
        assert_eq!(statusline_line(&sample(), false), "5h 27% - 7d 47%");
    }

    #[test]
    fn waybar_shape() {
        let wb = waybar_json(&sample(), 0);
        assert_eq!(wb["text"], "5h 27%");
        assert_eq!(wb["class"], "ok");
        assert_eq!(wb["percentage"], 27);
        assert!(wb["tooltip"].as_str().unwrap().contains("resets 3h57m"));
    }

    #[test]
    fn version() {
        assert!(version_string().starts_with("burnrate "));
    }
}
