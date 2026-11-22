//! Sign-in flows that run an agent's own CLI login (`claude auth login`, `codex login`, `grok login`),
//! and one that opens the provider's own app (Antigravity) and waits for its data to appear.
//!
//! T3 Code runs `claude auth login` with its own `CLAUDE_CONFIG_DIR` per account; the flow shapes
//! and the host-session environment strip follow its provider auth code (MIT, see NOTICE).
//! The runner is generic: a `CliSpec` says which binary to start, which hosts a sign-in link may
//! point to and where the finished login lands. The safety rules (process-tree kill, five minute
//! timeout, URL host allow-list, capped output, created-dir cleanup, no secrets in errors) are shared.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// A sign-in gets five minutes, the same budget T3 Code gives its auth flows.
const TIMEOUT: Duration = Duration::from_secs(300);
/// A CLI that opens the browser itself may print no link at all: after this long without one the
/// flow still moves on to "waiting for the browser" (without a `url`).
const BROWSER_HINT_AFTER: Duration = Duration::from_secs(4);
const POLL: Duration = Duration::from_millis(500);
/// After credentials appear, leave the CLI alone briefly so it can write `.claude.json`
/// (display name / e-mail) before we stop it.
const GRACE: Duration = Duration::from_secs(3);
const MAX_OUTPUT: usize = 64 * 1024;
const MAX_ACTIVE_FLOWS: usize = 4;
const ACCOUNTS_CACHE_TTL: Duration = Duration::from_secs(5);

/// Environment variables from a host Claude Code session. A child that inherits them behaves as
/// part of that session instead of performing a fresh interactive login.
const HOST_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_DESKTOP_APP_VERSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
    "CLAUDE_AGENT_SDK_VERSION",
    "ELECTRON_RUN_AS_NODE",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Starting,
    WaitingForBrowser,
    Connected,
    Failed,
    Cancelled,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Starting => "starting",
            Phase::WaitingForBrowser => "waitingForBrowser",
            Phase::Connected => "connected",
            Phase::Failed => "failed",
            Phase::Cancelled => "cancelled",
        }
    }

    fn is_active(self) -> bool {
        matches!(self, Phase::Starting | Phase::WaitingForBrowser)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StartError {
    InvalidName,
    AlreadyConnected,
    /// The agent's CLI is not installed (or not on PATH). The API answers `cli-not-found`.
    CliNotFound,
    SpawnFailed,
    AlreadyRunning,
    TooManyFlows,
    /// The provider has no CLI login we can run.
    NotSupported,
}

/// How a finished login is recognised.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    /// `<config dir>/.credentials.json` with `claudeAiOauth.accessToken`; one config dir per account.
    Claude,
    /// `~/.codex/auth.json` (or `CODEX_HOME`) with `tokens.access_token`.
    Codex,
    /// `~/.grok/auth.json` (or `GROK_HOME`) holding a credential with a `key`.
    Grok,
    /// No CLI to run: the provider's own app (Antigravity) holds the sign-in. The flow opens the
    /// installed app and waits until data Burnrate can read appears or changes on this computer.
    App,
}

/// One agent CLI we can start a browser sign-in with. Every value is static: nothing here comes
/// from a request.
pub struct CliSpec {
    pub provider_id: &'static str,
    pub label: &'static str,
    /// Binary base name; on Windows `.exe`, `.cmd` and `.bat` are tried.
    pub binary: &'static str,
    pub args: &'static [&'static str],
    /// The command as a user would type it, shown in the UI and in short failure reasons.
    pub display: &'static str,
    pub install_url: &'static str,
    /// Sign-in links are only surfaced when they point at one of these hosts (or a subdomain).
    pub hosts: &'static [&'static str],
    kind: Kind,
    /// Where the finished login is stored (for Claude: the default config dir's credentials file).
    cred_file: fn() -> PathBuf,
    /// `Kind::App` only: the installed app's executable, at fixed per-OS locations.
    app_path: fn() -> Option<PathBuf>,
}

fn claude_default_cred() -> PathBuf {
    crate::readers::home().join(".claude").join(".credentials.json")
}

pub static CLAUDE: CliSpec = CliSpec {
    provider_id: "claudeAgent",
    label: "Claude Code",
    binary: "claude",
    args: &["auth", "login"],
    display: "claude auth login",
    install_url: "https://code.claude.com/docs/en/setup",
    hosts: &["claude.ai", "claude.com", "anthropic.com"],
    kind: Kind::Claude,
    cred_file: claude_default_cred,
    app_path: || None,
};

// `codex login` opens a ChatGPT browser sign-in (documented: https://developers.openai.com/codex/auth).
pub static CODEX: CliSpec = CliSpec {
    provider_id: "codex",
    label: "Codex",
    binary: "codex",
    args: &["login"],
    display: "codex login",
    install_url: "https://developers.openai.com/codex/cli",
    hosts: &["openai.com", "chatgpt.com"],
    kind: Kind::Codex,
    cred_file: crate::providers::codex::auth_file,
    app_path: || None,
};

// `grok login` is the Grok Build CLI's browser sign-in (documented: https://docs.x.ai/build/cli/reference).
pub static GROK: CliSpec = CliSpec {
    provider_id: "grok",
    label: "Grok",
    binary: "grok",
    args: &["login"],
    display: "grok login",
    install_url: "https://docs.x.ai/build/overview",
    hosts: &["x.ai", "grok.com"],
    kind: Kind::Grok,
    cred_file: crate::providers::grok::auth_file,
    app_path: || None,
};

fn app_no_path() -> PathBuf {
    PathBuf::new()
}

// Antigravity has no `login` command to run (its CLI signs in interactively on first use, its IDE in
// its own window). "Sign in" opens the installed app and waits: `Kind::App` above.
pub static ANTIGRAVITY: CliSpec = CliSpec {
    provider_id: "antigravity",
    label: "Antigravity",
    binary: "Antigravity",
    args: &[],
    display: "Antigravity",
    install_url: "https://antigravity.google/",
    hosts: &[],
    kind: Kind::App,
    cred_file: app_no_path,
    app_path: antigravity_app_path,
};

/// Fixed Antigravity IDE locations, most likely first. The installer changed its folder name
/// between releases, so every known variant is checked; nothing here comes from a request.
fn antigravity_app_paths(local_programs: Option<PathBuf>, program_files: Option<PathBuf>, home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        if let Some(base) = &local_programs {
            out.push(base.join("Antigravity IDE").join("Antigravity IDE.exe"));
            out.push(base.join("Antigravity").join("Antigravity.exe"));
        }
        if let Some(base) = &program_files {
            out.push(base.join("Google").join("Antigravity").join("Antigravity IDE.exe"));
            out.push(base.join("Antigravity").join("Antigravity.exe"));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (&local_programs, &program_files);
        out.push(home.join("Applications").join("Antigravity.app").join("Contents").join("MacOS").join("Antigravity"));
        out.push(PathBuf::from("/Applications/Antigravity.app/Contents/MacOS/Antigravity"));
        out.push(home.join(".local").join("bin").join("antigravity"));
        out.push(PathBuf::from("/usr/local/bin/antigravity"));
        out.push(PathBuf::from("/usr/bin/antigravity"));
        out.push(PathBuf::from("/snap/bin/antigravity"));
    }
    out
}

