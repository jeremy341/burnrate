# 02 – T3 theme manager and settings system: map and port plan for Burnrate

Scope: port T3 Code's full theme manager and a Settings system scoped to a usage-only app.
Upstream (read only): `C:\Users\jerem\Documents\GITHUB\burnrate\app`, base commit `470ca634…` (see `scripts/t3-manifest.json`).
All `file:line` references below are relative to `apps/web/src` unless prefixed `packages/…`.

---

## 0. Findings that change the plan

1. **T3 does not store custom themes in `client-settings.json`.** Custom themes, the selected theme, appearance mode and
   the light/dark "halves" mix all live in the renderer's `localStorage`: `t3code:themes:v1`, `t3code:theme`,
   `t3code:theme-appearance-mode`, `t3code:theme-follow-system`, `t3code:theme-halves:v1`
   (`themePalette.ts:48-52`, `hooks/useTheme.ts:42`). That is why the user's theme "test" is not in
   `~/.t3/userdata/client-settings.json` (it holds only numeric appearance values: `appearanceContrast: 100`,
   `glassOpacity: 80`, `fontSizeInterface: 16`, `fontSizePrompt: 14`, `fontSizeCode: 13`, `fontSizeTerminal: 12`,
   `fontSmoothing: true`, empty font families, `chatWidth`, `effortDisplay`, …) and `~/.t3/userdata/themes/` (the
   server-published themes folder) is empty. To get "test" into Burnrate, export it from T3's theme card
   (`downloadThemeFile`, `components/settings/ThemeSettings.tsx:80`), which writes the `ThemeFile` v1 JSON, and import it
   into Burnrate. Burnrate already has its resolved values (`docs/THEME.md`: canvas `#181818`, accent `#ffffff`, dark).
2. **Burnrate's `index.css` is byte-identical to T3's** (`diff -q` clean), so the whole theme pipeline
   (`html[data-theme-id]:not([data-theme-id=""])` at `index.css:1326`, built-in theme rules at `index.css:758-913`, contrast
   `color-mix` chain at `index.css:1600+`) is already in place. Burnrate currently bypasses it: `src/theme-dark.css`
   hard-codes the derived values under `html.dark:root`, `App.tsx` only toggles the `dark` class, and
   `src/hooks/useSettings.ts` keeps three keys in `localStorage["burnrate.settings"]`. The port replaces the hand-copied CSS
   by running T3's own runtime derivation.
3. **Burnrate's Rust `/api/settings` cannot hold this yet** (details in §4.5): `SettingsStore::open` rebuilds the file with
   only two known keys (`server-rs/src/settings.rs:38-39`, so any other key is lost on restart), `patch` only understands
   those two maps, and `read_body` caps bodies at 16 KiB (`server-rs/src/main.rs:144-146`), which is about two themes.
4. The theme editor has **no contrast checker UI**. Contrast is enforced in the generator (`createVividThemeColors` solves
   text to 7:1 and muted text to 4.6:1, `themePalette.ts:855-899`) but nothing warns for hand-edited or imported themes.
   That is a gap worth closing in Burnrate (§6).

---

## 1. Inventory of T3 settings panels

Navigation is `SETTINGS_NAV_GROUPS` (`components/settings/settingsSearch.ts:132-177`), icons in `SettingsSidebarNav.tsx:81-103`,
one route file per panel (`routes/_chat.settings.<name>.tsx`). T3 has **two** persistence scopes:

- **Client settings** (`ClientSettingsSchema`, `packages/contracts/src/settings.ts:405-604`, defaults via `decodeSync({})` at `:606`):
  device-local, stored in `client-settings.json` (desktop) or `localStorage["t3code:client-settings:v1"]` (browser,
  `clientPersistenceStorage.ts:5`). Read/written by `hooks/useSettings.ts` (`persistClientSettingsPatch`, `:212`).
- **Server settings** (`ServerSettings`, `settings.ts:1366-1609`) and a merged `UnifiedSettings`
  (`DEFAULT_UNIFIED_SETTINGS`, `:1793`). Rows marked `serverScoped` write to the server; the project/environment scope machinery
  (`SettingsScopeContext`, `SettingInheritance`, `scopedSettings.ts`, `useScopedSettings.ts`) layers per-project overrides on top.
  **None of that scope machinery is relevant to Burnrate** (one machine, one scope).

Relevance key: **KEEP** = port as is, **ADAPT** = port with changes, **SKIP** = irrelevant to a usage-only app.

| Panel (route) | Component | Setting keys (type, default) | Verdict |
|---|---|---|---|
| **Appearance** `/settings/appearance` | `AppearanceSettingsPanel.tsx` (501 lines) | Theme library (see §2). `appearanceContrast` Int 50-200, 100. `glassOpacity` Int 40-100, 80 (`settings.ts:140-148`). `chatWidth` comfortable/wide/full. `effortDisplay` label/bars. `mathRenderingEnabled` bool false. `panelAnimationDurationMs` Int 0-400, 0. `environmentIdentificationMode` artwork/…/pill/none. `persistComposerContextStrip` bool false | **KEEP** theme library, contrast, glass, panel animation duration. **SKIP** chatWidth, effortDisplay, math, environment identification, composer strip |
| Appearance → Typography | `TypographySettings.tsx` (575) + `FontFamilyPicker.tsx` (243) + `SettingsFontPreviews.tsx` (251) + `appearanceFonts.ts` (341) | `fontFamilySans/Code/Composer/Terminal` string "" ; `fontSizeInterface` 12-20 def 16; `fontSizePrompt` 12-20 def 14; `fontSizeCode` 10-18 def 13; `fontSizeTerminal` 8-20 def 12; `fontSmoothing` bool true; `wordWrap` bool true. localStorage `t3code:typography-advanced` (separate fonts toggle) | **KEEP** sans font, mono (code) font, interface size, font smoothing. **SKIP** prompt/composer/terminal fonts and sizes, word wrap |
| **General** `/settings/general` | `GeneralSettingsPanel` in `SettingsPanels.tsx:826` | Sections: Notifications (`notificationMode` off/notifications/sound/notifications-and-sound def `off`; `inAppNotificationsEnabled` false), Sidebar (project grouping/order, working shelf), Confirmations (`confirmThreadArchive/Delete/Unpin`, `confirmTerminalClose`, `confirmQuit`), Display (`language` def `en`, `timestampFormat` locale/12-hour/24-hour def `locale`) | **KEEP** Display (language, time format). **ADAPT** notifications (use for limit-reached/reset alerts, §5). **SKIP** sidebar, confirmations |
| Chat `/settings/chat` | `ChatSettingsPanel` `SettingsPanels.tsx:1213` | composer rich text, send shortcut, follow-ups, tool calls, screen reader | **SKIP** (screen reader announcements could be revisited as accessibility) |
| Diffs | `DiffsSettingsPanel` `:1623` | `diffColorScheme` red-green/…, `diffLayout`, whitespace, collapsed | **SKIP** |
| **Keybindings** `/settings/keybindings` | `KeybindingsSettings.tsx` (1691) + `.logic.ts` (591) + `packages/contracts/src/keybindings.ts` | server-side `keybindings.json` | **ADAPT, much smaller**: Burnrate has 7 commands in `src/t3-shims/keybindings.ts:26-32` (`usage.cost`, `usage.tokens`, `usage.limits`, `usage.period.*`). Build a short "Shortcuts" list with a key-capture row (`CaptureShortcutConfig.tsx`, 377 lines, is reusable). Do not port the 1,691-line panel |
| Voice, Snap shot | `VoiceSettingsPanel`, `SnapShotSettings` | speech*, snapShot* | **SKIP** |
| **Providers** `/settings/providers` | `ProviderSettingsPanel.tsx` (1521), `ProviderInstanceCard.tsx` (1517), `UsageProviderSettings.tsx` (143), `AddUsageLimitSourceDialog.tsx` | `usageLimitSources` (CLI-proxy hubs), provider instances | **SKIP** (Burnrate has its own `ProvidersPage.tsx`). `UsageProviderSettings`/`AddUsageLimitSourceDialog` are the only usage-relevant pieces and Burnrate already covers accounts differently |
| Threads, Browser, Devices, Scheduled tasks, Projects, Source control, Worktrees, Connections, Access, Secrets, Archived | many | — | **SKIP** |
| Integrations (referenced in the brief) | `IntegrationsSettings.tsx` (1737) | has no nav entry in this checkout (only referenced by a test and route `_chat.settings.integrations.tsx`) | **SKIP** |
| **Maintenance** `/settings/maintenance` | `MaintenanceSettingsPanel` `:2302` + `StorageSettings.tsx` (972) + `DiagnosticsSettings.tsx` (1448) | Updates (`enableProviderUpdateChecks`), Background activity (profile), Diagnostics | **ADAPT**: keep only "Data" (scan cache / reset / export settings) and "Background activity" idea (refresh interval). Rest SKIP |
| **Labs** `/settings/labs` | `LabsSettingsPanel.tsx` (293) | `boringSidebarEnabled`, guest links, linked environments, prompt suggestions, simlock hosts, fast worktree checkout | **SKIP** content. **KEEP the pattern**: a "Beta" section for Burnrate's own experiments |
| **About** `/settings/about` | `AboutSettingsPanel` `:2449` + `AboutVersionTitle.tsx` + `OpenSourceLicenses.tsx` (314) | version, welcome page, privacy, licenses | **ADAPT**: version, licence (MIT + T3 NOTICE), link to `OpenSourceLicenses` pattern |
| Usage-relevant **server** settings (no UI in T3 Settings except Providers) | `settings.ts:1582-1605` | `usageLimitSources`, `usageHistoryRetentionDays`, `usagePriceOverrides`, `usageModelAliases`, `usageModelFilter` | Burnrate already has price overrides and aliases via `UsagePriceOverrides.tsx` and the Rust `SettingsStore`; add `usageHistoryRetentionDays` and `usageModelFilter` as new Data rows if wanted |

