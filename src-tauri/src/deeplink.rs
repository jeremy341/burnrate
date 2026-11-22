//! `burnrate://` deep links. The single-instance plugin forwards argv from a
//! second launch; we also read argv on first launch in main.rs.

use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeepLink {
    Open { view: Option<String> },
    Snooze { minutes: u32 },
}

pub(crate) fn parse(arg: &str) -> Option<DeepLink> {
    let rest = arg.strip_prefix("burnrate://")?.trim_matches('/');
    let (head, tail) = rest.split_once('/').unwrap_or((rest, ""));
    match head {
        "open" | "view" => Some(DeepLink::Open {
            view: if tail.is_empty() { None } else { Some(tail.to_string()) },
        }),
        "snooze" => tail
            .parse::<u32>()
            .ok()
            .map(|minutes| DeepLink::Snooze { minutes: minutes.clamp(1, 1440) }),
        _ => None,
    }
}

pub(crate) fn handle_args(app: &AppHandle, args: &[String]) -> Option<DeepLink> {
    for arg in args {
        if let Some(link) = parse(arg) {
            apply(app, &link);
            return Some(link);
        }
    }
    None
}

fn apply(app: &AppHandle, link: &DeepLink) {
    match link {
        DeepLink::Open { view } => crate::windows::open_main(app, view.as_deref()),
        DeepLink::Snooze { minutes } => {
            if let Some(state) = app.try_state::<std::sync::Arc<crate::AppState>>() {
                crate::stream::post_json(
                    &state.base,
                    "/api/alerts/snooze",
                    &serde_json::json!({ "minutes": minutes }),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_links() {
        assert_eq!(parse("burnrate://open"), Some(DeepLink::Open { view: None }));
        assert_eq!(
            parse("burnrate://view/settings/providers/"),
            Some(DeepLink::Open { view: Some("settings/providers".into()) })
        );
        assert_eq!(parse("burnrate://snooze/60"), Some(DeepLink::Snooze { minutes: 60 }));
        assert_eq!(parse("burnrate://snooze/99999"), Some(DeepLink::Snooze { minutes: 1440 }));
        assert_eq!(parse("https://example.com"), None);
        assert_eq!(parse("burnrate://nope"), None);
        assert_eq!(parse("burnrate://snooze/abc"), None);
    }
}
