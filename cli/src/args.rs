//! Command-line parsing. Kept dependency-free and unit-testable.

use std::{env, path::PathBuf};

pub const USAGE: &str = "\
burnrate - Burnrate loopback status CLI

USAGE:
    burnrate <command> [options]

COMMANDS:
    status       Print the current usage status (one line, or --json)
    statusline   Read Claude Code statusline JSON on stdin, push it to the
                 daemon (best effort), print a one-line status
    watch        Follow /api/stream and redraw the status line on each event
    waybar       Print a Waybar `custom` module JSON object
    version      Print the version and exit

OPTIONS:
    --json             status: print the raw /api/status JSON
    --provider ID      status: only show this provider id/label
    --window KIND      status: only show session|weekly|monthly windows
    --port N           daemon port (default: BURNRATE_PORT, saved port, or 13790)
    --unicode          use Unicode separators instead of plain ASCII
    --help, -h         show this help

EXIT CODES:
    0  ok        2  bad arguments        3  daemon not reachable
";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Status,
    Statusline,
    Watch,
    Waybar,
    Version,
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgsError(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opts {
    pub command: Command,
    pub json: bool,
    pub unicode: bool,
    pub provider: Option<String>,
    pub window: Option<String>,
    pub port: u16,
}

/// Path of the port file written by the desktop shell when it has to use a random
/// port. Kept identical to `src-tauri/src/main.rs::port_file_path`.
pub fn port_file_path() -> PathBuf {
    if let Some(dir) = env::var_os("BURNRATE_DATA") {
        return PathBuf::from(dir).join("port.txt");
    }
    #[cfg(windows)]
    let base = env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library").join("Application Support"));
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let base = env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| {
        env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share"))
    });
    base.unwrap_or_else(|| PathBuf::from(".")).join("burnrate").join("port.txt")
}

/// The port the shell actually selected, published for out-of-process consumers. A leftover file from a
/// crashed shell must not send the CLI to a dead port, so the port is only trusted when something is
/// accepting connections on it; otherwise the caller falls back to the default.
pub fn read_port_file() -> Option<u16> {
    let port = std::fs::read_to_string(port_file_path())
        .ok()?
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)?;
    port_is_listening(port).then_some(port)
}

/// Short loopback connect probe (the daemon is local, so a live port answers immediately).
pub fn port_is_listening(port: u16) -> bool {
    use std::net::{Ipv4Addr, SocketAddr, TcpStream};
    use std::time::Duration;
    TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_millis(300)).is_ok()
}

/// Resolve the daemon port: `--port` > `BURNRATE_PORT` > saved port > 13790.
/// Unparsable values are ignored in favour of the next fallback.
pub fn resolve_port(cli: Option<u16>) -> u16 {
    resolve_port_with_file(cli, read_port_file())
}

/// Pure core of `resolve_port` so precedence can be unit tested without touching disk.
pub fn resolve_port_with_file(cli: Option<u16>, file_port: Option<u16>) -> u16 {
    cli.or_else(|| {
        env::var("BURNRATE_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|port| *port > 0)
    })
    .or(file_port)
    .unwrap_or(13790)
}

/// Split `--flag=value` into `("--flag", Some("value"))`; other tokens yield `(token, None)`.
fn split_flag(token: &str) -> (&str, Option<&str>) {
    match token.split_once('=') {
        Some((k, v)) if k.starts_with("--") => (k, Some(v)),
        _ => (token, None),
    }
}

pub fn parse(args: &[String]) -> Result<Opts, ArgsError> {
    let mut command: Option<Command> = None;
    let mut json = false;
    let mut unicode = false;
    let mut provider: Option<String> = None;
    let mut window: Option<String> = None;
    let mut port: Option<u16> = None;

    let mut i = 0;
    while i < args.len() {
        let (flag, inline) = split_flag(&args[i]);
        match flag {
            "--help" | "-h" | "help" => command = Some(Command::Help),
            "--json" => {
                if inline.is_some() { return Err(ArgsError(format!("{flag} takes no value"))); }
                json = true;
            }
            "--unicode" => {
                if inline.is_some() { return Err(ArgsError(format!("{flag} takes no value"))); }
                unicode = true;
            }
            "--provider" | "--window" | "--port" => {
                let value = match inline {
                    Some(v) => v.to_string(),
                    None => {
                        i += 1;
                        args.get(i).cloned().ok_or_else(|| ArgsError(format!("{flag} needs a value")))?
                    }
                };
                match flag {
                    "--provider" => provider = Some(value),
                    "--window" => {
                        let w = value.to_ascii_lowercase();
                        if !matches!(w.as_str(), "session" | "weekly" | "monthly") {
                            return Err(ArgsError(format!("invalid --window {value:?} (expected session|weekly|monthly)")));
                        }
                        window = Some(w);
                    }
                    "--port" => {
                        port = Some(value.parse::<u16>().map_err(|_| ArgsError(format!("invalid --port {value:?}")))?);
                    }
                    _ => unreachable!(),
                }
            }
            "status" => command = Some(Command::Status),
            "statusline" => command = Some(Command::Statusline),
            "watch" => command = Some(Command::Watch),
            "waybar" => command = Some(Command::Waybar),
            "version" => command = Some(Command::Version),
            other if other.starts_with('-') => return Err(ArgsError(format!("unknown option {other:?}"))),
            other => return Err(ArgsError(format!("unknown command {other:?}"))),
        }
        i += 1;
    }

    Ok(Opts {
        command: command.ok_or_else(|| ArgsError("missing command".into()))?,
        json,
        unicode,
        provider,
        window,
        port: resolve_port(port),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> { v.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn parses_status_flags() {
        let o = parse(&a(&["status", "--json", "--provider", "claudeAgent", "--window", "weekly", "--port", "13811"])).unwrap();
        assert_eq!(o.command, Command::Status);
        assert!(o.json);
        assert_eq!(o.provider.as_deref(), Some("claudeAgent"));
        assert_eq!(o.window.as_deref(), Some("weekly"));
        assert_eq!(o.port, 13811);
    }

    #[test]
    fn parses_inline_values_and_unicode() {
        let o = parse(&a(&["--unicode", "waybar", "--port=13811"])).unwrap();
        assert_eq!(o.command, Command::Waybar);
        assert!(o.unicode);
        assert_eq!(o.port, 13811);
    }

    #[test]
    fn rejects_bad_args() {
        assert!(parse(&a(&["status", "--window", "hourly"])).is_err());
        assert!(parse(&a(&["status", "--port", "nope"])).is_err());
        assert!(parse(&a(&["nope"])).is_err());
        assert!(parse(&a(&["status", "--bogus"])).is_err());
        assert!(parse(&a(&[])).is_err());
    }

    #[test]
    fn port_resolution_order() {
        let env_port = env::var("BURNRATE_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|port| *port > 0);
        assert_eq!(resolve_port_with_file(Some(1234), Some(4321)), 1234, "--port wins");
        assert_eq!(
            resolve_port_with_file(None, Some(4321)),
            env_port.unwrap_or(4321),
            "env wins over the saved port",
        );
        assert_eq!(
            resolve_port_with_file(None, None),
            env_port.unwrap_or(13790),
            "default when neither source is available",
        );
    }

    #[test]
    fn dead_ports_are_not_listening_and_live_ones_are() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let live = listener.local_addr().unwrap().port();
        assert!(port_is_listening(live));
        drop(listener);
        assert!(!port_is_listening(live), "a closed port must not be trusted from a stale port file");
    }

    #[test]
    fn port_file_name_matches_shell_convention() {
        assert!(port_file_path().ends_with("port.txt"));
    }
}
