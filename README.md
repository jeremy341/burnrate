# Burnrate

See how fast you burn through your AI quotas: limits, and soon cost and tokens, for all your providers in one
local app. Connect API keys or existing logins; everything stays on your computer.

## Run

```powershell
corepack pnpm install
corepack pnpm build
corepack pnpm build:server   # Rust server, needs cargo
corepack pnpm start
```

The server is kept lean (about 125 MB with a warm cache): parsed usage is stored as compact rows, not objects.

Data (encrypted keys) lives in `data/` (override with `BURNRATE_DATA`). Port: `BURNRATE_PORT`.

## Status
- Views: Cost, Tokens, Limits and Providers. Dark and light mode.
- Limits: Claude Code, Codex, Grok, OpenCode Go (local logins), Cursor and Mistral (API keys).
- Cost and tokens only (no limits API): Antigravity, Pi, Muse Code.
- Cost and tokens are read from local transcripts: Claude (all `~/.claude*` accounts), Codex (including
  archived sessions), OpenCode. Prices come from LiteLLM and can be overridden per model.
- Totals match T3 Code within a few percent on the same data (Codex service tiers are not resolved yet).
- See [DESIGN.md](DESIGN.md) for the design system and how to add a provider.

## License
MIT. Contains code derived from T3 Code (MIT), see [NOTICE](NOTICE).
