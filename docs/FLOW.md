# Burnrate flow

One product, five jobs, each with exactly one home. Every way in has a way out, and every action has a
keyboard path and a name in the command palette.

## The map

| Job | Home | Reach it with |
| --- | --- | --- |
| Glance: how much is left | Usage > Limits (the screen the app opens on) | `l`, palette "Show limits" |
| Where did the money or quota go | Usage > Cost and Tokens, with the period | `c`, `t`, `Ctrl/Cmd+Shift+1..4`, palette "Show cost", "Show tokens", "Show the last 7 days" |
| Manage what is tracked | Providers: add, remove, rename, sign out, hide and show | `g p`, palette "Providers", "Add provider", "Connect an agent" |
| Change the app | Settings: grouped, searchable | gear in the header, `Ctrl/Cmd+,`, palette "Open settings" |

Esc goes back to Usage from every other screen. Usage is the home and stays mounted, so its period,
selection, collapse state and scroll survive a visit elsewhere.

## Decisions and why

1. **Open on Usage > Limits, always.** The brief says so, and T3's Usage window does not restore the
   metric either (its `usagePagePreferences` keep the metric per window but the window opens on the
   default). Burnrate keeps the user's last Cost/Tokens/Limits choice only as T3 does, in the page
   preferences. Nothing else is restored: a launch that opens on Settings or a dialog looks broken.
2. **Nothing pops up on first launch.** No wizard, no welcome dialog (the dialog was deleted; it repeated the
   Usage empty state and the Providers screen). If nothing is connected, Limits shows one calm card:
   "Connect an agent", the agents found on this computer with a Connect button each, and Add provider.
3. **Connecting is one click and ends in the place you were.** Connect (or Sign in) runs the real CLI
   login with progress in a dialog; paste-a-key providers get a key field with Test. On success a toast
   confirms, `notifyProvidersChanged()` reloads the list and re-reads limits, and the new provider appears
   in Limits without a reload. Failure says what happened and what to do next.
4. **Limits is honest about time.** While the first read runs, a line says "Checking your limits". Under
   the limits, "Updated 2 minutes ago" and a Refresh limits button stay visible. If the last refresh
   failed, or the data is older than ten minutes, a live warning says so and the old numbers stay on screen
   (marked stale per provider). The age text itself is not a live region, so assistive tech is not told every
   minute.
5. **Many providers stay usable.** Limits sections collapse to one summary row (hover card for detail);
   "Collapse all" and "Expand all" are in the palette. Providers lists what you can act on first, folds
   "Not found on this computer" into one closed group, and folds organization keys under Advanced.
6. **Three screens, three jobs.** Usage answers how much is left and where it went; Providers manages
   what is tracked; Settings changes the app.
7. **Management is Providers only.** Account rename, remove and sign out live on the provider's row
   (confirmed, with a way back for sign-in). Hide is reversible: a "Hidden" group lists hidden providers with
   a Show button. Admin keys never appear in the empty state; they sit under Advanced, closed.
8. **Settings stays where T3 puts it, plus one door.** T3's Usage window has no Settings entry. Burnrate
   adds a Settings gear at the left of the header. Pressing the gear again while Settings is open returns
   to Usage; the button stays where it is, so focus stays on it, and its tooltip then reads Back to Usage.
9. **Reverse states, everywhere.** Hide / Show, Collapse all / Expand all, Sign in / Sign out, Add key / Remove,
   Settings in / Settings out (button and Esc), Snooze alerts (palette) / un-snooze (Settings > Notifications).
10. **Keyboard and palette parity.** Every header control and every row action has a keyboard path; every
    screen, metric, period, "Add provider", "Connect an agent", "Refresh limits", collapse and expand have a
    palette command with its shortcut shown.
11. **Desktop window controls.** In the Tauri main window, Minimize, Maximize/Restore, and Close sit
    beside the Settings gear. Drag an unused part of the header to move the window, or double-click it to
    maximize or restore. Close follows the close-to-tray setting, and the shell remembers the window's
    position, normal size, and maximized state. On every secondary screen, in the browser and the desktop
    window alike, the button at the end of the header is named Back to Usage, and so is Escape. On Usage
    the browser keeps its Close action.

## What deliberately did not change

- The header keeps the breadcrumb screen switcher, filters, Cost | Tokens | Limits, and refresh. It is one
  row from 56rem. Below that, Usage's period, metric and refresh sit on a second row while search and close
  stay on the first, and below 36rem the four periods collapse into one menu. The toolbar wraps and never
  scrolls sideways, so every control stays reachable down to a 320px window.
- Refresh on Providers re-reads the provider list and the limits behind its rows, and shows busy until both
  settle.
- Usage matches T3 Code's usage monitor 1:1: a 1024px column with T3's page padding, one bordered card per
  limit window, the big total with its totals row, the plain composition bars and breakdown table. Providers
  and Settings keep Burnrate's own page rhythm.
- Settings content and layout belong to the settings work; this flow only links to it.
- The tray and autostart keep their existing behavior.

## Verified journeys

The isolated browser smoke run covers Usage Cost, Tokens, and Limits, plus navigation to Providers and
Settings. Screenshots are in `scripts/smoke/.out`. A separate browser check confirmed that
the header gear opens Settings and Escape returns to Usage.

Usage, Providers, and Settings were checked at 320, 640, and 1100 CSS pixels in the default
light and dark themes. The header gear remained in view, the document stayed within the viewport width,
and axe reported zero automated WCAG A/AA violations on those 18 page loads. The scan used an isolated
profile and covered the initial state of each screen.

## Settings flow audit

- Settings search opens a section or focuses its matching row. Both `#settings/notifications-channels`
  and `#settings/notifications/channels` reach the Channels section. A browser deep link to a
  desktop-only control focuses the section that explains its availability.
- The former Setup guide opens Providers. Its existing deep link still works. The palette's
  Add provider command opens the chooser on the Providers screen, including on its first visit.
- Provider settings show the connection method from the provider registry. Agent sign-ins, local
  session files, and ordinary account API keys are separate from organization admin keys. OpenCode Go
  offers an explicit account sign-in link from its registry URL. After signing in, choose OpenCode Go
  in Add provider and save the Go key there.
- OpenCode Go still needs a server-side opt-in gate. The `/api/providers` account-list route can mark
  it connected from local OpenCode data, and the native provider reader polls with credentials found
  on disk or in the environment. The route and reader must both require the explicit connection
  before local credentials count as connected or can be used to poll.
- Polling intervals accept whole seconds from 60 through 86,400. Clearing the interval restores the
  definition default and preserves other overrides. Notification tests and settings transfers wait
  for pending saves and surface a failure. Recent alerts distinguish loading, unavailable, and empty
  results and offer a retry after a failed read.
