//! Entry point. All interesting logic lives in the library so it can be tested.

use burnrate_cli::args::{self, Command};
use burnrate_cli::{model, net, render};
use std::io::{Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn out(line: &str) {
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(line.as_bytes());
    let _ = stdout.write_all(b"\n");
    let _ = stdout.flush();
}

fn fail(message: &str, code: i32) -> i32 {
    eprintln!("burnrate: {message}");
    code
}

/// Fetch and parse /api/status. Any failure means the daemon cannot serve us.
fn get_status(port: u16) -> Result<(String, model::Status), i32> {
    let body = net::fetch_status(port).map_err(|e| {
        fail(&format!("daemon not reachable at {} ({e})", net::base_url(port)), 3)
    })?;
    let status = model::Status::parse(&body).map_err(|e| fail(&e, 3))?;
    Ok((body, status))
}

fn redraw(text: &str, last_len: &mut usize) {
    let mut stdout = std::io::stdout();
    let _ = write!(stdout, "\r{text}");
    if *last_len > text.len() {
        let _ = write!(stdout, "{}", " ".repeat(*last_len - text.len()));
    }
    let _ = stdout.flush();
    *last_len = text.len();
}

fn run(opts: args::Opts) -> i32 {
    match opts.command {
        Command::Version => {
            out(&render::version_string());
            0
        }
        Command::Help => {
            out(args::USAGE);
            0
        }
        Command::Status => {
            let (body, status) = match get_status(opts.port) {
                Ok(v) => v,
                Err(code) => return code,
            };
            if opts.json {
                // Raw pass-through; useful even if a future status shape changes.
                out(&body);
            } else {
                let line = render::status_line(
                    &status,
                    opts.provider.as_deref(),
                    opts.window.as_deref(),
                    opts.unicode,
                    unix_now(),
                );
                out(&line);
            }
            0
        }
        Command::Statusline => {
            // Read the Claude Code statusline payload from stdin and push it to
            // the daemon on a detached thread (best effort, 280 ms timeout).
            let mut input = String::new();
            let _ = std::io::stdin().read_to_string(&mut input);
            let payload = if input.trim().is_empty() { "{}".to_string() } else { input };
            let port = opts.port;
            let _ = std::thread::spawn(move || {
                let _ = net::post_statusline(port, &payload);
            });

            let (_, status) = match get_status(opts.port) {
                Ok(v) => v,
                Err(code) => return code,
            };
            out(&render::statusline_line(&status, opts.unicode));
            0
        }
        Command::Waybar => {
            let (_, status) = match get_status(opts.port) {
                Ok(v) => v,
                Err(code) => return code,
            };
            let value = render::waybar_json(&status, unix_now());
            out(&value.to_string());
            0
        }
        Command::Watch => {
            // Paint an initial line from the snapshot endpoint, then follow SSE.
            // Share one `last_len` so a shorter stream redraw clears the residue of
            // the initial line instead of leaving trailing characters behind.
            let mut last_len = 0;
            match get_status(opts.port) {
                Ok((_, status)) => {
                    let first = render::status_line(
                        &status,
                        opts.provider.as_deref(),
                        opts.window.as_deref(),
                        opts.unicode,
                        unix_now(),
                    );
                    redraw(&first, &mut last_len);
                }
                Err(code) => return code,
            }
            let result = net::stream_events(opts.port, |line| {
                if let Some(json) = net::status_from_sse_line(line) {
                    if let Ok(status) = model::Status::parse(&json) {
                        let text = render::status_line(
                            &status,
                            opts.provider.as_deref(),
                            opts.window.as_deref(),
                            opts.unicode,
                            unix_now(),
                        );
                        redraw(&text, &mut last_len);
                    }
                }
            });
            match result {
                Ok(()) => 0,
                Err(e) => fail(&format!("stream ended: {e}"), 3),
            }
        }
    }
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let opts = match args::parse(&raw) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("burnrate: {}", e.0);
            eprintln!("{}", args::USAGE);
            std::process::exit(2);
        }
    };
    let code = run(opts);
    std::process::exit(code);
}