Shared infrastructure: layout (`settingsLayout.tsx`: `SettingsSection` `:213`, `SettingsRow` `:313`, `SettingResetButton` `:585`,
`SettingsPageContainer` `:620`), `SettingsGroup.tsx` (30), `AdvancedSettings.tsx` (43, collapsible "Advanced" fold),
`FoldedSettingsSection.tsx` (102), search (`settingsSearch.ts`, 1,707 lines, plus `SettingsSidebarNav` search box), restore-defaults
(`useSettingsRestore`, `SettingsPanels.tsx:468`, builds a changed-labels list and resets everything to defaults).

---

## 2. Theme system in detail

### 2.1 Data model (`packages/shared/src/themePalettes.ts`)

```ts
type ThemeAppearance = "light" | "dark";
const THEME_COLOR_ROLES = [ /* 61 roles, :30-92 */ ] as const;
type ThemeColorRole = typeof THEME_COLOR_ROLES[number];
type ThemeColors = Readonly<Record<ThemeColorRole, string>>;       // every role present, literal CSS color strings
type ThemeDefinition = Readonly<{                                  // :97-108
  id: string;                     // [a-z0-9][a-z0-9-]{0,47}; reserved: system/light/dark + built-ins + legacy aliases (:8-20)
  label: string;                  // ≤ 48 chars
  appearance: ThemeAppearance;    // the "base" half
  colors: ThemeColors;            // palette of the base half
  variants?: Partial<Record<ThemeAppearance, ThemeColors>>;  // the other half; getThemeColorsForAppearance :917
  collection?: { id: string; label: string };   // groups themes imported from one VS Code extension
  sidebarArtwork?: boolean;       // built-ins only
  managed?: boolean;              // true = generated from canvas+accent seeds; editor opens in guided mode
  css?: string;                   // optional custom stylesheet (max 100,000 chars, THEME_CSS_MAX_LENGTH, server.ts:640)
}>;
```

The 61 roles (all literal colors; `oklch(...)` canonical form): canvas, chrome, toolbar (+Foreground/Border/Control/ControlForeground/ControlHover),
surface/surfaceRaised/surfaceOverlay, text, textMuted, border, input, focus, accent(+Foreground), secondary(+Foreground), muted(+Foreground),
placeholder, secondaryLabel, iconMuted, error/warning (each +Foreground, +Surface), update (+Foreground, +Surface), accentSurface(+Foreground),
message* (Surface/Foreground/Action/ActionForeground/ActionHover), code (Background/Foreground), searchMatch* (4), sidebar* (8), terminal* (6).

For Burnrate the terminal roles and most sidebar roles are unused by the Usage UI but **must stay in the data model** so files stay
interchangeable with T3 (the sync tool keeps `index.css` verbatim and it references them).

### 2.2 Palette derivation (the "seed" model)

- `createVividThemeColors(appearance, canvas, accent)` (`themePalette.ts:831-965`): the guided generator. Converts both seeds to
  OKLCH (culori), decides dark/light by canvas luminance < 0.179, derives every surface by stepping lightness from the canvas
  (`surfaceAt(deltaL)`), solves text lightness to ≥ 7:1 (`solveOklchLightness`, `:676`) and muted/placeholder/foreground-on-surface to 4.6:1,
  picks action colors (hue + 50), foregrounds via `readableThemeForeground`, and status colors via `standardStatusColors` (`:798`).
  With an achromatic accent (`C < 0.02`) the neutral hue comes from the canvas (`:855`), which is what makes the user's "test" palette
  carry hue 89.876 (see `docs/THEME.md`).
- `getDefaultThemeColors(appearance)` (`:1027`) = stock T3 palette (`T3_CODE_LIGHT/DARK_THEME_COLORS`, `themePalettes.ts:110, 174`) used to fill omitted roles.
- `updateThemeColorFamily(...)` (`:1031-1230`): in advanced mode, editing one role re-derives its family (e.g. changing `surface` fixes dependent foregrounds).
- Seed/override semantics for files: `parseThemeFile` (`:1536-1623`) = `createVividThemeColors` if `canvas`+`accent` present, else stock defaults, then
  overlay the file's `colors`.

### 2.3 How CSS variables are derived and applied

No class per theme. Mechanism (all inline on `<html>`):

1. `applyThemePalette(theme, appearance)` (`themePalette.ts:1743-1770`): sets `document.documentElement.dataset.themeId = palette.id`, and for every
   role sets `--app-theme-<kebab>` (`APP_THEME_VARIABLES`, `:1665-1716`) inline via `root.style.setProperty`. Stock theme: deletes `data-theme-id` and
   removes all `--app-theme-*`.
