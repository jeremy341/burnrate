import { CheckIcon, CircleCheckIcon, CopyIcon, ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import type { LoginClient } from "~/api/providers";
import { Alert, AlertDescription } from "~/components/ui/alert";
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
import type { ProviderInfo } from "~/contracts";
import { T, useGT } from "~/i18n";
import { healthText } from "~/providers/health";
import { isActiveStatus, isHttpsUrl, useLoginFlow } from "~/providers/loginFlow";
import { ProviderIcon } from "~/providers/ProviderIcon";
import { claudeAccountForName, useLiveHealth } from "~/providers/useLiveHealth";

import { CLAUDE_PROVIDER_ID, providerLogin } from "./providersList";

export interface LoginFlowDialogProps {
  readonly provider: ProviderInfo;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Reload the provider list after the CLI reports a connected account. */
  readonly onConnected: () => void;
  /** The CLI was missing and the user says they installed it: re-read the provider list. */
  readonly onRecheck?: () => void;
  /** Ask for an account name first (adding a second Claude account). */
  readonly askName?: boolean;
  /** Account names already taken (ids with the `claude-` prefix removed). */
  readonly usedNames?: readonly string[];
  /** Render the flow inside another surface (the add-provider wizard) instead of a dialog. */
  readonly inline?: boolean;
  readonly inlineActionsTarget?: HTMLElement | null;
  /** A name collected earlier (the wizard's step 2). */
  readonly initialName?: string | undefined;
  /**
   * Renew a login that already exists (it expired). Starts with `force` and, for Claude, in the
   * account's own folder: `name` is its folder name, none for the main `~/.claude` login.
   */
  readonly signInAgain?: {
    readonly name?: string | undefined;
    readonly label?: string | undefined;
    /** The account's id in the provider list, to find its limits afterwards. */
    readonly accountId?: string | undefined;
  };
  /** Test/preview hook: a client other than the app's. */
  readonly client?: LoginClient;
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Same rule as the server: 1-64 safe characters, not ending with a dot, not only dots. */
export function isValidAccountName(value: string): boolean {
  return NAME_PATTERN.test(value) && !value.endsWith(".") && !/^\.+$/.test(value);
}

/** "main", then "main-2", "main-3" … skipping names already used. */
export function suggestLoginName(usedNames: readonly string[]): string {
  const used = new Set(usedNames.map((name) => name.trim().toLowerCase()));
  if (!used.has("main")) return "main";
  let n = 2;
  while (used.has(`main-${n}`)) n += 1;
  return `main-${n}`;
}

/**
 * The sign-in every agent shares (Claude, Codex, ...): the CLI does the real login, the server
 * proxies its state, and this shows progress, the fallback link, an optional paste-code field,
 * and a clear way out when it fails or the CLI is not installed.
 */
export function LoginFlowDialog({
  provider,
  open,
  onOpenChange,
  onConnected,
  onRecheck,
  askName = false,
  usedNames = [],
  inline = false,
  inlineActionsTarget,
  initialName,
  signInAgain,
  client,
}: LoginFlowDialogProps) {
  const gt = useGT();
  const nameInputId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const codeInputId = useId();
  const login = providerLogin(provider);
  const needsName = provider.id === CLAUDE_PROVIDER_ID;
  const again = signInAgain !== undefined;
  // The first Claude account needs no name: it signs in to `~/.claude`, the folder the claude CLI itself uses.
  const firstClaudeAccount = needsName && usedNames.length === 0;
  const nameStep = needsName && askName && initialName === undefined && !again && !firstClaudeAccount;
  const [name, setName] = useState(() => initialName ?? suggestLoginName(usedNames));
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);

  const { snapshot, controller } = useLoginFlow(provider.id, {
    enabled: open,
    onConnected,
    ...(client ? { client } : {}),
  });
  const { status } = snapshot;
  const active = isActiveStatus(status);
  const installed = login?.installed ?? true;
  const trimmedName = name.trim();
  const nameInvalid = nameStep && trimmedName.length > 0 && !isValidAccountName(trimmedName);
  const canStart = installed && (!nameStep || isValidAccountName(trimmedName));

  const startName = !needsName
    ? undefined
    : again
      ? signInAgain.name
      : nameStep
        ? trimmedName
        : (initialName ?? (firstClaudeAccount ? undefined : suggestLoginName(usedNames)));
  // Which account this sign-in is for, fixed when it starts: the provider list changes once it connects.
  const [started, setStarted] = useState<{ readonly id: string; readonly label: string } | undefined>();
  const startFlow = () => {
    if (needsName) {
      setStarted(
        again
          ? { id: signInAgain.accountId ?? "claude", label: signInAgain.label ?? "claude" }
          : startName === undefined
            ? { id: "claude", label: "claude" }
            : claudeAccountForName(startName),
      );
    }
    return controller.start(startName, again);
  };

  // What the account reads now, so "connected" shows a real number instead of a bare tick.
  const live = useLiveHealth(status === "connected", { provider, account: started });
  const liveLine = live ? healthText(live, gt) : null;
  // Without a name to ask for, opening the dialog is the click: start straight away. The timer
  // lets StrictMode's throwaway first mount be cleaned up before a request goes out.
  useEffect(() => {
    if (!open || nameStep || !installed) return;
    const timer = window.setTimeout(() => void startFlow(), 0);
    return () => window.clearTimeout(timer);
    // The name is only read at the moment the flow starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, nameStep, installed, controller]);

  useEffect(() => {
    if (open) {
      setCode("");
      setCopied(false);
    }
  }, [open]);

  // Land in the name field with the suggestion selected, so typing replaces it and Enter signs in.
  // An effect (not autoFocus): the wizard moves focus to its panel after the step mounts.
  const askingName = open && nameStep && status === "idle";
  useEffect(() => {
    if (!askingName) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [askingName]);

  const safeUrl = isHttpsUrl(snapshot.url) ? snapshot.url : null;
  const providerLabel = provider.label;
  // Antigravity signs in inside its own app window, not in the browser.
  const opensApp = provider.id === "antigravity";

  const retry = () => {
    controller.reset();
    setCode("");
    setCopied(false);
    if (!nameStep) void startFlow();
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    void controller.submitCode(code).then(() => setCode(""));
  };

  const copyLink = async () => {
    if (!safeUrl) return;
    try {
      await navigator.clipboard.writeText(safeUrl);
      setCopied(true);
    } catch {
      /* clipboard blocked: the link is still selectable on screen */
    }
  };

  const close = () => onOpenChange(false);
  const cancelAndClose = () => {
    void controller.cancel().finally(close);
  };

  const installPanel = (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertDescription className="grid gap-2">
        <span>
          {gt("{provider} is not installed on this computer. Install {command}, then check again.", {
            provider: providerLabel,
            command: login?.command ?? providerLabel,
          })}
        </span>
        <span className="flex flex-wrap gap-2">
          {login && isHttpsUrl(login.installUrl) ? (
            <Button
              size="xs"
              variant="outline"
              render={<a href={login.installUrl} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon />
              <T>How to install</T>
            </Button>
          ) : null}
          {onRecheck ? (
            <Button size="xs" variant="ghost" onClick={onRecheck}>
              <T>Check again</T>
            </Button>
          ) : null}
        </span>
      </AlertDescription>
    </Alert>
  );

  const body = (
    <>
      {!installed ? (
        installPanel
      ) : status === "idle" && nameStep ? (
        <div className="grid gap-1.5">
          <Label htmlFor={nameInputId}>
            <T>Account name</T>
          </Label>
          <Input
            id={nameInputId}
            ref={nameInputRef}
            value={name}
            maxLength={64}
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canStart) {
                event.preventDefault();
                void startFlow();
              }
            }}
            aria-invalid={nameInvalid}
            aria-describedby={`${nameInputId}-help`}
          />
          <p
            id={`${nameInputId}-help`}
            className={nameInvalid ? "text-xs text-destructive-foreground" : "text-xs text-muted-foreground"}
          >
            {nameInvalid ? (
              <T>Use 1-64 letters, digits, _ . or -; do not end with a dot.</T>
            ) : (
              <T>A short name to tell your accounts apart, for example "work" or "personal".</T>
            )}
          </p>
        </div>
      ) : (
        <div role="status" aria-live="polite" className="grid gap-3">
          {active ? (
            <div className="flex items-start gap-2.5 text-sm">
              <Spinner size="md" tone="muted" className="mt-0.5" />
              <div className="grid gap-0.5">
                <span className="font-medium">
                  {snapshot.url
                    ? gt("Finish signing in in your browser")
                    : opensApp
                      ? gt("Opening Antigravity…")
                      : gt("Opening your browser…")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {snapshot.url
                    ? gt("This window updates by itself when you are done.")
                    : gt("Starting sign-in…")}
                </span>
              </div>
            </div>
          ) : status === "connected" ? (
            <div className="flex items-start gap-2.5 text-sm">
              <CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
              <div className="grid gap-0.5">
                <span className="font-medium">{gt("{provider} is connected.", { provider: providerLabel })}</span>
                {liveLine ? (
                  <span className="text-xs text-muted-foreground" data-slot="login-live-status">
                    {liveLine}
                  </span>
                ) : live === null ? (
                  <span className="text-xs text-muted-foreground">
                    <T>Reading your limits…</T>
                  </span>
                ) : null}
              </div>
            </div>
          ) : status === "cancelled" ? (
            <p className="text-sm text-muted-foreground">
              <T>Sign-in cancelled.</T>
            </p>
          ) : null}
        </div>
      )}

      {snapshot.url && active ? (
        <div className="grid gap-2 border-t border-border pt-4">
          <p className="text-xs text-muted-foreground">
            <T>If the page did not open, use this link.</T>
          </p>
          {safeUrl ? (
            <a
              href={safeUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-start gap-1.5 break-all text-xs text-primary underline underline-offset-2"
            >
              <ExternalLinkIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {safeUrl}
            </a>
          ) : (
            <span className="break-all text-xs text-muted-foreground">{snapshot.url}</span>
          )}
          <Button size="xs" variant="outline" className="w-fit" onClick={() => void copyLink()} disabled={!safeUrl}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            <T>{copied ? "Copied" : "Copy link"}</T>
          </Button>
        </div>
      ) : null}

      {active ? (
        <form className="grid gap-1.5" onSubmit={submitCode}>
          <Label htmlFor={codeInputId}>
            <T>Got a code to paste? (optional)</T>
          </Label>
          <div className="flex gap-2">
            <Input
              id={codeInputId}
              value={code}
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              onChange={(event) => setCode(event.target.value)}
              placeholder={gt("Paste the code from the page")}
              aria-invalid={snapshot.codeError !== null}
              aria-describedby={snapshot.codeError ? `${codeInputId}-error` : undefined}
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={!code.trim() || snapshot.submittingCode}
            >
              <T>Send</T>
            </Button>
          </div>
          {snapshot.codeError ? (
            <p id={`${codeInputId}-error`} role="alert" className="text-xs text-destructive-foreground">
              {snapshot.codeError}
            </p>
          ) : null}
        </form>
      ) : null}

      {status === "failed" ? (
        snapshot.errorCode === "cli-not-found" ? (
          installPanel
        ) : (
          <Alert variant="error" role="alert">
            <TriangleAlertIcon />
            <AlertDescription>{snapshot.error}</AlertDescription>
          </Alert>
        )
      ) : null}
    </>
  );

  const actions = (
    <>
      {status === "connected" ? (
        <Button onClick={close} autoFocus>
          <T>Done</T>
        </Button>
      ) : (
        <>
          {inline ? null : (
            <Button variant="ghost" onClick={active ? cancelAndClose : close}>
              <T>Cancel</T>
            </Button>
          )}
          {status === "failed" || status === "cancelled" ? (
            <Button onClick={retry}>
              <T>Try again</T>
            </Button>
          ) : status === "idle" && nameStep ? (
            <Button onClick={() => void startFlow()} disabled={!canStart}>
              <T>Sign in</T>
            </Button>
          ) : inline && active ? (
            <Button variant="ghost" onClick={() => void controller.cancel()}>
              <T>Cancel</T>
            </Button>
          ) : null}
        </>
      )}
    </>
  );

  if (inline) {
    return (
      <div className="grid gap-4" data-slot="login-flow-panel">
        {body}
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
        if (!next) cancelAndClose();
        else onOpenChange(next);
      }}
    >
      <DialogPopup
        className="sm:max-w-md"
        data-provider-dialog
        initialFocus={(type) => (type === "touch" ? true : nameInputRef.current ?? true)}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ProviderIcon driver={provider.id} label={provider.label} iconClassName="size-5" />
            <DialogTitle>
              {again
                ? gt("Sign in to {provider} again", { provider: providerLabel })
                : gt("Connect {provider}", { provider: providerLabel })}
            </DialogTitle>
          </div>
          <DialogDescription>
            {opensApp
              ? gt("Opens the Antigravity app: sign in inside it. Your credentials stay on this computer.")
              : again
                ? gt("Opens your browser to renew the sign-in. Your usage history stays.")
                : gt("Opens your browser to sign in. Your credentials stay on this computer.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[min(60dvh,32rem)] space-y-4 overflow-y-auto">{body}</DialogPanel>
        <DialogFooter>{actions}</DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
