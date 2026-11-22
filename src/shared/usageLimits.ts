import type {
  LimitsAccount,
  ProviderId,
  UsageLimits as ServerProviderUsageLimits,
  UsageWindow as ServerProviderUsageWindow,
} from "~/contracts";

const MINUTE = 60_000;

export interface LimitAccount {
  readonly key: string;
  readonly driver: ProviderId;
  readonly displayName: string | null;
  readonly email: string | undefined;
  readonly plan: string | undefined;
  readonly accentColor: string | undefined;
  readonly sourceLabel: string | null;
  readonly limits: ServerProviderUsageLimits;
}

export function toLimitAccounts(accounts: readonly LimitsAccount[]): readonly LimitAccount[] {
  return accounts.map((account) => ({
    key: account.id,
    driver: account.driver,
    displayName: account.displayName ?? null,
    email: account.email,
    plan: account.plan,
    accentColor: account.accentColor,
    sourceLabel: account.sourceLabel ?? null,
    limits: account.limits,
  }));
}

export const CURSOR_USAGE_WINDOWS = [
  {
    id: "totalPercentUsed",
    label: "Overall",
    description: "All usage on your plan this billing cycle.",
  },
  {
    id: "autoPercentUsed",
    label: "Cursor Models",
    description: "Grok, Composer, and Auto use this allowance.",
  },
  {
    id: "apiPercentUsed",
    label: "Other Models",
    description: "Usage allowance for third-party models such as Claude, GPT, and Gemini.",
  },
] as const;

export function cursorUsageWindowDetails(id: string, pool: LimitPool) {
  const details = CURSOR_USAGE_WINDOWS.find((window) => window.id === id);
  return details &&
    ((pool.windows.length === 1 && id === "totalPercentUsed") || hasDuplicateCursorTotal(pool))
    ? { ...details, label: null, description: undefined }
    : details;
}

function cursorUsageWindowRank(id: string): number {
  const rank = CURSOR_USAGE_WINDOWS.findIndex((window) => window.id === id);
  return rank < 0 ? CURSOR_USAGE_WINDOWS.length : rank;
}

export interface LimitPoolMember {
  readonly account: LimitAccount;
  /** The account's own window for this slot: its real usage, reset and pace clock. */
  readonly window: ServerProviderUsageWindow;
  readonly refillPercent: number;
  /**
   * When `refillPercent` comes back: the window's own reset, or the weekly reset while the weekly limit
   * still caps this session. Unset when no clock says when.
   */
  readonly restoresAt?: string;
  /**
   * Set when the weekly limit is tighter than this session window, or spent (then 0): the session can
   * only be used up to what the weekly limit still allows (percent of the WEEKLY limit that is left).
   * A note only: `window` keeps the session's own figures.
   */
  readonly limitedByWeeklyLeft?: number;
}

export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly members: readonly LimitPoolMember[];
  readonly columns: ReadonlyArray<
    LimitPoolMember | { readonly account: LimitAccount; readonly window: null }
  >;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly pace: LimitPace | null;
  readonly resets: ReadonlyArray<{
    readonly member: LimitPoolMember;
    readonly at: number;
    readonly restoresPercent: number;
  }>;
}

export interface LimitPool {
  readonly driver: ProviderId;
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
}

function hasDuplicateCursorTotal(pool: LimitPool): boolean {
  if (pool.windows.length !== 2) return false;
  const total = pool.windows.find((window) => window.id === "totalPercentUsed");
  const auto = pool.windows.find((window) => window.id === "autoPercentUsed");
  return (
    total !== undefined &&
    auto !== undefined &&
    total.members.length === auto.members.length &&
    total.members.every(({ account, window }) =>
      account.limits.windows.some(
        (candidate) =>
          candidate.id === auto.id &&
          candidate.kind === auto.kind &&
          candidate.usedPercent === window.usedPercent &&
          candidate.resetsAt === window.resetsAt,
      ),
    )
  );
}

