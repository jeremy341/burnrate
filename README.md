# Burnrate

See how fast you burn through your AI quotas: limits, and soon cost and tokens, for all your providers in one
local app. Connect API keys or existing logins; everything stays on your computer.

## Run

```powershell
corepack pnpm install
corepack pnpm build
corepack pnpm start      # http://127.0.0.1:13790
```

Data (encrypted keys) lives in `data/` (override with `BURNRATE_DATA`). Port: `BURNRATE_PORT`.

## Status
- Limits view and Providers view work. Providers today: Codex (local ChatGPT login), Mistral (API keys).
- Not yet ported: Claude, OpenCode, Cost and Tokens views, price overrides.
- See [DESIGN.md](DESIGN.md) for the design system and how to add a provider.

## License
MIT. Contains code derived from T3 Code (MIT), see [NOTICE](NOTICE).