/// The installed Antigravity IDE, when its executable is in one of the known places.
fn antigravity_app_path() -> Option<PathBuf> {
    let local_programs = std::env::var_os("LOCALAPPDATA").map(|v| PathBuf::from(v).join("Programs"));
    let program_files = std::env::var_os("ProgramFiles")
        .or_else(|| std::env::var_os("PROGRAMFILES"))
        .map(PathBuf::from);
    antigravity_app_paths(local_programs, program_files, &crate::readers::home())
        .into_iter()
        .find(|p| p.is_file())
}

/// The CLI login for a provider id, when one is documented and detectable. Antigravity opens its
/// installed app instead of a CLI (see `ANTIGRAVITY`). Cursor (`agent login`), Gemini CLI and
/// OpenCode (`opencode auth login`) are deliberately absent: their login is either interactive or
/// stores credentials Burnrate does not read.
pub fn spec_for(provider_id: &str) -> Option<&'static CliSpec> {
    [&CLAUDE, &CODEX, &GROK, &ANTIGRAVITY].into_iter().find(|s| s.provider_id == provider_id)
}

/// How long an "is the CLI installed" answer is reused: `/api/providers` is polled by the UI.
const INSTALLED_TTL: Duration = Duration::from_secs(10);
static INSTALLED_CACHE: OnceLock<Mutex<HashMap<&'static str, (Instant, bool)>>> = OnceLock::new();

fn cli_installed(spec: &CliSpec) -> bool {
    let cache = INSTALLED_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    {
        let guard = cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, installed)) = guard.get(spec.binary) {
            if at.elapsed() < INSTALLED_TTL {
                return *installed;
            }
        }
    }
    // An app (Antigravity) lives at fixed per-user paths, not on PATH.
    let installed = match spec.kind {
        Kind::App => (spec.app_path)().is_some(),
        _ => resolve_binary(spec).is_some(),
    };
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(spec.binary, (Instant::now(), installed));
    installed
}

/// The `login` object of `GET /api/providers` for a provider; `Value::Null` when it has none.
pub fn login_info(provider_id: &str) -> Value {
    match spec_for(provider_id) {
        Some(spec) => json!({"kind": "cli", "command": spec.display, "installed": cli_installed(spec), "installUrl": spec.install_url}),
        None => Value::Null,
    }
}

/// Install page for a provider's CLI (sent with the `cli-not-found` error).
pub fn install_url(provider_id: &str) -> Option<&'static str> {
    spec_for(provider_id).map(|s| s.install_url)
}

/// Why a verification code could not be handed to the CLI.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SubmitError {
    InvalidCode,
    UnknownFlow,
    TerminalPhase,
    NoStdin,
}

struct Flow {
    spec: &'static CliSpec,
    dir: PathBuf,
    /// The file whose appearance (or change) means the sign-in finished.
    cred: PathBuf,
    /// Modification time of `cred` when the flow started: an older login is not a finished sign-in.
    baseline: Option<std::time::SystemTime>,
    timeout: Duration,
    hint_after: Duration,
    /// True only when *we* created `dir`. A pre-existing directory must never be cleaned up.
    created: bool,
    phase: Phase,
    url: Option<String>,
    error: Option<String>,
    started: Instant,
    /// When the flow reached a terminal phase, for pruning.
    finished_at: Option<Instant>,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    /// Capped CLI output, used only to find the sign-in URL. Never returned to the UI as an error.
    output: Arc<Mutex<String>>,
    /// `Kind::App` only: what the provider's data looked like when the flow started (whether any
    /// was on this computer, plus the change fingerprint from `app_data_state`).
    app_baseline: Option<(bool, u64)>,
}

#[derive(Default)]
struct Manager {
    flows: Mutex<HashMap<String, Flow>>,
}

static MANAGER: OnceLock<Manager> = OnceLock::new();
static ACCOUNTS_CACHE: OnceLock<Mutex<Option<(Instant, Vec<Value>)>>> = OnceLock::new();

fn manager() -> &'static Manager {
    MANAGER.get_or_init(Manager::default)
}

fn lock_flows() -> MutexGuard<'static, HashMap<String, Flow>> {
    manager().flows.lock().unwrap_or_else(|e| e.into_inner())
}

/// Same rule as the API-key account names in `main.rs`.
pub fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.ends_with('.')
        && !s.bytes().all(|c| c == b'.')
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}

/// Strip SGR/OSC control sequences. OSC-8 hyperlinks are unwrapped so the URI stays visible;
/// a separator is inserted so the following link text cannot be glued onto the URL.
fn clean_output(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != '\u{1b}' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        if i + 1 < chars.len() && chars[i + 1] == '[' {
            // CSI (e.g. SGR colours): skip parameters/intermediates through the final byte.
            i += 2;
            while i < chars.len() {
                let c = chars[i];
                i += 1;
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        } else if i + 1 < chars.len() && chars[i + 1] == ']' {
            // OSC: ends at BEL or ST (ESC \). Keep the URI of an OSC-8 link.
            let start = i + 2;
            let mut j = start;
            while j < chars.len() {
                if chars[j] == '\u{7}' {
                    break;
                }
                if chars[j] == '\u{1b}' && j + 1 < chars.len() && chars[j + 1] == '\\' {
                    break;
                }
                j += 1;
            }
            let sequence: String = chars[start..j].iter().collect();
            if let Some(rest) = sequence.strip_prefix("8;") {
                if let Some((_params, uri)) = rest.split_once(';') {
                    out.push_str(uri);
                    out.push(' ');
                }
            }
            i = if j < chars.len() {
                if chars[j] == '\u{7}' { j + 1 } else { j + 2 }
            } else {
                chars.len()
            };
        } else {
            i += 1; // stray ESC
        }
    }
    out
}

fn host_allowed(host: &str, hosts: &[&str]) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    hosts.iter().any(|base| host == *base || host.strip_suffix(base).is_some_and(|prefix| prefix.ends_with('.')))
}

/// Scan already-cleaned text for the first https URL on an allowed host.
fn scan_url(text: &str, hosts: &[&str]) -> Option<String> {
    let mut rest = text;
    loop {
        let pos = rest.find("https://")?;
        let tail = &rest[pos..];
        let end = tail
            .char_indices()
            .find(|&(_, c)| {
                c.is_whitespace()
                    || c.is_control()
                    || matches!(c, '"' | '\'' | '<' | '>' | '[' | ']' | '(' | ')' | '{' | '}' | '`' | '\\')
            })
            .map_or(tail.len(), |(i, _)| i);
        let mut url = &tail[..end];
        while url.ends_with(['.', ',', ';', ':', '!']) {
            url = &url[..url.len() - 1];
        }
        let after = &url["https://".len()..];
        let host_end = after.find(|c: char| matches!(c, '/' | '?' | '#' | ':')).unwrap_or(after.len());
        if host_allowed(&after[..host_end], hosts) {
            return Some(url.to_string());
        }
        rest = &tail["https://".len()..];
    }
}

/// A wrapped URL's next line starts with no whitespace and with URL-ish syntax (a query/path
/// continuation), not ordinary prose.
fn looks_like_continuation(token: &str) -> bool {
    let Some(first) = token.chars().next() else { return false };
    matches!(first, '&' | '=' | '?' | '/' | '%' | '.') || token.chars().any(|c| matches!(c, '&' | '=' | '?' | '/' | '%'))
}

