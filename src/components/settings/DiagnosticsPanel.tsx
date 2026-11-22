import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { CopyIcon } from "lucide-react";

import {
  formatBytes,
  formatDiagnosticsReport,
  formatProbeDuration,
  formatUptime,
  getDiagnostics,
  maskHomePath,
  type DiagnosticsReport,
} from "~/api/diagnostics";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { msg, useGT } from "~/i18n";
import { providerLabel } from "~/providers/registry";
import { SettingsEmptyRow, SettingsRow, SettingsSection } from "~/settings/layout";
import { useSettings } from "~/settings/store";

type CopyState = "idle" | "copied" | "error";

/** One label / value line in the settings row rhythm: label left, quiet tabular value right. */
function FactRow({
  label,
  children,
  mono = false,
  action,
  id,
}: {
  readonly label: string;
  readonly children: ReactNode;
  /** A file name rather than a plain label: quieter, monospaced. */
  readonly mono?: boolean;
  readonly action?: ReactNode;
  /** Search / deep-link target. */
  readonly id?: string;
}) {
  return (
    <div id={id} tabIndex={id ? -1 : undefined} data-slot="settings-row" className="flex items-center justify-between gap-6 px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      <span className={mono ? "shrink-0 font-mono text-xs text-muted-foreground" : "shrink-0 text-foreground"}>{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-3">
        <span className="min-w-0 wrap-anywhere text-end font-mono text-xs tabular-nums text-muted-foreground">
          {children}
        </span>
        {action}
      </span>
    </div>
  );
}

/**
 * Version, data folder, cache sizes and per-provider checks as two flat settings groups, plus a
 * redacted copy button. `footer` rows (the logs folder) are appended to the first group.
 */
export function DiagnosticsPanel({
  footer,
  onOpenFolder,
}: {
  readonly footer?: ReactNode;
  /** Adds an Open button to the data folder row. */
  readonly onOpenFolder?: () => void;
} = {}) {
  const gt = useGT();
  const hideSensitive = useSettings((s) => s.general.hideSensitive);
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [copyError, setCopyError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getDiagnostics().then(
      (next) => {
        if (!mounted.current) return;
        setReport(next);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!mounted.current) return;
        setReport(null);
        setError(cause instanceof Error ? cause.message : msg("Unknown error."));
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const copyReport = useCallback(async () => {
    if (!report) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error(msg("Clipboard API is unavailable."));
      await navigator.clipboard.writeText(formatDiagnosticsReport(report));
      setCopyState("copied");
      setCopyError(null);
    } catch (cause) {
      setCopyState("error");
      setCopyError(cause instanceof Error ? cause.message : msg("Could not copy diagnostics."));
    }
  }, [report]);

  // A provider that was never read has no result to report; listing it as "OK" would be a claim
  // nobody checked, so only providers with a probe or an error appear.
  const providers = (report?.providers ?? []).filter((p) => p.lastProbeMs != null || p.lastError);
  const caches = Object.entries(report?.cacheSizes ?? {}).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );
  const dataDir = report?.dataDir ?? "—";

  const status =
    loading && !report
      ? msg("Loading diagnostics…")
      : copyState === "copied"
        ? msg("Diagnostics copied to clipboard.")
        : copyState === "error"
          ? (copyError ?? msg("Could not copy diagnostics."))
          : "";

  return (
    <>
      {error ? (
        <Alert variant="error">
          <AlertTitle>{gt("Could not load diagnostics")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          <AlertAction>
            <Button size="compact" variant="outline" onClick={load}>
              {gt("Retry")}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <SettingsSection
        title={gt("Diagnostics")}
        description={gt("Keys and tokens are never included in the report.")}
      >
        <FactRow label={gt("Version")}>{report?.version ?? "—"}</FactRow>
        <FactRow label={gt("Platform")}>{report ? `${report.os} · ${report.arch}` : "—"}</FactRow>
        <FactRow label={gt("Uptime")}>{formatUptime(report?.uptimeSec)}</FactRow>
        <FactRow label={gt("Memory")}>{report?.memoryMB == null ? "—" : `${Math.round(report.memoryMB)} MB`}</FactRow>
        <SettingsRow
          id="advanced-copy-diagnostics"
          title={gt("Copy diagnostics")}
          description={gt("Copies a redacted report you can paste into a bug report.")}
          keywords={["report", "bug", "support", "copy"]}
          control={(descriptionProps) => (
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      onClick={load}
                      disabled={loading}
                      aria-label={gt("Refresh diagnostics")}
                    >
                      <RefreshIcon refreshing={loading} />
                    </Button>
                  }
                />
                <TooltipPopup>{gt("Refresh")}</TooltipPopup>
              </Tooltip>
              <Button {...descriptionProps} size="sm" variant="outline" onClick={copyReport} disabled={!report}>
                <CopyIcon />
                {gt("Copy")}
              </Button>
            </div>
          )}
        />
      </SettingsSection>

      <SettingsSection title={gt("Storage")} description={gt("Where Burnrate keeps its data on this computer.")}>
        <FactRow
          id="advanced-logs-folder"
          label={gt("Data folder")}
          action={
            onOpenFolder ? (
              <Button size="sm" variant="outline" onClick={onOpenFolder}>
                {gt("Open")}
              </Button>
            ) : undefined
          }
        >
          {hideSensitive ? maskHomePath(dataDir) : dataDir}
        </FactRow>
        <FactRow label={gt("Settings file")}>{formatBytes(report?.settingsSizeBytes)}</FactRow>
        {caches.map(([name, bytes]) => (
          <FactRow key={name} label={name} mono>
            {formatBytes(bytes)}
          </FactRow>
        ))}
        {footer}
      </SettingsSection>

      <SettingsSection title={gt("Provider checks")} description={gt("The result of the last attempt to read each provider.")}>
        {providers.length === 0 ? (
          <SettingsEmptyRow>{gt("Nothing has been read yet. Connect a provider and its result shows up here.")}</SettingsEmptyRow>
        ) : (
          providers.map((provider) => (
            <div key={provider.id} data-slot="settings-row" className="flex flex-col gap-0.5 px-4 py-3">
              <div className="flex items-center justify-between gap-6 text-sm">
                <span className="min-w-0 wrap-anywhere text-foreground">{providerLabel(provider.id)}</span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {formatProbeDuration(provider.lastProbeMs)}
                  </span>
                  {provider.lastError ? (
                    <Badge variant="error" size="sm">{gt("Error")}</Badge>
                  ) : (
                    <Badge variant="success" size="sm">{gt("OK")}</Badge>
                  )}
                </span>
              </div>
              {provider.lastError ? (
                <p className="wrap-anywhere font-mono text-2xs text-muted-foreground">{provider.lastError}</p>
              ) : null}
            </div>
          ))
        )}
      </SettingsSection>

      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>
    </>
  );
}