2. `index.css:1326` `html[data-theme-id]:not([data-theme-id=""])` maps roles → semantic shadcn tokens (`--background: var(--app-theme-canvas)`,
   `--primary: var(--app-theme-message-action)`, `--accent: var(--app-theme-accent-surface)`, `--ring`, `--border`, `--sidebar*`, `--terminal*` …).
3. `index.css:1600+` computes `--contrast-*` tokens with `color-mix` over `--appearance-contrast-base/boost/border-boost/target`, set by
   `applyAppearanceContrast` (`appearanceContrast.ts`, 10 lines): base = min(contrast,100)%, boost = max(contrast-100,0)%, border-boost = boost/4.
4. The `dark` class is toggled separately (`hooks/useTheme.ts:332`) and also sets `--appearance-contrast-target` (`index.css:93-146`).
5. `applyThemeCss(css)` (`themeCss.ts`, 64 lines): custom theme CSS goes into a constructable `CSSStyleSheet` in `document.adoptedStyleSheets`; every rule/declaration that can
   fetch (`url()`, `@import`, etc.) is stripped using `themeCssValueFetches` (`packages/shared/src/themeCss.ts:28`). Documented hook selectors are in
   `THEME_CSS_HOOKS` / `THEME_GUIDE` (`themeCss.ts:42, 78`).
6. `applyThemeBackground` (`themeBackground.ts`, 127 lines): `--theme-background-image` from a server-published image beside `<id>.json`. Needs T3's asset
   RPC; **SKIP** (could be rebuilt later as a local file upload).
7. `applyContextChipVariables` (`themePalette.ts:774`): extra `--context-chip-*` variables for composer chips. **SKIP**.
8. `syncBrowserChromeTheme` (`hooks/useTheme.ts:279`): copies `--app-chrome-background` into `html`/`body` background and every `theme-color` meta; Burnrate's
   `syncTitleBarColor` in `App.tsx:12` is a smaller version of this.

### 2.4 Built-in presets

`BUILT_IN_THEMES` (`themePalettes.ts:913`): `t3-chat`, `grove`, `ocean`, `ember`, `iris`, each with `colors` + `variants` (both halves) and `sidebarArtwork: true`
(`:238, 373, 508, 643, 778`; ~135 lines each, literal palettes). CSS for them exists in `index.css:758-913`. The "Default" theme is the stock palette (no `data-theme-id`).
`STANDARD_THEME_CARDS` / `getThemeCardDefinition` (`components/settings/ThemePreviewCircles.tsx:59, 77`) build the preview circles. The maintainer set in
`ThemeSettings.tsx:58` lists them for the library.

### 2.5 Selection model

- `theme: string` = a theme id, or `"light"|"dark"|"system"` (legacy stock). `appearanceMode: "light"|"dark"|"system"` is independent (`readAppearanceModePreference`,
  `useTheme.ts:~150`), so a dual-palette theme follows the OS, while a single-appearance theme forces its own mode (`resolveThemeAppearance`, `themePalette.ts:1772`).
- **Halves** (`themeHalves`, `t3code:theme-halves:v1`): `{light?: id, dark?: id}` lets a different theme own each appearance ("mix"). `resolveThemeHalf` `:1852`, setter
  `setThemeHalf` `useTheme.ts:583`. `setTheme` clears the mix (`:518`).
- Sync: `storage` events keep multiple windows consistent (`handleStorageChange`, `useTheme.ts:444`); `matchMedia` change re-applies in system mode.
- Desktop bridge (`window.desktopBridge.setTheme`) tells Electron the resolved mode; Burnrate has no equivalent (the OS title bar follows the `theme-color` meta, see
  `App.tsx:12`).
- **Server-default theme** (`useDefaultTheme.ts`, `themeServerSettingsAtom`): a T3 server can push a default theme; **SKIP**.

### 2.6 Import / export / share formats

| Format | Where | Notes |
|---|---|---|
| **T3 theme file v1 (JSON)** | `ThemeFile` type `themePalette.ts:64-74`; `serializeThemeFile` `:1637`; `parseThemeFile` `:1536` | `{version:1, id, name, appearance, colors:{role:color…}, variants?:{other:{…}}, collection?, managed?, css?}`. Seeds `canvas`/`accent` accepted on import. Colors must be literal CSS (no `var()`, `calc()`, keywords; `toCanonicalThemeColor` `:508`). Export = Blob download (`ThemeSettings.tsx:80`). Import cap 256 KiB per file (`ThemeImportDialog.tsx:30`) |
| **VS Code / Open VSX themes** | `vscodeThemeImport.ts` (498 lines): `parseThemeImport`, `parseVsCodeThemeFile`, `pairVsCodeThemes`, `resolveThemeLabelCollisions`; `jsonc-parser` for JSONC | Maps editor colors onto roles with `createVividThemeColors`. Pairs a light and a dark theme from one extension into one dual theme. Accepts `.json` theme files and multi-file drops (`readThemeBatch`, `ThemeImportDialog.tsx`) |
| **Open VSX marketplace search + install** | `openVsxThemes.ts` (806 lines), `ThemeSearchSection.tsx` (538), `jszip`, `@noble/hashes` | Network calls to open-vsx.org and zip parsing. **Default OFF or SKIP for Burnrate** ("everything stays on your computer", `README.md`). If kept, it must be an explicit opt-in with a disclosure |
| **Server-published themes** | `apps/server/src/environmentTheme.ts` (`~/.t3/userdata/themes/<id>.json` + optional background image, ≤ 32 files, 2 MiB total) | Same schema (`EnvironmentThemeFile`, `contracts/server.ts:640-661`, hex-only seeds). Not needed. Burnrate's own library lives in `data/settings.json` |
| **Clipboard / paste** | `ThemeJsonEditor` in `ThemeImportDialog.tsx:93` (highlighted JSON textarea, 20k highlight cap) | Paste JSON as the "share code". T3 has **no** short share-code or URL scheme. For Burnrate "copy theme JSON" is the share format |

Validation errors are user-readable strings (`parseThemeFile` throws `Error(m(msg(...)))`).

### 2.7 Theme editor UI

- Library cards: `ThemeSettings.tsx` (1,065): `ThemeLibrary` `:558`, `ThemeLibraryCard` `:100`, `CustomThemeCollectionCard` `:479`; card actions = use / light-half / dark-half /
  edit / duplicate / export / delete (AlertDialog multi-select for collections). Preview: `ThemePreviewCircles.tsx` (221) + `ThemeWireframe.tsx` (128; renders a mini UI from
  `packages/shared/src/themePreview.ts`).
- Editor: `ThemeEditorPanel.tsx` (1,352) opened through `ThemeEditorHost.tsx` (lazy, 93 lines) and the `zustand` `themeEditorStore.ts` (55). It is a **floating, draggable, resizable,
  minimizable panel** (not a dialog), so the *whole app is the live preview*: `applyThemeColorPreview` (`themePalette.ts:1724`) writes the draft colors to the root with
  `data-theme-id="__preview"`, and `restoreTheme` (= `refreshTheme`) reverts on close.
  - Guided mode (default for `managed` themes): only `canvas` and `accent` are edited; the rest regenerate (`getManagedEditorColors`).
  - Advanced mode: `THEME_EDITOR_ROLE_GROUPS` (`:64-243`: Foundation, Brand & content, Search, Context, Status) of color *families*; editing a family root cascades through `updateThemeColorFamily`.
  - Light/dark tabs per theme, role search (`roleQuery`), **element inspector** (`themeInspector.ts`, 474 lines: hover/click an element to find which role paints it, with spotlight overlay and
    `#theme-inspector-*` styles in `index.css:1366+`), a role usage counter (`highlightThemeRoleUsage`), CSS editor (`ThemeCssEditor.tsx`, 128, 100k limit, strips fetches), name + merge into an existing theme
    with the same name to add the missing appearance.