/// Conservatively rejoin a URL a terminal wrapped onto the next line.
fn join_wrapped_urls(text: &str, hosts: &[&str]) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut token_start = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '\n' || c == '\r' {
            let next = if c == '\r' && i + 1 < chars.len() && chars[i + 1] == '\n' { i + 2 } else { i + 1 };
            let continuation: String = chars[next..].iter().take_while(|ch| !ch.is_whitespace() && !ch.is_control()).collect();
            if scan_url(&out[token_start..], hosts).is_some() && looks_like_continuation(&continuation) {
                i = next;
                continue;
            }
            out.push('\n');
            token_start = out.len();
            i = next;
            continue;
        }
        out.push(c);
        if c.is_whitespace() {
            token_start = out.len();
        }
        i += 1;
    }
    out
}

/// First browser sign-in link on one of `hosts` in CLI output.
pub fn first_https_url(text: &str, hosts: &[&str]) -> Option<String> {
    let cleaned = clean_output(text);
    let joined = join_wrapped_urls(&cleaned, hosts);
    scan_url(&joined, hosts)
}

/// A Claude config dir holds a login.
fn credentials_ready(dir: &Path) -> bool {
    let Ok(bytes) = std::fs::read(dir.join(".credentials.json")) else { return false };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { return false };
    value.pointer("/claudeAiOauth/accessToken").and_then(Value::as_str).is_some_and(|t| !t.trim().is_empty())
}

/// The login file at `path` holds a usable login for this kind of CLI.
fn cred_file_ready(kind: Kind, path: &Path) -> bool {
    match kind {
        Kind::Claude => path.parent().is_some_and(credentials_ready),
        Kind::Codex => crate::providers::codex::login_present(path),
        Kind::Grok => crate::providers::grok::login_present(path),
        // An app sign-in is not recognised by any one file; `flow_connected` decides.
        Kind::App => false,
    }
}

fn mtime(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Finished: the login file is valid and, when one already existed at the start (a re-login), it changed.
fn flow_connected(flow: &Flow) -> bool {
    match flow.spec.kind {
        Kind::App => {
            let Some((was_connected, baseline)) = flow.app_baseline else { return false };
            app_signin_done(was_connected, baseline, app_data_state(flow.spec))
        }
        _ => cred_file_ready(flow.spec.kind, &flow.cred)
            && match (flow.baseline, mtime(&flow.cred)) {
                (Some(before), Some(now)) => now > before,
                _ => true,
            },
    }
}

/// A finished app sign-in: the provider's data is on this computer, and it either appeared during
/// the flow (a first sign-in) or changed since it started (signing in and using the app again).
fn app_signin_done(was_connected: bool, baseline: u64, now: (bool, u64)) -> bool {
    now.0 && (!was_connected || now.1 != baseline)
}

/// What an app sign-in leaves visible to Burnrate: whether the provider's data is on this computer
/// at all, plus a cheap change fingerprint (its transcript count and total size).
fn app_data_state(spec: &CliSpec) -> (bool, u64) {
    let Some(reader) = crate::readers::all().into_iter().find(|r| r.provider() == spec.provider_id) else {
        return (false, 0);
    };
    let files = reader.files();
    let connected = reader.dir().exists() || !files.is_empty();
    let fingerprint = files.len() as u64 + files.iter().map(|f| f.size as u64).sum::<u64>();
    (connected, fingerprint)
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn binary_names(base: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![format!("{base}.exe"), format!("{base}.cmd"), format!("{base}.bat")]
    }
    #[cfg(not(windows))]
    {
        vec![base.to_string()]
    }
}

/// PATH in a GUI-launched server often misses the npm/native installer shims, so the usual
/// user-level install folders are searched too.
fn extra_bin_dirs() -> Vec<PathBuf> {
    let home = crate::readers::home();
    let mut dirs = vec![home.join(".local").join("bin"), home.join(".grok").join("bin"), home.join(".claude").join("local"), home.join(".bun").join("bin")];
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    dirs
}

fn resolve_binary(spec: &CliSpec) -> Option<PathBuf> {
    let names = binary_names(spec.binary);
    for name in &names {
        if let Some(path) = find_in_path(name) {
            return Some(path);
        }
    }
    for dir in extra_bin_dirs() {
        for name in &names {
            let path = dir.join(name);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// A 128-bit random id: the GET status route has no CSRF header check, so a guessable id would let
/// any local process poll another flow's sign-in URL and state.
fn next_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

/// Remove only the two directories we may have created, never recursively, and only when there
/// are no credentials to preserve. An empty/non-empty leftover is harmless.
fn cleanup_new_dir(dir: &Path, created: bool) {
    if !created || credentials_ready(dir) {
        return;
    }
    let _ = std::fs::remove_dir(dir.join("projects"));
    let _ = std::fs::remove_dir(dir);
}

fn cleanup_created_dir(flow: &Flow) {
    cleanup_new_dir(&flow.dir, flow.created);
}

/// Finished flows vanish after ten minutes; a flow that never finishes is kept for at most an
/// hour so a wedged entry cannot accumulate forever.
fn prune_locked(flows: &mut HashMap<String, Flow>) {
    flows.retain(|_, f| match f.finished_at {
        Some(at) => at.elapsed() < Duration::from_secs(600),
        None => f.started.elapsed() < Duration::from_secs(3600),
    });
}

/// Start `claude auth login` for a named extra account (the original Claude-only entry point).
pub fn start(name: &str) -> Result<String, StartError> {
    start_spec(&CLAUDE, Some(name), false)
}

/// Start a provider's sign-in. CLI providers run their own `login` command; `name` only matters for
/// Claude (one config dir per account), and `force` re-runs the login although one exists.
pub fn start_login(provider_id: &str, name: Option<&str>, force: bool) -> Result<String, StartError> {
    let spec = spec_for(provider_id).ok_or(StartError::NotSupported)?;
    start_spec(spec, name, force)
}

/// First `~/.claude-account-N` that holds no login: the name for "add another Claude account".
fn next_claude_name() -> String {
    let home = crate::readers::home();
    (2..100).map(|n| format!("account-{n}")).find(|n| !credentials_ready(&home.join(format!(".claude-{n}")))).unwrap_or_else(|| "account-100".into())
}

fn start_spec(spec: &'static CliSpec, name: Option<&str>, force: bool) -> Result<String, StartError> {
    let (dir, cred) = match spec.kind {
        Kind::App => {
            // Nothing of ours to ask for or check: open the installed app and wait.
            let app = (spec.app_path)().ok_or(StartError::CliNotFound)?;
            return launch_app(spec, &app);
        }
        Kind::Claude => {
            let home = crate::readers::home();
            let default_dir = home.join(".claude");
            let dir = match name.map(str::trim).filter(|n| !n.is_empty()) {
                Some(name) if valid_name(name) => home.join(format!(".claude-{name}")),
                Some(_) => return Err(StartError::InvalidName),
                // No name: the CLI's own folder first, then extra accounts.
                // `force` (renewing the main login) must sign in to the same folder again, not to a new one.
                None if force || !credentials_ready(&default_dir) => default_dir,
                None => home.join(format!(".claude-{}", next_claude_name())),
            };
            let cred = dir.join(".credentials.json");
            (dir, cred)
        }
        Kind::Codex | Kind::Grok => {
            let cred = (spec.cred_file)();
            (cred.parent().map(Path::to_path_buf).unwrap_or_default(), cred)
        }
    };
    if !force && cred_file_ready(spec.kind, &cred) {
        return Err(StartError::AlreadyConnected);
    }
    let binary = resolve_binary(spec).ok_or(StartError::CliNotFound)?;
    launch(spec, &binary, dir, cred, Tuning { timeout: TIMEOUT, hint_after: BROWSER_HINT_AFTER })
}

struct Tuning {
    timeout: Duration,
    hint_after: Duration,
}

/// Spawn the CLI and register the flow. The returned id is polled through `status`.
fn launch(spec: &'static CliSpec, binary: &Path, dir: PathBuf, cred: PathBuf, tuning: Tuning) -> Result<String, StartError> {
    let mut flows = lock_flows();
    prune_locked(&mut flows);
    let active: Vec<_> = flows.iter().filter(|(_, f)| f.phase.is_active()).collect();
    if active.len() >= MAX_ACTIVE_FLOWS {
        return Err(StartError::TooManyFlows);
    }
    if active.iter().any(|(_, f)| f.cred == cred) {
        return Err(StartError::AlreadyRunning);
    }

    // Only a Claude config dir is ours to create (and to clean up again); a Codex/Grok home belongs
    // to the user's own CLI.
    let created = spec.kind == Kind::Claude && !dir.exists();
    if spec.kind == Kind::Claude && std::fs::create_dir_all(dir.join("projects")).is_err() {
        cleanup_new_dir(&dir, created);
        return Err(StartError::SpawnFailed);
    }
    let baseline = mtime(&cred);

    let mut cmd = Command::new(binary);
    cmd.args(spec.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if spec.kind == Kind::Claude {
        // The CLI's own default folder needs no override: it then behaves exactly like `claude auth login`.
        if dir != crate::readers::home().join(".claude") {
            cmd.env("CLAUDE_CONFIG_DIR", &dir);
        }
        for var in HOST_SESSION_VARS {
            cmd.env_remove(var);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Keep a console window from flashing up behind the web UI.
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(_) => {
            cleanup_new_dir(&dir, created);
            return Err(StartError::SpawnFailed);
        }
    };
    let stdin = child.stdin.take();
    let output = Arc::new(Mutex::new(String::new()));
    if let Some(stream) = child.stdout.take() {
        capture(stream, Arc::clone(&output));
    }
    if let Some(stream) = child.stderr.take() {
        capture(stream, output.clone());
    }

    let id = next_id();
    let flow = Flow {
        spec,
        dir,
        cred,
        baseline,
        timeout: tuning.timeout,
        hint_after: tuning.hint_after,
        created,
        phase: Phase::Starting,
        url: None,
        error: None,
        started: Instant::now(),
        finished_at: None,
        child: Some(child),
        stdin,
        output,
        app_baseline: None,
    };
    flows.insert(id.clone(), flow);
    drop(flows);
    invalidate_accounts_cache();
    let watched = id.clone();
    std::thread::spawn(move || monitor(watched));
    Ok(id)
}

/// Open a `Kind::App` provider's own app (Antigravity) and register a flow that waits for data
/// Burnrate can read to appear or change. From the first moment the process belongs to the user:
/// the flow holds no handle to it, so cancelling or a timeout never closes the app.
fn launch_app(spec: &'static CliSpec, app: &Path) -> Result<String, StartError> {
    let mut flows = lock_flows();
    prune_locked(&mut flows);
    let active: Vec<_> = flows.iter().filter(|(_, f)| f.phase.is_active()).collect();
    if active.len() >= MAX_ACTIVE_FLOWS {
        return Err(StartError::TooManyFlows);
    }
    if active.iter().any(|(_, f)| f.spec.provider_id == spec.provider_id) {
        return Err(StartError::AlreadyRunning);
    }
    let mut cmd = Command::new(app);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: the app opens its own window
    }
    if cmd.spawn().is_err() {
        return Err(StartError::SpawnFailed);
    }
    let id = next_id();
    let flow = Flow {
        spec,
        dir: app.to_path_buf(),
        cred: PathBuf::new(),
        baseline: None,
        timeout: TIMEOUT,
        hint_after: BROWSER_HINT_AFTER,
        created: false,
        phase: Phase::Starting,
        url: None,
        error: None,
        started: Instant::now(),
        finished_at: None,
        child: None,
        stdin: None,
        output: Arc::new(Mutex::new(String::new())),
        app_baseline: Some(app_data_state(spec)),
    };
    flows.insert(id.clone(), flow);
    drop(flows);
    invalidate_accounts_cache();
    let watched = id.clone();
    std::thread::spawn(move || monitor(watched));
    Ok(id)
}

fn capture(mut stream: impl Read + Send + 'static, sink: Arc<Mutex<String>>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut text = sink.lock().unwrap_or_else(|e| e.into_inner());
                    if text.len() < MAX_OUTPUT {
                        let remaining = MAX_OUTPUT - text.len();
                        // Keep `remaining` on a UTF-8 boundary: never truncate inside a char.
                        let mut take = n.min(remaining);
                        while take > 0 && !std::str::from_utf8(&buf[..take]).is_ok() {
                            take -= 1;
                        }
                        text.push_str(&String::from_utf8_lossy(&buf[..take]));
                    }
                }
            }
        }
    });
}

