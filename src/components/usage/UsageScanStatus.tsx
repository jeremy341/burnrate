import { useEffect, useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { describeScan, type ScanProgress } from "~/api/usage";
import { useGT, useLocale } from "~/i18n";
import { formatCount } from "~/shared/usageFormat";

/** True once `active` has stayed true for `ms`; resets when it turns false. */
export function useActiveFor(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active && elapsed;
}

/** Numbers are `aria-hidden` so a screen reader hears one calm status, not a counter; the bar carries the value. */
export function UsageScanStatus({
  scan,
  stale = false,
  hasData,
}: {
  readonly scan: ScanProgress | null | undefined;
  readonly stale?: boolean;
  /** Some figures are already on screen, so say they are partial. */
  readonly hasData: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  const view = describeScan(scan);
  if (view.kind === "idle" && !stale) return null;
  if (hasData && !stale && view.kind === "scanning") {
    return (
      <div role="status" className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <Spinner size="sm" tone="muted" className="shrink-0" aria-hidden />
        <span aria-hidden className="tabular-nums">
          {gt("Scanning {done} of {total} files…", {
            done: formatCount(view.done, locale),
            total: formatCount(view.total, locale),
          })}
        </span>
        <span className="sr-only">{gt("Scanning your agents' history. Usage totals are partial.")}</span>
      </div>
    );
  }
  const percent = view.kind === "scanning" ? Math.round(view.fraction * 100) : undefined;
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-xl border bg-card/40 px-3 py-2.5 text-xs text-muted-foreground"
    >
      <div className="flex items-center gap-2">
        <Spinner size="sm" tone="muted" className="shrink-0" aria-hidden />
        <span className="min-w-0">
          {view.kind === "scanning" ? (
            <>
              <span aria-hidden className="text-foreground tabular-nums">
                {gt("Scanning {done} of {total} files…", {
                  done: formatCount(view.done, locale),
                  total: formatCount(view.total, locale),
                })}
              </span>
              <span className="sr-only">{gt("Scanning your agents' history.")}</span>{" "}
              {stale
                ? gt("Showing your last saved numbers while Burnrate checks for changes.")
                : hasData ? gt("Showing what has been read so far.") : gt("Charts appear as soon as the first files are read.")}
            </>
          ) : view.kind === "preparing" ? (
            gt("Looking for your agents' history on this computer…")
          ) : (
            gt("Showing your last saved numbers while Burnrate checks for changes.")
          )}
        </span>
      </div>
      {percent === undefined ? null : (
        <div
          role="progressbar"
          aria-label={gt("Scan progress")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}

/** Replaces an endless skeleton: the scan has nothing yet, or the server is slow or unreachable. */
export function UsageWaiting({
  scan,
  error,
  onRetry,
}: {
  readonly scan: ScanProgress | null | undefined;
  readonly error: string | null;
  readonly onRetry: () => void;
}) {
  const gt = useGT();
  if (error !== null) {
    return (
      <Alert variant="error" role="alert">
        <AlertTitle>{gt("Burnrate can't read usage right now")}</AlertTitle>
        <AlertDescription className="wrap-break-word">{error}</AlertDescription>
        <AlertAction>
          <Button size="xs" variant="outline" onClick={onRetry}>
            {gt("Try again")}
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {describeScan(scan).kind === "idle" ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="md" aria-hidden />
          {gt("Starting up…")}
        </p>
      ) : (
        <UsageScanStatus scan={scan} hasData={false} />
      )}
    </div>
  );
}