- Color picker: `ThemeColorPicker.tsx` (408): popover with `ColorSaturationValuePlane` + `ColorHueSlider` (`components/ui/color-picker.tsx`, **already in Burnrate**), hex/RGB text entry, alpha suffix kept,
  rAF-batched commits. `src/lib/color.ts` (hex↔hsv) is **already in Burnrate**.
- No contrast indicators, no WCAG pass/fail badges (see §0.4).

### 2.8 Storage

Local only: `localStorage` for themes, selection, mode, halves (key list in §0.1) through `saveCustomThemes` (`themePalette.ts:1316`) which throws `ThemeLibraryStorageError` on quota/privacy failure; reads
are validated leniently (`parseStoredTheme(s)` `:179, 201`). Environment themes cache: `t3code:environment-themes:v1`. Client numeric settings: `client-settings.json` or `localStorage` (§1).
The first-paint script in T3's `index.html` re-implements theme parsing in ~250 inline lines (it can't import modules) to paint `canvas` and `theme-color` before React mounts. Test: `themeBoot.test.ts`.

### 2.9 Fonts, density, radius, UI scale

- Fonts: `appearanceFonts.ts` + `appInit.tsx:70-130 startClientAppearance`: `--font-sans`, `--font-mono`, `--font-composer` = `custom, defaultStack`; canvas-metric probes
  (`isFontFamilyAvailable`, `isMonospaceFamily`), `--list-marker-sans`; `FontFamilyPicker.tsx` enumerates installed fonts (`queryLocalFonts` where available, `discoverInstalledFonts`).
  Default stacks (`appearanceFonts.ts:14-19`): sans `-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif`; code `"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace`.
- **UI scale** = `html { font-size: <fontSizeInterface>px }` (12-20 px, default 16). Everything is rem-based, so this is T3's only "UI scale / density" control.
  `--font-size-prompt`, `--font-size-code`, `--diffs-font-size` are set in px.
- **Radius**: no setting. `--radius: 0.5rem` constant in `index.css` (Burnrate `DESIGN.md`). **Density**: no setting; the closest controls are the interface font size and `chatWidth`.
  If the user wants radius/density controls they are **new Burnrate features**, cheap to build because everything derives from `--radius` and rem (§5 offers them as Advanced).
- `glassOpacity` → `--glass-opacity` (and `--glass-blur: 0px` at 100%) (`appInit.tsx:94-100`); consumed by popovers/composer. `panelAnimationDurationMs` → panel animation consumers (`panelAnimations.ts`).
- `data-diff-color-scheme`, `data-chat-width` dataset attrs (`appInit.tsx:82-88`): not needed.

### 2.10 Terminal themes

`terminal*` roles exist in the palette and `terminal/ghostty/*`, but Burnrate has no terminal. Keep the roles in files (they are in the 61), drop all terminal code.

---

## 3. Exact port list, shims, effort

Effort unit = engineer-days for someone familiar with the codebase, including tests. Total for the full theme manager + settings shell ≈ **13-16 days**; MVP (§3.4) ≈ **6-7 days**.

### 3.1 Files to copy (mode)

| # | Upstream file | Lines | Burnrate target | Mode | Shims / changes | Days |
|---|---|---|---|---|---|---|
| 1 | `packages/shared/src/themePalettes.ts` | 927 | `src/shared/themePalettes.ts` | verbatim | none (pure TS) | 0.1 |
| 2 | `packages/shared/src/themeCss.ts` | 97 | `src/shared/themeCss.ts` | verbatim | none | 0.1 |
| 3 | `packages/shared/src/themePreview.ts` | 143 | `src/shared/themePreview.ts` | verbatim | change `.js` import suffix | 0.1 |
| 4 | `themePalette.ts` | 1858 | `src/themePalette.ts` | **adapted (largest)** | Remove: `Atom`/`appAtomRegistry`/`themeServerEnvironmentThemesAtom`/`environmentThemeDefinitionsAtom` (`:34, 37, 274-370`), `contextChip*` (`:733-780`, `./lib/contextChipAccents`), `EnvironmentTheme` import, `applyThemeBackground`. Keep: ~1,300 lines of pure math/parse/serialize. Replace `Schema.TaggedError` classes with plain `Error` subclasses. Replace `m(msg())` with Burnrate `~/i18n` `msg`. **Replace the localStorage backend** with the store in §4 (keep a write-through localStorage mirror for the first-paint script) | 1.5 |
| 5 | `hooks/useTheme.ts` | 669 | `src/hooks/useTheme.ts` | adapted | Remove `Schema`, `safeErrorLogAttributes`, `DesktopBridge`/`syncDesktopTheme`; keep `applyTheme`, snapshot/subscribe, halves, preview guard, `no-transitions` class. Keep as `useSyncExternalStore` (no Effect needed) | 1.0 |
| 6 | `hooks/useCustomThemes.ts` | 9 | same | verbatim | — | 0 |
| 7 | `themeCss.ts` | 64 | `src/themeCss.ts` | verbatim | needs `~/shared/themeCss` alias | 0.1 |
| 8 | `appearanceContrast.ts` | 10 | same | verbatim | replace `@t3tools/contracts/settings` type import | 0 |
| 9 | `appearanceFonts.ts` | 341 | same | adapted | contracts constants (`MIN/MAX/DEFAULT_*_FONT_SIZE`) moved to Burnrate settings module | 0.3 |
| 10 | `vscodeThemeImport.ts` | 498 | same | adapted | add dep `jsonc-parser@3.3.1`; i18n | 0.3 |
| 11 | `components/settings/ThemeColorPicker.tsx` | 408 | same | verbatim-ish | already has `ui/color-picker`, `lib/color`, `popover`, `input`, `tooltip` | 0.2 |
| 12 | `components/settings/ThemePreviewCircles.tsx`, `ThemeWireframe.tsx` | 221+128 | same | verbatim | none | 0.2 |
| 13 | `components/settings/ThemeSettings.tsx` | 1065 | same | adapted | remove `useEnvironmentThemeDefinitions` (published themes), `stackedThreadToast`/`toastManager` (**Burnrate has no `ui/toast.tsx`**: copy `ui/toast` + its deps, or swap for inline `Alert`), `gt-react` is shimmed already | 1.5 |
| 14 | `ThemeEditorPanel.tsx`, `ThemeEditorHost.tsx`, `themeEditorStore.ts`, `ThemeCssEditor.tsx`, `themeInspector.ts` | 1352+93+55+128+474 | same | adapted | `zustand` dep (or 15-line own store, `src/t3-shims/store.ts` pattern); `useViewportSize` hook; ToggleGroup/Switch/Input exist. Inspector uses `data-slot` + class names that exist because `ui/*` is verbatim | 2.0 |
| 15 | `ThemeImportDialog.tsx` | 567 | same | adapted | remove `ThemeSearchSection` (Open VSX) unless opt-in; `@t3tools/client-runtime` (`thrownErrorMessage`, `settlePromise`) → local 10-line helpers; `formatBytes` lib | 0.8 |
| 16 | `ThemeSearchSection.tsx` + `openVsxThemes.ts` | 538+806 | — | **SKIP by default** (optional opt-in, +2.5 d incl. jszip, @noble/hashes, offline-first disclosure) | | (2.5) |
| 17 | `components/settings/AppearanceSettingsPanel.tsx` | 501 | same | adapted | trim rows per §5; `useScopedSettings` → Burnrate `useSettings` | 0.6 |
| 18 | `TypographySettings.tsx`, `FontFamilyPicker.tsx`, `SettingsFontPreviews.tsx` | 575+243+251 | same | adapted | drop prompt/terminal/composer rows; `useLocalStorage` hook; `ui/combobox`, `ui/command` exist | 1.2 |
| 19 | `settingsLayout.tsx` | 674 | same | **rewrite subset (~150 lines)** | Keep `SettingsSection`, simplified `SettingsRow`, `SettingResetButton`, `SettingsPageContainer`, `scrollToSettingsTarget`; delete scope/policy/inheritance/environment code (`:313-584` is ~80% scope logic) | 0.8 |
| 20 | `SettingsGroup.tsx`, `AdvancedSettings.tsx`, `FoldedSettingsSection.tsx`, `PanelAnimationsPreview.tsx`, `ScopedSwitch` (drop) | 30+43+102+54 | same | verbatim | `ui/collapsible` exists | 0.2 |
| 21 | `SettingsSidebarNav.tsx` + `settingsSearch.ts` + `settingsSectionNavigation.ts` | 443+1707+33 | slim versions | **rewrite** | Keep nav groups, active styling, `/` and Ctrl+F search focus. The search index is a flat list of `{id, title, keywords, path}`; rebuild a ~100-line version for Burnrate rows (do not port 1,707 lines tied to T3 commands) | 1.2 |
| 22 | `appInit.tsx` `startClientAppearance` | ~60 | `src/appearance.ts` | adapted | `data-*` and CSS var writers; subscribe to the new settings store | 0.3 |
| 23 | `useSettingsRestore` (`SettingsPanels.tsx:468`) | ~200 | `Restore defaults` | rewrite (~50 lines) | changed-labels list from a field registry (§4.3) | 0.4 |
| 24 | Tests: `themePalette.test.ts`, `themePalette.browser.test.tsx`, `themeBoot.test.ts`, `themeCss.test.ts`, `vscodeThemeImport.test.ts`, `ThemeEditorPanel.browser.test.tsx` | — | `src/**/*.test.ts` | adapted | Burnrate has no test runner yet (`package.json` scripts: dev/build/typecheck only); add `vitest`. Port at least `themePalette.test.ts` + `themeBoot.test.ts` (first-paint script parity) | 1.0 |
| 25 | `ui/toast.tsx` (+ `Toast.Provider` at app root) | — | `src/components/ui/toast.tsx` | verbatim copy via sync tool | needed for save-failure/import-success feedback | 0.4 |