/// Stop the child and leave a short, token-free reason for the terminal phase.
fn finish(flow: &mut Flow, phase: Phase, error: Option<&str>) {
    flow.phase = phase;
    flow.error = error.map(str::to_string);
    flow.finished_at = Some(Instant::now());
    flow.stdin.take();
    // Release the capped CLI output as soon as the flow is terminal.
    *flow.output.lock().unwrap_or_else(|e| e.into_inner()) = String::new();
    flow.output = Arc::new(Mutex::new(String::new()));
    if let Some(child) = flow.child.as_mut() {
        kill_child_tree(child);
        let _ = child.wait();
    }
    flow.child.take();
}

/// Kill the whole tree on Windows so no detached CLI child survives a cancel/timeout.
fn kill_child_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut killer = Command::new("taskkill");
        killer
            .arg("/PID")
            .arg(child.id().to_string())
            .arg("/T")
            .arg("/F")
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = killer.status();
    }
    let _ = child.kill();
}

/// Give a freshly connected CLI a short grace period to write `.claude.json` before stopping it.
fn spawn_grace(child: Option<Child>) {
    if let Some(mut child) = child {
        std::thread::spawn(move || {
            let deadline = Instant::now() + GRACE;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {}
                    Err(_) => {
                        let _ = child.kill();
                        break;
                    }
                }
                if Instant::now() >= deadline {
                    kill_child_tree(&mut child);
                    break;
                }
                std::thread::sleep(POLL);
            }
            let _ = child.wait();
            // The account label (displayName / e-mail) may only have landed during the grace.
            invalidate_accounts_cache();
        });
    }
}

