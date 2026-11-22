# 05 — UI parity, motion inventory, UX research, feature backlog

Scope: Burnrate (`C:\Users\jerem\Documents\GITHUB\burnrate-app`) vs T3 Code's Usage window
(`C:\Users\jerem\Documents\GITHUB\burnrate\app\apps\web\src`, read only). Paths prefixed `T3:` are upstream
(relative to `apps/web/src`), `B:` are Burnrate (relative to `src`).

Method: `node scripts/sync-t3.mjs check` (63 tracked files; 39 byte-identical, 24 adapted), `diff` of every adapted
file, grep of every `transition|animate|@keyframes|data-*-style|motion-*` in T3's usage UI and shared primitives, and
a read of `B:App.tsx`, `B:components/AppModalFrame.tsx`, `B:api.ts`, `B:state/usage.ts`.

---------------------------------------------------------------------------------------------------

## 0. Headline findings

1. **Good news.** `index.css` is byte-identical to T3 (so every keyframe, token, scrollbar, `@utility visible-animate-spin`,
   and the Inter font stack are already there). All `ui/*` primitives except `dialog`, `spinner`, `color-picker`, `sheet`, `wizard`
   differ only by an import path. `UsagePage.tsx` is a near-clone (the diff is plumbing: atoms replaced by props).
   Therefore **most "missing animations" are not CSS gaps; they are structural gaps in the 3 files Burnrate wrote itself**:
   `AppModalFrame.tsx`, `App.tsx`, `api.ts` (`useLoad`).
2. **The biggest visible parity miss is the app shell:** T3 opens Usage in a Base UI `Dialog` that fades/scales in and out.
   Burnrate's `AppModalFrame` is a plain `<div>`, so `data-starting-style` / `data-ending-style` never exist and
   the window **pops in with no animation** (and the backdrop never fades either). The classes are copied, the mechanism is not.
3. **The biggest UX bug:** the Limits tab has no loading or error state. `useLimits()` returns `data: null` while loading
   and `error` on failure, but `App.tsx:110` only passes `data` and `loading`. First paint (and any server failure) shows
   the empty-state sentence "No provider on the selected environments reports subscription limits."
   (`B:components/usage/UsageLimitsPooled.tsx:619`), which is false and uses T3 multi-environment wording.
4. **T3's own Usage page has few animations.** The page itself has no count-up, no bar-fill tween, no route transition. Motion
   lives in primitives (dialog, popover, tooltip, skeleton, spinner, scroll-area, toggle, button press). So "1:1 including
   animations" = fix the shell + keep primitives verbatim + replicate the loading-dim and refresh behaviour.

---------------------------------------------------------------------------------------------------

## 1. Parity audit (ranked by visibility)

Severity: **P0** = visible in the first 5 seconds, **P1** = visible in normal use, **P2** = edge/rare, **P3** = invisible/dev.

