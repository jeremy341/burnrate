import { useState, type RefObject } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { T, useGT } from "~/i18n";

import type { DisconnectCopy } from "./rowPlan";

/**
 * The one confirmation for every Disconnect on the Providers screen. The words come from
 * `disconnectCopy` so each provider says exactly what changes. A failure stays in the dialog, where
 * the user asked for the action; success closes it and the caller shows the toast.
 */
export function DisconnectDialog({
  open,
  onOpenChange,
  copy,
  onConfirm,
  finalFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly copy: DisconnectCopy;
  /** Does the disconnect; a thrown error is shown in the dialog. */
  readonly onConfirm: () => Promise<void>;
  /** The element that opened the dialog, so focus returns there. */
  readonly finalFocus?: RefObject<HTMLElement | null> | undefined;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Could not disconnect. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <AlertDialogPopup finalFocus={finalFocus} data-slot="disconnect-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
          {copy.warning ? (
            <p className="text-sm font-medium text-destructive-foreground">{copy.warning}</p>
          ) : null}
        </AlertDialogHeader>
        {error !== null ? (
          <p role="alert" className="px-6 pb-2 text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />} disabled={busy}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy} aria-busy={busy}>
            {busy ? <Spinner /> : null}
            {copy.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