fn monitor(id: String) {
    // An app sign-in reads folders on disk to see progress; give that a slower cadence.
    let mut tick = 0u32;
    loop {
        std::thread::sleep(POLL);
        let mut flows = lock_flows();
        let Some(flow) = flows.get_mut(&id) else { return };
        if !flow.phase.is_active() {
            return;
        }
        if flow.spec.kind == Kind::App {
            tick = tick.wrapping_add(1);
            if tick % 4 != 0 {
                continue;
            }
        }
        if flow.url.is_none() {
            let text = flow.output.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(url) = first_https_url(&text, flow.spec.hosts) {
                flow.url = Some(url);
                if flow.phase == Phase::Starting {
                    flow.phase = Phase::WaitingForBrowser;
                }
            }
        }
        // A CLI that opens the browser itself may never print a link: say so after a moment.
        if flow.phase == Phase::Starting && flow.started.elapsed() >= flow.hint_after {
            flow.phase = Phase::WaitingForBrowser;
        }
        if flow_connected(flow) {
            // Connected is terminal: mark it immediately and free the flow's output, but take the
            // child out so it can finish writing `.claude.json` during a short grace period.
            flow.phase = Phase::Connected;
            flow.error = None;
            flow.finished_at = Some(Instant::now());
            flow.stdin.take();
            *flow.output.lock().unwrap_or_else(|e| e.into_inner()) = String::new();
            let child = flow.child.take();
            invalidate_accounts_cache();
            drop(flows);
            spawn_grace(child);
            return;
        }
        if flow.started.elapsed() >= flow.timeout {
            let reason = if flow.spec.kind == Kind::App {
                // Static wording only: the app is a window the user owns, not a CLI that exited.
                format!("{} showed no new activity. Sign in inside it, use it once, and its usage appears here.", flow.spec.label)
            } else {
                "Sign-in took too long. Start it again.".to_string()
            };
            finish(flow, Phase::Failed, Some(&reason));
            cleanup_created_dir(flow);
            return;
        }
        if let Some(status) = flow.child.as_mut().and_then(|child| child.try_wait().ok()).flatten() {
            // Static wording only: CLI output may hold tokens and is never echoed back.
            let reason = if status.success() {
                // Codex can keep its login in the system keyring, which Burnrate does not read.
                format!("{} finished, but Burnrate found no login. The CLI may keep it in the system keyring, which Burnrate cannot read.", flow.spec.display)
            } else {
                format!("{} stopped before sign-in finished. Try again.", flow.spec.display)
            };
            finish(flow, Phase::Failed, Some(&reason));
            cleanup_created_dir(flow);
            return;
        }
    }
}

pub fn status(id: &str) -> Option<Value> {
    let mut flows = lock_flows();
    prune_locked(&mut flows);
    let flow = flows.get(id)?;
    let mut out = json!({"state": flow.phase.as_str(), "providerId": flow.spec.provider_id});
    if let Some(url) = &flow.url {
        out["url"] = json!(url);
    }
    if let Some(error) = &flow.error {
        out["error"] = json!(error);
    }
    Some(out)
}

/// Feed a pasted verification code to the running CLI (it may prompt for one).
pub fn submit_code(id: &str, code: &str) -> Result<(), SubmitError> {
    if code.is_empty() || code.len() > 512 || code.chars().any(|c| c == '\n' || c == '\r') {
        return Err(SubmitError::InvalidCode);
    }
    let stdin = {
        let mut flows = lock_flows();
        let Some(flow) = flows.get_mut(id) else { return Err(SubmitError::UnknownFlow) };
        if !flow.phase.is_active() {
            return Err(SubmitError::TerminalPhase);
        }
        flow.stdin.take().ok_or(SubmitError::NoStdin)?
    };
    let mut stdin = stdin;
    let payload = format!("{}\n", code.trim());
    let written = stdin.write_all(payload.as_bytes()).is_ok() && stdin.flush().is_ok();
    // Put the pipe back unless the flow has finished in the meantime.
    let mut flows = lock_flows();
    if let Some(flow) = flows.get_mut(id) {
        if flow.phase.is_active() {
            flow.stdin = Some(stdin);
        }
    }
    if written { Ok(()) } else { Err(SubmitError::NoStdin) }
}

/// Cancel a flow. The config dir is removed only when we created it and it holds no credentials.
pub fn cancel(id: &str) -> bool {
    let mut flows = lock_flows();
    let Some(flow) = flows.get_mut(id) else { return false };
    // Terminal phases are final; a second cancel must not rewrite them.
    if !flow.phase.is_active() {
        return true;
    }
    finish(flow, Phase::Cancelled, None);
    cleanup_created_dir(flow);
    invalidate_accounts_cache();
    true
}

fn claude_accounts_uncached() -> Vec<Value> {
    let default_dir = crate::readers::home().join(".claude");
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for dir in crate::readers::claude_config_dirs() {
        if !credentials_ready(&dir) {
            continue;
        }
        let id = dir
            .file_name()
            .map(|n| n.to_string_lossy().trim_start_matches('.').to_string())
            .unwrap_or_else(|| "claude".into());
        if !seen.insert(id.clone()) {
            continue;
        }
        let account_file = if dir == default_dir { crate::readers::home().join(".claude.json") } else { dir.join(".claude.json") };
        let label = crate::providers::read_json(&account_file)
            .and_then(|v| v.pointer("/oauthAccount/displayName").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()).map(str::to_string))
            .unwrap_or_else(|| id.clone());
        out.push(json!({"id": id, "label": label}));
    }
    out
}

/// Accounts for the `localLogin` provider info: one per config dir holding a Claude login.
/// Cached briefly because every call walks the home directory.
pub fn claude_accounts() -> Vec<Value> {
    let cache = ACCOUNTS_CACHE.get_or_init(|| Mutex::new(None));
    {
        let guard = cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, accounts)) = &*guard {
            if at.elapsed() < ACCOUNTS_CACHE_TTL {
                return accounts.clone();
            }
        }
    }
    let fresh = claude_accounts_uncached();
    *cache.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), fresh.clone()));
    fresh
}

