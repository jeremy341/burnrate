# T3 UI rulebook (Burnrate must follow it)

Burnrate's UI is a 1:1 copy of T3 Code's Usage window, and it has to stay one. This file collects
T3's own written rules (`AGENTS.md`, `docs/internals/web-ui.md`, `i18n.md`, `consistency-action-names.md`,
`mobile-layout.md`, `performance-regressions.md`, its custom lint rules in `oxlint-plugin-t3code/`) and the
concrete scales and patterns its code uses (`apps/web/src/index.css`, `components/ui/*`, `UsagePage.tsx`,
`WorkspacePageContainer.tsx`, `settingsLayout.tsx`). Upstream source is read-only at
`C:\Users\jerem\Documents\GITHUB\burnrate\app`. **When this file and the T3 source disagree, the T3 source wins.**
If a rule fights your task, say so loudly in your summary instead of quietly breaking it.

Read the whole file before touching any UI. Every item has a reason; most of them exist because someone already made
the mistake.

## 1. Philosophy (T3's words, adapted)

- "Performance without compromise." Audit for dropped frames, GPU-spiking CSS animations, hard-to-render lists,
  too much data over the wire. Make every change considerate of performance.
- "I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it
  already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real
  constraint, then fight for the smallest model that makes the correct behavior unsurprising." Measure twice, cut once.
  YAGNI. Fight scope creep.
- "Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label." A spinner must mean
  something is really loading. A label must be current. A skeleton that never resolves is a bug.
- "No continuously repainting animations; they peg the GPU on high-refresh displays."
- "Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb." Components render state; logic
  lives in hooks and `*.logic.ts` helpers that are unit-testable.
- Default to no code comment. Write one only for a constraint, an external quirk or an invariant the code cannot show,
  one line where possible, four at most. Never restate names, narrate steps, or record history.
- Inferred types over annotations. `any` is the enemy.

## 2. The primitives law (the rule agents break most)

- Every control comes from `src/components/ui`. Those exports **own their look**: choose a `variant` and a `size`.
  **Do not restyle a primitive with `className`.** If no variant fits and the look is a generic concept, add a variant
  to the component. A look that belongs to one feature lives in that feature's own component, never in `components/ui`.
- `className` on a primitive may carry **layout only** (width, flex, margin, position). Everything visual is a variant.
- Do not style a raw `<button>`, `<input>`, `<select>`, `<textarea>` to imitate a control a primitive provides. **Never
  ship a native `<select>`**: use `Select`/`Combobox`. Raw elements are right only when the element is not that control
  (semantic rows, tabs, resize handles, swatches, editor surfaces).
- Compose or extend a component instead of copying its markup and classes. When a second call site repeats a treatment,
  turn it into a variant or a slot on the shared component. (T3's reference: `ComposerBanner` exports small slots that own
  their classes, take `className`, spread the rest of their props, merge with `cn`; the stack component composes them and
  owns only stack behaviour.)
- Primitive catalogue: Alert, AlertDialog, Autocomplete, Badge, Button, Checkbox, Collapsible, Combobox, Command, Dialog,
  Empty, Group, Input, InputGroup, Kbd, Label, Menu, NumberField, Popover, PreviewCard, RadioGroup, ScrollArea, Select,
  Separator, Sheet, Skeleton, Spinner, Switch, Table, Textarea, Toggle/ToggleGroup, Tooltip, Wizard, Toast. Use them.
  Tooltips use `Tooltip` + `TooltipTrigger` + `TooltipPopup`, **never the native `title` attribute**.
- Buttons: variants `default | destructive | destructive-outline | ghost | ghost-muted | ghost-destructive | glass | link |
  outline | secondary`; sizes `xs | sm | default | lg | xl | compact | micro | icon-xs | icon-sm | icon | icon-lg`. Icon-only
  buttons use an `icon*` size and always carry an `aria-label` plus a Tooltip.
- Segmented switchers (Cost | Tokens | Limits, periods) are `ToggleGroup` with `variant="segmented"`. Do not hand-roll them.

## 3. Styling law

