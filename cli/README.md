# burnrate CLI

A tiny, GUI-free command-line client for the Burnrate loopback daemon. It uses
only `ureq` + `serde_json` — no GTK, no WebView, no TLS stack, no crypto. It is
meant to be spawned on every statusline redraw, so the release profile is tuned
for size (`opt-level = "z"`, LTO, stripped, abort on panic).

## Build

```sh
cargo build --release --manifest-path cli/Cargo.toml
# binary: cli/target/release/burnrate
```

The port is taken from `--port`, then `BURNRATE_PORT`, then `13790`.

## Commands

```sh
burnrate status                       # Claude Kernel 27% used - resets 3h57m
burnrate status --json                # raw /api/status JSON
burnrate status --provider claudeAgent --window weekly
burnrate status --port 13811 --unicode
burnrate statusline                   # reads Claude Code JSON on stdin; prints 5h 47% - 7d 36%
burnrate watch                        # follows /api/stream, redraws one line
burnrate waybar                       # {"text":"5h 27%","tooltip":"...","class":"ok","percentage":27}
burnrate version
```

Exit codes: `0` ok, `2` bad arguments, `3` daemon not reachable. Output is
plain ASCII by default; `--unicode` switches to nicer separators. The
`statusline` command pushes the payload it receives on stdin to
`POST /api/ingest/claude-statusline` on a detached thread with a 280 ms budget
(best effort) before printing the line from `/api/status`.

## Claude Code statusline

Add this to `~/.claude/settings.json` (Claude passes its statusline JSON on
stdin; Burnrate also forwards its `rate_limits` to the local daemon):

```json
{
  "statusLine": {
    "type": "command",
    "command": "burnrate statusline",
    "refreshInterval": 30
  }
}
```

Use a full path to the binary if `cli/target/release` is not on your `PATH`.
On Windows, Claude runs the command through Git Bash (or PowerShell); use
forward slashes in the path.

## Waybar

Add a `custom/burnrate` module. Waybar reads the JSON object printed by
`burnrate waybar` and uses `class` for CSS styling:

```jsonc
"custom/burnrate": {
  "format": "{}",
  "exec": "burnrate waybar",
  "return-type": "json",
  "interval": 30,
  "tooltip-format": "{tooltip}"
}
```

`class` values are `ok`, `warn`, `critical`, or `unavailable`; `percentage` is
the worst window's used percent (0–100). Example styling:

```css
#custom-burnrate.warn    { color: #e5c07b; }
#custom-burnrate.critical{ color: #e06c75; }
#custom-burnrate.unavailable { color: #808080; }
```

Shell snippets (tmux / starship / PowerShell prompt):

```sh
tmux set -g status-right '#(burnrate status --json >/dev/null 2>&1 && burnrate status)'
```

## Tests

```sh
cargo test --manifest-path cli/Cargo.toml
```

Unit tests cover formatting (percentages, RFC 3339 parsing, countdowns, state
rules), argument parsing and status rendering. Integration tests spin up a
one-shot `std::net::TcpListener` stub on an ephemeral loopback port for
`/api/status`, `/api/ingest/claude-statusline` and `/api/stream`; they never
contact a real daemon or the network.
