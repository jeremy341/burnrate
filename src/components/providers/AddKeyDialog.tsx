import { CircleAlertIcon, CircleCheckIcon, ExternalLinkIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { api, humanMessage } from "~/api";
import type { ProviderInfo } from "~/contracts";
import { T, useGT, Var } from "~/i18n";
import { ProviderIcon } from "~/providers/ProviderIcon";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";
import {
  type AddKeyDraft,
  type AddKeyIssues,
  initialKeyName,
  validateAddKeyDraft,
} from "./addKeyDialog.logic";

interface TestResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Mounted by the providers page per open, so every open starts from a fresh draft.
 *
 * `inline` renders only the form and its actions, for the "Add provider" wizard's authentication
 * step (`docs/CONTRACTS.md` section 14); the default rendering is the dialog used elsewhere.
 */
export function AddKeyDialog({
  provider,
  open,
  onOpenChange,
  onSaved,
  inline = false,
  inlineActionsTarget,
  initialName,
  hideNameField = false,
  replacing = false,
  secondary = false,
}: {
  readonly provider: ProviderInfo;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: () => void;
  /** Render the authentication form inside another surface (the add-provider wizard). */
  readonly inline?: boolean;
  readonly inlineActionsTarget?: HTMLElement | null;
  /** Prefilled account name (the wizard's step 2), or undefined to suggest one. */
  readonly initialName?: string | undefined;
  /** The wizard already collected the name, so the step shows only the key field. */
  readonly hideNameField?: boolean;
  /** Swap the key of an account the provider stopped accepting: same name, new key. */
  readonly replacing?: boolean;
  /** Another button on the same surface leads (the one-click import): Save key is the quieter one. */
  readonly secondary?: boolean;
}) {
  const gt = useGT();
  const formId = useId();
  const nameId = `${formId}-name`;
  const keyId = `${formId}-key`;
  const keyUrl = provider.keyUrl && /^https:\/\//i.test(provider.keyUrl) ? provider.keyUrl : null;
  const suggestedName = () => initialName ?? initialKeyName(provider);
  // The first key needs no name: it is just "the key". A second one asks, so the two can be told apart.
  const nameHidden = hideNameField || replacing || provider.accounts.length === 0;
  const [draft, setDraft] = useState<AddKeyDraft>(() => ({
    name: suggestedName(),
    apiKey: "",
  }));
  const [showKey, setShowKey] = useState(false);
  const [touched, setTouched] = useState<{ readonly name?: boolean; readonly apiKey?: boolean }>({});
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The provider turned the key down once: the next Save is an explicit "save anyway".
  const [rejected, setRejected] = useState(false);
  // A close while a request is in flight must not apply its result to a later open.
  const pendingRef = useRef(0);
  const keyInputRef = useRef<HTMLInputElement>(null);

  // The key is the first thing to type. An effect, because the wizard moves focus to its panel
  // after the step mounts and would undo a plain autoFocus.
  useEffect(() => {
    if (open) keyInputRef.current?.focus();
  }, [open]);
  // The field is disabled while the key is checked, which drops focus: bring it back on a rejection.
  useEffect(() => {
    if (rejected) keyInputRef.current?.focus();
  }, [rejected]);

  // The wizard's step 2 can change the name while this form is mounted; keep the hidden field in
  // sync without overwriting an edit the user made inside the visible name field.
  useEffect(() => {
    if (initialName === undefined) return;
    setDraft((current) =>
      current.name === initialName ? current : { ...current, name: initialName },
    );
  }, [initialName]);

  const validation = validateAddKeyDraft(draft, provider);
  const issues: AddKeyIssues = validation.ok ? {} : validation.issues;
  const nameError = touched.name ? issues.name : undefined;
  const keyError = touched.apiKey ? issues.apiKey : undefined;
  const canSave = validation.ok && busy === null;

  const update = (patch: Partial<AddKeyDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    // A different key deserves a fresh check.
    if (patch.apiKey !== undefined) {
      setRejected(false);
      setTestResult(null);
    }
  };

  const reset = () => {
    setDraft({ name: suggestedName(), apiKey: "" });
    setShowKey(false);
    setTouched({});
    setBusy(null);
    setTestResult(null);
    setSaveError(null);
    setRejected(false);
  };

  const close = () => {
    pendingRef.current += 1;
    reset();
    onOpenChange(false);
  };

  const save = async () => {
    if (!validation.ok || busy !== null) {
      setTouched({ name: true, apiKey: true });
      return;
    }
    const token = pendingRef.current;
    const { name, apiKey } = validation.value;
    setSaveError(null);
    try {
      // Check the key with the provider first, so a typo is caught here and not an hour later as
      // "Key not accepted". A check that cannot run (offline) does not block saving.
      if (!rejected) {
        setBusy("test");
        setTestResult(null);
        const verdict = await api.testKey(provider.id, apiKey).catch(() => null);
        if (token !== pendingRef.current) return;
        if (verdict && !verdict.ok) {
          setTestResult({
            ok: false,
            message: verdict.error?.trim()
              ? humanMessage(verdict.error.trim())
              : gt("The key was rejected. Check it and try again."),
          });
          setRejected(true);
          return;
        }
      }
      setBusy("save");
      await api.saveKey(provider.id, name, apiKey);
      // The key was saved even if Esc/overlay dismissed the dialog while the request was in
      // flight: always refresh the account list so the new account shows up.
      onSaved();
      if (token !== pendingRef.current) return;
      reset();
      onOpenChange(false);
    } catch {
      if (token === pendingRef.current) {
        setSaveError(gt("Could not save the account. Try again."));
      }
    } finally {
      if (token === pendingRef.current) setBusy(null);
    }
  };

  const form = (
    <form
      id={formId}
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {nameHidden ? null : (
        <div className="grid gap-1.5">
          <Label htmlFor={nameId}>
            <T>Account name</T>
          </Label>
          <Input
            id={nameId}
            value={draft.name}
            onChange={(event) => update({ name: event.target.value })}
            onBlur={() => setTouched((current) => ({ ...current, name: true }))}
            maxLength={64}
            placeholder={gt("e.g. Personal or Work")}
            disabled={busy !== null}
            spellCheck={false}
            aria-invalid={nameError !== undefined}
            aria-describedby={nameError !== undefined ? `${nameId}-error` : undefined}
          />
          {nameError !== undefined ? (
            <p id={`${nameId}-error`} role="alert" className="text-xs text-destructive-foreground">
              {nameError}
            </p>
          ) : null}
        </div>
      )}
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={keyId}>
            <T>API key</T>
          </Label>
          {keyUrl ? (
            <a
              href={keyUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-sm text-xs text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              <T>Open the page to get your key</T>
              <ExternalLinkIcon className="size-3" aria-hidden />
            </a>
          ) : null}
        </div>
        <div className="relative">
          <Input
            id={keyId}
            ref={keyInputRef}
            className="[&>input]:pe-10 [&>input::-ms-reveal]:hidden"
            type={showKey ? "text" : "password"}
            value={draft.apiKey}
            onChange={(event) => update({ apiKey: event.target.value })}
            onBlur={() => setTouched((current) => ({ ...current, apiKey: true }))}
            placeholder={gt("Paste your API key")}
            autoComplete="new-password"
            spellCheck={false}
            disabled={busy !== null}
            aria-invalid={keyError !== undefined}
            aria-describedby={keyError !== undefined ? `${keyId}-error` : undefined}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute end-1 top-1/2 -translate-y-1/2"
            aria-label={showKey ? gt("Hide API key") : gt("Show API key")}
            aria-pressed={showKey}
            onClick={() => setShowKey((current) => !current)}
            disabled={busy !== null}
          >
            {showKey ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        </div>
        {keyError !== undefined ? (
          <p id={`${keyId}-error`} role="alert" className="text-xs text-destructive-foreground">
            {keyError}
          </p>
        ) : null}
        {nameHidden && issues.name !== undefined ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {issues.name}
          </p>
        ) : null}
      </div>
      {testResult !== null ? (
        <Alert
          variant={testResult.ok ? "success" : "error"}
          role="status"
          aria-live="polite"
          className="break-words"
        >
          {testResult.ok ? <CircleCheckIcon /> : <CircleAlertIcon />}
          <AlertTitle>{testResult.ok ? gt("Key works") : gt("The provider did not accept this key")}</AlertTitle>
          <AlertDescription>{testResult.message}</AlertDescription>
        </Alert>
      ) : null}
      {saveError !== null ? (
        <Alert variant="error" role="alert">
          <CircleAlertIcon />
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-xs text-muted-foreground">
        <T>Stored encrypted on this computer. Never shown again after saving.</T>
      </p>
    </form>
  );

  const actions = (
    <>
      {inline ? null : (
        <Button variant="ghost" onClick={close} disabled={busy !== null}>
          <T>Cancel</T>
        </Button>
      )}
      <Button type="submit" form={formId} disabled={!canSave} variant={rejected || secondary ? "outline" : "default"}>
        {busy !== null ? <Spinner /> : null}
        {busy === "test"
          ? gt("Checking key…")
          : busy === "save"
            ? gt("Saving…")
            : rejected
              ? gt("Save anyway")
              : gt("Save key")}
      </Button>
    </>
  );

  if (inline) {
    return (
      <div className="grid gap-4" data-slot="add-key-panel">
        {form}
        {inlineActionsTarget === undefined
          ? <DialogFooter variant="bare">{actions}</DialogFooter>
          : inlineActionsTarget && createPortal(actions, inlineActionsTarget)}
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(next);
      }}
    >
      <DialogPopup
        className="max-w-md"
        data-provider-dialog
        initialFocus={(type) => (type === "touch" ? true : keyInputRef.current)}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ProviderIcon driver={provider.id} label={provider.label} iconClassName="size-5" />
            <DialogTitle>
              {replacing
                ? gt("Replace {provider} key", { provider: provider.label })
                : gt("Add {provider} key", { provider: provider.label })}
            </DialogTitle>
          </div>
          <DialogDescription>
            {replacing ? (
              <T>
                Paste a new key for <Var>{provider.label}</Var>. It is checked first, then replaces
                the saved key. The old key is never shown.
              </T>
            ) : (
              <T>
                Add an API key for <Var>{provider.label}</Var>. It is used to read this provider's
                quota on this computer.
              </T>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[min(60dvh,32rem)] overflow-y-auto">{form}</DialogPanel>
        <DialogFooter>{actions}</DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