- Style with Tailwind classes **in the component that renders the element**. Global CSS (`src/index.css`, which stays
  byte-identical to T3's) is only for what classes cannot express: generated markup, custom elements, animations, runtime
  theme variables, browser/Electron integration. Burnrate-only global CSS lives in `src/appearance.css` / `src/a11y.css`.
- No `style={{ ... }}` for static values a class covers. Runtime-computed values (a bar width, a colour from data) are fine.
- Theme-only rules use `@variant dark` / `@variant light`, not `.dark` selectors.
- **Only theme tokens, never raw hex/rgb/hsl** in components: `bg-background`, `bg-card`, `bg-muted`, `bg-accent`,
  `bg-popover`, `text-foreground`, `text-muted-foreground`, `border-border`, `border-input`, `ring-ring`,
  `text-destructive-foreground`, `bg-primary text-primary-foreground`. Provider colours come from the server/registry and are
  used only for bars and small marks (DESIGN.md: "Data is the color").
- Hover, active, disabled, focus: use what the primitive gives you. Disabled is `opacity-64`, `pointer-events-none`.
  Pressed buttons scale to `0.97`. Do not invent new press/hover treatments.
- **Focus and selection indicators stay inside their element** (`ring-inset`, no positive outline offsets): an ancestor with
  `overflow` would clip them (T3 lint `no-outset-state-indicators`).
- Anchor every `:has()` in an arbitrary variant to a class/attribute/tag (T3 lint `no-unscoped-has`): an unanchored `:has()` makes
  Chrome restyle the whole page on every DOM change.

## 4. Scales and tokens (do not invent new ones)

- **Radius**: `--radius: 0.5rem`; `rounded-sm` (-4px), `rounded-md` (-2px), `rounded-lg` (= radius), `rounded-xl` (+4px),
  `rounded-2xl` (+8px), `rounded-3xl` (+12px). Cards and sections are `rounded-xl` with a thin border; controls follow their primitive.
- **Type**: Inter Variable (`font-sans`), system monospace (`font-mono`). Body `text-sm`; secondary `text-xs`; dense data
  `text-2xs` (0.6875rem), `text-3xs` (0.625rem), tiny marks `text-4xs`/`text-5xs`. Headings are modest: `text-sm font-medium`
  for section titles, the big percent in a limit card is the one large number on the screen. Numbers that change use
  `tabular-nums`. Sentence case everywhere ("Panel animations", "Render math").
- **Spacing**: Tailwind's 4px scale. Between page sections `gap-6`; inside a section `gap-2`/`gap-3`; inside rows `gap-1.5`/`gap-2`.
  Header row `px`: `ps-5 pe-2` (logical properties, RTL-safe).
- **Colour feel**: calm surfaces, thin borders, no shadows except popovers and the subtle primary-button shadow, monochrome with one
  accent. Provider colour only in quota bars and small marks. Light and dark are both first class (DESIGN.md).
- **Controls**: desktop heights shrink at `sm:` (default `h-9 sm:h-8`, sm `h-8 sm:h-7`, xs `h-7 sm:h-6`, icon `size-9 sm:size-8`);
  touch gets a 44px hit area via `pointer-coarse:`. Never set your own control heights.

## 5. Layout patterns (copy them, do not redesign them)

- **Window frame (Usage)**: ONE header row `flex min-h-12 shrink-0 items-center gap-1 border-b ps-5 pe-2`, wrapped in a
  `@container/usage-header`. Left: breadcrumb `Usage / All environments v / All providers v`. Right: segmented
  `Cost | Tokens | Limits`, refresh icon button, close button. At narrow container widths (`@4xl` switch) the toolbar collapses
  to the compact variant. There is **no tab strip, no theme toggle, no extra icon buttons** in the header.
- **Page body**: `WorkspacePageContainer`: `mx-auto flex w-full flex-col gap-6 px-5 pt-6 pb-12 sm:px-6` with widths
  `max-w-4xl` (readable), `max-w-5xl` (wide), `max-w-6xl` (expanded). Use it; do not write your own page padding.
- **Scrolling**: `ScrollArea`. A scroller that centres its content needs `scrollbar-gutter-both` so content does not jump sideways when the
  scrollbar appears (T3 lint `require-centered-scroll-gutter`).
- **Settings**: `SettingsSection` + `SettingsRow` (title, description, control). Row descriptions are **at most 200 characters**
  (two lines next to a control; the column is at most 672px). A setting that does nothing yet does not ship.
- **Responsive**: drive it with container queries (`@container`, `@4xl:`) and the `sm:` breakpoint, not with JS width checks.
  Content uses `min-w-0` + truncation so nothing overflows; bars and cards flex. Lay out by role: a screen never asks which
  platform or window width it is on, the shell/frame decides (T3 `mobile-layout.md`: each layer makes one decision).
  Use `observeResize` from `~/lib/observeResize`, never a raw `ResizeObserver` (state set in a raw callback lands a frame late).
- **Lists** that can grow (providers, accounts, models) must collapse, virtualise or paginate; never rely on a long scroll.
- **Empty, loading, error, stale**: every data view has all four. Loading uses `Skeleton` briefly then real content or an honest
  progress line. Errors use `Alert` with a retry. Stale data stays visible and labelled ("Updated 12 minutes ago").

## 6. Interaction, motion, keyboard

- Everything reachable by mouse is reachable by keyboard; every command has a visible name in the command palette. If you add a
  way in, add the way out and the way to see it (snooze needs unsnooze, close needs reopen). A one-way door is a bug.
- Shortcuts follow T3's: `c`/`t`/`l` switch Cost/Tokens/Limits, `mod+shift+1..4` periods, `mod+k` palette, `Esc` closes/back.
- Motion: panels open and close **instantly by default** (T3's "Panel animations" is 0 ms until the user raises it, max 400 ms).
  Use `data-starting-style` / `data-ending-style` transitions from the primitives, short, transform/opacity only, and honour
  `prefers-reduced-motion`. No infinite or continuous animations, no timers that run while the window is hidden.
- Tooltips, menus, popovers, dialogs, toasts come from the primitives; never roll your own overlay or use the `title` attribute.

## 7. Copy and naming

- Plain language, short, sentence case. **No em dashes** in user-visible strings (T3 lint `no-em-dash-copy`): use a comma,
  period, colon or parentheses. **No sparkles/"AI" glyph** on controls: label what the control does (T3 lint `no-sparkles-icon`).
- **One action, one name**: the visible label, tooltip, menu text and accessible name describe the same action on the same object
  ("Copy message" never says "Copy link"; completed feedback never names another object). Icon-only buttons keep that meaning.
- Every user-visible string goes through `useGT()` / `<T>` / `msg()` from `~/i18n` (T3: `gt-react`). One sentence is one string with
  variables inside; never assemble a sentence from fragments. Product and provider names, model ids, paths and commands stay English.
  Plurals use ICU: `gt("{count, plural, one {{count} account} other {{count} accounts}}", { count })`.
- Error messages say what happened and what to do next; they never print raw server codes, stack traces or secrets.

## 8. React rules

- Effects are only for synchronising with something outside React (listeners, timers, subscriptions, DOM measurement). Derive values in
  render, act in event handlers. State that mirrors props/other state is a bug (T3 lint `no-unreasoned-state-sync`).
- **Never compare identity-unstable values during render.** A `new Set(...)`, `[]` or `{}` created in render and fed to a hook that compares
  it by identity and sets state while rendering loops forever (this blanked our whole app once). Memoise, or compare by value.
- Every effect cleans up (listeners, timers, `EventSource`, abort controllers). Nothing keeps polling while the window is hidden.
- In large long-lived components keep handlers plain functions and stabilise only the ones that leave the component (T3 `web-ui.md`).

## 9. Performance

- Budgets live in `docs/PERFORMANCE.md` (main chunk, idle RAM/CPU). Do not exceed them; lazy-load whole screens
  (Settings, Providers, theme editor) with `React.lazy`; never `import(`./dir/${name}`)` (bundles the whole folder).
- Large lists virtualise; charts are plain SVG; no chart library; no layout thrash; no `box-shadow`/`filter` animation.
- Send and render only what the screen needs; cache last results (stale-while-revalidate).

## 10. Hit every surface (T3's most common defect)

Before you call UI work done, walk this list and say which entries applied: **entry points** (a behaviour reachable from one place is
usually also needed in Settings, the command palette and a shortcut), **clients** (browser tab, desktop window, CLI),
**providers** (each adapter needs a decision, even "not supported here"), **reverse states**, **connection/data states** (new user with
nothing, many providers, offline, stale, error), **themes** (dark, light, custom, high contrast, forced colours), **sizes** (the window
resized from tiny to huge, 480px to 4k), **languages**, **docs**.

## 11. Proof and testing (T3's rules, short)

- Purely visual change (spacing, colour, alignment): before/after screenshots are the proof; no UI test. Logic/state/protocol bug: a failing
  test first, then the fix, in the module's existing test file where one fits. Test what can break, not what types already guarantee.
- Extend an existing test table before adding a new `it`. Unit-test logic beside the code (`*.logic.test.ts`); use a real-browser check only for
  layout, focus, pointer or scrolling. No sleeps, polling or wall-clock assertions in tests.
- Always look at the real thing: run the built app, take screenshots (dark and light, at several widths), READ them. A passing test is not a
  verified UI.
- Never kill processes by name pattern; only the PID you started. Never write to the user's live install or data. Keep PRs/commits to one problem.

## 12. Burnrate mapping and the mistakes already made

| T3 | Burnrate |
|---|---|
| `components/usage/UsagePage.tsx` header + toolbar | `src/components/usage/UsagePage.tsx` (header region), `src/App.tsx`, `src/components/AppModalFrame.tsx` |
| `components/ui/*` | `src/components/ui/*` (byte-identical copies; `node scripts/sync-t3.mjs check --strict`) |
| `WorkspacePageContainer`, `settingsLayout.tsx` | `src/components/WorkspacePageContainer.tsx`, `src/settings/layout.tsx` |
| `index.css` tokens | `src/index.css` (never edit) + `src/appearance.css` |

Reference screenshots of the target (READ them): `C:\Users\jerem\.t3\userdata\attachments\7f2e1f33-438f-45fc-a40d-c74ec7241057-d1394226-2bd5-4316-89cb-21d166436eb0.png`
and `...-07af159b-f89a-4f09-bff8-92a14434977f.png` (T3 Usage > Limits, dark).

Mistakes that already happened, do not repeat them: a tab strip above a second filter row instead of T3's single header; extra icon
buttons and a theme toggle in the header; native `<select>` elements; an onboarding wizard that pops up by itself; admin-key providers
listed next to everyday ones; long provider lists with no way to collapse them; skeletons that never resolve; a state setter inside render
fed by a `new Set` every render; unit tests green while the real app was blank; `import()` of a whole directory; hand-rolled UI instead of
a primitive; strings not wrapped for translation; light mode default for a dark-first product.
