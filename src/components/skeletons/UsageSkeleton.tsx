import { Skeleton } from "~/components/ui/skeleton";
import { useGT } from "~/i18n";

/**
 * The Usage screen body, at skeleton fidelity: the toolbar row (period / metric toggles and
 * refresh live in the header), the ranking-list + chart grid, and the Totals metric row —
 * the same geometry `UsageOverview` renders, so swapping in real data never jumps.
 */
export function UsageSkeleton() {
  const gt = useGT();
  return (
    <div
      data-slot="usage-skeleton"
      role="status"
      aria-busy="true"
      className="flex min-w-0 flex-col gap-6"
    >
      <span className="sr-only">{gt("Loading usage…")}</span>
      {/* Toolbar: provider filter on the left, period/metric toggles + refresh on the right. */}
      <div className="flex flex-wrap items-center justify-between gap-2" aria-hidden>
        <Skeleton shape="card" className="h-8 w-44 max-w-full" />
        <div className="flex items-center gap-1">
          <Skeleton shape="card" className="h-8 w-28" />
          <Skeleton shape="card" className="h-8 w-20" />
          <Skeleton shape="card" className="size-8" />
        </div>
      </div>
      <section
        className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]"
        aria-hidden
      >
        {/* Provider ranking list. */}
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-10 w-36" />
            <Skeleton className="h-4 w-32" />
          </div>
          {[0, 1, 2, 3].map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <Skeleton shape="pill" className="size-2 shrink-0" />
                  <Skeleton shape="pill" className="size-4 shrink-0" />
                  <Skeleton className="h-3.5 w-20" />
                </span>
                <Skeleton className="h-3.5 w-14" />
              </div>
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </div>
        {/* Chart with axis labels. */}
        <div className="flex min-w-0 flex-col gap-3">
          <Skeleton className="h-5 w-24" />
          <div className="flex flex-col gap-1">
            <Skeleton className="h-56 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      </section>
      {/* Totals metrics row. */}
      <section className="flex flex-col gap-2" aria-hidden>
        <Skeleton className="h-5 w-16" />
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          {[0, 1, 2, 3, 4].map((tile) => (
            <div key={tile} className="flex flex-col gap-0.5">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-6 w-16" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