export function displayLimitWindows(pool: LimitPool) {
  if (pool.driver === "antigravity") {
    return [...pool.windows].sort(
      (left, right) =>
        Number(!left.id.startsWith("gemini-")) - Number(!right.id.startsWith("gemini-")) ||
        left.id
          .replace(/-(5h|weekly|quota)$/, "")
          .localeCompare(right.id.replace(/-(5h|weekly|quota)$/, "")) ||
        WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind],
    );
  }
  if (pool.driver !== "cursor") return pool.windows;
  const hasAuto = pool.windows.some((window) => window.id === "autoPercentUsed");
  const hasApi = pool.windows.some((window) => window.id === "apiPercentUsed");
  const hideTotal = (hasAuto && hasApi) || hasDuplicateCursorTotal(pool);
  return pool.windows
    .filter((window) => !hideTotal || window.id !== "totalPercentUsed")
    .sort((left, right) => cursorUsageWindowRank(left.id) - cursorUsageWindowRank(right.id));
}

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function collectLimitPools(
  accounts: readonly LimitAccount[],
  now: number,
): readonly LimitPool[] {
  const byDriver = new Map<ProviderId, LimitAccount[]>();
  for (const account of accounts) {
    const list = byDriver.get(account.driver);
    if (list) list.push(account);
    else byDriver.set(account.driver, [account]);
  }
  return [...byDriver].map(([driver, members]) => {
    const orderWindow = members
      .flatMap((account) => account.limits.windows)
      .sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind])[0];
    const orderReset = (account: LimitAccount) => {
      const window = account.limits.windows.find(
        (window) => orderWindow && poolKey(driver, window) === poolKey(driver, orderWindow),
      );
      return (
        (window ? isoMillis(poolMember(account, window, now).restoresAt) : null) ??
        Number.POSITIVE_INFINITY
      );
    };
    const sorted = [...members].sort(
      (left, right) =>
        orderReset(left) - orderReset(right) ||
        accountSortName(left).localeCompare(accountSortName(right)) ||
        left.key.localeCompare(right.key),
    );
    return { driver, accounts: sorted, windows: poolWindows(sorted, now) };
  });
}

function accountSortName(account: LimitAccount): string {
  return (account.displayName ?? account.email ?? account.key).toLowerCase();
}

const CODEX_PLAN_CAPACITY: Record<string, number> = {
  "ChatGPT Plus Subscription": 1,
  "ChatGPT Pro 100 Subscription": 5,
  "ChatGPT Pro 200 Subscription": 20,
};
// Claude's published plan multipliers describe the session allowance only.
const CLAUDE_SESSION_CAPACITY: Record<string, number> = { Pro: 1, Max: 5, Ultra: 20 };

function planCapacity(account: LimitAccount, kind: ServerProviderUsageWindow["kind"]) {
  if (!account.plan) return undefined;
  if (account.driver === "codex" && (kind === "session" || kind === "weekly")) {
    return CODEX_PLAN_CAPACITY[account.plan];
  }
  if (account.driver === "claudeAgent" && kind === "session") {
    return CLAUDE_SESSION_CAPACITY[account.plan];
  }
  return undefined;
}

// Codex ids name slots, so pool by kind; other drivers' ids identify distinct allowances.
function poolKey(driver: ProviderId, window: ServerProviderUsageWindow): string {
  return driver === "codex" ? window.kind : `${window.kind}:${window.id}`;
}

/** The weekly window that caps this account's sessions (Claude: seven_day; Codex: the weekly slot). */
function weeklyWindowOf(account: LimitAccount): ServerProviderUsageWindow | undefined {
  return account.limits.windows.find((window) =>
    account.driver === "claudeAgent"
      ? window.id === "seven_day"
      : account.driver === "codex" && window.kind === "weekly",
  );
}

/**
 * An account's member of a pool slot. A session keeps its own usage, reset and pace clock, so its figures
 * are the real window. A weekly limit that is tighter than the session, or spent, only caps what can be
 * used: it is a note (`limitedByWeeklyLeft`), and `restoresAt` says when usable quota comes back.
 */
