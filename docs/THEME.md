# Theme and appearance

Burnrate keeps T3 Code's palette pipeline and adds a small set of appearance extras
(radius, density, UI scale, reduced motion, high contrast, two fonts). This file documents
both the **palette parity** and the Burnrate-only CSS layer.

- Theme types and the five T3 built-ins: `src/shared/themePalettes.ts` (verbatim from T3).
- Palette CSS generation and runtime application: `src/themePalette.ts`, `src/appearance.ts`.
- Burnrate presets: `src/themes/presets/*.ts` (each exports `theme: ThemeDefinition`).
- Burnrate-only CSS: `src/appearance.css` (this file's extras) and `src/a11y.css`.
- `src/index.css` is a verbatim T3 file and must stay byte-identical to T3's copy.

## Burnrate Dark (the user's "test" palette)

Burnrate's dark default is **Burnrate Dark**, id `burnrate-dark`, label `Burnrate Dark`,
`appearance: "dark"`, `managed: true`. It is the static palette T3 derives at runtime for
the custom theme "test" (`appearance: dark`, canvas `#181818`, accent `#ffffff`).

The definition belongs to the theme engine:

- `src/themes/engine/burnrateDark.ts` exports `burnrateDark: ThemeDefinition` (all 61 roles).
- `src/themes/presets/burnrate-dark.ts` re-exports it as `theme` so the registry glob
  (`src/themes/registry.ts`, `./presets/*.ts`) picks it up as a drop-in preset.

`appearance.darkThemeId` defaults to `burnrate-dark` in `src/settings/schema.ts`;
`lightThemeId` stays `null` (the stock light palette is the fallback). burned-in ids are
never stored in CSS: `applyThemePalette` writes `data-theme-id` and every `--app-theme-*`
role inline on `<html>`, exactly like T3.

## Burnrate Light

`src/themes/presets/burnrate-light.ts` publishes the **stock T3 light palette**
(`T3_CODE_LIGHT_THEME_COLORS`) as id `burnrate-light`, label `Burnrate Light`. It is a
regular preset, so the theme library can show it next to Burnrate Dark; selecting it simply
pins the palette that `src/index.css` already resolves when `lightThemeId` is `null`.

## The 61 roles

`THEME_COLOR_ROLES` in `src/shared/themePalettes.ts` is the authoritative list. Both presets
must define every role (the type `ThemeColors` enforces it; `presets.test.ts` asserts the
count and non-empty values):

```text
canvas, chrome, toolbar, toolbarForeground, toolbarBorder, toolbarControl,
toolbarControlForeground, toolbarControlHover, surface, surfaceRaised, surfaceOverlay,
text, textMuted, border, input, focus, accent, accentForeground, secondary,
secondaryForeground, muted, mutedForeground, placeholder, secondaryLabel, iconMuted,
error, errorForeground, errorSurface, warning, warningForeground, warningSurface,
update, updateForeground, updateSurface, accentSurface, accentSurfaceForeground,
messageSurface, messageForeground, messageAction, messageActionForeground,
messageActionHover, codeBackground, codeForeground, searchMatchBackground,
searchMatchForeground, searchMatchActiveBackground, searchMatchActiveForeground,
sidebar, sidebarForeground, sidebarMutedForeground, sidebarControlSurface,
sidebarRowHover, sidebarRowActive, sidebarRowSelected, sidebarBorder,
terminalBackground, terminalForeground, terminalCursor, terminalSelection,
terminalScrollbar, terminalScrollbarHover
```

## How T3 derives the palette (read-only source)

- Seed → colors: `apps/web/src/themePalette.ts`,
  `createVividThemeColors(appearance, canvas, accent)` (called from `publishedThemeColors`
  for custom/environment themes and from `ThemeEditorPanel`). With an achromatic accent
  (`C < 0.02`), the neutral hue comes from the canvas; the chroma step is clamped to
  `0.008`, which is why the raised surfaces carry `89.876` as their hue.
- Color → CSS: `APP_THEME_VARIABLES` in the same file publishes **every** role as
  `--app-theme-*` (canvas, chrome, toolbar, surface, surfaceOverlay, text, textMuted,
  border, input, focus, accent, secondary, muted, placeholder, error, warning, update,
  accentSurface, messageSurface, messageAction, codeBackground, searchMatch*, sidebar*,
  terminal*, …).
- `apps/web/src/index.css` maps those roles onto the semantic tokens
  (`html[data-theme-id]:not(...)`) and computes the `--contrast-*` tokens with
  `color-mix(...)` over the `--appearance-contrast-*` inputs. Burnrate keeps `100`, i.e.
  base `100%`, boost `0%`, so each contrast token resolves to its underlying token.

`burnrateDark` declares all 61 roles, so nothing T3 sets for dark is missing. Values were
recomputed from the seeds with a transcription of T3's math and match the previous
hand-written `theme-dark.css` values; the previously missing roles (textMuted, focus,
updateSurface, accentSurface*, searchMatch*, sidebarStageFade, terminal*, and all
`--app-theme-*`) are covered by the definition.

`client-settings.json` contains no theme definition (only appearance *contrast*); the theme
definition itself is not persisted in the userdata files available here, so the seeds above
come from the task brief and are confirmed by the pixel samples below.

## Appearance extras (Burnrate-only)

`src/appearance.ts` writes the settings onto `<html>`; `src/appearance.css` is the only
stylesheet that consumes them. All of it is unlayered, so it wins over T3's layered
utilities without changing `index.css`.

### Corner radius

`appearance.radius` (rem, default `0.5`) → inline `--radius`. Burnrate never redeclares it:
`index.css` already derives `--radius-sm` … `--radius-3xl` from `--radius`, so every rounded
surface follows the slider.

### Density

`appearance.density` → `html[data-density="compact" | "comfortable" | "spacious"]`.
`comfortable` reproduces T3's `0.25rem` spacing step. The other two override Tailwind v4's
`--spacing` token (`calc(var(--spacing) * n)` drives every spacing utility) and the
`--burnrate-density-*` hooks. Settings rows additionally read
`--burnrate-density-row-padding-block`; the default comfortable value matches T3's `py-3`.

### UI scale

`appearance.uiScale` (0.85–1.5) → inline `--burnrate-ui-scale`, applied as CSS `zoom` on
`<html>`. Zoom scales layout, type, controls, popups and fixed overlays together; scaling
only the font size would leave px-sized chrome behind.

### Reduced motion

`appearance.reduceMotion` → `html[data-reduce-motion]`:

- `system` removes the attribute; `@media (prefers-reduced-motion: reduce)` then decides.
- `on` writes `on` (the system setting can also report `reduce`; both are accepted) and collapses
  animation/transition durations, disables smooth scrolling and keeps the final state.
- `off` writes `off` and explicitly opts out of the OS media query.

### High contrast

`appearance.highContrast` → `html[data-high-contrast="true"]`. Instead of hard-coded
colors, the layer mixes the theme's `--foreground` into `--background` to strengthen
`--border`, `--input`, `--sidebar-border` and muted labels (`--muted-foreground`,
`--placeholder`, …), so it works for every light/dark/custom palette. Focus rings get a
2 px outline and settings cards use the stronger border. An OS `prefers-contrast: more`
preference applies the same tokens when the user has not opted in; `forced-colors: active`
falls back to `CanvasText`.

## Typography

Burnrate trims T3's typography editor to the two families in the settings contract:
`appearance.fontFamily` (`--font-sans`) and `appearance.monoFontFamily` (`--font-mono`).

- `src/appearanceFonts.ts` — font-stack normalisation (`cssFontFamilies`,
  `appearanceFontStack`), availability and monospace probes, installed-font enumeration
  (Local Font Access API, optional), `applyAppearanceFontVariables` and the
  `startAppearanceFonts()` store subscription that applies choices to `<html>`.
- `src/components/settings/FontFamilyPicker.tsx` — filterable picker over installed fonts;
  clears back to the default stack, rejects proportional faces for monospace.
- `src/components/settings/SettingsFontPreviews.tsx` — `InterfaceFontPreview` and
  `MonoFontPreview`.
- `src/components/settings/TypographySettings.tsx` — the `Typography` settings section
  (`TypographySection` is an alias).

Clearing a family removes the inline property, so `index.css`'s `@theme` defaults
(`Inter Variable`, per-OS fallbacks) come back. The default stacks in
`appearanceFonts.ts` mirror `index.css`.

## First-paint colors

`index.html` uses one constant per mode for both the inline pre-paint background and the
`theme-color` meta tag: dark `#181818` (Burnrate Dark's resolved `--background`) and light
`#fcfcfc` (the resolved `oklch(99.2% 0 0)` of `index.css`). The boot script reads the
settings mirror, and `appearance.ts` later syncs the meta to the computed token, so the
window chrome never flashes a different color during hydration.

**New installs are dark.** `appearance.themeMode` defaults to `"dark"` (client `DEFAULT_SETTINGS`, server
`default_settings()`, the `index.html` boot script, and the shell's saved window colours all agree; the
test `src/appearanceBoot.test.ts` runs the real boot script and compares client and server defaults).
Stored `system` and `light` choices are untouched and keep following the OS / staying light. An unknown stored
mode is treated like a new install.

**Desktop window chrome.** In the Tauri shell `appearance.ts` calls `window.burnrateShell.setChrome(dark, bg, fg)`
whenever the resolved palette changes (`syncDesktopChrome`). The shell sets the native theme, the window
background and, on Windows 11, the DWM caption/border/text colours to the same `bg`/`fg`, so the title bar and the
in-app header read as one surface. The last palette is kept in `window-state.json`, which the next start reads
before the window exists (no white frame, no wrong title bar).

## Screenshot pixel samples vs. resolved CSS

Scripts used for sampling/derivation were throwaway files in the scratchpad, not in this
repo. Screenshot: T3 Limits window, dark, 1322×1000. CSS values were resolved with culori
4.0.2 (the version pinned in the T3 checkout).

| Element | Screenshot pixels | Resolved token | Token value | Result |
| --- | --- | --- | --- | --- |
| Page background | `#181818` (dominant, 42k px in empty area) | `--background` / `--app-theme-canvas` | `oklch(0.209036 0 0)` → `#181818` | match |
| Toolbar strip | `#181818` | `--toolbar-background` | `oklch(0.209036 0 0)` → `#181818` | match |
| Card interior | `#181818` (same as page; cards are transparent) | `--card` | `oklch(0.224036 0.008 89.876)` → `#1d1b17` | intended: the Limits cards have no background class |
| Card border (pool rows, `border-border/60`) | `#303030` (uniform 960 px runs) | `--border` at 60% over `#181818` | `oklch(0.369036 0 0)` → `#3f3f3f` | match after 60% alpha blend |
| Card border (ChatGPT row, full `border`) | `#3f3f3f` (row y=771) | `--border` | `oklch(0.369036 0 0)` → `#3f3f3f` | match |
| Muted text ("left", "↻ +7%") | `#8e8e8e` flat pixels (antialiased edges around it) | `--muted-foreground` | `oklch(0.645769 0 0)` → `#8e8e8e` | match |
| Foreground text ("93%") | `#eeeeee` flat pixels | `--foreground` | `oklch(0.949119 0 0)` → `#eeeeee` | match |
| Claude session/weekly bars | `#654337` (brown) | provider presentation color | not a theme token | n/a |
| OpenCode session/weekly bars | `#394f5b` (blue-grey) | provider presentation color | not a theme token | n/a |

The bar colors come from `barColor(driver)` / provider presentation colors in T3's usage UI
(`apps/web/src/components/usage/UsageLimits.tsx`), so they are deliberately independent of
the theme palette; there is no theme variable to align them with.

No color mismatches were found; the sampled surfaces, borders, and text all resolve to the
declared values.

## Verification

- `src/themes/presets/presets.test.ts` — both presets satisfy `ThemeDefinition`, Burnrate
  Dark has all 61 roles and matches the engine definition, ids/labels/appearances are
  correct.
- `src/themes/presets/appearance-css.test.ts` — `appearance.css` implements every attribute
  and variable `appearance.ts` writes (density, reduce motion, high contrast, UI scale,
  radius hook).
- `corepack pnpm typecheck`, `corepack pnpm test`, `corepack pnpm build`.
