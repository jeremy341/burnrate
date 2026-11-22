import { ChevronDownIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";

const SURFACE = "rounded-xl border border-border bg-card";

/**
 * One block of the Providers screen: a heading with its count, then one bordered surface whose rows
 * are split by 1px rules. A folded block turns its heading into a disclosure, so a long tail of
 * providers stays closed without losing its name or its count.
 */
export function ProvidersSection({
  id,
  title,
  count,
  folded = false,
  emptyText,
  listSlot,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly count: number;
  /** Starts closed: the blocks the user did not come for (not found, hidden). */
  readonly folded?: boolean;
  /** Shown instead of the rows when the block is empty. */
  readonly emptyText?: string;
  /** `data-slot` of the list, for the blocks other code looks up. */
  readonly listSlot?: string;
  readonly children: ReactNode;
}) {
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const list = (
    <ul data-slot={listSlot} data-providers-list className={cn("flex flex-col divide-y divide-border", SURFACE)}>
      {children}
    </ul>
  );

  if (!folded) {
    return (
      <section
        aria-labelledby={headingId}
        data-slot="providers-section"
        data-section={id}
        className="flex flex-col gap-3"
      >
        <div className="flex items-center gap-2">
          <h2 id={headingId} className="text-sm font-medium text-foreground">
            {title}
          </h2>
          <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
        </div>
        {count === 0 && emptyText ? <p className={cn(SURFACE, "px-4 py-3 text-xs text-muted-foreground")}>{emptyText}</p> : list}
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} data-slot="providers-section" data-section={id} className="flex flex-col">
      <Collapsible open={open} onOpenChange={(next) => setOpen(next)}>
        <h2 id={headingId} className="text-sm font-medium text-foreground">
          <CollapsibleTrigger
            render={<Button variant="ghost" size="multiline" />}
            className="-ms-2.75 w-[calc(100%+0.6875rem)] justify-start gap-x-2 text-start text-sm"
          >
            {title}
            <span className="text-xs font-normal tabular-nums text-muted-foreground">{count}</span>
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                !open && "-rotate-90",
              )}
            />
          </CollapsibleTrigger>
        </h2>
        <CollapsiblePanel keepMounted>
          <div className="pt-3">{list}</div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
