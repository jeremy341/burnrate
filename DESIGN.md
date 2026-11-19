# Burnrate design

Derived from the stylesheet and components this project reuses (`src/index.css`, `src/components/ui`),
not from screenshots. The look follows the Usage window of T3 Code: quiet, dense, monochrome with one
accent, and provider colors only where they carry meaning (the quota bars).

## Principles
- Calm surfaces, thin borders, no shadows except popovers. Data is the color.
- A bar shows quota **remaining**. A tick on the bar marks where even spending would be (pace).
- Provider color appears only in bars and small marks. Everything else is neutral.
- Light and dark are both first class. The root element carries the `dark` class.

## Tokens (see `:root` in `src/index.css`)
| Token | Light | Dark |
|---|---|---|
| `--background` | zinc-25 | `#000` |
| `--foreground` | zinc-900 | neutral-100 |
| `--card` | white | neutral-950 mixed with white 3% |
| `--muted` | zinc-50 | white 3% |
| `--border` | zinc-200 | white 8% |
| `--primary` | `oklch(0.488 0.217 264)` | `oklch(0.571 0.21 264)` |
| `--radius` | 0.5rem (sm/md/lg/xl/2xl/3xl derive from it) | same |

Typography: Inter Variable (sans), system monospace. Small sizes `text-2xs` to `text-5xs` exist for dense data.

## Components
Built on Base UI primitives: `Button` (variants default, outline, ghost, ghost-muted; sizes xs, sm, icon-sm,
compact), `ToggleGroup` with `variant="segmented"` for view switches, `Tooltip`, `Popover`, `Dialog`,
`Alert`, `Input`, `Select`, `Table`, `Skeleton`, `ScrollArea`.

## Limits view
- One section per provider: icon, name, then one card per window (Session, Weekly, Monthly).
- Card: big percent left, bar with one numbered segment per account, reset countdown at the right.
- Hover or click a segment for a popover with account, plan, reset time and pace.
- Accounts of one provider are pooled in one bar.

## Providers view
One card per provider with connection state. API-key providers take a name and a write-only key; login
providers read an existing sign-in on this computer. A key is never displayed after saving.

## Adding a provider
Add a server module (`server/providers/<id>.ts`) and list it in `server/providers/index.ts`. The UI takes
name, color and connection kind from the server. Add a brand mark in `src/providers/ProviderIcon.tsx` if it
has one; otherwise initials are shown.
