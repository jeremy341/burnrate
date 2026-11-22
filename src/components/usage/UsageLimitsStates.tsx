import { PlusIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { T, useGT } from "~/i18n";
import { requestAddProvider } from "~/providers/reload";

/** Limits read failure: honest error with a retry, instead of a false empty state. */
export function LimitsErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  const gt = useGT();
  return (
    <div role="alert">
      <Alert variant="error">
        <TriangleAlertIcon />
        <AlertTitle>{gt("Couldn't read limits")}</AlertTitle>
        <AlertDescription className="wrap-anywhere">{error}</AlertDescription>
        <AlertAction>
          <Button size="xs" variant="outline" onClick={onRetry}>
            {gt("Try again")}
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}

/** "Updated 2 minutes ago", from the report's own timestamp so a failed refresh cannot make old numbers look current. */
export function limitsAgeLabel(
  gt: (message: string, values?: Record<string, unknown>) => string,
  checkedAt: string,
  now: number,
): string {
  const parsed = Date.parse(checkedAt);
  const minutes = Number.isFinite(parsed) ? Math.max(0, Math.floor((now - parsed) / 60000)) : 0;
  if (minutes < 1) return gt("Updated just now");
  if (minutes < 60) {
    return gt("Updated {count, plural, one {{count} minute} other {{count} minutes}} ago", { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  return gt("Updated {count, plural, one {{count} hour} other {{count} hours}} ago", { count: hours });
}

/**
 * The freshness line under the limits. Staleness is already shown on the bars themselves, so this
 * stays a single quiet sentence; the header owns the refresh button.
 */
export function LimitsFooter({
  checkedAt,
  now,
  error,
  refreshing: _refreshing,
  onRefresh: _onRefresh,
}: {
  checkedAt: string;
  now: number;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const gt = useGT();
  return (
    <div
      data-slot="limits-footer"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
    >
      <span className="tabular-nums">{limitsAgeLabel(gt, checkedAt, now)}</span>
      {error !== null ? (
        <span role="status">{gt("Could not refresh. Showing the last known limits.")}</span>
      ) : null}
    </div>
  );
}

/** T3's plain empty sentence, plus the one next step: connecting an agent (opens Add provider). */
export function LimitsEmptyState() {
  return (
    <div className="flex flex-col items-start gap-3" data-slot="limits-empty">
      <p className="text-sm text-muted-foreground">
        <T>No limits to show yet. Connect an agent to see how much you have left.</T>
      </p>
      <Button size="sm" variant="outline" onClick={requestAddProvider}>
        <PlusIcon />
        <T>Connect an agent</T>
      </Button>
    </div>
  );
}
