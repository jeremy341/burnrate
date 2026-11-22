# Review: Settings, theming and UI parity

Scope: static review of `src/` (React 19 + Vite + Tailwind 4) and `server-rs/src/settings.rs`, `server-rs/src/themes.rs`. Branch `feature/universal-app`, commit `b0de7a6`. No app run; visual findings are flagged as needing a visual check.

## Severity: Critical

_None found that is provably a crash/data-loss by reading code alone. The highest-risk item is below under High._

## Severity: High

### H1. Two independent writers of the `dark` class on `<html>` can fight each other
- Files: `src/App.tsx:32-47` (`useThemeMode`), `src/appearance.ts:43-70` (`applyAppearance`), `src/main.tsx:26-27` (mount order).
- What is wrong: `App.tsx`'s `useThemeMode()` toggles `.dark` based only on `settings.appearance.themeMode` (`dark`/`system`+OS). Separately, `appearance.ts`'s `applyAppearance()` toggles `.dark` based on `resolveAppearance()`, which can *force* dark/light for a single-appearance theme (e.g. a dark-only VS Code theme selected while `themeMode === "system"` and the OS is light). Both effects run on settings changes. `AppearanceSync` is mounted before `App`, so `App`'s effect runs last and overwrites the resolved mode.
- Why it matters: selecting a single-appearance theme in the opposite OS mode, or toggling the theme button, can leave `.dark` stale, so the whole UI paints with the wrong palette until a reload. This is the same class of "stale derived state" bug as the UsagePage render loop.
- Suggested fix: delete `useThemeMode` from `App.tsx` and let `appearance.ts` be the sole owner of `.dark`/`colorScheme`. Keep `App.tsx`'s theme button calling `updateSettings({ appearance: { themeMode } })`; `useAppearanceSync` already re-runs `applyAppearance`. Remove the now-unused `MoonIcon`/`SunIcon` import only if nothing else uses them.

### H2. Render-loop risk: `ThemeEditorPanel` derives state during render
- File: `src/components/settings/ThemeEditorPanel.tsx:558-570`.
- What is wrong: `if (appliedMergeKey !== mergeKey) { setAppliedMergeKey(mergeKey); ... setActiveAppearance(...); }` runs in the render body. It is guarded by the key comparison so it terminates, but it is the exact pattern that caused the UsagePage `hiddenProviders` loop. Any future change that makes `mergeKey` recomputed to a new value each render (it depends on `takenAppearances.join(",")`, and `takenAppearances` is derived from props) re-enters the branch and loops.
- Why it matters: a render loop in the theme editor freezes the settings tab; the guard is fragile.
- Suggested fix: move this into a `useEffect` keyed on `mergeKey`, or compute `activeAppearance` lazily with `useState(initial)` + `useEffect`. Add a regression test mounting the panel with a two-appearance merge target.

### H3. Server theme-color validation is far weaker than the client's
- File: `server-rs/src/settings.rs:315-323` (`validate_colors`).
- What is wrong: the server only checks that each color value is a string of 1-40 chars. The client (`src/themePalette.ts:116-118`, `toCanonicalThemeColor`) requires a parseable CSS color that canonicalizes to oklch. A patch/import can therefore persist values such as `"red"` or `"not-a-color"` that the client then fails to canonicalize; `applyThemePalette` (`src/themePalette.ts:1525-1543`) calls `root.style.setProperty(APP_THEME_VARIABLES[role], value)` with the raw string, and `parseStoredTheme` (`src/themePalette.ts:179-199`) fills defaults only for missing roles, not invalid ones.
- Why it matters: imported/malformed themes can produce invisible or unstyled UI in both modes, and the server echoes the bad values back on every load.
- Suggested fix: either reject non-canonical colors server-side (port a minimal oklch/hex check) or, cheaper, canonicalize in `parseStoredTheme`/`applyThemePalette` by skipping roles whose `toCanonicalThemeColor` is null instead of applying them. The client-side guard is the smaller, safer change and keeps the server dumb.

## Severity: Medium

### M1. First paint can flash stock palette for custom themes
- Files: `index.html:14-47` (boot script), `src/main.tsx:3-16`, `src/themes/engine/boot.ts:37-51`.
- What is wrong: the inline boot script only paints `--background`/`.dark` from `burnrate.boot` (`{dark,bg,fg}`) and the mirror; it never sets `data-theme-id` or the `--app-theme-*` variables, and `startClientAppearance()` (which does) runs only after `index.css`/`appearance.css` are imported (`main.tsx:14`). For a non-stock theme the first frame is the stock palette, then snaps.
- Why it matters: visible flash on cold start, especially switching between a dark-only custom theme and light OS mode (interacts with H1).
- Suggested fix: either inline the resolved `data-theme-id` + a small subset of `--app-theme-*` into `burnrate.boot`, or apply `startClientAppearance()` before importing the stylesheets is not possible (CSS needed). Acceptable alternative: keep the current behavior but document it; visual check required.

