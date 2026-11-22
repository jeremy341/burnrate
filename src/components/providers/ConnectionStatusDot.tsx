import { cn } from "~/lib/utils";

import type { AgentDotTone } from "./agentTiles";

/** T3's connection dot palette: one small token per state, never colour alone. */
export const DOT_TONE_CLASS: Readonly<Record<AgentDotTone, string>> = {
  ready: "bg-success",
  neutral: "bg-muted-foreground/60",
  warning: "bg-warning",
  error: "bg-destructive",
  disabled: "bg-muted-foreground/30",
};

/**
 * A status dot with an accessible name. T3 keeps these calm and tiny; the text beside it carries
 * the meaning for screen readers and for anyone who cannot distinguish the tones.
 */
export function ConnectionStatusDot({
  tone,
  label,
  className,
}: {
  readonly tone: AgentDotTone;
  readonly label: string;
  readonly className?: string | undefined;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      data-status={tone}
      data-slot="connection-status-dot"
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
    >
      <span className={cn("size-1.5 rounded-full", DOT_TONE_CLASS[tone])} aria-hidden />
    </span>
  );
}
