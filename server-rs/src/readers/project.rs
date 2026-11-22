// Project (working directory / repository) attribution for local-log readers.
//
// `types::Record` (owned by the integrator, NOT by package 09) has no `project`
// field yet. Package 09 therefore exposes the optional value here, in a file it
// owns, and the integrator must add `project: Option<String>` to `Record` and
// assign it from these helpers. See CONTRACT_ISSUE in the package 09 summary.

const MAX_PROJECT_LEN: usize = 120;

/// The project attribution derived from a tool's logged working directory.
#[allow(dead_code)] // exposed for the integrator to wire into types::Record
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProjectHint {
    /// Repository / working-directory name, when the tool recorded one.
    pub project: Option<String>,
}

#[allow(dead_code)]
impl ProjectHint {
    pub fn new(project: Option<String>) -> Self {
        ProjectHint { project }
    }
}

fn normalize(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return None;
    }
    Some(trimmed.chars().take(MAX_PROJECT_LEN).collect())
}

/// Last path component of a working directory, on both Windows and Linux.
/// Handles `/`, `\\`, trailing separators and `.` / `..` segments.
pub fn project_from_cwd(cwd: &str) -> Option<String> {
    let trimmed = cwd.trim().trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty() && *part != "." && *part != "..")
        .and_then(normalize)
}

/// A directory name used directly as a project label (Gemini/Qwen store it in
/// the parent directory of the chat files).
pub fn project_from_dir_name(name: &str) -> Option<String> {
    normalize(name)
}

/// Copilot writes `cwd: <path>` into `workspace.yaml` beside `events.jsonl`.
/// Inline YAML comments and either quote style are tolerated.
pub fn project_from_workspace_yaml(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("cwd:") else {
            continue;
        };
        let mut value = rest.trim();
        if let Some(index) = value.find(" #") {
            value = &value[..index];
        }
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
        if let Some(project) = project_from_cwd(value) {
            return Some(project);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_from_posix_and_windows_paths() {
        assert_eq!(
            project_from_cwd("/home/me/dev/burnrate"),
            Some("burnrate".into())
        );
        assert_eq!(
            project_from_cwd("C:\\Users\\me\\dev\\burnrate\\"),
            Some("burnrate".into())
        );
        assert_eq!(
            project_from_cwd("/mnt/c/Users/me/dev/app"),
            Some("app".into())
        );
        assert_eq!(project_from_cwd("C:\\repo"), Some("repo".into()));
    }

    #[test]
    fn project_ignores_empty_and_dot_segments() {
        assert_eq!(project_from_cwd(""), None);
        assert_eq!(project_from_cwd("   "), None);
        assert_eq!(project_from_cwd("/home/me/.."), Some("me".into()));
        assert_eq!(project_from_dir_name(""), None);
        assert_eq!(
            project_from_dir_name("  my-project  "),
            Some("my-project".into())
        );
    }

    #[test]
    fn project_caps_length() {
        let long = "x".repeat(200);
        let got = project_from_dir_name(&long).unwrap();
        assert_eq!(got.len(), MAX_PROJECT_LEN);
    }

    #[test]
    fn project_from_copilot_workspace_yaml() {
        let yaml =
            "client_name: vscode-agent-host\n# comment\ncwd: /home/me/dev/app # trailing\nx: 1\n";
        assert_eq!(project_from_workspace_yaml(yaml), Some("app".into()));
        let yaml = "cwd: \"C:\\Users\\me\\dev\\app\"\n";
        assert_eq!(project_from_workspace_yaml(yaml), Some("app".into()));
        assert_eq!(project_from_workspace_yaml("other: 1\n"), None);
    }

    #[test]
    fn project_hint_carries_optional_value() {
        assert_eq!(
            ProjectHint::new(Some("app".into())).project.as_deref(),
            Some("app")
        );
        assert_eq!(ProjectHint::default().project, None);
    }
}
