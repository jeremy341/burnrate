import { createContext, use, type ReactNode } from "react";

import { useMinuteNow } from "~/state/usage";

const LimitsClockContext = createContext<number | null>(null);

/** Only descendants reading the clock update on minute boundaries. */
export function LimitsClock({ enabled, children }: { readonly enabled: boolean; readonly children: ReactNode }) {
  const now = useMinuteNow(enabled);
  return <LimitsClockContext value={enabled ? Math.max(now, Date.now()) : now}>{children}</LimitsClockContext>;
}

export function useLimitsClockNow(fallback: number): number {
  return use(LimitsClockContext) ?? fallback;
}