New npm deps: `culori@^4.0.2` (`themePalette.ts:8-9`, `converter`, `parse`; ~30 KB min), `jsonc-parser@3.3.1`, `zustand` (optional), `vitest`. Optional: `jszip`, `@noble/hashes` (Open VSX only).
Already satisfied in Burnrate: `@base-ui/react`, lucide, `ui/color-picker`, `ui/select`, `ui/switch`, `ui/dialog`, `ui/alert-dialog`, `ui/popover`, `ui/combobox`, `ui/command`, `ui/collapsible`, `ui/toggle-group`, `ui/input-group`, `src/t3-shims/gt-react.ts`, `src/i18n.ts`.

### 3.2 Dependencies that must be shimmed

| T3 dependency | Used by | Burnrate approach |
|---|---|---|
| `effect` (`Schema`, `Atom`, `Function.pipe`, `Equal`, `Option`) | `themePalette.ts`, `useTheme.ts`, `useSettings.ts`, `contracts/settings.ts` | **Do not add Effect.** Replace `Schema.TaggedError` with `class X extends Error`, `pipe` with direct calls, `Atom` stores with `useSyncExternalStore` (pattern already in `src/hooks/useSettings.ts`). Validation of settings with small hand-written parsers (§4.2) or `zod`/`valibot` (zod adds ~13 KB) |
| `@t3tools/contracts` (settings, server) | constants `MIN/MAX/DEFAULT_*`, `THEME_CSS_MAX_LENGTH` | New `src/settings/schema.ts` (§4.2). Re-export the same constant names so copied files only need an import path change |
| `@t3tools/shared/themePalettes`, `themeCss`, `themePreview` | palette, applyThemeCss, wireframe | copy into `src/shared/` verbatim (tracked in `t3-manifest.json`) |
| `@t3tools/client-runtime` (`errors`, `state/runtime`) | import dialog, theme editor, ThemeSettings | local 15-line helpers: `thrownErrorMessage`, `settlePromise`, `errorDisplayMessage` |
| `gt-react` | everywhere | `src/t3-shims/gt-react.ts` already exports `msg, T, useGT, useMessages, Var, useLocale` |
| `./i18n/messages` `m`, `MessageResolver` | `themePalette.ts`, pickers | provide `src/i18n/messages.ts` re-exporting `msg`/identity resolver from `~/i18n` |
| `rpc/atomRegistry`, `state/server`, `state/primaryEnvironment`, `state/assets` | published themes + backgrounds + default-theme adoption | delete code paths (themes are local) |
| `window.desktopBridge` | `syncDesktopTheme` | delete; keep `syncTitleBarColor` from `App.tsx` |
| `useLocalStorage` hook, `useViewportSize`, `lib/formatBytes`, `lib/workspaceFocus` | typography toggle, editor, import | small copies |
| `@tanstack/react-router` | settings routing | not needed: Burnrate navigates with local state (`App.tsx` `view`); use a `settingsSection` state and the URL hash |

### 3.3 Recommended port order