### M2. `applyAppearanceContrast` ignores `highContrast`
- Files: `src/appearance.ts:67`, `src/appearanceContrast.ts:10-17`, `src/settings/schema.ts:48`.
- What is wrong: `applyAppearance(root, 100)` is hardcoded to 100 regardless of `settings.appearance.highContrast`. The boolean is handled only by the CSS `html[data-high-contrast="true"]` block (`src/appearance.css:124-134`), which overrides tokens. That works for the stock palette, but for custom themes the `--contrast-*` chain from `index.css` is what drives text; the CSS override only changes `--border`/`--muted-foreground`/etc., not the `--contrast-*` inputs, so high-contrast text can stay at stock contrast.
- Why it matters: high-contrast mode is partially ineffective on custom themes.
- Suggested fix: either drive high-contrast through the same `--contrast-*` variables (call `applyAppearanceContrast(root, highContrast ? 200 : 100)`) or extend the CSS block to also boost `--contrast-foreground`/`--contrast-muted-foreground`. Needs visual verification.

### M3. `validate_colors` (server) and `parseStoredTheme` (client) disagree on partial themes
- Files: `server-rs/src/settings.rs:315-323`, `src/themePalette.ts:156-159`, `src/themePalette.ts:179-199`.
- What is wrong: server requires `colors` to be an object but does not require any keys; client `parseStoredTheme` calls `parseStoredThemeColors` which fills *all* defaults from `getDefaultThemeColors(appearance)` and then overlays whatever was stored. So a theme saved with 3 colors silently becomes a full 60-color theme on the next read, and the server's `validate_colors` accepts the partial object. This is mostly intended (lenient read), but it means a theme that was edited by hand to override only `canvas`/`accent` cannot be distinguished from a full theme, and `parseThemeFile` (the import path) *does* require at least one color role.
- Why it matters: inconsistent contract between "imported theme file" (strict) and "stored theme record" (lenient); debugging a half-edited theme is hard.
- Suggested fix: document the two paths in `docs/THEME.md` and add a `partial`/`managed` flag if distinction is needed. Low priority; not a bug per se.

### M4. `ThemeSettings.tsx` `themeHalfOwners` masks missing keys as `null`
- File: `src/components/settings/ThemeSettings.tsx:56-62`, `src/settings/migrate.ts:65-84`.
- What is wrong: `themeHalfOwners` treats `undefined` as `null` ("stock palette"). That is deliberate for the post-clear race, but it also means a corrupt/partial settings object that is missing `lightThemeId`/`darkThemeId` is indistinguishable from an explicit "stock" choice, so a reset can be lost.
- Why it matters: minor; only matters if the mirror is hand-edited. Listed for completeness.
- Suggested fix: none required; keep the comment. Could add a schema default so the keys always exist (server already does).

### M5. `UsagePage` empty-state copy does not account for hidden providers
- File: `src/components/usage/UsagePage.tsx:477-485`.
- What is wrong: when `selectedEnvironments.length === 0` the message is "Connect/select an environment", even if environments exist but all providers are hidden. A user who hid every provider sees "Select an environment" instead of "No providers visible".
- Why it matters: confusing empty state; visual check at 480px.
- Suggested fix: add a branch: if `environments.length > 0 && hiddenProviders.size === PROVIDER_ORDER.length`, show "Show at least one provider to see usage".

## Severity: Low

### L1. `appearanceFonts.ts` is started twice
- Files: `src/appearanceFonts.ts:313-315`, `src/main.tsx:16`.
- What is wrong: the module auto-starts on import; `main.tsx` calls `startAppearanceFonts()` again immediately. `startAppearanceFonts` is idempotent, so no harm, but the double call is misleading and the comment in `main.tsx` implies it is the only start.
- Suggested fix: remove the module-level auto-start OR the explicit call; keep one. (Info-level, but listed under Low because it is a real (harmless) duplicate.)

### L2. `FontFamilyPicker`/`resolveDefaultFamilyLabel` probe the DOM during render
- File: `src/appearanceFonts.ts:175-216` (`measureDomProbeWidth`), `src/components/settings/FontFamilyPicker.tsx` (not fully read).
- What is wrong: `measureDomProbeWidth` appends/removes a `<span>` to `document.body`. If called during render (rather than in an effect/memo) it mutates the DOM during React's render phase. I could not verify the call site without reading the whole file; flagged as suspicion.
- Suggested fix: verify call sites; if render-time, wrap in `useMemo`/effect. Visual check required.

