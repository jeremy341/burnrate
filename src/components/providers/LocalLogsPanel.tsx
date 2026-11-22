import { FolderOpenIcon, FolderPlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import type { ProviderInfo } from "~/contracts";
import { useGT } from "~/i18n";
import { toast } from "~/lib/toast";
import {
  addFolderDeepLink,
  localStats,
  localStatusLine,
  openLocalDataFolder,
  withHidden,
} from "~/providers/localLogs";
import { ProviderIcon } from "~/providers/ProviderIcon";
import { updateSettings, useSettings } from "~/settings/store";

import { ProviderRowFrame } from "./ProviderRowFrame";

/**
 * The row of a local-log provider (Pi, Muse Code): one honest status line measured from the
 * provider's own session files on this computer, plus the actions that actually work on them —
 * open the data folder, add a folder in Settings > Providers > Local sources, or stop tracking.
 * No quota is invented: these agents have none Burnrate could verify.
 */
export function LocalLogsPanel({
  provider,
  hidden,
  onChanged,
}: {
  readonly provider: ProviderInfo;
  readonly hidden?: boolean | undefined;
  readonly onChanged?: (() => void) | undefined;
}) {
  const gt = useGT();
  const hiddenIds = useSettings((settings) => settings.providers.hidden);
  const isHidden = hidden ?? hiddenIds.includes(provider.id);
  const stats = localStats(provider);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setHidden = (hide: boolean): Promise<void> =>
    updateSettings({ providers: { hidden: withHidden(hiddenIds, provider.id, hide) } }).then(() => {
      onChanged?.();
    });

  const openFolder = () => {
    if (opening) return;
    setOpening(true);
    setError(null);
    openLocalDataFolder(provider.id).then(
      () => setOpening(false),
      (cause: unknown) => {
        setOpening(false);
        setError(cause instanceof Error ? cause.message : gt("Could not open the data folder."));
      },
    );
  };

  const stopTracking = () => {
    setError(null);
    void setHidden(true)
      .then(() =>
        toast.success(gt("Stopped tracking {provider}.", { provider: provider.label }), {
          action: { label: gt("Undo"), onClick: () => void setHidden(false) },
        }),
      )
      .catch(() => setError(gt("Could not save that. Try again.")));
  };

  const trackAgain = () => {
    setError(null);
    void setHidden(false).catch(() => setError(gt("Could not save that. Try again.")));
  };

  return (
    <ProviderRowFrame
      className="group/row"
      data-provider={provider.id}
      data-slot="local-logs-panel"
      data-mode={isHidden ? "hidden" : "idle"}
      mark={<ProviderIcon driver={provider.id} label={provider.label} className="size-5" />}
      name={<p className="truncate text-sm font-medium">{provider.label}</p>}
      status={
        <p className="text-xs text-muted-foreground" data-slot="local-logs-status">
          {localStatusLine(provider, { hidden: isHidden }, gt)}
        </p>
      }
      actions={
        <>
          {stats ? (
            <Button
              size="sm"
              variant="outline"
              disabled={opening}
              aria-busy={opening || undefined}
              onClick={openFolder}
            >
              {opening ? <Spinner /> : <FolderOpenIcon />}
              {gt("Open data folder")}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" render={<a href={addFolderDeepLink(provider.id)} />}>
            <FolderPlusIcon />
            {gt("Add folder")}
          </Button>
          {isHidden ? (
            <Button size="sm" onClick={trackAgain}>
              {gt("Track again")}
            </Button>
          ) : (
            <Button size="sm" variant="ghost-muted" onClick={stopTracking}>
              {gt("Stop tracking")}
            </Button>
          )}
        </>
      }
      footer={
        error !== null ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null
      }
    />
  );
}
