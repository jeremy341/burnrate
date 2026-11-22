# 07 Design audit: Burnrate against T3 Code

Method. `node scripts/sync-t3.mjs check` (66 tracked files: 40 identical, 26 adapted), then `sync-t3.mjs diff` on every adapted file in `src/components/usage`, `src/components/ui`, `src/shared`; then a tree-wide grep for the rulebook violations (`docs/T3-UI-RULES.md` sections 2, 3, 5, 7); then real screenshots of every screen (fresh user and real home, dark, 1100x860) read one by one. T3 source: `apps/web/src` (read only).

## A. Adapted files that differ from T3

| File | Diff | Verdict |
| --- | --- | --- |
| `ui/dialog.tsx`, `ui/spinner.tsx`, `ui/sheet.tsx`, `ui/wizard.tsx`, `ui/color-picker.tsx` | 2 lines | Import path only (`gt-react` -> `~/i18n`). Deliberate, nothing to fix. |
| `usage/UsageModelDialog.tsx`, `UsageProviderChart.tsx`, `UsageShareBar.tsx`, `usageBreakdown.ts`, `usagePriceForm/Table/Targets.ts`, `shared/usageFormat*.ts`, `usageMerge.ts`, `themePreview.ts` | 2 to 10 lines | Import paths only (`@t3tools/*` -> `~/shared`, `~/contracts`, shims). Deliberate. |
| `usage/UsageLimits.tsx` (379 changed lines of 432) | large | Burnrate additions marked `// burnrate:` (pace text, provenance badge, stale badge, projected empty time). Body structure (bars, `role=meter`, spacing, tokens) follows T3. One deviation fixed, see B1. |
| `usage/UsageLimitsPooled.tsx` (426) | large | Multi-account pooling is Burnrate only. Focus ring, `h-5 @2xl/pool:h-8`, grid structure are T3's. Fine. |
| `usage/UsagePage.tsx` (360) | large | Header region is T3's (`grid ... @4xl/usage-header:flex`, line 373 upstream, 383 ours). Differences: environment filter shim, no sharing row, collapse/expand all. Fine. |
| `usage/UsagePriceOverrides.tsx` (41), `usagePagePreferences.ts` (147), `usageProviders.ts` (81), `usageShortcuts.ts` (19), `usageLimits*.ts` (682/137) | mixed | Data and preference plumbing (hidden providers, server-backed prefs, extra providers). No visual rules involved. |

Native `title=` on the period/metric `Toggle` and `SelectItem` (UsagePage) and `<datalist>` in the price dialog exist in T3 itself. Per the rulebook "T3 source wins", they stay.

## B. Deviations found

| # | Screen | Deviation | T3 reference | Fix | Status |
| --- | --- | --- | --- | --- | --- |
| B1 | Usage > Limits | `StaleBadge` used native `title` tooltip | `ui/tooltip.tsx`; rule 2 "never title" | `Tooltip` + `aria-label` on the `role=status` badge | fixed |
| B2 | Insights > Today | Project name used native `title` for the full path | rule 2 | `Tooltip` / `TooltipPopup` | fixed |
| B3 | Providers | Hand-rolled `<button>` for the Advanced section header with its own focus and hover classes | `ui/collapsible.tsx` + `Button variant="ghost-muted"` | `Collapsible` / `CollapsibleTrigger render={Button}` / `CollapsiblePanel animate={false}` (instant) | fixed |
| B4 | Providers | Second gear icon "Provider settings" beside Add provider; duplicates the header Settings icon added in phase 2 and leaves two gears on one screen | one action, one name (rule 7) | removed; Settings lives in the header, Advanced has Manage | fixed |
| B5 | Providers | Page used `gap-4` / `gap-5` between sections | `WorkspacePageContainer` `gap-6` | `gap-6` | fixed |
| B6 | Providers | Provider accent swatches: outset focus ring (`ring-offset-2`) | lint `no-outset-state-indicators` | `ring-inset` | fixed |
| B7 | Providers, Advanced | British spellings ("Organisation", "colour") against T3's American copy | rule 7 plain, consistent copy | "Organization" fixed here; "colour" strings in settings are owned by the settings agent | partly fixed (NEEDS_FROM_OTHER) |
| B8 | Providers | Not-found agents (Grok, Muse Code, Pi...) listed as full rows with no action; 4 to 7 dead rows | rule 5 "lists that can grow must collapse" | collapse into one "Not found on this computer" group (phase 2) | phase 2 |
| B9 | Providers | "Hide provider" has no way back on the page | rule 6 "a one-way door is a bug" | "Hidden" group with Show (phase 2) | phase 2 |
| B10 | Insights | Four of six panels repeat Usage Cost/Tokens (usage over time, models and providers, totals, by model) | one screen, one job | reorganise: Insights keeps what Usage does not show (phase 2) | phase 2 |
| B11 | Header, all screens | No Settings entry in the header | user demand | Settings icon button (phase 2) | phase 2 |
| B12 | Usage > Limits | Skeleton rows stay for the first seconds with the real home while the Claude probe answers; no text says what is loading | rule 5 "honest progress" | `role=status` line "Checking your limits" under the skeleton (phase 2) | phase 2 |
| B13 | Widget (`Widget.tsx`, `layouts/bar.tsx`) | Native `title` tooltips on the always-on-top widget, own CSS (`br-widget-*`) | none (T3 has no widget) | Widget is a separate surface with its own non-Base-UI shell; left, listed in section C | accepted |

