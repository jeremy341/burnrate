import { Skeleton } from "~/components/ui/skeleton";
import { useGT } from "~/i18n";

/**
 * The Providers screen at skeleton fidelity: the header row (description and Add provider), then the
 * same heading and bordered rows the page draws, so swapping in the real page does not jump.
 */
export function ProvidersSkeleton() {
  const gt = useGT();
  return (
    <div data-slot="providers-skeleton" role="status" aria-busy="true" className="flex min-w-0 flex-col gap-6">
      <span className="sr-only">{gt("Loading providers…")}</span>
      <div className="flex items-center justify-between gap-3" aria-hidden>
        <Skeleton className="h-4 w-64 max-w-full" />
        <Skeleton shape="card" className="h-8 w-28 shrink-0" />
      </div>
      <ProviderRowsSkeleton />
    </div>
  );
}

/** A heading and three rows in the page's row grid, for the first load of the list. */
export function ProviderRowsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <Skeleton className="h-4 w-24" />
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {[0, 1, 2].map((row) => (
          <li key={row} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3">
            <Skeleton shape="pill" className="size-5" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <Skeleton className="h-4 w-32 max-w-full" />
              <Skeleton className="h-3.5 w-48 max-w-full" />
            </div>
            <Skeleton shape="card" className="h-7 w-16" />
          </li>
        ))}
      </ul>
    </div>
  );
}
