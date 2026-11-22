import { useId, useEffect, useState } from "react";

import { CircleAlertIcon } from "lucide-react";

import { deleteSecret, listSecrets, setSecret } from "~/api/secrets";
import type { AlertSecretName } from "~/api/secrets";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useGT } from "~/i18n";

export interface ChannelSecretFieldProps {
  /** Name inside the secret store: ntfy, discord or webhook. */
  readonly name: AlertSecretName;
  readonly label: string;
  readonly placeholder?: string;
  /** Scope in the secret store; defaults to `alerts`. */
  readonly scope?: string;
  /** Inert while the notifications master switch is off. */
  readonly disabled?: boolean;
  /** Value from settings; the real state is verified against the server on mount. */
  readonly configured?: boolean;
  /** Lets the settings section keep `channels.<name>.configured` in sync. */
  readonly onConfiguredChange?: (configured: boolean) => void;
}

/**
 * Write-only field for a notification channel URL/token. The server never returns secret values,
 * so this shows only a "Set"/"Not set" badge. A saved value is cleared from the input immediately
 * and is never rendered, logged or mirrored into settings.
 */
export function ChannelSecretField({
  name,
  label,
  placeholder,
  scope = "alerts",
  disabled = false,
  configured = false,
  onConfiguredChange,
}: ChannelSecretFieldProps) {
  const gt = useGT();
  const inputId = useId();
  const statusId = useId();
  const [value, setValue] = useState("");
  const [stored, setStored] = useState(configured);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (disabled) return;
    let alive = true;
    listSecrets(scope)
      .then((all) => {
        if (!alive) return;
        const actual = all.some((secret) => secret.name === name && secret.set);
        setStored(actual);
        // The store is the truth: tell the page when its remembered flag has drifted, so a
        // dependent action (Send test) is never offered for a secret that is not there.
        if (actual !== configured) onConfiguredChange?.(actual);
      })
      .catch(() => {
        // Keep the flag from settings if the store is unreachable; the save/retry still works.
      });
    return () => {
      alive = false;
    };
  }, [disabled, name, scope]);

  const save = async () => {
    const secret = value.trim();
    if (!secret || busy || disabled) return;
    setBusy(true);
    setMessage("");
    setFailed(false);
    try {
      await setSecret(scope, name, secret);
      setValue("");
      setStored(true);
      onConfiguredChange?.(true);
      setMessage(gt("Saved. The value is write-only and cannot be viewed again."));
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : gt("Could not save the secret."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || disabled) return;
    setBusy(true);
    setMessage("");
    setFailed(false);
    setConfirmRemove(false);
    try {
      await deleteSecret(scope, name);
      setValue("");
      setStored(false);
      onConfiguredChange?.(false);
      setMessage(gt("Secret removed."));
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : gt("Could not remove the secret."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={inputId}>{label}</Label>
        <Badge variant={stored ? "success" : "secondary"} size="sm">
          {stored ? gt("Set") : gt("Not set")}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          type="password"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (failed) {
              setFailed(false);
              setMessage("");
            }
          }}
          placeholder={placeholder ?? gt("Paste a URL or token")}
          autoComplete="new-password"
          spellCheck={false}
          disabled={disabled || busy}
          aria-describedby={statusId}
          aria-invalid={failed || undefined}
          className="min-w-0 flex-1 basis-48"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
          }}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={save}
          disabled={disabled || busy || value.trim().length === 0}
        >
          {gt("Save")}
        </Button>
        {stored ? (
          <Button
            size="sm"
            variant="ghost-destructive"
            onClick={() => setConfirmRemove(true)}
            disabled={disabled || busy}
            aria-label={gt("Remove {name} secret", { name: label })}
          >
            {gt("Remove")}
          </Button>
        ) : null}
      </div>
      <p
        id={statusId}
        role={failed ? "alert" : "status"}
        className={failed ? "flex items-start gap-1 text-xs text-destructive-foreground empty:hidden" : "text-xs text-muted-foreground empty:hidden"}
      >
        {failed && message ? <CircleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" /> : null}
        {message}
      </p>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogPopup data-settings-overlay="">
          <AlertDialogHeader className="overflow-y-auto overscroll-contain scroll-py-3">
            <AlertDialogTitle>{gt("Remove the {name} secret?", { name: label })}</AlertDialogTitle>
            <AlertDialogDescription>
              {gt("The saved value is deleted from this computer and {name} alerts stop until you paste a new one.", { name: label })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{gt("Cancel")}</AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              {gt("Remove secret")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