function poolMember(
  account: LimitAccount,
  reported: ServerProviderUsageWindow,
  now: number,
): LimitPoolMember {
  const weekly = reported.kind === "session" ? weeklyWindowOf(account) : undefined;
  if (!weekly || (weekly.usedPercent <= reported.usedPercent && weekly.usedPercent < 100)) {
    return {
      account,
      window: reported,
      refillPercent: reported.usedPercent,
      restoresAt: reported.resetsAt,
    };
  }
  if (weekly.usedPercent < 100) {
    // The weekly limit is not spent but is TIGHTER than the session (e.g. 69% of the session left but
    // only 1% of the week): you cannot use more than the week still allows. Upstream T3 only handled a
    // fully spent week, which overstated what is really usable.
    const weeklyReset = resetMillis(weekly);
    const sessionReset = resetMillis(reported);
    const weeklyBinds = weeklyReset !== null && (sessionReset === null || weeklyReset > sessionReset);
    return {
      account,
      window: reported,
      refillPercent: reported.usedPercent,
      restoresAt: weeklyBinds ? weekly.resetsAt : reported.resetsAt,
      limitedByWeeklyLeft: Math.max(0, 100 - weekly.usedPercent),
    };
  }

  // The week is spent, so nothing is usable until a reset frees quota: the week's, or the session's own
  // when that lands after the week's.
  const weeklyReset = resetMillis(weekly);
  const sessionReset = resetMillis(reported);
  const cutoff = Math.max(now, Date.parse(account.limits.checkedAt));
  let restoresAt: string | undefined;
  let refillPercent = 0;
  // A stale or missing clock cannot tell us when blocked quota becomes usable.
  if (
    weeklyReset !== null &&
    sessionReset !== null &&
    weeklyReset > cutoff &&
    sessionReset > cutoff
  ) {
    if (sessionReset <= weeklyReset) {
      restoresAt = weekly.resetsAt;
      refillPercent = 100;
    } else if (reported.usedPercent >= 100) {
      restoresAt = reported.resetsAt;
      refillPercent = 100;
    } else {
      restoresAt = weekly.resetsAt;
      refillPercent = 100 - Math.max(0, Math.min(100, reported.usedPercent));
    }
  }
  return { account, window: reported, refillPercent, restoresAt, limitedByWeeklyLeft: 0 };
}

function poolWindows(accounts: readonly LimitAccount[], now: number): readonly LimitPoolWindow[] {
  const byKey = new Map<string, LimitPoolMember[]>();
  for (const account of accounts) {
    for (const reported of account.limits.windows) {
      const member = poolMember(account, reported, now);
      const { window } = member;
      const pooled = poolKey(account.driver, window);
      const key = byKey.get(pooled)?.some((member) => member.account === account)
        ? `${window.kind}:${window.id}`
        : pooled;
      const list = byKey.get(key);
      if (list) list.push(member);
      else byKey.set(key, [member]);
    }
  }
  const pools = [...byKey].map(([key, members]): LimitPoolWindow => {
    const memberByAccount = new Map(members.map((member) => [member.account.key, member]));
    const first = members[0]!.window;
    const id = members[0]!.account.driver === "codex" ? key : first.id;
    // One unknown plan makes the pool incomparable by plan, so every member then counts once.
    const capacities = members.map((m) => planCapacity(m.account, first.kind));
    const weights = capacities.every((capacity) => capacity !== undefined)
      ? capacities
      : members.map(() => 1);
    const weightOf = new Map(members.map((m, index) => [m, weights[index]!]));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const usedPercent =
      members.reduce((sum, m) => sum + m.window.usedPercent * weightOf.get(m)!, 0) / totalWeight;
    // Judge pace only for windows with reset clocks; others add spend without elapsed time.
    const timed = members.flatMap((m) => {
      const share = elapsedShare(m.window, now);
      return share === null
        ? []
        : [{ used: m.window.usedPercent, elapsed: share, weight: weightOf.get(m)! }];
    });
    const timedWeight = timed.reduce((sum, t) => sum + t.weight, 0);
    const timedUsed = timed.reduce((sum, t) => sum + t.used * t.weight, 0) / timedWeight;
    const meanElapsed =
      timed.length > 0
        ? timed.reduce((sum, t) => sum + t.elapsed * t.weight, 0) / timedWeight
        : null;
    const resets = members
      .flatMap((member) => {
        const at = isoMillis(member.restoresAt);
        return at === null
          ? []
          : [
              {
                member,
                at,
                restoresPercent: Math.round(
                  (member.refillPercent * weightOf.get(member)!) / totalWeight,
                ),
              },
            ];
      })
      .sort((left, right) => left.at - right.at);
    return {
      id,
      kind: first.kind,
      label: first.label,
      members,
      columns: accounts.map(
        (account) => memberByAccount.get(account.key) ?? { account, window: null },
      ),
      usedPercent: Math.round(usedPercent),
      remainingPercent: Math.round(100 - usedPercent),
      pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed),
      resets,
    };
  });
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]);
}