1. Pure modules (#1-3, #4 minus storage, #7-9) + tests → runs headless.
2. New settings store + schema + Rust persistence (§4), then `useTheme` on top of it (#5).
3. Replace `theme-dark.css`/`App.tsx useTheme`/`index.html` boot script with the runtime pipeline; confirm pixel parity for the Burnrate default (§6.1).
4. Settings shell (#19-21), Appearance page with theme library cards (#13, #12, #17), then editor (#14), import/export (#15), typography (#18).
5. Restore/import/export of all settings (§4.4), polish.

### 3.4 MVP cut (≈ 6-7 days)

Pure modules + store + persistence + Appearance page with: theme cards (built-ins + custom), light/dark/system, per-appearance "halves", import/export JSON of a single theme (no VS Code, no Open VSX), the *guided* editor (canvas + accent + name) with live preview, contrast slider, glass opacity, interface font size, font family pickers, restore defaults. Add the advanced role editor, VS Code import and inspector second.

---

## 4. Proposed Burnrate settings model and persistence

### 4.1 Where state lives

Today: UI prefs in `localStorage["burnrate.settings"]` (`src/hooks/useSettings.ts:11`), usage-page prefs in `t3code:usage-page-preferences:v1` (`usagePagePreferences.ts:4`), Rust server holds only price overrides/aliases.
Recommendation: **the server `data/settings.json` is the source of truth; `localStorage` is a write-through cache** used (a) by the synchronous first-paint script and (b) if the server is unreachable. Rationale: the app is served from `127.0.0.1` and a desktop shell may use a different WebView profile than the browser, so themes in `localStorage` would silently differ per profile (T3's own desktop vs web split); one file also makes backup/import trivial. The first paint cannot wait for `fetch`, so the cache mirror must be maintained (§6.2).

### 4.2 Schema (TypeScript)

```ts
// src/settings/schema.ts
export const SETTINGS_VERSION = 1 as const;

export type AppearanceMode = "system" | "light" | "dark";
export type ThemeHalves = { light?: string; dark?: string };          // same as T3 (themePalette.ts:1830)

export interface AppearanceSettings {
  appearanceMode: AppearanceMode;          // default "system"
  themeId: string;                         // "" = stock Burnrate palette; else a built-in/custom id
  themeHalves: ThemeHalves | null;         // default null
  contrast: number;                        // 50-200 int, default 100
  glassOpacity: number;                    // 40-100 int, default 80 (T3 MIN_GLASS_OPACITY = 40, settings.ts:139)
  fontSizeInterface: number;               // 12-20, default 16
  fontSizeCode: number;                    // 10-18, default 13
  fontFamilySans: string;                  // "" = default stack
  fontFamilyCode: string;                  // "" = default stack
  fontSmoothing: boolean;                  // default true
  panelAnimationDurationMs: number;        // 0-400, default 0
  // Burnrate additions (not in T3):
  radius: "compact" | "default" | "round"; // maps to --radius 0.25rem / 0.5rem / 0.75rem, default "default"
  density: "compact" | "default";          // default "default"; implemented as a data attribute + a few CSS vars
  reducedMotion: "system" | "on" | "off";  // default "system"
}

export interface DisplaySettings {
  language: string;                        // "en" (T3 default; "system" allowed)
  timestampFormat: "locale" | "12-hour" | "24-hour";  // default "locale" (src/timestampFormat.ts)
  hideSensitive: boolean;                  // existing Burnrate key, default false (hides account names/emails)
  currency: "USD";                         // placeholder; default "USD"
}

export interface UsageViewSettings {       // replaces t3code:usage-page-preferences:v1
  defaultMetric: "cost" | "tokens" | "limits";   // default "limits"
  defaultWindowDays: 1 | 7 | 30 | 90;            // default 30
  hiddenProviders: string[];                      // default []
  limitsBarMode: "remaining" | "used";            // default "remaining" (DESIGN.md: bar shows remaining)
  showPaceTick: boolean;                          // default true
  poolAccounts: boolean;                          // default true
  autoRefreshSeconds: 0 | 30 | 60 | 300;          // default 60; 0 = manual
}

export interface NotificationSettings {
  mode: "off" | "notifications" | "sound" | "notifications-and-sound";   // default "off" (T3: notificationMode)
  warnAtRemainingPercent: number;           // default 20 (0 disables)
  notifyOnReset: boolean;                   // default false
}

export interface DataSettings {
  usageHistoryRetentionDays: number | null; // T3 key usageHistoryRetentionDays; default null = keep all
  usagePriceOverrides: Record<string, PriceOverride>;   // existing, server-validated
  usageModelAliases: Record<string, string>;            // existing
  usageModelFilter?: unknown;                           // T3 usageModelFilter, optional
}

export interface LabsSettings { [flag: string]: boolean }   // all default false

export interface ThemeFileV1 { /* exactly T3 ThemeFile, themePalette.ts:64 */ }

export interface BurnrateSettings {
  version: typeof SETTINGS_VERSION;
  appearance: AppearanceSettings;
  display: DisplaySettings;
  usage: UsageViewSettings;
  notifications: NotificationSettings;
  data: DataSettings;
  labs: LabsSettings;
  themes: ThemeFileV1[];                   // custom theme library (≤ 64 entries, ≤ 256 KiB each in file, ≤ 2 MiB total, same ceiling as T3's server publisher)
  shortcuts: Record<string, string>;       // command → key chord override; missing = default
}
```

Naming note: keep T3's flat key names (`appearanceContrast`, `fontSizeInterface`, `timestampFormat`, …) *inside* the groups where possible so the sync/diff against T3 stays mechanical, e.g. `appearance.contrast` ↔ `appearanceContrast`.
Validation: per-field parsers with clamping and defaults (T3 uses `withDecodingDefault`, which decodes unknown/invalid input to the default per field, `settings.ts:405+`). Unknown keys are **preserved** (forward compatibility, as T3 does for `threadDetailsItems`).

### 4.3 Defaults registry and reset

Define one `SETTINGS_FIELDS` registry: `{ path: "appearance.contrast", label, default, section, searchId, risk: "visual"|"data" }`. It drives (a) defaults, (b) per-row `SettingResetButton` visibility (`value !== default`, as in `AppearanceSettingsPanel.tsx:171-181`), (c) the "Restore defaults" dialog's changed-labels list (replaces the 200-line hand-written chain in `useSettingsRestore`, `SettingsPanels.tsx:468-640`), and (d) search.

Reset strategy (three levels, each behind an AlertDialog):
1. **Per row**: undo icon → set the field to default.
2. **Per section** ("Reset appearance"): resets the group, leaves `themes` library alone.
3. **Restore defaults** (Maintenance → Data): lists changed settings, resets everything **except** `data.usagePriceOverrides`, `data.usageModelAliases`, `themes` (custom library) and encrypted provider keys; a second checkbox "Also delete my custom themes" and a separate, clearly destructive "Clear price overrides". Offer an automatic `settings.json.bak` before any bulk reset or import (T3 users keep `.bak-*` files by hand in `~/.t3/userdata/`, which shows the demand).

### 4.4 Import / export of all settings

- Export: `GET /api/settings` → `burnrate-settings-YYYY-MM-DD.json` with `{"format":"burnrate-settings","version":1,"exportedAt":…, "settings":{…}}`. Secrets (API keys) live in the encrypted `keys` store, never in this file, so the export is safe to share. Include a toggle "Include price overrides / custom themes".
- Import: parse, run the same field parsers, show a diff summary ("12 settings change, 3 themes added, 1 theme conflicts"), per-theme conflict choice (skip / replace / keep both, mirrors `ThemeImportDialog` `conflicts` state), then `PATCH`. Reject files > 2 MiB.
- Single theme import/export stays T3-compatible (`ThemeFile` v1) so themes move between T3 and Burnrate unchanged.

### 4.5 Rust server changes (`server-rs/src/settings.rs`, `main.rs`)

Current state (read): `SettingsStore { path, raw: Mutex<Value> }`; `open` keeps **only** `usagePriceOverrides` and `usageModelAliases` from disk (`:36-40`) so unknown keys are dropped on next write; `patch` loops those two keys with null-to-delete semantics and per-entry validators (`valid_price`, `valid_name`, `:12-24`), writes pretty JSON with `std::fs::write` (non-atomic) and returns the merged object; `GET /api/settings` returns `raw()`, `PATCH` takes `{"patch": {...}}` (`main.rs:173-179`); mutations require header `X-Burnrate: 1` and a matching `Origin` (`main.rs:155-166`, client adds the header in `src/api.ts:55`).

Required changes:

1. **Preserve everything**: `raw` starts as the full on-disk object; add `"version"`. Keep the typed `Settings` view for the engine (`get()`), unchanged.
2. **Generic deep-merge PATCH** (RFC 7396 style, `null` deletes) for the new groups, with per-group validators in Rust (clamp numbers, enum check, string length caps, `themes` array validated for `id` pattern `^[a-z0-9][a-z0-9-]{0,47}$`, reserved ids, ≤ 64 themes, each color ≤ 64 chars, CSS ≤ 100,000 chars). Keep "an invalid entry rejects the whole patch" (the existing rule) so partial writes cannot corrupt state. Arrays (`themes`, `hiddenProviders`) are replaced wholesale, not merged. Validate colors server-side only structurally (do not parse CSS colors in Rust; the client parsers are the authority).
3. **Atomic writes**: write `settings.json.tmp` then rename; keep `settings.json.bak` of the last-good file (cheap, and it enables the "undo import" path).
4. **Raise the body limit** for `/api/settings` to ~2.5 MiB (`read_body` currently 16 KiB, `main.rs:144`); keep 16 KiB for the other endpoints. 61 roles × ~45 B ≈ 3 KB per palette, ≈ 6 KB per dual theme, so 64 themes ≈ 400 KB plus CSS.
5. **Versioning**: top-level `version: 1`. On `open`, if `version` is missing (today's file), run `migrate_0_to_1` (wrap the two existing maps under `data.*`, or keep them at the top level and treat as v1 layout – decide once; I recommend keeping `usagePriceOverrides`/`usageModelAliases` at their current top-level keys to avoid breaking the engine's `get()` and existing users). Unknown higher `version` ⇒ load read-only and warn rather than overwrite.
6. **Concurrency**: the `Mutex` serialises writers; add a `revision` counter returned in each response and accepted as `ifRevision` in PATCH to detect multi-window lost updates (T3 handles this with `storage` events; Burnrate should emit a `BroadcastChannel("burnrate-settings")` message after every successful PATCH and the client refetches).
7. New endpoints (optional): `POST /api/settings/reset` with `{scope}` and `GET /api/settings/export`, or do both client-side over GET/PATCH (simpler; no new server surface).

### 4.6 Client settings store

Replace `src/hooks/useSettings.ts` with the same external-store shape (`useSyncExternalStore`) but: initial snapshot = parsed `localStorage` mirror (sync, for first render and the boot script), then hydrate from `GET /api/settings`; `updateSettings(patch)` applies optimistically, mirrors to `localStorage`, debounces a `PATCH` (250 ms, coalescing; sliders fire often), rolls back and toasts on 400. Keep exported names `usePrimarySettings` / `updateSettings` so the copied Usage components that already import them (`UsagePage.tsx`, `UsageLimits*.tsx`, `UsagePriceOverrides.tsx`, `src/timestampFormat.ts`) keep working. Migrate once: read `burnrate.settings` (`theme` → `appearanceMode`, `timestampFormat`, `hideSensitive`) and `t3code:usage-page-preferences:v1`, write v1 to the server, then leave the old keys in place for one release.

---

## 5. Recommended Settings page layout

Window pattern: reuse `AppModalFrame` (currently Usage and Providers are `view` states in `App.tsx:46`); Settings becomes a third `view` with a left nav (T3's icon-rail below `md`, `SettingsSidebarNav.tsx`) and the `SettingsPageContainer` scroller. Route state in the URL hash (`#appearance`, `#appearance-contrast`) so search results and deep links scroll to a row (`scrollToSettingsTarget`, `settingsLayout.tsx:666`). Header action: gear icon next to the Providers button (`App.tsx:51`).

Nav groups (mirrors `SETTINGS_NAV_GROUPS`):
- *Preferences* (hidden heading): **General**, **Appearance**, **Usage**, **Notifications**, **Shortcuts**
- *Data*: **Providers** (existing page), **Data & storage**
- *More* (hidden heading): **Labs**, **About**

Rows use `SettingsSection` (title + rounded `bg-card/40` group) and `SettingsRow` (title, description, reset undo, control) exactly as in T3. "ON/OFF" below is the **default**.

**General** – Display: Language (select, `en`), Time format (locale/12/24, `locale`), Hide account names and emails (switch, OFF; hides what `RedactedSensitiveText.tsx` already hides), Launch/startup: *Open on login* (Labs; OFF).

**Appearance**
1. *Colors & themes* (plain section, no title): ThemeLibrary: appearance toggle (System · Light · Dark, default System), theme cards (Default, 5 T3 presets, Burnrate Graphite (the "test" palette), customs), per-card light/dark half assignment, **New theme**, **Import**, Export, Duplicate, Delete.
2. *Interface*: Contrast slider (100%), Glass opacity (80%), Corner roundness (Default), Density (Default), Reduce motion (System). Advanced fold: Panel animations (0 ms), Theme CSS enabled (ON, but see §6), Show theme source/inspector (OFF).
3. *Typography*: Interface font (default stack), Interface size (16 px), Monospace font (default), Code size (13 px), Font smoothing (ON). Advanced fold: Reset all fonts.

**Usage**
- Default view (Limits), Default period (30 days), Pool accounts in one bar (ON), Bars show remaining (ON) / used (OFF), Show pace tick (ON), Auto refresh (60 s), Hide providers (multi-select, none), Cost currency (USD).
- *Model names*: aliases and price overrides entry point (re-use `UsagePriceOverrides`, already built).

**Notifications** – Mode (Off), Warn when remaining ≤ (20 %), Notify when a limit resets (OFF), Sound (OFF). OFF by default because they request OS permission (`NotificationSettings.tsx` flow: `Notification.requestPermission`, HTTPS/secure-context check; `127.0.0.1` counts as secure).

**Shortcuts** – 7 rows (cost, tokens, limits, 4 periods) with the key-capture control; per-row reset; "Reset all".

**Data & storage** – Data folder path (read-only + Open), Scan-cache size and "Clear cache", History retention (Keep all), **Export settings**, **Import settings**, **Restore defaults** (destructive, confirm), Price overrides (count, "Clear").

**Labs** (all OFF): Open Vsx theme search (network), Theme CSS editor, Radius/density sliders if not promoted, Experimental providers.

**About** – Version, build, data location, MIT licence, T3 Code notice (`NOTICE`), Open-source licenses page (pattern of `OpenSourceLicenses.tsx`, 314 lines, SPDX in `third-party-licenses/`), "Check theme file format" help.

Default philosophy: nothing that reaches the network (Open VSX, update checks, notifications) is ON; visual defaults reproduce today's Burnrate exactly; accessibility toggles (reduced motion = System, contrast 100%) follow the OS.

---

## 6. Risks and mitigations

### 6.1 Theme contrast / readability
- Generated themes are contrast-safe (text ≥ 7:1, muted ≥ 4.6:1, `themePalette.ts:855-899`), but **imported VS Code themes, hand-edited roles and custom CSS can produce unreadable UI**, and Burnrate's quota bars rely on a colour-on-surface read (provider colours are independent of the theme, `docs/THEME.md`).
- Add (Burnrate-only, T3 lacks it): a contrast report in the editor computed with `themeContrastRatio` (module-private today, `themePalette.ts:967`; export it in the adapted copy) for the key pairs (text/canvas, mutedForeground/surface, accentForeground/accent, messageActionForeground/messageAction, errorForeground/errorSurface), AA/AAA badges, a warning toast on save/import, and a "Fix automatically" action that re-runs `readableThemeColorOn(color, surface, 4.5)` (`themePalette.ts:706`). The contrast slider (50-200) can already rescue many cases; make it reachable from a recovery path.
- **Safe mode**: `?safe-theme` query / `Ctrl+Shift+R` in Settings forces the stock palette and disables theme CSS without touching stored data, so a bad theme can never lock the user out of the editor.
- Parity risk when replacing `theme-dark.css` (static copy of a derived palette): verify the runtime-derived Burnrate Graphite equals the 61 values already declared there and the pixel samples in `docs/THEME.md` (#181818 etc.), then delete the file.

### 6.2 Flash of unstyled theme (FOUT/FOUC)
- Current boot script (`index.html:14-33`) only handles light/dark. With custom themes the pre-paint script must resolve: selected theme id → stored custom theme → `canvas`/`chrome` colour for the active appearance, set `html` background, `theme-color` meta and `color-scheme`. T3 does this with a 250-line inline script that duplicates parsing (`apps/web/index.html`, `themeBoot.test.ts`); it reads **localStorage**, which is why Burnrate's cache mirror (§4.1) must hold `{themeId, appearanceMode, halves, themes[]}` or at least a precomputed `{light:{canvas,fg}, dark:{canvas,fg}}` "boot palette". The simpler Burnrate variant: on every theme change, write `burnrate.boot = {dark:bool, bg:"#rrggbb", fg:"#rrggbb"}` (computed from the applied `--background`, as `syncTitleBarColor` already does) and have the boot script only read that, plus `matchMedia` for `system`. That removes the need to duplicate colour parsing.
- Also apply `fontSize`, `--glass-opacity` and contrast vars in the boot script (or before first render in `main.tsx`) to avoid a visible resize after hydration. Keep T3's `no-transitions` class around changes (`useTheme.ts:~320`).
- The Rust server serves a static `index.html`; the CSP must allow the inline boot script (hash it) and `adoptedStyleSheets` (no CSP impact). Check `server-rs` headers when adding the theme CSS feature.

### 6.3 Token drift when T3 updates
- `index.css` is verbatim and tracked by `scripts/sync-t3.mjs`; new theme roles in T3 would add `--app-theme-*` vars and `THEME_COLOR_ROLES` entries; if `themePalettes.ts` drifts from `index.css`, the new tokens render with fallback values. Add both `src/shared/themePalettes.ts` (verbatim), `src/shared/themeCss.ts`, `src/shared/themePreview.ts` to `scripts/t3-manifest.json`, and `themePalette.ts` as `adapted` (check its diff on every sync; the adapted parts are confined to storage/Effect). Add a CI check that the set of `--app-theme-*` variables used in `index.css` equals `APP_THEME_VARIABLES` values.
- Theme file `version` is `1` (`THEME_FILE_VERSION`); `parseThemeFile` rejects other versions. Keep T3's behaviour and add Burnrate's own forward path: unknown extra keys ignored on import, `version > 1` → "made with a newer app" message.
- Missing roles in old files fill from defaults (`parseThemeFile` `fallback`), so adding roles upstream does not break stored themes.

### 6.4 Licence / NOTICE
- T3 Code is MIT, Copyright (c) 2026 T3 Tools Inc. (`LICENSE:3`). Burnrate's `NOTICE` today lists only the UI library, stylesheet, Usage components and limit pooling logic. **Update `NOTICE`** to add: theme palette/derivation (`themePalette.ts`, `themePalettes.ts`, `themeCss.ts`, `themePreview.ts`), theme editor/import UI, settings layout components, `vscodeThemeImport.ts`, and (if shipped) `openVsxThemes.ts`. MIT requires keeping the copyright + permission notice with "substantial portions", so keep the notice in the shipped app (About page) and per-file header comments for adapted files.
- Built-in presets (T3 Chat, Grove, Ocean, Ember, Iris) are T3 content; "T3 Chat" is a product/brand name belonging to a different T3 product. Rename in the Burnrate UI (e.g. keep ids for file compatibility, relabel) and avoid implying endorsement (NOTICE already disclaims affiliation). The `T3Wordmark.tsx` component in `src/components` should not appear in Settings → About.
- Third-party: `culori` (MIT), `jsonc-parser` (MIT), `zustand` (MIT), optional `jszip` (MIT or GPLv3 dual, pick MIT) and `@noble/hashes` (MIT). Add to a generated `third-party-licenses` listing as T3 does (`third-party-licenses/spdx`, `OpenSourceLicenses.tsx`).
- Imported VS Code themes carry the original extension's licence; the import dialog should show the source name and keep `collection.label`, and exports should not strip it.
- Theme CSS: treat as **untrusted code**. T3's strip of `url()`/`@import`/unknown at-rules is the key defence (`themeCss.ts`), but stylesheet-only attack surface still includes UI redressing (hide the real "Delete" button, spoof status text) and attribute-selector data exfil via fonts is blocked only because fetches are stripped. Default the "Theme CSS" feature to Labs/OFF, show a warning on import of a theme with `css`, and never apply CSS from an import before the user clicks Use.

### 6.5 Other risks
- **Bundle/complexity**: `themePalette.ts` + editor + inspector ≈ 6,000 lines; lazy-load the editor (`ThemeEditorHost` already uses `lazy`) and `vscodeThemeImport` to keep the main chunk lean (the server is tuned for a ~125 MB footprint, but this is client code).
- **localStorage quota**: T3 caps published themes at 2 MiB total because of the ~5 MB quota (`environmentTheme.ts` comment); Burnrate's cache mirror should store only the boot palette, not the library.
- **Multiple windows/profiles** diverging: use `BroadcastChannel` + `revision` (§4.5).
- **Slider write storms**: debounce PATCH; apply CSS vars synchronously and persist later.
- **Rust patch validation vs. client schema drift**: put limits (ranges, id pattern) in one JSON "limits" block that both sides read, or generate one from the other in a test.
- **Preview leak**: the editor sets `data-theme-id="__preview"` and `applyTheme` skips while it is set (`useTheme.ts:306-309`); a crash while editing would leave the preview on. Clear it on `visibilitychange`/reload (the boot script ignores `__preview`).
- **No test runner** in Burnrate; porting ~25 T3 test files without one is not possible. Add `vitest` + `jsdom` first.
- **i18n**: Burnrate's `~/i18n` resolves English only; copied strings stay as `msg(...)`, so a later translation effort works unchanged.

---

## 7. Open questions for the product plan
1. Do we want the Open VSX marketplace search at all (breaks the "stays on your computer" promise unless opt-in)?
2. Should the "test" palette ship as a built-in **Burnrate Graphite** dark half, with the stock palette as light half (using `themeHalves`), or stay a user-importable file?
3. Are radius/density controls (new, not in T3) in scope for v1, or only T3's contrast/glass/interface-size?
4. Server-first (recommended) or `localStorage`-first persistence for themes? The former needs the Rust changes in §4.5.
5. Notifications: in scope (permission prompts, background polling in the Rust server) or deferred?