| # | Sev | Difference | T3 (ref) | Burnrate (ref) | Fix |
|---|-----|-----------|----------|----------------|-----|
| 1 | P0 | **No open/close animation for the app card or its backdrop.** T3: Popup `transition-[opacity,scale] duration-150 ease-out` + `data-starting-style:scale-[0.985] opacity-0` and Backdrop `transition-all duration-200 data-*-style:opacity-0`. These need Base UI to set the attributes. | `T3:components/AppRouteModal.tsx:103`, `T3:components/ui/dialog-styles.ts:2` | `B:components/AppModalFrame.tsx:54,64` (plain div; the classes are inert) | Port AppRouteModal onto `DialogPrimitive` (code in §2.A). |
| 2 | P0 | **Limits first-load / error state wrong.** `limits.error` ignored; empty sentence flashes during load; copy says "selected environments". | T3 always has a hydrated presentation, so never shows the sentence while loading | `B:App.tsx:110-112`, `B:components/usage/UsageLimitsPooled.tsx:617-621`, `B:api.ts:~140` (`useLoad` sets `error` but nothing reads it) | Add `LimitsSkeleton` (reuse `Skeleton`, see §2.D), error `Alert` with Retry, real empty state (see §4.1). |
| 3 | P0 | **Multi-environment vocabulary leaks.** "All environments" dropdown with a single entry "This computer", "Connect an environment to see usage", "Select an environment…", "Usage / This computer / Providers" breadcrumb. | Legit in T3 (many machines) | `B:components/usage/UsagePage.tsx:~330,478-486,1165,1199`, `B:components/usage/UsagePriceOverrides.tsx:203,345,380`, `B:state/usage.ts:36` | Hide `UsageEnvironmentFilter` when `environments.length === 1`, but keep its status content (partial/duplicate/mismatch popover, "Model prices" entry) in a small menu; rewrite copy to "this computer". The breadcrumb then reads `Usage / Providers`. |
| 4 | P1 | **Providers is a different layout, not the T3 clone.** Swapping `view` renders a second `AppModalFrame`, which remounts the card (replays nothing now, but after fix #1 would replay the open animation), resets `UsagePage` state (period selection, `shown`, scroll) and refetches `/api/usage` so the skeleton flashes each time the user comes back. | T3 Settings → Providers is a route inside the same modal route family | `B:App.tsx:66-93, 98-118` | Single frame, switch the body only (keep `UsagePage` mounted, hidden with `hidden`/`inert`, or lift state). Animate content swap with `AnimatedHeight` + 150 ms opacity. |
| 5 | P1 | **Limits never re-fetch when you switch to the Limits tab; no 5-minute throttled auto refresh.** T3: effect on `[showingLimits, connectedLimitsEnvironments]` calls `refreshLimits(true)`; `refreshUsageLimits` coalesces in-flight calls and throttles automatic refresh to 5 min. | `T3:components/usage/UsagePage.tsx:329-345`, `T3:packages/client-runtime/src/state/usage.ts:19-42` | `B:App.tsx:51-56` (single `reload` on mount) | Add `useEffect(() => { if (showingLimits) autoRefresh() }, [showingLimits])` with the same 5-min guard; coalesce in `useLoad`. |
| 6 | P1 | **Reset countdowns freeze.** T3 deliberately advances `now` only on explicit refresh ("avoid repaints") because T3 is used for minutes at a time. Burnrate runs as a standalone always-open window (Edge `--app`), so "resets in 2h 3m" is wrong after 10 min and the pace tick drifts. | `T3:components/usage/UsageLimits.tsx` (comment above `UsageLimitsSection`), `T3:components/usage/UsagePage.tsx:205` | `B:components/usage/UsagePage.tsx:521` (`Math.max(limitsNow, enteredLimitsAt)`) | Tick `limitsNow` at minute boundaries only while `document.visibilityState === "visible"` (see §2.F). Text uses `tabular-nums` already, so no layout shift. |
| 7 | P1 | **Reset-credit redemption UI removed.** T3 shows "Use credit" buttons, an `AlertDialog` confirm and a status line; Burnrate shows banked credits as read-only text. Only matters if the server can consume credits. | `T3:components/usage/UsageLimits.tsx:265-391`, `T3:components/usage/UsageLimitsPooled.tsx:218-237,299-349` | `B:components/usage/UsageLimitsPooled.tsx:~170` (removed) | Defer; needs a server endpoint (see backlog). |
| 8 | P1 | **Esc / close behaviour.** T3 Esc closes the modal and returns focus to the opener only after a keyboard close; blur-before-close commits typed fields. Burnrate Usage passes no `onEscape`, so Esc does nothing; Providers Esc goes back. `window.close()` for the X. | `T3:components/AppRouteModal.tsx:47-61,90-100` | `B:App.tsx:108-117`, `B:components/AppModalFrame.tsx:33-47` | Port (item 1) gives focus handling; decide product behaviour for Esc on the root view (recommend: Esc is a no-op on the root, ⌘/Ctrl+W closes, tooltip says "Close"). |
| 9 | P2 | **Window chrome / WCO class never applied.** `syncDocumentWindowControlsOverlayClass()` is never called (T3: `T3:appInit.tsx:266`), so `.wco` CSS (`index.css:155-165`, `@custom-variant wco`) is dead. `useNativeTitlebarHeight()` works (reads `navigator.windowControlsOverlay`), so dialogs/tooltips would clear the caption buttons *if* WCO were active. The manifest has no `display_override`, so Edge `--app=` never enables it. | `T3:lib/windowControlsOverlay.ts` (identical), `T3:appInit.tsx:266` | `public/site.webmanifest` (no `display_override`), `B:main.tsx` | Add `"display_override": ["window-controls-overlay"]` and call the sync in `main.tsx`; make the header `[-webkit-app-region:drag]` outside controls and pad to `env(titlebar-area-*)`. Requires installed-PWA or a WebView2 shell; verify under `--app`. See §2.G. |
| 10 | P2 | **`theme-color` and first paint are correct** (done in the prior batch: `index.html` inline script, `App.tsx:14-24`). One gap: `useTheme` writes `html.style.background` inline, so after a light↔dark toggle the OS title bar changes in a rAF but the card does not cross-fade (T3's boot doesn't either). | `T3:index.html:15-60` | `B:App.tsx:14-35` | Fine; optional `transition: background-color 150ms` on `html` guarded by `motion-safe`. |
| 11 | P2 | **`TooltipProvider` not mounted.** T3 relies on Base UI default delay (600 ms) except in the model picker (`delay={0}`) and PR panel (`delay=150 closeDelay=150 timeout=400`). Burnrate also uses defaults, so same. No action. | `T3:components/pullRequest/PullRequestDetailPanel.tsx:1536` | n/a | none |
| 12 | P2 | **Toast system absent** (`ui/toast.tsx`, `anchoredCopyToast.ts` not synced, `T3:components/ui/toast.tsx` 839 lines). Needed for "Copied", "Export saved", "Refresh failed", update-available. | `T3:components/ui/toast.tsx` | none | Add to sync manifest (verbatim), mount `ToastProvider` + `AnchoredToastProvider` once in `main.tsx`. |
| 13 | P2 | **Settings surface missing.** `AppSettings.hideSensitive` exists (`B:hooks/useSettings.ts:7`) but has no UI toggle anywhere; theme is a binary sun/moon (loses "system"); timestamp format has no UI. | `T3:routes/_chat.settings.appearance.tsx`, `T3:routes/_chat.settings.general.tsx` | `B:App.tsx:68-75` | Settings dialog (see §4.8). |
| 14 | P2 | **`html` font size** not set. T3 forces `root.style.fontSize = 16px` from appearance prefs (`T3:appearanceFonts.ts:101`, default 16). Burnrate relies on the browser default; if the user changed Edge's "font size" or OS text scale, every rem utility drifts. | `T3:appearanceFonts.ts:101,168-174` | `B:main.tsx` | `document.documentElement.style.fontSize = "16px"` (or an Appearance setting 12–20). |
| 15 | P2 | **Provider icon shim lacks badge/indicator.** `ProviderInstanceIcon` shim ignores `showBadge`, `indicatorBackground`; Burnrate's `AccountAvatar` shows the icon for accounts without email and an email chip otherwise (T3: icon only for redeemable accounts). Intentional but not 1:1. | `T3:components/usage/UsageLimitsPooled.tsx:78-103` | `B:components/usage/UsageLimitsPooled.tsx:70-95`, `B:t3-shims/ProviderInstanceIcon.tsx` | Accept; document as intentional. |
| 16 | P3 | **i18n is a stub** (`B:i18n.ts`): every string resolves to English; `useLocale()` returns `"en"`, so `formatUsd`/`formatDayShort` ignore the user's locale (T3 passes the real locale). Numbers: "$1,234.56" for a German user. | `T3:i18n/*`, `gt-react` | `B:i18n.ts:55-58` | `useLocale = () => navigator.language`; RTL needs `dir` (see §3). |
| 17 | P3 | `sync-t3.mjs` reports `UsageLimits.tsx` 232 lines, `UsageLimitsPooled.tsx` 196, `usageLimits.ts` 629 lines changed (the latter is the server-shape adapter). Drift on the first two is almost entirely the removed redemption + environment plumbing. | n/a | n/a | OK. |

### Things verified identical (no work)
Tokens/radii/typography (`index.css` identical; `--radius`, `text-2xs…5xs`, Inter Variable first in `--font-sans`, `font-feature-settings` untouched),
scrollbars (`index.css:1852-1866`, `--app-scrollbar-*` and `theme-dark.css:136`), focus rings (`button.tsx:9`, `ring-2 ring-inset ring-ring ring-offset-1`),
tooltip/popover (verbatim), skeleton/spinner/refresh icon (verbatim), number formatting (`usageFormat.ts` 2-line diff = import paths),
keyboard shortcuts (`c`, `t`, `l`, `mod+shift+1..4`; `B:t3-shims/keybindings.ts:25-32` matches T3 defaults),
dark palette (`theme-dark.css` proven to match T3 "test" theme per `docs/THEME.md`).

---------------------------------------------------------------------------------------------------

## 2. Animation and micro-interaction inventory

### 2.1 Where T3 animates (everything in the Usage window path)

| Element | Mechanism | T3 ref | Burnrate status |
|---|---|---|---|
| App card enter/exit | Base UI Popup `transition-[opacity,scale] duration-150 ease-out`, `data-starting/ending-style:scale-[0.985] opacity-0` | `T3:components/AppRouteModal.tsx:103` | **Missing** (div, no attributes) |
| Backdrop enter/exit | `transition-all duration-200 data-*-style:opacity-0` | `T3:components/ui/dialog-styles.ts:2` | **Missing** (same cause) |
| Nested dialog (model, prices, reset credit) | scale 0.98 + opacity + `-translate-y(1.25rem*nested)`, `duration-200 ease-in-out`; mobile slide `translate-y-4` | `T3:components/ui/dialog-styles.ts:8,14` | Present (verbatim `dialog.tsx`); parent not a Base UI popup so no "stack depth" push, which T3 also lacks for the route modal |
| Popover / tooltip enter | `transition-[width,height,scale,opacity]`, `scale-98`, `opacity-0`; tooltip `transition-[top,left,right,bottom,transform]` + `data-instant:transition-none` for warm-up | `T3:components/ui/popover.tsx:83-120`, `T3:components/ui/tooltip.tsx:109,143` | Present (verbatim) |
| Segment popover morph between bars | shared `PopoverCreateHandle` + `actionsRef`; popup resizes with `h/w-(--popup-height/width)` transition and `data-current/previous` cross-fade | `T3:components/usage/UsageLimitsPooled.tsx:~259-296`, `popover.tsx:116` | Present |
| Loading dim of figures | `transition-opacity` + `opacity-40 delay-150` | `T3:components/usage/UsagePage.tsx:1108`, `UsageProviderChart.tsx:439` | Present (copied) |
| Skeleton shimmer | `--animate-skeleton: skeleton 2.4s infinite` stepped opacity 1→0.55, `motion-safe:animate-skeleton` | `T3:index.css:224,296-312`, `T3:components/ui/skeleton.tsx:5` | Present |
| Refresh icon spin | `motion-safe:visible-animate-spin` + `observeVisibleAnimation` (IntersectionObserver, `visibilitychange`, `prefers-reduced-motion`) | `T3:components/ui/refresh-icon.tsx:29-32`, `T3:index.css:581-585`, `T3:lib/visibleAnimation.ts` | Present (lib identical in logic) |
| Spinner | same `visible-animate-spin` | `T3:components/ui/spinner.tsx` | Present |
| Button press | `[&:active]:scale-[0.97]`, `transition-[box-shadow,scale]` | `T3:components/ui/button.tsx:9` | Present |
| Segmented toggle | `transition-colors`, `data-pressed:bg-background shadow-xs/10` (no sliding pill) | `T3:components/ui/toggle.tsx:32` | Present |
| Scroll-area scrollbar fade | `opacity-0 transition-opacity delay-300`, `data-hovering/scrolling:opacity-100 delay-0 duration-100` | `T3:components/ui/scroll-area.tsx:87-95` | Present |
| Table row hover | `transition-colors hover:bg-muted/50` | `T3:components/usage/UsagePage.tsx:955,1044` | Present |
| Provider chevron reveal | `opacity-60 transition-opacity group-hover:opacity-100` | `UsagePage.tsx:1230,1348` | Present |
| Collapsible height | `transition-[height] duration-200 motion-reduce:transition-none` | `T3:components/ui/collapsible.tsx:29` | Present (unused on Usage) |
| Wizard / AnimatedHeight | `transition-[height] duration-200 ease-out motion-reduce:transition-none` + fallback timer | `T3:components/AnimatedHeight.tsx:85` | Present (used by `wizard.tsx` only) |
| Switch thumb squish | `[transition:translate .15s, border-radius .15s, scale .1s .1s]`, active `scale-x-110` | `T3:components/ui/switch.tsx:29`, `menu.tsx:194` | Present |
| Status pulse/ping (duty-cycled) | `status-pulse 2s`, `status-ping 2s` steps(6)/(8) | `T3:index.css:227-228,333-355` | CSS present; no consumer yet (use for "live" dot) |
| Reduced motion | `motion-safe:` / `motion-reduce:` variants on spin, skeleton, collapsible, AnimatedHeight; `observeVisibleAnimation` pauses when `prefers-reduced-motion` | see rows above | Present |
| Forced colors | `@media (forced-colors: active)` for `.settings-slider`, shine effects | `T3:index.css:1061, 566-576, 639-653` | CSS present; **no forced-colors handling for the limits bar** (see §3.7) |
| Numeric count-up | **none in T3** | – | n/a (do not add; breaks "1:1") |
| Bar-fill transition | **none in T3** (`style={{ width: ${remaining}% }}`, no transition) | `T3:components/usage/UsageLimits.tsx` (WindowBar) | identical, none |
| Route transition | none for Usage (only a View Transition for the mobile composer, `index.css:21-80`) | – | n/a |
| Stash row pulse / live-tool shine / preview progress / settings-search pulse | chat-only | `index.css:231-233,552,2433,924` | not needed |

Net: **the only missing animations are #1 and #2 (card + backdrop)**, plus everything that depends on remounting less often
(§1 item 4). Everything else the user sees animate in T3's Usage window is already in Burnrate through verbatim primitives.

### 2.A Port: Base UI shell with enter/exit (fixes P0 #1, and gives focus management, `inert`, Esc, blur-commit)

Replace the body of `B:components/AppModalFrame.tsx` with a Base UI dialog. Keep the public API (`label`, `onEscape`, `children`) and add `onClosed`:

```tsx
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";
import { DialogBackdrop } from "./ui/dialog";

export function AppModalFrame({
  label, children, onRequestClose, onClosed,
}: {
  label: string; children: ReactNode;
  /** Return false to veto (e.g. root view: Esc does nothing). */
  onRequestClose?: () => boolean | void;
  /** Runs after the 150 ms exit animation, like T3's onOpenChangeComplete. */
  onClosed?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const popupRef = useRef<HTMLDivElement>(null);
  const backdropPressRef = useRef(false);
  const titlebar = useNativeTitlebarHeight();
  const close = () => { if (onRequestClose?.() === false) return; setOpen(false); };
  return (
    <DialogPrimitive.Root
      open={open}
      disablePointerDismissal
      onOpenChange={(next, details) => {
        if (next) return;
        const f = document.activeElement;                       // commit-on-blur fields (T3 AppRouteModal.tsx:55-59)
        if (f instanceof HTMLElement && popupRef.current?.contains(f)) f.blur();
        close();
      }}
      onOpenChangeComplete={(next) => { if (!next) onClosed?.(); }}
    >
      <DialogPrimitive.Portal>
        <DialogBackdrop />
        <DialogPrimitive.Viewport
          style={{ "--app-modal-titlebar-height": `${titlebar}px`,
                   "--app-modal-top-inset": `max(env(safe-area-inset-top), ${titlebar}px)`,
                   "--app-modal-sm-top": `max(1.5rem, ${titlebar}px)` } as CSSProperties}
          className="fixed inset-0 z-50 flex items-center justify-center [-webkit-app-region:no-drag] sm:p-6 sm:pt-(--app-modal-sm-top) lg:p-10"
          onPointerDown={(e) => { backdropPressRef.current = e.target === e.currentTarget; }}
          onClick={(e) => { if (backdropPressRef.current && e.target === e.currentTarget) close(); backdropPressRef.current = false; }}
        >
          <DialogPrimitive.Popup
            ref={popupRef} initialFocus={popupRef} aria-label={label}
            data-slot="dialog-popup" data-app-modal=""
            className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background max-sm:pt-(--app-modal-top-inset) max-sm:pb-safe text-foreground outline-none transition-[opacity,scale] duration-150 ease-out [-webkit-app-region:no-drag] data-ending-style:scale-[0.985] data-ending-style:opacity-0 data-starting-style:scale-[0.985] data-starting-style:opacity-0 sm:max-h-[60rem] sm:max-w-[80rem] sm:rounded-2xl sm:border sm:shadow-2xl/40"
          >
            {children}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
```
Notes: (1) `AppModalClose` must become a `DialogPrimitive.Close` render prop as in `T3:components/AppRouteModal.tsx:123-135`
so the exit animation runs; (2) the shim `B:t3-shims/app-route-modal.tsx` already routes close through context, so it just
needs `onClose` → `setOpen(false)` through a context; (3) `window.close()` goes in `onClosed`, so the card fades for 150 ms before
the window closes; (4) the nested-dialog selector in the old Esc handler becomes unnecessary because Base UI stacks dialogs;
(5) keep `[data-app-modal]` on the popup because `usageShortcuts.ts:35-38` exempts it from the "inside a dialog" guard.

### 2.B Keep the view switch inside one frame (item 4)

```tsx
<AppModalFrame label={view === "usage" ? gt("Usage") : gt("Providers")} onClosed={() => window.close()}>
  <div className={view === "usage" ? "contents" : "hidden"} inert={view !== "usage"}><UsagePage …/></div>
  {view === "providers" && <ProvidersPane onBack={() => setView("usage")} />}
</AppModalFrame>
```
Optionally wrap the pane in `AnimatedHeight` (already in repo) and use `transition-opacity duration-150` with
`@starting-style` for the Providers body; guard with `motion-safe`.

### 2.C Re-use T3's existing "settle" cues for refresh
`B:components/usage/UsagePage.tsx:321,396-401` already drives `RefreshIcon refreshing={refreshBusy}`. Missing: when a refresh
*completes* nothing signals it. Add a 1.4 s `text-foreground` flash on the "Updated 12:04" label using T3's stash-pulse keyframes
(`--animate-stash-pulse-row`, `index.css:231-232,315-326`, alternating `-alt` variant so repeated refreshes restart without remount).

### 2.D Skeleton for Limits (reuse, no new keyframes)
```tsx
function LimitsSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-live="polite">
      {[0, 1].map((i) => (
        <section key={i} className="flex flex-col gap-3">
          <div className="flex items-center gap-2"><Skeleton shape="pill" className="size-5" /><Skeleton className="h-4 w-28" /></div>
          <div className="grid grid-cols-[11rem_minmax(0,1fr)_7rem] gap-x-4 gap-y-1">
            {[0, 1].map((r) => (<Fragment key={r}><Skeleton className="h-4 w-24" /><Skeleton shape="pill" className="h-3 w-full" /><Skeleton className="h-4 w-16 justify-self-end" /></Fragment>))}
          </div>
        </section>
      ))}
    </div>
  );
}
```
Render it when `limits.data === null && limits.loading`. Use T3's dim-while-refreshing for subsequent loads:
`cn("transition-opacity", loading && "opacity-40 delay-150")` on the pools container (same helper as `UsagePage.tsx:1108`).

### 2.E Limits error state
```tsx
{limits.error && !limits.data ? (
  <Alert variant="error"><AlertTriangleIcon/><AlertTitle>{gt("Couldn't read limits")}</AlertTitle>
    <AlertDescription>{limits.error}</AlertDescription>
    <AlertAction><Button size="xs" variant="outline" onClick={limits.reload}>{gt("Try again")}</Button></AlertAction></Alert>
) : …}
```
When `limits.data` exists *and* `error` is set, keep showing data with a "stale" chip (§3.5).

### 2.F Minute ticker (replaces frozen `now`)
```ts
export function useMinuteNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    let t: number;
    const tick = () => { setNow(Date.now()); t = window.setTimeout(tick, 60_000 - (Date.now() % 60_000)); };
    const onVis = () => document.visibilityState === "visible" && setNow(Date.now());
    t = window.setTimeout(tick, 60_000 - (Date.now() % 60_000));
    document.addEventListener("visibilitychange", onVis);
    return () => { clearTimeout(t); document.removeEventListener("visibilitychange", onVis); };
  }, [enabled]);
  return now;
}
```
Pause when hidden (the `visibilitychange` handler resumes with a fresh `now`). This changes at most one text node per
pool per minute and the pace tick by ~0.02 %, with no layout shift.

### 2.G Title bar / WCO (Windows + Linux)
`display_override: ["window-controls-overlay"]` works for **installed PWAs** in Edge/Chrome, not for plain `--app=` windows. Two ways:
(a) ship a PWA install step (`edge --install-webapp`) and ask for `window-controls-overlay`; (b) keep `--app` and accept the native title bar
(current behaviour, theme-colored by `theme-color`). Recommended: (b) now; the T3 code path is already imported, so enabling later is only the
manifest line + `syncDocumentWindowControlsOverlayClass()` in `main.tsx`. On Linux (Chromium `--app`) there is no overlay API; the same fallback holds.

---------------------------------------------------------------------------------------------------

## 3. UX best practice for usage/quota dashboards (researched)

Sources: Coralogix Usage & Quota docs; SaaSFrame "Usage Indicator" pattern; Dynatrace run-rate docs; OpenAI community burn-rate thread; W3C
WCAG 2.2 (What's New, Understanding 1.4.1 and 1.4.11); MDN/APG/Evinced/Primer on `progressbar`/`meter`; Microsoft Edge blog on forced colors;
Databricks/Qualtrics/TheNewStack on data freshness. Links at the end. Where search did not return authoritative text, the item is marked *(judgement)*.

### 3.1 Pace / burn rate
- T3 already has the correct primitive: a bar of *remaining* quota plus a tick for "even spending" and a three-state pace icon (ahead/on/under, ±5 pt).
  Keep it; it is more legible than a bare percentage. Add the **numeric gap** in the tooltip ("12 pt ahead of pace") and per-day wording
  ("safe to spend ≈ 14 % per day"), a pattern Coralogix uses ("Safe daily spend").
- Always show the **reset time** alongside the countdown (T3 does in the tooltip: `Resets {resetsAt} · {resetsIn}`).

### 3.2 "Time to empty" prediction
Research is explicit: do **not** show a precise remaining-time claim from a volatile rate without a model (SaaSFrame). Coralogix flags "Warning"
only when forecast < reset; Dynatrace frames run-rate as a risk indicator. Recommendation for Burnrate:
- Compute `rate = used_in_last_N / N` with N = min(elapsed, 60 min) from **stored samples** (needs history, §4.3), require ≥ 3 samples and a
  non-zero rate, and show **"At this pace: empty ~16:40 (before reset 18:00)"** only when `empty < reset`. Otherwise show nothing (no "∞").
- Label as an estimate ("~", "at this pace"), show the assumption on hover, and never colour it red unless empty-before-reset.

### 3.3 Reset countdowns
Relative ("in 2h 15m") with the absolute time on hover/focus; minute resolution; ">24 h" switches to "Tue 09:00". Local timezone always;
state the timezone in the tooltip if it differs from the account's. T3's `formatResetsIn` and `formatUpcomingTimestamp` already do this.
Respect `Intl.RelativeTimeFormat` for non-English once `useLocale` is real.

### 3.4 Colour semantics, colour-blind safety
WCAG 1.4.1: colour must not be the only carrier; 1.4.11: graphical objects ≥ 3:1 against adjacent colours. T3's bars use provider hue only, which is
safe because meaning is carried by length, the tick, the icon and text. If Burnrate adds threshold colouring, add it as a **second channel**:
- Thresholds on *remaining*: ≥ 25 % neutral (provider hue), 10–25 % `--warning` + `TriangleAlert` icon, < 10 % `--error` + `OctagonAlert` icon; "0 %" gets text "Limit reached".
- Use T3's own `--warning`/`--error` tokens (already contrast-tuned in both themes); verify 3:1 on `--muted` track with the project's color validator.
- Avoid red/green pairs; use luminance difference (ligher = more remaining) plus an end-cap or hatch pattern for the "gap" region in forced colors.
- Provider hues (`#d97757`, `#5b9bbd`, `#8c7bd1`, `#4d9f8a`, `#0866ff`, `#8b8b8b`) must be checked pairwise for deuteranopia; they only appear in separate rows, so low risk, but the chart (`UsageProviderChart`) overlays them — keep its direct labels/legend.

### 3.5 Density and compact mode
T3's layout: `grid-cols-[11rem_minmax(0,1fr)_7rem]` rows of 24 px bars; `LimitWindows compact` already exists (`UsageLimits.tsx` `compact` prop: `grid-cols-[minmax(0,9rem)_minmax(3rem,1fr)_auto]`)
but is unused by the page. Wire it to a **Compact** setting and to container width `< 28rem`. For a "mini" window (≤ 420 × 600), show only the
tightest window per provider (min remaining across windows), one line each.

### 3.6 First run, empty, and onboarding
Pattern *(judgement, consistent with SaaSFrame "define near/reached/over states")*: empty = "what you'll see here" + the single next action.
Detect what is on the machine (server already reads `~/.claude*`, Codex, OpenCode, Cursor, Grok, Mistral key stores) and show a checklist
"Found Claude Code (2 accounts), Codex, OpenCode · Not found: Cursor, Mistral → Add key". One click per row ("Use this login" is automatic for
local logins; "Add API key" opens the existing `AddKeyDialog`). No account-wizard unless a login is expired.

### 3.7 Error, expired-login and stale/offline states
- Per-account `unavailable.reason` (`unsupported` | `probeFailed`) already exists in `UsageLimits`. Add `expired` (HTTP 401/403) → inline row
  "Claude sign-in expired · Sign in again" with a primary button wired to `ClaudeSignInDialog`.
- **Stale-data indicator:** show "Updated 12:04" (or "3 min ago") in the header, derived from the **data's own `checkedAt`**, not the render
  time (Databricks/TheNewStack: timestamp from the underlying data; a failed refresh must not leave old numbers looking current).
  If `now - checkedAt > 10 min`, turn the label `text-warning` and prefix a `CircleAlert` icon; if the last request failed, add "· offline".
- **Offline:** `fetch` rejects → keep the last report, dim to `opacity-60`, show an `Alert` "Can't reach the Burnrate server. Showing data from 12:04."
  with Retry. Do not clear data.

### 3.8 Accessibility
- **Semantics.** The bar is `role="img"` + `aria-label` (`UsageLimits.tsx:~143`). Per APG a quota is a *meter*, not a progressbar (progressbar =
  task progress). Use `role="meter" aria-valuemin=0 aria-valuemax=100 aria-valuenow={remaining} aria-valuetext={summary}` on the focusable outer
  element, keeping the decorative fill/track `aria-hidden`/presentational (Evinced/APG). Keep the existing `aria-label`.
- **Live regions.** A threshold crossing (e.g. < 10 %) should announce once via a visually-hidden `role="status"` — not on every refresh.
- **WCAG 2.2.** 2.5.8 target size ≥ 24 × 24 px (T3 `Button size="icon-sm"` is 28 px; the 24-px bar is a hover target, OK; `size="xs"` text buttons need ≥ 24 px height — verify);
  2.4.11 focus not obscured (the sticky header must not cover a focused row: add `scroll-padding-top: 3.5rem` on the scroll viewport);
  2.4.7 focus visible (already `ring-2 ring-ring`); 3.3.7 redundant entry n/a; 3.3.8 accessible authentication: the API-key field must allow paste (do not set `onPaste` handlers that block).
- **Reduced motion.** Already covered by `motion-safe:`/`motion-reduce:` and `observeVisibleAnimation`. The shell's 150 ms scale should also be
  gated: `motion-reduce:transition-none motion-reduce:data-starting-style:scale-100` (T3 does not; this is a safe improvement).
- **Forced colors (Windows High Contrast).** Custom `backgroundColor` fills disappear in forced-colors mode. Add:
  ```css
  @media (forced-colors: active) {
    [role="meter"] > div > div { background-color: Highlight !important; forced-color-adjust: none; }
    [role="meter"] > div > div:first-child { background-color: Canvas; outline: 1px solid CanvasText; }
    [data-pace-tick] { background-color: CanvasText; forced-color-adjust: none; }
  }
  ```
  (Evinced/Primer: draw the fill as border/outline or use system colours so it survives.)
- **Screen-reader copy.** Per row: "Weekly, 62 percent left, 41 percent of the window left, resets in 3 days" — the existing `summary` string already does this; keep it.

### 3.9 i18n / RTL
T3 uses logical properties (`ps-`/`pe-`/`ms-auto`; bars use `left-0` and the pace tick uses physical `left` in `paceMarkStyles`). For RTL set `dir`
from locale and flip with `[dir=rtl]:` for the bar fill origin (`left-0` → `right-0`) and tick position. Currency/number formatting must use
`Intl.NumberFormat(locale)` (T3's `usageFormat` does once `useLocale` is real, §1 #16). Units: provide `Intl.RelativeTimeFormat`.

### 3.10 Keyboard-first
Keep T3's `c/t/l` (metric) and `⌘/Ctrl+⇧+1..4` (period). Add: `r` (refresh), `/` or `⌘/Ctrl+K` (command palette), `g p` (Providers), `,` (Settings),
`?` (shortcuts sheet, T3 has `ui/kbd.tsx`), `Esc` (close topmost layer only). Show shortcuts in tooltips (`shortcutTitle(...)` in `UsagePage.tsx` already does for toggles).

---------------------------------------------------------------------------------------------------

## 4. Proposed screens and features (T3 design language)

Server data: Burnrate server routes today = `/api/{providers,limits,settings,usage,accounts/claude/*}` (`server-rs/src/main.rs:171-194`).
`Record` carries `{provider, ts, model, session, tokens…}` but **no project/cwd** (`server-rs/src/types.rs:5-20`). History is not stored.

### 4.1 First-run / empty state ("Welcome")
- **Shows:** detection checklist (§3.6), a single primary action, privacy sentence ("Everything stays on this computer").
- **Data:** `/api/providers` already returns `connected`, `auth`, `accounts`; add `detected: { path, lastActivity }` and `needsAttention: "expired"`.
- **Reuse:** `ui/empty.tsx` (`Empty`, `EmptyHeader`, `EmptyMedia`), `ui/discovery-list.tsx` (T3's "found on this machine" list — built for exactly this),
  `ui/wizard.tsx` (`AnimatedHeight`), `Badge`, `Button`, existing `AddKeyDialog`/`ClaudeSignInDialog`.

### 4.2 "Today" summary strip (top of Limits)
- **Shows:** spend today (USD), tokens today, tightest window ("Claude weekly 38 % left · resets Tue"), and the §3.2 forecast chip.
- **Data:** `/api/usage?since=today&until=today&resolution=hour` (exists); tightest window from `/api/limits` (client-side).
- **Reuse:** `UsagePage.tsx` `Metric` component (`figureClass` loading dim), `Badge`, `Tooltip`.

### 4.3 History / sparkline per window + forecast
- **Shows:** 24 h / 7 d sparkline of remaining % behind each bar; hover shows value; forecast line to reset (dashed).
- **Data:** new `limits_samples(account_id, window_id, ts, used_percent)` table written on every `/api/limits` poll (every refresh and every 5 min),
  pruned at 30 days; endpoint `GET /api/limits/history?account=&window=&since=`. 8 bytes/sample → ~3 MB/month at 1-min cadence for 10 windows.
- **Reuse:** the monotone-cubic helpers in `UsageProviderChart.tsx` (`smoothCurve`, `curvePath`, `niceScale`) are chart-agnostic; copy for a 160×24 SVG. `PopoverCreateHandle` for hover detail.

### 4.4 Per-project and per-model cost breakdown
- **Model:** already in Usage → Cost/Tokens (table + `UsageModelDialog`).
- **Project:** needs `cwd`/project key in `Record` (`readers/*`: Claude `cwd` field in transcripts, Codex `cwd` in session meta, OpenCode `path.cwd`),
  aggregated in `engine.summary` as `byProject`. Surface as a second table + `UsageShareBar` with a "Group by: Model | Project | Provider" `ToggleGroup variant="segmented"`.
- **Privacy:** show only the folder basename by default; full path on hover; `RedactedSensitiveText` honours `hideSensitive`.
- **Reuse:** `UsageShareBar`, `usageBreakdown.ts`, `UsageModelDialog` (clone as `UsageProjectDialog`), `ui/middle-truncate.tsx`.

### 4.5 Provider comparison
- **Shows:** one row per provider: cost per 1M tokens, cache-hit %, share of spend, limit headroom. Sorted by spend; sparkline per row.
- **Data:** all derivable from existing `ModelTotals` (`costPerMillionTokens`, `cacheHitRate` in `usageBreakdown.ts`).
- **Reuse:** `ui/table.tsx`, `UsageShareBar`.

### 4.6 Export (CSV / JSON) and shareable snapshot
- **CSV/JSON:** client-side from the already-merged `MergedUsage` (columns: date, provider, model, tokens by type, cost, speed). `Blob` + `<a download>`; toast "Saved". Server route unnecessary.
- **Snapshot image:** render the Limits section to a 1200×630 canvas (inline SVG → `canvas.toBlob`) using theme tokens; **redact email/names by default**,
  watermark "Burnrate"; copy to clipboard + save. Needs `foreignObject`-free SVG for reliability (draw bars, text, and ticks directly).
- **Reuse:** `ui/toast.tsx` + `anchoredCopyToast.ts` (add to sync), `Menu` for "Export ▸", `T3:routes/_chat.settings.snap-shot.tsx` as a naming/placement precedent.

### 4.7 Command palette
T3 has a full palette: `T3:components/CommandPalette.tsx` (3181 lines), `CommandPaletteContent/Results.tsx`, primitive `T3:components/ui/command.tsx`
(already synced verbatim as `B:components/ui/command.tsx`, and it already uses `useNativeTitlebarHeight`). The Usage entry is at
`CommandPalette.tsx:1744-1750` (`value: "action:usage"`, search terms usage/tokens/cost/spend/limits). **Do not port the 3 k-line file.**
Build a ~150-line palette on the verbatim `ui/command.tsx`: items = views (Cost/Tokens/Limits), periods (24h/7/30/90), providers (toggle visibility),
actions (Refresh, Export CSV, Add API key, Sign in to Claude, Toggle theme, Open Settings, About). `⌘/Ctrl+K`. The existing `isCommandPaletteOpen()` shim
(`B:t3-shims/overlays.ts`) already suppresses Usage shortcuts while it is open.

### 4.8 Settings
- **Sections:** Appearance (theme System/Light/Dark, interface font size 12–20 per `T3:appearanceFonts.ts`, compact density), General (timestamp format, hide emails, refresh interval 1/5/15 min, start on login),
  Notifications (§4.10), Data (data folder path, clear caches, price overrides link), Providers link.
- **Data:** extend `AppSettings` (`B:hooks/useSettings.ts`); server-side settings via `PATCH /api/settings` for anything the tray/notifier needs.
- **Reuse:** `ui/switch.tsx`, `ui/radio-group.tsx`, `ui/number-field.tsx`, `ui/select.tsx`, `ui/collapsible-section-header.tsx`, `ui/separator.tsx`.

### 4.9 About / diagnostics
- **Shows:** version, build, server port, data dir, uptime, RSS (README: ≈125 MB), last scan duration, files scanned/malformed per reader (`ReadResult.malformed`), per-provider last success/error, "Copy diagnostics" (redacted), licenses (MIT + T3 NOTICE).
- **Data:** `GET /api/diagnostics`. 
- **Reuse:** `Table`, `Badge`, `Alert`; layout precedent `T3:routes/_chat.settings.diagnostics.tsx`, `_chat.settings.about.tsx`, `_chat.settings.open-source-licenses.tsx`.

### 4.10 Notifications and tray (Windows/Linux)
- Desktop notification at 80 % and 95 % *used* per window (once per window-cycle), "limit reached", "reset happened — you have capacity again".
  Use Web Notifications (works in Edge `--app`); tray requires a native shell (later).
- **Data:** the §4.3 sampler runs server-side so notifications fire while the window is closed (system tray / background service).
- **Reuse:** `T3:threadNotifications.ts` as a pattern for de-duplication.

### 4.11 Update notifications
Server checks the GitHub releases API once a day (opt-out in Settings → General); show a non-blocking toast "Burnrate 0.4 is available · What's new · Update". 
No auto-install in v1. **Reuse:** `ui/toast.tsx` (`update` colour token `--update`, present in `index.css:228-230`).

---------------------------------------------------------------------------------------------------

## 5. Prioritised backlog

Effort: S ≤ ½ day, M 1–2 days, L 3+ days.

### Must
| Item | Effort | Notes |
|---|---|---|
| Base UI shell for `AppModalFrame` (enter/exit animation, focus return, Esc, backdrop fade) — §2.A | M | Biggest parity win; unblocks everything else. |
| Limits loading skeleton + error alert + honest empty state — §2.D/E, §1 #2 | S | Removes a false statement. |
| Keep one frame for Usage⇄Providers; keep `UsagePage` mounted — §2.B | S | Prevents skeleton flash/state reset. |
| Auto-refresh on entering Limits + 5-min throttle + in-flight coalescing — §1 #5 | S | Port `refreshUsageLimits` logic. |
| Minute ticker for countdowns, paused when hidden — §2.F | S | Correctness for an always-open window. |
| "Updated HH:MM" stale indicator (from `checkedAt`) + offline banner — §3.7 | S | |
| Hide single-environment UI; rewrite copy to "this computer" — §1 #3 | S | |
| `role="meter"` + forced-colors CSS for bars — §3.8 | S | Windows high-contrast users currently see no fill. |
| Reduced-motion guard on shell/pane transitions — §3.8 | S | |
| First-run empty state with detected-agents checklist — §4.1 | M | Needs `detected` from server. |

### Should
| Item | Effort | Notes |
|---|---|---|
| Toast system (sync `ui/toast.tsx`, mount providers) | S | Prerequisite for export/update/copy. |
| Command palette (lean, on `ui/command.tsx`) — §4.7 | M | |
| Settings dialog (theme tri-state, font size, timestamp, hide emails, refresh interval) — §4.8 | M | |
| Expired-login row with "Sign in again" — §3.7 | S | Server must report `expired`. |
| Real `useLocale` + `Intl` number/date/relative formatting — §1 #16 | S | |
| Root `font-size: 16px` guard — §1 #14 | S | |
| "Today" summary strip — §4.2 | S | |
| CSV/JSON export — §4.6 | S | |
| Threshold notifications (80/95 %) — §4.10 | M | Needs background sampler. |
| History sampler + sparklines + forecast chip — §4.3, §3.2 | L | New store + endpoint + chart. |
| About/diagnostics — §4.9 | M | |
| Compact density mode (`LimitWindows compact`) — §3.5 | S | |

### Could
| Item | Effort | Notes |
|---|---|---|
| Per-project breakdown — §4.4 | L | Reader changes per provider. |
| Provider comparison table — §4.5 | M | |
| Shareable snapshot image — §4.6 | M | |
| Update notifications — §4.11 | M | |
| WCO title bar via PWA install — §2.G | M | Needs installed-PWA/WebView2 path; verify Linux fallback. |
| Reset-credit redemption (`ResetCreditDialog`) — §1 #7 | M | Needs server `consume` endpoint. |
| RTL support + translation catalogue — §3.9 | L | |
| Subtle `html` background cross-fade on theme switch — §1 #10 | S | |
| Mini/compact always-on-top window mode | M | Edge `--app` window sizing + tightest-window view. |

---------------------------------------------------------------------------------------------------

## 6. Quick-reference line numbers

T3: `components/AppRouteModal.tsx:43,55-62,90-103,123-135` · `components/ui/dialog-styles.ts:2,8,14` · `components/ui/popover.tsx:83-120` ·
`components/ui/tooltip.tsx:109,143` · `components/ui/skeleton.tsx:5` · `components/ui/refresh-icon.tsx:29-32` · `components/ui/scroll-area.tsx:87-95` ·
`components/ui/button.tsx:9` · `components/ui/toggle.tsx:32` · `components/ui/collapsible.tsx:29` · `components/AnimatedHeight.tsx:85` ·
`index.css:224-233` (animation tokens), `296-355` (skeleton/stash/status keyframes), `581-585` (`visible-animate-spin`), `1061` (forced-colors), `1852-1866` (scrollbar) ·
`components/usage/UsagePage.tsx:205,329-345,1108,1230,1348` · `components/usage/UsageLimitsPooled.tsx:78-103,218-237,299-349` ·
`packages/client-runtime/src/state/usage.ts:19-42` · `lib/visibleAnimation.ts` · `lib/windowControlsOverlay.ts` · `appInit.tsx:266` · `appearanceFonts.ts:101`.

Burnrate: `components/AppModalFrame.tsx:54,64` · `App.tsx:14-35,51-56,66-118` · `api.ts` (`useLoad`) · `state/usage.ts:36` ·
`components/usage/UsagePage.tsx:321,396-401,478-486,521,1165,1342` · `components/usage/UsageLimitsPooled.tsx:70-95,617-621` ·
`components/usage/UsageLimits.tsx:99-175` · `t3-shims/keybindings.ts:25-32` · `i18n.ts:55-58` · `public/site.webmanifest` · `server-rs/src/main.rs:171-194` · `server-rs/src/types.rs:5-20`.

## Sources
- [Coralogix — Usage & Quota overview (forecast/warning, safe daily spend)](https://coralogix.com/docs/user-guides/account-management/organization-management/usage-and-quota/usage-overview.md)
- [SaaSFrame — Usage Indicator pattern](https://www.saasframe.io/patterns/usage-indicator?ee3058b5_page=1)
- [Dynatrace — Project run rate](https://docs.dynatrace.com/docs/manage-your-costs/predict/project-run-rate)
- [OpenAI community — burn-rate forecast request](https://community.openai.com/t/restore-usage-reset-visibility-and-add-a-burn-rate-forecast/1391275)
- [Claude Code usage limits (DataCamp)](https://www.datacamp.com/tutorial/claude-code-usage-limits) · [feature request for rate_limits in statusline](https://github.com/anthropics/claude-code/issues/20636)
- [W3C — Understanding 1.4.1 Use of Color](https://w3.org/WAI/WCAG22/Understanding/use-of-color.html) · [1.4.11 Non-text Contrast](https://w3.org/WAI/WCAG22/Understanding/non-text-contrast) · [What's New in WCAG 2.2](https://w3.org/WAI/standards-guidelines/wcag/new-in-22/)
- [APG meter pattern](https://masup9.github.io/apg-patterns-examples/patterns/meter/astro) · [Evinced — progressbar](https://knowledge.evinced.com/components/progressbar) · [Evinced — meter](https://knowledge.evinced.com/components/Meter) · [Primer — progress bar accessibility](https://primer.style/product/components/progress-bar/accessibility)
- [Microsoft Edge — styling for forced colors](https://blogs.windows.com/msedgedev/2020/09/17/styling-for-windows-high-contrast-with-new-standards-for-forced-colors/)
- [The New Stack — dashboard data freshness](https://thenewstack.io/can-you-trust-your-dashboard-the-critical-role-of-data-freshness/) · [Basedash — data freshness](https://basedash.com/blog/data-freshness-how-current-your-dashboard-data-really-is)

Not covered by search (marked *judgement* above): authoritative onboarding/empty-state and offline-state patterns, and any dedicated pace-indicator research.