function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}

export function remainingPercent(window: ServerProviderUsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

// burnrate: usage.barMode chooses which number a bar represents ("remaining" is T3's default).
export type BarValueMode = "remaining" | "used";

export function barValue(window: ServerProviderUsageWindow, mode: BarValueMode): number {
  return mode === "used"
    ? Math.round(Math.max(0, Math.min(100, window.usedPercent)))
    : remainingPercent(window);
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  return isoMillis(window.resetsAt);
}

/** A reset clock as milliseconds, or null when it is missing or not a date. */
function isoMillis(resetsAt: string | undefined): number | null {
  if (resetsAt === undefined) return null;
  const at = Date.parse(resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** burnrate: the moment a window reaches 100% at its average burn rate so far. */
export interface ProjectedEmpty {
  readonly at: number;
  readonly ms: number;
}

/**
 * burnrate: project exhaustion from the elapsed share of the window. The estimate is only
 * useful when it lands before the reset, so projections after the reset return null.
 */
export function projectedEmpty(
  window: ServerProviderUsageWindow,
  now: number,
): ProjectedEmpty | null {
  const used = Math.max(0, Math.min(100, window.usedPercent));
  if (used <= 0 || used >= 100) return null;
  const reset = resetMillis(window);
  if (reset === null || window.windowDurationMins === undefined || window.windowDurationMins <= 0) {
    return null;
  }
  const length = window.windowDurationMins * MINUTE;
  const elapsed = Math.max(0, Math.min(length, length - (reset - now)));
  if (elapsed <= 0) return null;
  const ms = ((100 - used) / used) * elapsed;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const at = now + ms;
  return at < reset ? { at, ms } : null;
}

/**
 * burnrate: a report is stale once it is older than three refresh intervals (30 s floor),
 * so a sleeping scheduler cannot present an old snapshot as current.
 */
export function isLimitStale(
  checkedAt: string | undefined,
  now: number,
  refreshIntervalSec: number,
): boolean {
  if (checkedAt === undefined) return false;
  const checked = Date.parse(checkedAt);
  if (!Number.isFinite(checked)) return false;
  return now - checked > Math.max(30, refreshIntervalSec) * 1000 * 3;
}

export function isLimitSnapshotStale(
  limits: Pick<ServerProviderUsageLimits, "checkedAt" | "stale">,
  now: number,
  refreshIntervalSec: number,
): boolean {
  return limits.stale === true || isLimitStale(limits.checkedAt, now, refreshIntervalSec);
}

export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

// Bars show quota remaining, so even pace tracks time remaining.
export function paceRemainingPercent(
  window: ServerProviderUsageWindow,
  now: number,
): number | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : Math.round((1 - elapsed) * 100);
}

export type LimitPace = "ahead" | "on" | "under";

export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : paceOfShares(window.usedPercent, elapsed);
}

function paceOfShares(usedPercent: number, elapsed: number): LimitPace {
  const gap = usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

/** One redeemable reset as clients offer it; `input` already names the chosen credit. */
export interface ResetCreditChoice {
  readonly key: string;
  readonly summary: string;
  readonly actionLabel: string;
  readonly confirmDescription: string;
  readonly availableCount: number;
}

export type ResetCountdown =
  | { readonly kind: "now" }
  | { readonly kind: "momentarily" }
  | { readonly kind: "in"; readonly ms: number };

export function resetCountdown(
  window: ServerProviderUsageWindow,
  now: number,
): ResetCountdown | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  if (resetsAt <= now) return { kind: "now" };
  if (resetsAt - now < MINUTE) return { kind: "momentarily" };
  return { kind: "in", ms: resetsAt - now };
}

