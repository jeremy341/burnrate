import { useState } from "react";

import { importLocalKey } from "~/api/catalog";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import type { ProviderInfo } from "~/contracts";
import { useGT } from "~/i18n";
import { toast } from "~/lib/toast";

import { providerRowPlan, importResultText } from "./rowPlan";

/**
 * The one-click import in the Add provider wizard: "Import from Mistral Vibe" (or OpenCode's Go key)
 * leads, pasting a key stays below it. Nothing is read until the click, and the result is the real
 * answer: the saved account, or the server's own reason it could not.
 */
export function LocalImportCard({
  provider,
  onImported,
}: {
  readonly provider: ProviderInfo;
  /** The import worked: refresh the list and close the wizard. */
  readonly onImported: () => void;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = providerRowPlan(provider, {}, gt).lead;
  if (action?.kind !== "importLocal") return null;

  const run = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    importLocalKey(action.providerId).then(
      (result) => {
        setBusy(false);
        toast.success(importResultText(action.providerId, action.source, result, gt));
        onImported();
      },
      (cause: unknown) => {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : gt("Could not import the key."));
      },
    );
  };

  return (
    <div className="grid gap-2 rounded-xl border border-border bg-card px-4 py-3" data-slot="local-import">
      <p className="text-sm text-muted-foreground">
        {action.providerId === "opencode-go"
          ? gt("OpenCode is on this computer. Use its login and Burnrate reads your Go plan limits with the key OpenCode already holds.")
          : gt("{source} is on this computer. Import its key in one click, after Mistral accepts it. Mistral has no browser sign-in.", { source: action.source })}
      </p>
      <div>
        <Button size="sm" disabled={busy} aria-busy={busy || undefined} onClick={run}>
          {busy ? <Spinner /> : null}
          {busy ? (action.providerId === "opencode-go" ? gt("Connecting…") : gt("Importing…")) : action.label}
        </Button>
      </div>
      {error ? (
        <Alert variant="error" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
