# Burnrate design

Derived from T3 Code's design system (`apps/web/src/index.css`, `themePalette.ts`). `src/index.css` stays
byte-identical to T3's except two additions: the a11y divider floor and self-hosted Inter `@font-face`s.

## Tokens (`:root` and dark variant in `src/index.css`)
| Token | Light | Dark |
|---|---|---|
| `--radius` | 0.5rem | 0.5rem — fixed; sm/md/lg/xl/2xl/3xl derive from it |
| `--spacing` | 0.25rem | 0.25rem — fixed; no density/scale multipliers |
| `--background` | `#fcfcfc` | `#000` stock; themed default `#181818` |
| `--foreground` | zinc-900 | neutral-100 / `#eee` themed |
| `--card`, `--popover` | white | `#111` stock; themed from `--app-theme-surface` |
| `--border` | zinc-200 | white 8%, lifted by `--divider-floor` (a11y) |
| `--primary` | `oklch(0.488 0.217 264)` | `oklch(0.571 0.21 264)` |

## Type
Inter Variable, self-hosted in all seven subsets, latin face preloaded at boot. Sans stack
`-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif`; mono
`ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`.
Dense sizes: `text-2xs` 11px, `3xs` 10px, `4xs` 8px, `5xs` 7px, with T3's line-height ratios.
Figures use `tabular-nums`.

## Theme engine
The default dark theme `burnrate-dark` (`src/themes/engine/burnrateDark.ts`) is T3's derived palette for
canvas `#181818` + accent `#ffffff`: `#181818` canvas, `#242424` raised surface, `#eeeeee` text. All 61
roles are published as `--app-theme-*` by `src/themePalette.ts`, exactly as in T3. Custom themes
(T3-compatible v1 files, up to 100 KB CSS) live in the settings store and apply instantly. The light
fallback is T3's stock `#fcfcfc` palette. `index.html` paints the saved palette and `theme-color`
before React mounts, so there is no flash.

## Accessibility (kept gains)
`--divider-floor` keeps hairline borders visible in dark; `prefers-contrast: more` and High contrast
raise it further. Forced colors use system colors; reduced motion (OS or `data-reduce-motion`) stops
animation. Focus stays `focus-visible:ring-2 ring-ring`; interactive targets are at least 24x24.

## Brand
Claude bars/lines are always `#d97757`; Codex is always `var(--contrast-foreground)`. Provider chart
lines are solid — no opacity control, no right-click menu. The corner-radius, density
and UI-scale settings are gone: their saved keys are tolerated and ignored, and the app uses T3's
fixed radius, spacing and scale tokens.

## Shell
A persistent top bar carries Usage / Providers and the Settings gear; the active link uses
`aria-current="page"` and a primary underline. The view lives in the URL hash. Page rhythm mirrors
`--workspace-gutter` (12px / 20px), with `viewport-fit=cover` for safe areas. Usage is the exception: it keeps
T3's own frame (`WorkspacePageContainer width="usage"`, a 1024px column with 20px / 24px padding), so it reads
the same as T3's usage monitor.
