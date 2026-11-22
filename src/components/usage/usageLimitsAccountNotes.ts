import type { LimitsAccount, UsageLimits } from "~/contracts";
import type { MFunctionType } from "~/i18n";
import { limitsNotice, resetCreditChoices } from "~/shared/usageLimitsCopy";

export interface AccountLimitNotice {
  readonly key: string;
  readonly name: string;
  readonly message: string;
}

/**
 * Accounts that cannot show a limit bar still owe the reader a sentence (T3's "No limits reported.",
 * "Could not read limits.", "This account has no subscription limits."). Accounts the external-link
 * card already explains are skipped so the same account is never described twice.
 */
export function accountLimitNotices(
  accounts: readonly LimitsAccount[],
  resolve?: MFunctionType,
): readonly AccountLimitNotice[] {
  return accounts.flatMap((account) => {
    if (account.limits.externalUsage) return [];
    const message = limitsNotice(account.limits, resolve);
    return message === null
      ? []
      : [{ key: account.id, name: account.displayName ?? account.label, message }];
  });
}

/**
 * One honest line per reset-credit offer: how many are banked and when the next one expires. The
 * server contract has no redeem call, so these are information, never a button.
 */
export function resetCreditLines(
  limits: UsageLimits,
  now: number,
  resolve?: MFunctionType,
): readonly string[] {
  const credits = limits.resetCredits;
  if (!credits || credits.availableCount <= 0) return [];
  return resetCreditChoices(credits, now, false, resolve)
    .filter((choice) => choice.availableCount > 0)
    .map((choice) => choice.summary);
}
