import { EllipsisIcon, ExternalLinkIcon, KeyRoundIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { disconnectLocalLogin } from "~/api/providers";
import { importLocalKey } from "~/api/catalog";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import type { ProviderInfo } from "~/contracts";
import { useGT } from "~/i18n";
import { toast } from "~/lib/toast";
import { ProviderIcon } from "~/providers/ProviderIcon";
import { updateSettings, useSettings } from "~/settings/store";

import { DisconnectDialog } from "./DisconnectDialog";
import { ProviderRowFrame } from "./ProviderRowFrame";
import { disconnectCopy, importResultText, type PlanAction, type ProviderRowPlan } from "./rowPlan";

/**
 * One provider-level row on the Providers screen: a provider with no saved account, or a login that
 * lives outside Burnrate (Codex, OpenCode, Antigravity). It draws a `ProviderRowPlan`; the plan is the
 * single place that decides which actions a provider gets, so a status never sits there with nothing to do.
 */
export function ProviderPlanRow({
  provider,
  plan,
  status,
  tone = "muted",
  onSignIn,
  onSignInAgain,
  onAddKey,
  onLaunchCancel,
  onChanged,
}: {
  readonly provider: ProviderInfo;
  readonly plan: ProviderRowPlan;
  /** The line under the name: what Burnrate sees, in words. */
  readonly status: string;
  readonly tone?: "muted" | "error";
  readonly onSignIn: () => void;
  readonly onSignInAgain: () => void;
  readonly onAddKey: () => void;
  /** Stop waiting for an app sign-in (Antigravity); the app itself stays open. */
  readonly onLaunchCancel?: (() => void) | undefined;
  readonly onChanged: () => void;
}) {
  const gt = useGT();
  const hiddenIds = useSettings((settings) => settings.providers.hidden);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  const runImport = (action: Extract<PlanAction, { kind: "importLocal" }>) => {
    if (importing) return;
    setImporting(true);
    setError(null);
    importLocalKey(action.providerId).then(
      (result) => {
        setImporting(false);
        toast.success(importResultText(action.providerId, action.source, result, gt));
        onChanged();
      },
      (cause: unknown) => {
        setImporting(false);
        setError(cause instanceof Error ? cause.message : gt("Could not import the key."));
      },
    );
  };

  const setHidden = (hide: boolean): Promise<void> =>
    updateSettings({
      providers: {
        hidden: hide
          ? [...hiddenIds.filter((id) => id !== provider.id), provider.id]
          : hiddenIds.filter((id) => id !== provider.id),
      },
    });

  const run = (action: PlanAction) => {
    switch (action.kind) {
      case "importLocal":
        return runImport(action);
      case "signIn":
        return onSignIn();
      case "signInAgain":
        return onSignInAgain();
      case "addKey":
        return onAddKey();
      case "cancelWait":
        return onLaunchCancel?.();
      case "track":
        return void setHidden(false).catch(() => setError(gt("Could not save that. Try again.")));
      case "install":
        return undefined;
    }
  };

  const copy = plan.disconnect
    ? disconnectCopy(plan.disconnect, { providerLabel: provider.label, name: provider.label }, gt)
    : null;

  const disconnect = async () => {
    if (!plan.disconnect || !copy) return;
    switch (plan.disconnect) {
      case "codex":
        await disconnectLocalLogin("codex");
        toast.success(copy.done);
        break;
      case "opencodeLocal":
        await disconnectLocalLogin("opencode-go");
        toast.success(copy.done, {
          action: {
            label: gt("Undo"),
            onClick: () => {
              importLocalKey("opencode-go").then(onChanged, (cause: unknown) =>
                toast.error(cause instanceof Error ? cause.message : gt("Could not turn it back on.")),
              );
            },
          },
        });
        break;
      case "hide":
        await setHidden(true);
        toast.success(copy.done, {
          action: { label: gt("Undo"), onClick: () => void setHidden(false) },
        });
        break;
      default:
        return;
    }
    onChanged();
  };

  const button = (action: PlanAction, variant: "default" | "outline") => {
    const busy = action.kind === "importLocal" && importing;
    const icon = action.kind === "addKey" ? <KeyRoundIcon /> : null;
    if (action.kind === "install") {
      return (
        <Button
          key={action.kind}
          size="sm"
          variant="outline"
          render={<a href={action.url} target="_blank" rel="noreferrer" />}
        >
          {action.label}
          <ExternalLinkIcon aria-hidden />
        </Button>
      );
    }
    return (
      <Button
        key={action.kind}
        size="sm"
        variant={variant}
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => run(action)}
      >
        {busy ? <Spinner /> : icon}
        {busy ? (action.kind === "importLocal" && action.providerId === "opencode-go" ? gt("Connecting…") : gt("Importing…")) : action.label}
      </Button>
    );
  };

  const actions = (
    <>
      {plan.lead ? button(plan.lead, plan.lead.kind === "addKey" || plan.lead.kind === "install" ? "outline" : "default") : null}
      {plan.secondary ? button(plan.secondary, "outline") : null}
      {plan.mode === "connected" && plan.disconnect ? (
        <>
          <Button
            size="xs"
            variant="ghost-destructive"
            className="max-sm:hidden sm:opacity-0 sm:group-hover/row:opacity-100 sm:group-focus-within/row:opacity-100"
            data-slot="disconnect-button"
            aria-label={gt("Disconnect {name}", { name: provider.label })}
            onClick={() => setConfirmOpen(true)}
          >
            {gt("Disconnect")}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  ref={menuTriggerRef}
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label={gt("Actions for {name}", { name: provider.label })}
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {plan.menu.map((action) =>
                action.kind === "install" ? (
                  <MenuItem
                    key={action.kind}
                    render={<a href={action.url} target="_blank" rel="noreferrer" />}
                  >
                    <ExternalLinkIcon />
                    {action.label}
                  </MenuItem>
                ) : (
                  <MenuItem key={action.kind} onClick={() => run(action)}>
                    {action.kind === "addKey" ? <KeyRoundIcon /> : <RefreshCwIcon />}
                    {action.label}
                  </MenuItem>
                ),
              )}
              {plan.menu.length > 0 ? <MenuSeparator /> : null}
              <MenuItem variant="destructive" onClick={() => setConfirmOpen(true)}>
                <Trash2Icon />
                {gt("Disconnect")}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      ) : null}
    </>
  );

  const footer =
    plan.note || error !== null ? (
      <>
        {plan.note ? (
          <p className="text-xs text-muted-foreground" data-slot="provider-note">
            {plan.note}
          </p>
        ) : null}
        {error !== null ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </>
    ) : null;

  return (
    <ProviderRowFrame
      className="group/row"
      data-provider={provider.id}
      data-mode={plan.mode}
      mark={<ProviderIcon driver={provider.id} label={provider.label} className="size-5" />}
      name={<p className="truncate text-sm font-medium">{provider.label}</p>}
      status={<p data-slot="account-status">{status}</p>}
      statusTone={tone}
      actions={actions}
      footer={footer}
    >
      {copy ? (
        <DisconnectDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          copy={copy}
          onConfirm={disconnect}
          finalFocus={menuTriggerRef}
        />
      ) : null}
    </ProviderRowFrame>
  );
}
