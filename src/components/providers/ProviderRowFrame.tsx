import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * The one row shape on the Providers screen: mark, name, status and actions in one grid.
 * Under 36rem the row is two lines, the name over its status, with the mark and the actions either side.
 * From 36rem the name, status and actions share one line in fixed columns, so every row's status starts
 * at the same x and its actions line up on the right. The row is its own container, so the grid follows
 * the row's width, not the window's.
 */
export function ProviderRowFrame({
  mark,
  name,
  status,
  statusTone = "muted",
  actions,
  footer,
  className,
  children,
  ...rest
}: ComponentProps<"li"> & {
  readonly mark: ReactNode;
  readonly name: ReactNode;
  readonly status?: ReactNode;
  readonly statusTone?: "muted" | "error";
  readonly actions?: ReactNode;
  /** A note or an error. It starts at the name column, under the row. */
  readonly footer?: ReactNode;
}) {
  return (
    <li data-slot="provider-row" {...rest} className={cn("@container/provider-row min-w-0 px-4 py-3", className)}>
      <div className="grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 @min-[36rem]/provider-row:grid-cols-[1.25rem_minmax(0,12rem)_minmax(0,1fr)_minmax(9.5rem,max-content)]">
        <div className="col-start-1 row-span-2 row-start-1 flex items-center @min-[36rem]/provider-row:row-span-1">
          {mark}
        </div>
        <div className="col-start-2 row-start-1 min-w-0">{name}</div>
        {status ? (
          <div
            className={cn(
              "col-start-2 row-start-2 min-w-0 text-xs tabular-nums @min-[36rem]/provider-row:col-start-3 @min-[36rem]/provider-row:row-start-1",
              statusTone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {status}
          </div>
        ) : null}
        {actions ? (
          <div className="col-start-3 row-span-2 row-start-1 flex min-w-0 flex-wrap items-center justify-end justify-self-end gap-1 @min-[36rem]/provider-row:col-start-4 @min-[36rem]/provider-row:row-span-1">
            {actions}
          </div>
        ) : null}
        {footer ? (
          <div className="col-span-2 col-start-2 row-start-3 min-w-0 @min-[36rem]/provider-row:col-span-3 @min-[36rem]/provider-row:row-start-2">
            {footer}
          </div>
        ) : null}
      </div>
      {children}
    </li>
  );
}
