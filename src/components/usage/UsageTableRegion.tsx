import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export function UsageTableRegion({ label, className, children }: {
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        "isolate max-h-[min(28rem,60dvh)] min-w-0 max-w-full scroll-pt-10 overflow-auto overscroll-x-contain rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_[data-slot=table-container]]:overflow-visible [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:bg-[var(--usage-table-surface,var(--background))] [&_thead_th]:shadow-[inset_0_-1px_0_var(--border)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
