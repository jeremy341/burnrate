import { CheckIcon, EllipsisIcon, KeyRoundIcon, PencilIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { api } from "~/api";
import { disconnectLocalLogin } from "~/api/providers";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Input } from "~/components/ui/input";
import type { ProviderAccount } from "~/contracts";
import { T, useGT } from "~/i18n";
import { ProviderIcon } from "~/providers/ProviderIcon";
import { healthText, type AccountHealth } from "~/providers/health";
import { toast } from "~/lib/toast";

import { DisconnectDialog } from "./DisconnectDialog";
import { ProviderRowFrame } from "./ProviderRowFrame";
import { accountDisconnectKind, disconnectCopy } from "./rowPlan";

export interface ProviderAccountRowProps {
  readonly account: ProviderAccount;
  readonly providerId: string;
  /** Claude and the Codex ChatGPT login are logins, not keys: both actions go through their own files. */
  readonly kind: "claude" | "codex" | "key";
  readonly onChanged: () => void;
  /** The Providers screen keeps its rows calm: actions live in one `…` menu, not three buttons. */
  readonly menu?: boolean | undefined;
  /** Offered in the menu for Claude accounts, which can re-run their CLI sign-in. */
  readonly onReauth?: (() => void) | undefined;
  /** What the last limits read says: shows the live percent, or the expired-login state. */
  readonly health?: AccountHealth | undefined;
  /** Offered in the menu for key accounts: swap in a new key under the same name. */
  readonly onReplaceKey?: (() => void) | undefined;
  /** The one fix for an expired login (sign in again, or replace the key). Shown on the row itself. */
  readonly onFix?: (() => void) | undefined;
  /** Name shown with the icon on the Providers screen. */
  readonly providerLabel?: string | undefined;
}

/** One saved account line, with rename and a confirmed remove/sign-out action.
 * The `menu` variant groups those actions behind a single `…` button for the Providers screen. */
