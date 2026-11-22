import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { Skeleton } from "~/components/ui/skeleton";
import { useGT } from "~/i18n";

/** Skeleton nav groups: heading + real row count of the sidebar's two tallest groups. */
const NAV_GROUPS: readonly { readonly rows: readonly number[] }[] = [
  { rows: [3, 3, 4] },
];
// The sections list is 10 items in 3 groups.

/**
 * The Settings page, at skeleton fidelity. Used as the Suspense fallback while the settings
 * chunk loads and as the page's own loading state while the settings sync round-trip settles:
 * same root classes, sidebar geometry and one SettingsRow-geometry card, so swapping in the
 * real page never jumps.
 */
export function SettingsSkeleton() {
  const gt = useGT();
  return (
    <div
      data-slot="settings-skeleton"
      role="status"
      aria-busy="true"
      className="absolute inset-0 flex min-h-0 flex-col bg-background sm:flex-row"
    >
      <span className="sr-only">{gt("Loading settings")}</span>
      {/* Sidebar: search field, the stacked section switch on narrow windows, nav groups. */}
      <nav
        aria-hidden
        className="flex max-h-[50%] w-full shrink-0 flex-col gap-3 border-b border-sidebar-border bg-sidebar px-3 py-3 text-sidebar-foreground sm:h-full sm:max-h-none sm:w-60 sm:border-b-0 sm:border-e"
      >
        <Skeleton shape="card" className="h-8 w-full" />
        <Skeleton shape="card" className="h-8 w-full sm:hidden" />
        <div className="hidden min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-1 sm:flex">
          {NAV_GROUPS.flatMap((group) =>
            group.rows.map((rows, groupIndex) => (
              <div key={groupIndex} className="flex flex-col gap-1">
                <Skeleton className="mx-2 h-3.5 w-16" />
                <div className="flex flex-col gap-0.5">
                  {Array.from({ length: rows }, (_, row) => (
                    <div key={row} className="flex min-h-8 items-center gap-2 px-2 py-1">
                      <Skeleton shape="card" className="size-4 shrink-0" />
                      <Skeleton className="h-4 w-24" />
                    </div>
                  ))}
                </div>
              </div>
            )),
          )}
        </div>
      </nav>
      {/* Content mirrors the General section that opens first: two SettingsSection
          stacks (Startup with three switch rows, Display with two select rows), so
          the card heights, heading rhythm and scroll length match the real page. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" aria-hidden>
        <WorkspacePageContainer width="form">
          {[
            { heading: "w-20", rows: 3, control: "switch" as const },
            { heading: "w-16", rows: 2, control: "select" as const },
          ].map((group) => (
            <section key={group.control} className="space-y-3">
              <div className="flex min-h-7 flex-wrap items-start justify-between gap-x-4 px-4">
                <div className="flex min-w-0 flex-wrap items-center gap-1 py-1">
                  <Skeleton className="h-4.5 w-20" />
                </div>
              </div>
              <div className="relative rounded-xl border border-border bg-card text-foreground *:not-first:border-t *:not-first:border-border">
                {Array.from({ length: group.rows }, (_, row) => (
                  <div
                    key={row}
                    className="group/settings-row @container/settings-row min-w-0 rounded-xl px-4 py-3 outline-none"
                  >
                    <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_auto] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-6">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex min-h-5 items-center gap-1.5">
                          <Skeleton className="h-4 w-36" />
                        </div>
                        <div className="max-w-2xl py-px">
                          <Skeleton className="h-3.5 w-72 max-w-full" />
                        </div>
                      </div>
                      <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
                        <Skeleton
                          shape={group.control === "switch" ? "pill" : "card"}
                          className={group.control === "switch" ? "h-6 w-10" : "h-8 w-40"}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </WorkspacePageContainer>
      </div>
    </div>
  );
}