## C. Grep results (whole tree, outside `components/ui`, `index.css`, tests, shims)

| Rule | Result |
| --- | --- |
| Native `<select>` | none. (`<datalist>` in `UsagePriceOverrides` is T3's; one in `DefinitionEditor` for key-name suggestions, kept: it is a suggestion list, not a select.) |
| `title=` tooltips | fixed in Usage, Insights. Remaining: T3's own Toggle titles, `settings/DiagnosticsPanel` (settings agent), `Widget` (B13) |
| Raw hex / rgb | only brand logos in `components/Icons.tsx` (provider marks: data colour by design) and `oklch(... hue)` computed from data in the pooled bar avatar |
| Static `style=` | none; every remaining `style=` is a runtime width or a data colour |
| Hand-rolled buttons | Providers Advanced (fixed), accent swatches and the model row button in the table (raw elements allowed by the rulebook: swatch, semantic row) |
| className restyling of primitives | none found beyond layout (width, margin, flex) |
| Outset focus rings | swatches fixed; `ring-offset-*` in `button.tsx`, `badge.tsx`, `UsageLimits` meter, pooled meter are T3's own classes (verbatim) |
| `ResizeObserver` | only `lib/observeResize.ts` (the shared helper) and `widget/Widget.tsx` (separate bundle) |
| Em dashes in copy | none in user-visible strings. A few remain in code comments and as the empty-value glyph `"—"` in diagnostics and the widget ring |
| Unanchored `:has()` | none in our files (index.css is T3's, `data-*` anchored) |
| Icon-only buttons without label + tooltip | none; all have `aria-label`, header ones have Tooltip |
| Unwrapped strings | none found in screens reviewed; settings is owned by the settings agent |
| Continuous animation | none (`RefreshIcon` spins only while refreshing, `motion-safe`) |

## D. T3 parity score (visual and structural, 5 = indistinguishable from a T3 page)

| Screen | Score | Note |
| --- | --- | --- |
| Header (all screens) | 5 | Identical to T3; Settings icon to add |
| Usage > Limits | 4.5 | T3 bars/pooling; Burnrate additions are labelled |
| Usage > Cost / Tokens | 5 | Verbatim chart and tables |
| Usage empty state (Connect an agent) | 3.5 | Card is calm but wider than its content and the primary button colour reads as green-on-dark; fine after phase 2 pass |
| Providers | 3 -> 4 | Primitives fixed here; grouping and dead rows in phase 2 |
| Insights | 2.5 | Duplicates Usage; panel headings fine; phase 2 |
| Settings | 4 | Owned by the settings agent; layout is T3's `SettingsSection`/`SettingsRow` |
| Palette, dialogs, toasts | 4.5 | T3 Command / Dialog / Toast classes verbatim |
| Widget | n/a | Separate surface |