pub fn invalidate_accounts_cache() {
    if let Some(cache) = ACCOUNTS_CACHE.get() {
        *cache.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Sign out one account by deleting only its credentials file; transcripts are left alone.
pub fn claude_signout(id: &str) -> bool {
    let id = id.trim();
    if !valid_name(id) || (id != "claude" && !id.starts_with("claude-")) {
        return false;
    }
    let credentials = crate::readers::home().join(format!(".{id}")).join(".credentials.json");
    if !credentials.exists() {
        return true;
    }
    let removed = std::fs::remove_file(credentials).is_ok();
    if removed {
        invalidate_accounts_cache();
    }
    removed
}

/// Why a Codex sign-out did nothing.
#[derive(Debug, PartialEq, Eq)]
pub enum CodexSignoutError {
    /// `auth.json` holds no ChatGPT login (missing, or only an API key): nothing of ours to remove.
    NoLogin,
    /// The file could not be deleted (in use, read-only, permissions).
    Failed,
}

/// Signs Codex out the way `codex logout` does: deletes the `auth.json` the Codex CLI keeps its ChatGPT
/// login in. That file belongs to Codex, so this is only ever called from an explicit, confirmed click,
/// and only when the file really holds a ChatGPT login (an API-key-only file is left alone).
pub fn codex_signout_file(path: &std::path::Path) -> Result<(), CodexSignoutError> {
    if !crate::providers::codex::login_present(path) {
        return Err(CodexSignoutError::NoLogin);
    }
    std::fs::remove_file(path).map_err(|_| CodexSignoutError::Failed)
}

/// `codex_signout_file` on the Codex CLI's own login file (`CODEX_HOME` or `~/.codex`).
pub fn codex_signout() -> Result<(), CodexSignoutError> {
    codex_signout_file(&crate::providers::codex::auth_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_signout_deletes_only_a_real_chatgpt_login() {
        let dir = std::env::temp_dir().join(format!("burnrate-codex-signout-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("auth.json");
        // Missing file: nothing to do, and nothing is created.
        let _ = std::fs::remove_file(&file);
        assert_eq!(codex_signout_file(&file), Err(CodexSignoutError::NoLogin));
        // An API-key-only file is not a ChatGPT login: left untouched.
        std::fs::write(&file, r#"{"OPENAI_API_KEY":"sk-test"}"#).unwrap();
        assert_eq!(codex_signout_file(&file), Err(CodexSignoutError::NoLogin));
        assert!(file.exists());
        // A ChatGPT login is removed, exactly like `codex logout`.
        std::fs::write(&file, r#"{"tokens":{"access_token":"tok"}}"#).unwrap();
        assert_eq!(codex_signout_file(&file), Ok(()));
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_first_https_link_from_cli_output() {
        let output = "\u{1b}[2KOpening browser: \u{1b}[4mhttps://claude.ai/oauth/authorize?state=x\u{1b}[0m (copied)\nhttps://example.com/later";
        assert_eq!(first_https_url(output, CLAUDE.hosts), Some("https://claude.ai/oauth/authorize?state=x".into()));
    }

    #[test]
    fn ignores_incomplete_and_non_https_links() {
        assert_eq!(first_https_url("visit https:// then http://example.com", CLAUDE.hosts), None);
        assert_eq!(first_https_url("no links here", CLAUDE.hosts), None);
        assert_eq!(first_https_url("url: https://claude.ai/oauth.", CLAUDE.hosts), Some("https://claude.ai/oauth".into()));
    }

    #[test]
    fn accepts_only_anthropic_hosts() {
        assert_eq!(first_https_url("go to https://sub.claude.ai/oauth?x=1 now", CLAUDE.hosts), Some("https://sub.claude.ai/oauth?x=1".into()));
        assert_eq!(first_https_url("https://claude.com/x", CLAUDE.hosts), Some("https://claude.com/x".into()));
        assert_eq!(first_https_url("https://anthropic.com/x", CLAUDE.hosts), Some("https://anthropic.com/x".into()));
        assert_eq!(first_https_url("https://evilclaude.ai/x", CLAUDE.hosts), None);
        assert_eq!(first_https_url("https://claude.ai.evil.test/x", CLAUDE.hosts), None);
        assert_eq!(first_https_url("http://claude.ai/x", CLAUDE.hosts), None);
    }

    #[test]
    fn reads_osc8_hyperlinks() {
        let output = "\u{1b}]8;;https://claude.ai/oauth/authorize?state=x\u{1b}\\Click here\u{1b}]8;;\u{1b}\\";
        assert_eq!(first_https_url(output, CLAUDE.hosts), Some("https://claude.ai/oauth/authorize?state=x".into()));
        let bel = "\u{1b}]8;;https://claude.com/oauth\u{7}link\u{1b}]8;;\u{7}";
        assert_eq!(first_https_url(bel, CLAUDE.hosts), Some("https://claude.com/oauth".into()));
    }

    #[test]
    fn cuts_url_at_control_characters() {
        assert_eq!(first_https_url("https://claude.ai/oauth\u{0}junk", CLAUDE.hosts), Some("https://claude.ai/oauth".into()));
        assert_eq!(first_https_url("https://claude.ai/oauth\u{7}junk", CLAUDE.hosts), Some("https://claude.ai/oauth".into()));
    }

    #[test]
    fn rejoins_wrapped_urls_conservatively() {
        assert_eq!(
            first_https_url("Opening https://claude.ai/oauth/authorize?state=abc\ndef=ghi now", CLAUDE.hosts),
            Some("https://claude.ai/oauth/authorize?state=abcdef=ghi".into())
        );
        assert_eq!(first_https_url("https://claude.ai/oauth\nSome prose here", CLAUDE.hosts), Some("https://claude.ai/oauth".into()));
    }

    #[test]
    fn flow_ids_are_random_128_bit_hex() {
        let a = next_id();
        let b = next_id();
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "flow ids must not be guessable from a counter or timestamp");
    }

    #[test]
    fn validates_account_names() {
        for name in ["work", "claude-work", "a.b_c-1", "W"] {
            assert!(valid_name(name), "{name} should be valid");
        }
        for name in ["", "has space", "../etc", "a/b", "clé", &"x".repeat(65), ".", "..", "...", "work."] {
            assert!(!valid_name(name), "{name} should be invalid");
        }
    }

    fn test_flow(dir: PathBuf, phase: Phase, created: bool) -> String {
        let flow = Flow {
            spec: &CODEX,
            cred: dir.join("auth.json"),
            baseline: None,
            timeout: TIMEOUT,
            hint_after: BROWSER_HINT_AFTER,
            dir,
            created,
            phase,
            url: None,
            error: None,
            started: Instant::now(),
            finished_at: None,
            child: None,
            stdin: None,
            output: Arc::new(Mutex::new(String::new())),
            app_baseline: None,
        };
        let id = next_id();
        lock_flows().insert(id.clone(), flow);
        id
    }

    #[test]
    fn cancel_does_not_remove_a_preexisting_dir() {
        let dir = std::env::temp_dir().join(format!("burnrate-accounts-preexisting-{}", next_id()));
        let projects = dir.join("projects");
        let _ = std::fs::create_dir_all(&projects);
        let keep = projects.join("keep.txt");
        std::fs::write(&keep, b"keep").expect("test file");

        let id = test_flow(dir.clone(), Phase::WaitingForBrowser, false);
        assert!(cancel(&id));
        assert!(keep.exists(), "a pre-existing config dir must survive cancel");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_does_not_overwrite_a_terminal_phase() {
        let dir = std::env::temp_dir().join(format!("burnrate-accounts-terminal-{}", next_id()));
        let id = test_flow(dir.clone(), Phase::Connected, false);
        assert!(cancel(&id));
        assert_eq!(lock_flows().get(&id).map(|f| f.phase), Some(Phase::Connected));
    }

    #[test]
    fn capture_never_truncates_inside_a_multibyte_char() {
        let sink = Arc::new(Mutex::new(String::new()));
        {
            let mut guard = sink.lock().unwrap();
            let bytes = "é".repeat(MAX_OUTPUT / 2 + 4);
            let remaining = MAX_OUTPUT - guard.len();
            let mut take = bytes.len().min(remaining);
            while take > 0 && std::str::from_utf8(&bytes.as_bytes()[..take]).is_err() {
                take -= 1;
            }
            guard.push_str(&String::from_utf8_lossy(&bytes.as_bytes()[..take]));
        }
        assert!(sink.lock().unwrap().len() <= MAX_OUTPUT);
    }

    // ------------------------------------------------------------ generic CLI login runner

    /// The active-flow cap is global, so tests that start real flows run one at a time.
    static FLOW_SERIAL: Mutex<()> = Mutex::new(());

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("burnrate-login-{tag}-{}", next_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn missing_cred() -> PathBuf {
        std::env::temp_dir().join("burnrate-login-missing").join("auth.json")
    }

    /// A CLI that is not installed anywhere (the binary name cannot exist on any machine).
    static MISSING_CLI: CliSpec = CliSpec {
        provider_id: "fake-missing",
        label: "Fake",
        binary: "burnrate-no-such-cli-7f3a",
        args: &["login"],
        display: "fake login",
        install_url: "https://example.com/install",
        hosts: &["openai.com"],
        kind: Kind::Codex,
        cred_file: missing_cred,
        app_path: || None,
    };

    static FAKE_CLI: CliSpec = CliSpec {
        provider_id: "fake",
        label: "Fake",
        binary: "burnrate-fake-login",
        args: &[],
        display: "fake login",
        install_url: "https://example.com/install",
        hosts: &["openai.com"],
        kind: Kind::Codex,
        cred_file: missing_cred,
        app_path: || None,
    };

    /// An app whose executable can never be found. Kind::App data detection looks the provider's
    /// reader up by id, so a made-up id also keeps these flows independent of this machine.
    static MISSING_APP: CliSpec = CliSpec {
        provider_id: "fake-app-missing",
        label: "Fake App",
        binary: "burnrate-no-such-app",
        args: &[],
        display: "fake App",
        install_url: "https://example.com/app",
        hosts: &[],
        kind: Kind::App,
        cred_file: missing_cred,
        app_path: || None,
    };

    /// Writes a stand-in login CLI next to its `auth.json`; `body` is the script (cmd / sh).
    fn fake_cli(dir: &Path, cmd_body: &str, sh_body: &str) -> PathBuf {
        #[cfg(windows)]
        {
            let script = dir.join("fake-login.cmd");
            std::fs::write(&script, format!("@echo off\r\n{cmd_body}\r\n")).expect("script");
            script
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.join("fake-login.sh");
            std::fs::write(&script, format!("#!/bin/sh\n{sh_body}\n")).expect("script");
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            script
        }
    }

    fn wait_for(id: &str, wanted: &str, secs: u64) -> Value {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            let state = status(id).expect("flow exists");
            if state["state"] == wanted || Instant::now() >= deadline {
                return state;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    const LOGIN_WRITES_AUTH: &str = r#"{"tokens":{"access_token":"throwaway-not-a-real-token"}}"#;

    #[test]
    fn missing_cli_is_reported_before_anything_is_started() {
        assert_eq!(start_spec(&MISSING_CLI, None, false), Err(StartError::CliNotFound));
        assert_eq!(start_login("no-such-provider", None, false), Err(StartError::NotSupported));
        // Providers without a sign-in Burnrate can start have no flow at all.
        for id in ["cursor", "opencode", "opencode-go", "gemini", "mistral"] {
            assert!(spec_for(id).is_none(), "{id} must not claim a sign-in");
            assert_eq!(login_info(id), Value::Null);
        }
        // Antigravity is offered: its sign-in opens the installed app (Kind::App, not a CLI).
        assert!(spec_for("antigravity").is_some_and(|s| s.provider_id == "antigravity"));
        assert_eq!(login_info("antigravity")["command"], "Antigravity");
        // An app that is not installed fails the same honest way, before anything is started.
        assert_eq!(start_spec(&MISSING_APP, None, false), Err(StartError::CliNotFound));
    }

    #[test]
    fn antigravity_locations_cover_the_known_installer_variants_in_order() {
        let home = std::env::temp_dir().join(format!("burnrate-antigravity-apps-{}", std::process::id()));
        let paths = antigravity_app_paths(Some(home.join("local").join("Programs")), Some(home.join("programfiles")), &home);
        #[cfg(windows)]
        {
            assert_eq!(
                paths,
                vec![
                    home.join("local").join("Programs").join("Antigravity IDE").join("Antigravity IDE.exe"),
                    home.join("local").join("Programs").join("Antigravity").join("Antigravity.exe"),
                    home.join("programfiles").join("Google").join("Antigravity").join("Antigravity IDE.exe"),
                    home.join("programfiles").join("Antigravity").join("Antigravity.exe"),
                ]
            );
        }
        #[cfg(not(windows))]
        {
            // The user's own Applications folder wins over the machine-wide one on macOS.
            assert_eq!(paths[0], home.join("Applications").join("Antigravity.app").join("Contents").join("MacOS").join("Antigravity"));
            assert_eq!(paths[1], PathBuf::from("/Applications/Antigravity.app/Contents/MacOS/Antigravity"));
            assert!(paths.contains(&PathBuf::from("/usr/bin/antigravity")));
        }
    }

    /// A finished app sign-in: data appeared (fresh) or changed (a re-login).
    #[test]
    fn an_app_signin_needs_new_or_changed_data() {
        // Data appeared during the flow: connected, whether or not any existed before.
        assert!(!app_signin_done(true, 3, (true, 3)), "nothing changed on a re-login");
        assert!(app_signin_done(true, 3, (true, 4)), "the data changed");
        assert!(app_signin_done(false, 0, (true, 0)), "data appeared where none was");
        // Still nothing on this computer: not connected.
        assert!(!app_signin_done(false, 0, (false, 0)));
        assert!(!app_signin_done(true, 0, (false, 0)));
    }

    #[test]
    fn app_signin_opens_the_app_and_waits_without_owning_it() {
        let _serial = FLOW_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        static FAKE_APP_PATH: OnceLock<PathBuf> = OnceLock::new();
        // The stand-in "app" exits at once: the flow does not track it, so the exit changes nothing.
        static FAKE_APP: CliSpec = CliSpec {
            provider_id: "fake-app",
            label: "Fake App",
            binary: "burnrate-fake-app",
            args: &[],
            display: "Fake App",
            install_url: "https://example.com/app",
            hosts: &[],
            kind: Kind::App,
            cred_file: missing_cred,
            app_path: || FAKE_APP_PATH.get().cloned(),
        };
        let dir = temp_dir("app");
        let script = fake_cli(&dir, "exit /b 0", "exit 0");
        let _ = FAKE_APP_PATH.set(script);
        let id = start_spec(&FAKE_APP, None, false).expect("starts");
        // No browser link is expected: the user signs in inside the app's own window.
        let waiting = wait_for(&id, "waitingForBrowser", 10);
        assert_eq!(waiting["state"], "waitingForBrowser");
        assert_eq!(waiting["providerId"], "fake-app");
        assert!(waiting.get("url").is_none());
        // Cancelling only stops waiting: the app itself stays open, so nothing is killed.
        assert!(cancel(&id));
        assert_eq!(status(&id).unwrap()["state"], "cancelled");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn login_info_describes_the_cli_and_where_to_install_it() {
        for (id, command) in [("claudeAgent", "claude auth login"), ("codex", "codex login"), ("grok", "grok login"), ("antigravity", "Antigravity")] {
            let info = login_info(id);
            assert_eq!(info["kind"], "cli");
            assert_eq!(info["command"], command);
            assert!(info["installed"].is_boolean(), "{id} reports whether its sign-in helper is installed");
            assert!(info["installUrl"].as_str().is_some_and(|u| u.starts_with("https://")));
            assert_eq!(install_url(id), info["installUrl"].as_str());
        }
        // Antigravity's helper is its IDE, at fixed per-user paths, and its download page is real.
        assert_eq!(ANTIGRAVITY.install_url, "https://antigravity.google/");
        assert!(ANTIGRAVITY.hosts.is_empty(), "an app sign-in never surfaces a browser link");
    }

    #[test]
    fn cli_login_hosts_are_per_provider() {
        let claude = "open https://claude.ai/oauth/authorize?x=1 and https://auth.openai.com/oauth/authorize?y=2";
        assert_eq!(first_https_url(claude, CLAUDE.hosts), Some("https://claude.ai/oauth/authorize?x=1".into()));
        assert_eq!(first_https_url(claude, CODEX.hosts), Some("https://auth.openai.com/oauth/authorize?y=2".into()));
        assert_eq!(first_https_url("https://chatgpt.com/auth", CODEX.hosts), Some("https://chatgpt.com/auth".into()));
        assert_eq!(first_https_url("https://claude.ai/x", CODEX.hosts), None, "another provider's host is not allowed");
        assert_eq!(first_https_url("https://evilopenai.com/x", CODEX.hosts), None);
        assert_eq!(first_https_url("https://openai.com.evil.test/x", CODEX.hosts), None);
        assert_eq!(first_https_url("https://auth.x.ai/oauth2/auth?z=1", GROK.hosts), Some("https://auth.x.ai/oauth2/auth?z=1".into()));
        assert_eq!(first_https_url("https://auth.openai.com/x", GROK.hosts), None);
    }

    #[test]
    fn a_finished_login_must_be_valid_and_newer_than_the_old_one() {
        let dir = temp_dir("baseline");
        let cred = dir.join("auth.json");
        let mut flow_for = |baseline| Flow {
            spec: &CODEX,
            dir: dir.clone(),
            cred: cred.clone(),
            baseline,
            timeout: TIMEOUT,
            hint_after: BROWSER_HINT_AFTER,
            created: false,
            phase: Phase::WaitingForBrowser,
            url: None,
            error: None,
            started: Instant::now(),
            finished_at: None,
            child: None,
            stdin: None,
            output: Arc::new(Mutex::new(String::new())),
            app_baseline: None,
        };
        assert!(!flow_connected(&flow_for(None)), "no file yet");
        std::fs::write(&cred, br#"{"OPENAI_API_KEY":"k"}"#).unwrap();
        assert!(!flow_connected(&flow_for(None)), "an API key is not a ChatGPT login");
        std::fs::write(&cred, LOGIN_WRITES_AUTH).unwrap();
        assert!(flow_connected(&flow_for(None)), "fresh login");
        let existing = mtime(&cred);
        assert!(!flow_connected(&flow_for(existing)), "the login that was there before the flow started");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn connected_cli_flow_goes_starting_to_waiting_to_connected() {
        let _serial = FLOW_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("connected");
        let cred = dir.join("auth.json");
        let script = fake_cli(
            &dir,
            &format!("echo Open https://auth.openai.com/oauth/authorize?state=abc\r\nping -n 3 127.0.0.1 >nul\r\necho {LOGIN_WRITES_AUTH}> \"%~dp0auth.json\"\r\nping -n 60 127.0.0.1 >nul"),
            &format!("echo 'Open https://auth.openai.com/oauth/authorize?state=abc'\nsleep 1\necho '{LOGIN_WRITES_AUTH}' > \"$(dirname \"$0\")/auth.json\"\nsleep 60"),
        );
        let id = launch(&FAKE_CLI, &script, dir.clone(), cred.clone(), Tuning { timeout: TIMEOUT, hint_after: BROWSER_HINT_AFTER }).expect("starts");
        let waiting = wait_for(&id, "waitingForBrowser", 10);
        assert_eq!(waiting["state"], "waitingForBrowser");
        assert_eq!(waiting["url"], "https://auth.openai.com/oauth/authorize?state=abc");
        assert_eq!(waiting["providerId"], "fake");
        let connected = wait_for(&id, "connected", 15);
        assert_eq!(connected["state"], "connected");
        assert!(connected.get("error").is_none());
        // The CLI's own output (which may hold tokens) is never part of a status.
        assert!(!connected.to_string().contains("throwaway"));
        // Terminal phases are final.
        assert!(cancel(&id));
        assert_eq!(status(&id).unwrap()["state"], "connected");
        // Nothing but the stand-in CLI's own files may appear in a Codex/Grok home.
        assert!(!dir.join("projects").exists());
        std::thread::sleep(GRACE + Duration::from_millis(500));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cli_that_exits_without_a_login_fails_with_a_static_reason() {
        let _serial = FLOW_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("exits");
        let script = fake_cli(&dir, "echo secret-token-1234 1>&2\r\nexit /b 3", "echo secret-token-1234 >&2\nexit 3");
        let id = launch(&FAKE_CLI, &script, dir.clone(), dir.join("auth.json"), Tuning { timeout: TIMEOUT, hint_after: BROWSER_HINT_AFTER }).expect("starts");
        let failed = wait_for(&id, "failed", 10);
        assert_eq!(failed["state"], "failed");
        assert_eq!(failed["error"], "fake login stopped before sign-in finished. Try again.");
        assert!(!failed.to_string().contains("secret-token"), "CLI output must never leak into an error");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cli_that_exits_cleanly_without_a_login_says_where_it_may_be() {
        let _serial = FLOW_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("clean-exit");
        let script = fake_cli(&dir, "exit /b 0", "exit 0");
        let id = launch(&FAKE_CLI, &script, dir.clone(), dir.join("auth.json"), Tuning { timeout: TIMEOUT, hint_after: BROWSER_HINT_AFTER }).expect("starts");
        let failed = wait_for(&id, "failed", 10);
        let message = failed["error"].as_str().unwrap();
        assert!(message.starts_with("fake login finished, but Burnrate found no login."), "{message}");
        assert!(message.contains("system keyring"));
        assert!(!message.contains('\u{2014}'), "no em dashes in user-visible copy");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cli_that_never_finishes_times_out_and_is_stopped() {
        let _serial = FLOW_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("timeout");
        let script = fake_cli(&dir, "ping -n 60 127.0.0.1 >nul", "sleep 60");
        let id = launch(&FAKE_CLI, &script, dir.clone(), dir.join("auth.json"), Tuning { timeout: Duration::from_secs(2), hint_after: BROWSER_HINT_AFTER }).expect("starts");
        let failed = wait_for(&id, "failed", 10);
        assert_eq!(failed["state"], "failed");
        assert_eq!(failed["error"], "Sign-in took too long. Start it again.");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cli_that_prints_no_link_still_reaches_waiting_and_can_be_cancelled() {
        let _serial = FLOW_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("nolink");
        let cred = dir.join("auth.json");
        let script = fake_cli(&dir, "ping -n 60 127.0.0.1 >nul", "sleep 60");
        let id = launch(&FAKE_CLI, &script, dir.clone(), cred.clone(), Tuning { timeout: TIMEOUT, hint_after: Duration::from_secs(1) }).expect("starts");
        // A second flow on the same login file is refused while this one runs.
        assert_eq!(launch(&FAKE_CLI, &script, dir.clone(), cred.clone(), Tuning { timeout: TIMEOUT, hint_after: BROWSER_HINT_AFTER }), Err(StartError::AlreadyRunning));
        let waiting = wait_for(&id, "waitingForBrowser", 10);
        assert_eq!(waiting["state"], "waitingForBrowser");
        assert!(waiting.get("url").is_none());
        assert!(cancel(&id));
        let cancelled = status(&id).unwrap();
        assert_eq!(cancelled["state"], "cancelled");
        assert!(!dir.join("projects").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn active_flows_are_capped() {
        let _serial = FLOW_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("cap");
        let script = fake_cli(&dir, "ping -n 60 127.0.0.1 >nul", "sleep 60");
        let mut ids = Vec::new();
        let mut last = Ok(String::new());
        // The cap is global, so other tests' flows count too: fill until refused.
        for n in 0..=MAX_ACTIVE_FLOWS {
            last = launch(&FAKE_CLI, &script, dir.clone(), dir.join(format!("auth-{n}.json")), Tuning { timeout: TIMEOUT, hint_after: BROWSER_HINT_AFTER });
            match &last {
                Ok(id) => ids.push(id.clone()),
                Err(_) => break,
            }
        }
        assert_eq!(last, Err(StartError::TooManyFlows));
        for id in ids {
            cancel(&id);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
