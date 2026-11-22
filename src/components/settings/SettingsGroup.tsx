import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** T3's grouped settings surface: a rounded, softly divided card for a section's rows. */
export function SettingsGroup({
  variant = "grouped",
  divided = true,
  className,
  ...props
}: ComponentProps<"div"> & {
  variant?: "grouped" | "plain";
  divided?: boolean;
}) {
  return (
    <div
      data-slot="settings-group"
      {...props}
      className={cn(
        "relative overflow-visible text-foreground",
        variant === "grouped"
          ? "rounded-xl border border-border bg-card"
          : "space-y-1",
        variant === "grouped" &&
          divided &&
          "*:not-first:border-t *:not-first:border-border [&>[data-slot=settings-row]]:rounded-none",
        className,
      )}
    />
  );
}