export function ProviderAccountRow({
  account,
  providerId,
  kind,
  onChanged,
  menu = false,
  onReauth,
  onReplaceKey,
  health,
  onFix,
  providerLabel,
}: ProviderAccountRowProps) {
  const gt = useGT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Guard against Enter + blur firing two saves, and let Escape cancel without saving on blur.
  const renameBusyRef = useRef(false);
  const cancelRenameRef = useRef(false);
  const editRowRef = useRef<HTMLLIElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  // In menu mode one trigger serves both "return focus after rename" and "return focus after remove".
  const setMenuTriggerRef = (node: HTMLButtonElement | null) => {
    renameButtonRef.current = node;
    removeButtonRef.current = node;
  };
  const returnToRenameRef = useRef(false);
  const name = account.label;

  useEffect(() => {
    setDraft(account.label);
  }, [account.label]);

  useLayoutEffect(() => {
    if (editing || !returnToRenameRef.current) return;
    returnToRenameRef.current = false;
    renameButtonRef.current?.focus();
  }, [editing]);

  const stopEditing = (returnFocus: boolean) => {
    returnToRenameRef.current = returnFocus;
    setEditing(false);
    setDraft(account.label);
  };

  const saveRename = async (returnFocus: boolean) => {
    if (renameBusyRef.current || cancelRenameRef.current) return;
    const next = draft.trim();
    // A discovered account (Claude, Codex) can go back to its own name by saving an empty one;
    // a key always needs one.
    if ((!next && kind === "key") || next === account.label) {
      stopEditing(returnFocus);
      return;
    }
    renameBusyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (kind === "key") await api.renameKey(providerId, account.id, next);
      else await api.setAccountName(providerId, account.id, next);
      cancelRenameRef.current = false;
      stopEditing(returnFocus && editRowRef.current?.contains(document.activeElement) === true);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not rename the account."));
    } finally {
      renameBusyRef.current = false;
      setBusy(false);
    }
  };

  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveRename(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelRenameRef.current = true;
      stopEditing(true);
    }
  };

  // Throws on failure: the confirmation dialog keeps the message where the user asked for the action.
  const remove = async () => {
    setBusy(true);
    try {
      if (kind === "claude") await api.claudeSignOut(account.id);
      // The Codex row disconnects the way the provider-level row does: it signs the CLI out.
      else if (kind === "codex") await disconnectLocalLogin("codex");
      else await api.removeKey(providerId, account.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const copy = disconnectCopy(
    accountDisconnectKind(providerId),
    { providerLabel: providerLabel ?? providerId, name, accountId: account.id },
    gt,
  );
  const actionLabel =
    kind === "claude"
      ? gt("Sign out of {name}", { name })
      : kind === "codex"
        ? gt("Disconnect {name}", { name })
        : gt("Remove {name}", { name });
  const expired = health?.kind === "expired";
  const liveText = health ? healthText(health, gt) : null;
  // Logins (Claude, Codex) share their words; a row that is just a key keeps the key words.
  const statusText = expired
    ? kind === "key"
      ? gt("Key not accepted")
      : gt("Sign-in expired")
    : (liveText ?? (kind === "key" ? gt("Key saved") : gt("Signed in")));
  const statusTone = expired || health?.kind === "error" ? "error" : "muted";
  const fixLabel = kind === "key" ? gt("Replace key") : gt("Sign in again");
  const accountLine = providerLabel ? `${providerLabel} · ${statusText}` : statusText;

  const fix =
    expired && onFix ? (
      <Button size="sm" onClick={onFix} aria-label={`${fixLabel}: ${name}`}>
        {fixLabel}
      </Button>
    ) : null;

  const renameInput = (
    <Input
      aria-label={gt("Name for {name}", { name })}
      size="sm"
      value={draft}
      maxLength={64}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onRenameKeyDown}
      className="min-w-0 max-w-56 flex-1"
    />
  );

  const renameActions = (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Save name for {name}", { name })}
              disabled={busy || (kind === "key" && !draft.trim())}
              onClick={() => void saveRename(true)}
            />
          }
        >
          <CheckIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">{gt("Save name")}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Cancel rename for {name}", { name })}
              onClick={() => {
                cancelRenameRef.current = true;
                stopEditing(true);
              }}
            />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">{gt("Cancel")}</TooltipPopup>
      </Tooltip>
    </>
  );

  const menuActions = (
    <>
      {fix}
      <Button
        size="xs"
        variant="ghost-destructive"
        className="max-sm:hidden sm:opacity-0 sm:group-hover/row:opacity-100 sm:group-focus-within/row:opacity-100"
        data-slot="disconnect-button"
        aria-label={gt("Disconnect {name}", { name })}
        onClick={() => {
          setError(null);
          setConfirmOpen(true);
        }}
      >
        {gt("Disconnect")}
      </Button>
      <Menu>
        <MenuTrigger
          render={
            <Button
              ref={setMenuTriggerRef}
              size="icon-sm"
              variant="ghost-muted"
              aria-label={gt("Actions for {name}", { name })}
              data-row-actions
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem
            onClick={() => {
              cancelRenameRef.current = false;
              setError(null);
              setEditing(true);
            }}
          >
            <PencilIcon />
            <T>Rename</T>
          </MenuItem>
          {kind !== "key" && onReauth ? (
            <MenuItem onClick={onReauth}>
              <RefreshCwIcon />
              <T>Sign in again</T>
            </MenuItem>
          ) : null}
          {kind === "key" && onReplaceKey ? (
            <MenuItem onClick={onReplaceKey}>
              <KeyRoundIcon />
              <T>Replace key</T>
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem
            variant="destructive"
            onClick={() => {
              setError(null);
              setConfirmOpen(true);
            }}
          >
            <Trash2Icon />
            <T>Disconnect</T>
          </MenuItem>
        </MenuPopup>
      </Menu>
    </>
  );

  const inlineActions = (
    <>
      {fix}
      {kind === "key" || kind === "claude" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                ref={renameButtonRef}
                variant="ghost-muted"
                aria-label={gt("Rename {name}", { name })}
                onClick={() => {
                  cancelRenameRef.current = false;
                  setError(null);
                  setEditing(true);
                }}
              />
            }
          >
            <PencilIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">{gt("Rename")}</TooltipPopup>
        </Tooltip>
      ) : null}
      <Button
        size="xs"
        ref={removeButtonRef}
        variant="ghost-destructive"
        aria-label={actionLabel}
        onClick={() => {
          setError(null);
          setConfirmOpen(true);
        }}
      >
        {kind === "claude" ? <T>Sign out</T> : kind === "codex" ? <T>Disconnect</T> : <T>Remove</T>}
      </Button>
    </>
  );

  return (
    <ProviderRowFrame
      ref={editRowRef}
      className="group/row"
      data-account={account.id}
      data-provider={providerId}
      data-health={health?.kind}
      onBlur={(event) => {
        if (!editing || event.currentTarget.contains(event.relatedTarget)) return;
        void saveRename(false);
      }}
      mark={<ProviderIcon driver={providerId} label={providerLabel ?? providerId} className="size-5" />}
      name={editing ? renameInput : <p className="truncate text-sm font-medium">{name}</p>}
      status={editing ? undefined : <p className="truncate" data-slot="account-status">{accountLine}</p>}
      statusTone={statusTone}
      actions={editing ? renameActions : menu ? menuActions : inlineActions}
      footer={
        error !== null ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null
      }
    >
      <DisconnectDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        copy={copy}
        onConfirm={async () => {
          await remove();
          toast.success(copy.done);
        }}
        finalFocus={removeButtonRef}
      />
    </ProviderRowFrame>
  );
}
