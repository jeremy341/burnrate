import { useEffect, useState } from "react";

import { api } from "~/api";
import type { LimitsReport, ProviderInfo } from "~/contracts";

import { accountHealth, providerHealth, type AccountHealth } from "./health";

export interface LiveHealthTarget {
  readonly provider: Pick<ProviderInfo, "id" | "accounts">;
  /** The account that just signed in, when the sign-in names one. Otherwise the provider's worst row. */
  readonly account?: { readonly id: string; readonly label: string } | undefined;
}

/** What a brand-new Claude account is called by the server: `claude-<name>`. */
export function claudeAccountForName(name: string): { readonly id: string; readonly label: string } {
  return { id: `claude-${name}`, label: name };
}

/**
 * Right after a sign-in the first limits read can take a moment, so ask a few times and stop at the
 * first real answer. `null` while still looking; `{kind: "unknown"}` when nothing ever showed up.
 */
export function useLiveHealth(
  enabled: boolean,
  target: LiveHealthTarget,
  read: () => Promise<Pick<LimitsReport, "accounts">> = api.limits,
  options: { readonly tries?: number; readonly delayMs?: number } = {},
): AccountHealth | null {
  const [health, setHealth] = useState<AccountHealth | null>(null);
  const { provider, account } = target;
  const providerId = provider.id;
  const accountId = account?.id;
  const accountLabel = account?.label;
  const { tries = 5, delayMs = 1500 } = options;

  useEffect(() => {
    if (!enabled) {
      setHealth(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (left: number) => {
      read().then(
        (report) => {
          if (cancelled) return;
          const next = accountId
            ? accountHealth(report, { id: providerId, accounts: [] }, { id: accountId, label: accountLabel ?? accountId })
            : providerHealth(report, { id: providerId });
          if (next.kind !== "unknown" || left <= 1) {
            setHealth(next);
            return;
          }
          timer = setTimeout(() => attempt(left - 1), delayMs);
        },
        () => {
          if (cancelled) return;
          if (left <= 1) setHealth({ kind: "unknown" });
          else timer = setTimeout(() => attempt(left - 1), delayMs);
        },
      );
    };
    attempt(tries);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // `read` is a stable module function in the app; tests pass their own once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, providerId, accountId, accountLabel, tries, delayMs]);

  return health;
}
