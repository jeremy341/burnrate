import type { LimitsAccount, LimitsReport, ProviderInfo, UsageWindow } from "~/contracts";
import { m, type MessageResolver } from "~/i18n";

/**
 * What the last limits read says about one connected account, in words the Providers screen and
 * the sign-in dialogs can show: "Weekly 94% used", or the one thing to do when the login ran out.
 * Pure and UI-free so the rules are unit-tested; nothing here fetches.
 */

/** The server's stable prefix for an expired login (`login_expired_message` in the Rust server). */
export const LOGIN_EXPIRED_PREFIX = "login-expired:";

export type AccountHealth =
  /** Reading limits. `window` is the closest one to its limit, like the Limits headline. */
  | { readonly kind: "ok"; readonly window: UsageWindow; readonly stale: boolean }
  /** The provider rejected the saved login or key: one action fixes it, signing in again. */
  | { readonly kind: "expired" }
  /** The read failed for another reason; the message is already human text. */
  | { readonly kind: "error"; readonly message: string }
  /** Nothing to say yet (no read, or a provider that reports no limits). */
  | { readonly kind: "unknown" };

const UNKNOWN: AccountHealth = { kind: "unknown" };

export function isLoginExpiredMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && message.trim().toLowerCase().startsWith(LOGIN_EXPIRED_PREFIX);
}

/** The window closest to its limit (highest used percent). */
export function headlineWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  let best: UsageWindow | null = null;
  for (const window of windows) {
    if (!Number.isFinite(window.usedPercent)) continue;
    if (best === null || window.usedPercent > best.usedPercent) best = window;
  }
  return best;
}

export function healthOfLimits(account: LimitsAccount | undefined): AccountHealth {
  if (!account) return UNKNOWN;
  const { limits } = account;
  const message = limits.unavailable?.message;
  if (isLoginExpiredMessage(message)) return { kind: "expired" };
  const window = headlineWindow(limits.windows);
  if (window) return { kind: "ok", window, stale: limits.stale === true };
  if (limits.unavailable?.reason === "probeFailed") {
    return { kind: "error", message: message?.trim() || m("Could not read limits.") };
  }
  return UNKNOWN;
}

/**
 * The limits row for one saved account. The server names Claude rows `claude-<account id>` and key
 * rows `<definition>-<key name>`; a provider with a single account and a single row needs no id.
 */
export function limitsForAccount(
  report: Pick<LimitsReport, "accounts"> | null | undefined,
  provider: Pick<ProviderInfo, "id" | "accounts">,
  account: { readonly id: string; readonly label: string },
): LimitsAccount | undefined {
  const rows = (report?.accounts ?? []).filter((row) => row.driver === provider.id);
  if (rows.length === 0) return undefined;
  const prefix = provider.id === "claudeAgent" ? "claude" : provider.id;
  const ids = [`${prefix}-${account.id}`, account.id, `${provider.id}-${account.id}`];
  const byId = rows.find((row) => ids.includes(row.id));
  if (byId) return byId;
  const byLabel = rows.filter((row) => row.label === account.label);
  if (byLabel.length === 1) return byLabel[0];
  return rows.length === 1 && provider.accounts.length === 1 && provider.accounts[0]?.id === account.id
    ? rows[0]
    : undefined;
}

export function accountHealth(
  report: Pick<LimitsReport, "accounts"> | null | undefined,
  provider: Pick<ProviderInfo, "id" | "accounts">,
  account: { readonly id: string; readonly label: string },
): AccountHealth {
  return healthOfLimits(limitsForAccount(report, provider, account));
}

const RANK: Record<AccountHealth["kind"], number> = { expired: 3, error: 2, ok: 1, unknown: 0 };

/** One health for a whole provider (a row without saved accounts, like Codex): the worst account wins. */
export function providerHealth(
  report: Pick<LimitsReport, "accounts"> | null | undefined,
  provider: Pick<ProviderInfo, "id">,
): AccountHealth {
  let worst: AccountHealth = UNKNOWN;
  for (const row of report?.accounts ?? []) {
    if (row.driver !== provider.id) continue;
    const next = healthOfLimits(row);
    if (RANK[next.kind] > RANK[worst.kind]) worst = next;
    else if (next.kind === "ok" && worst.kind === "ok" && next.window.usedPercent > worst.window.usedPercent) {
      worst = next;
    }
  }
  return worst;
}

/** "Weekly 94% used" for a window. */
export function windowUsedText(window: UsageWindow, resolve: MessageResolver = m): string {
  return resolve("{label} {percent}% used", { label: window.label, percent: Math.round(window.usedPercent) });
}

/** One short status phrase, or null when there is nothing honest to add. */
export function healthText(health: AccountHealth, resolve: MessageResolver = m): string | null {
  switch (health.kind) {
    case "ok":
      return health.stale
        ? resolve("{text}, last read earlier", { text: windowUsedText(health.window, resolve) })
        : windowUsedText(health.window, resolve);
    case "expired":
      return resolve("Sign-in expired");
    case "error":
      return health.message;
    default:
      return null;
  }
}