### L3. Model breakdown table has no horizontal scroll container
- File: `src/components/usage/UsagePage.tsx:878-960`.
- What is wrong: the "By model" `<table className="w-full text-sm">` is not wrapped in an `overflow-x-auto` region (unlike the "By time" table at line 962). At 480px with long model names + 5 columns, the row can push the layout wider than the viewport.
- Why it matters: horizontal overflow / clipped columns on narrow windows.
- Suggested fix: wrap the table in `<div className="overflow-x-auto">…</div>`, matching the time breakdown.

### L4. `ThemeImportDialog` lazy import + `open` state can leave a stale dialog
- File: `src/components/settings/ThemeSettings.tsx:116-128` (`ThemeImportButtonSlot`).
- What is wrong: `open` is local state; the dialog is mounted only while `open`. If an import fails and the dialog calls `onOpenChange(false)`, state clears. Normal. Listed only to note that the `Suspense` fallback is `null`, so a slow chunk leaves the button with no feedback. Low.
- Suggested fix: optional spinner fallback.

### L5. Server `validate_shell` allows empty `globalShortcut`
- File: `server-rs/src/settings.rs:618-620`.
- What is wrong: `check_nullable_string(path, v, 0, 100)` allows `""`. Client `ShellSettings.globalShortcut: string | null` treats `""` as a shortcut binding rather than "none", which can register an empty global shortcut. Minor.
- Suggested fix: min length 1, or normalize `""` to `null` in `set`/patch.

## Severity: Info

### I1. T3 parity: `ProviderInfo` has no `status`/catalog field
- File: `src/contracts.ts:81-90`.
- What is wrong (suspected): T3's provider catalog may expose a `status` (e.g. `stable`/`experimental`/`disabled`) that Burnrate's `CatalogEntry`/`DefinitionInfo` already carries for defs but `ProviderInfo` (the `/api/providers` row) does not. I could not verify against upstream T3 because the upstream checkout's provider contract differs; flagged as suspicion only.
- Suggested fix: confirm against `apps/web/src` upstream; if T3 has it, add to `ProviderInfo` and the Rust provider list.

### I2. `NULLABLE_FIELDS` is duplicated in two languages
- Files: `src/settings/migrate.ts:56-63`, `server-rs/src/settings.rs:141-148`.
- What is wrong: the set is hand-mirrored; the comment in `migrate.ts` already says to keep them in sync. A future field can be added on one side only, silently breaking null round-trips (e.g. stock-theme selection reverting to default).
- Suggested fix: generate one from the other, or add a test that compares the two lists (the Rust tests already cover the nullable round-trip).

### I3. `sync-t3.mjs` default upstream path is machine-specific
- File: `scripts/sync-t3.mjs:26`.
- What is wrong: `DEFAULT_UPSTREAM = "C:\\Users\\jerem\\..."`. Fine on this machine; not portable. `T3_SRC` overrides it.
- Suggested fix: none required for this repo.

### I4. `appearance.ts` writes `burnrate.boot` on every `applyAppearance`
- File: `src/themes/engine/boot.ts:53-60`, `src/appearance.ts:69`.
- What is wrong: `writeBootPalette` is called on every appearance apply (including density/UI-scale changes), not just theme/mode changes. Minor write amplification.
- Suggested fix: guard with a dirty check, or move the write into theme/mode-only path.

## Verified vs unverified

Verified by reading code:
- H1 (dual `.dark` writers) — verified by reading `App.tsx`, `appearance.ts`, `main.tsx`.
- H2 (render-time setState) — verified in `ThemeEditorPanel.tsx`.
- H3 (server color validation) — verified in `settings.rs` vs `themePalette.ts`.
- M1, M2, M3, M4, M5 — verified.
- L1, L3, L4, L5 — verified.
- I2, I3, I4 — verified.

Suspicions (not verified, need visual/runtime check):
- L2 render-time DOM mutation in `FontFamilyPicker`/`resolveDefaultFamilyLabel` — only the helper was read; call sites not fully traced.
- I1 T3 catalog `status` field on `ProviderInfo` — upstream contract not located.
- All empty-state/layout breakage claims at 480px (M5, L3) — need actual visual run; static analysis only.
- Any first-paint flash magnitude (M1) — needs a real cold start.
- High-contrast effectiveness on custom themes (M2) — needs visual check.
- Render-loop regressions beyond the listed ones — static search covered `useEffect`/`useMemo`/`useCallback` dep arrays in `src/`, but deeply nested components (e.g. `ThemeEditorPanel`) were only spot-checked.