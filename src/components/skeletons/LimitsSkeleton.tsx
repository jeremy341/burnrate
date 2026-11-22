import { Skeleton } from "~/components/ui/skeleton";
import { useGT } from "~/i18n";

/**
 * The Limits tab, at skeleton fidelity: each provider section (icon + name) holds two window
 * cards with the real card's header row, meter bar and reset footer, so the section heights and
 * the scroll length match the loaded `UsageLimitsPooled` view instead of the old two thin rows.
 */
export function LimitsSkeleton() {
  const gt = useGT();
  return (
    <div
      data-slot="limits-skeleton"
      role="status"
      aria-busy="true"
      className="flex flex-col gap-5"
    >
      <span className="sr-only">{gt("Checking your limits…")}</span>
      {[0, 1].map((provider) => (
        <section key={provider} className="flex flex-col gap-3" aria-hidden>
          <div className="flex min-h-6 items-center gap-2">
            <Skeleton shape="pill" className="size-5 shrink-0" />
            <Skeleton className="h-4 w-28" />
          </div>
          {[0, 1].map((card) => (
            <div
              key={card}
              className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card/30 p-3"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <Skeleton className="h-3.5 w-16" />
                  <Skeleton className="h-7 w-20" />
                </div>
                <Skeleton className="mt-0.5 h-3.5 w-14" />
              </div>
              <Skeleton shape="pill" className="h-6 w-full" />
              <div className="flex items-center justify-between gap-4">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
