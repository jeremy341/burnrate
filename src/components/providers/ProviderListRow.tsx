import {
  ChevronDownIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  EyeOffIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
} from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { ProviderInfo } from "~/contracts";
import { T, useGT } from "~/i18n";
import { cn } from "~/lib/utils";
import { ProviderIcon } from "~/providers/ProviderIcon";

import { ProviderAccountRow } from "./ProviderAccountRow";
import {
  CLAUDE_PROVIDER_ID,
  canAddAccount,
  primaryAction,
  providerStatus,
  providerSubtitle,
  type ProviderStatus,
} from "./providersList";

function StatusChip({ status }: { readonly status: ProviderStatus }) {
  switch (status) {
    case "connected":
      return (
        <Badge variant="success" size="sm">
          <T>Connected</T>
        </Badge>
      );
    case "needsSignIn":
      return (
        <Badge variant="warning" size="sm">
          <T>Needs sign-in</T>
        </Badge>
      );
    case "notInstalled":
      return (
        <Badge variant="outline" size="sm">
          <T>Not installed</T>
        </Badge>
      );
    default:
      return null;
  }
}

/**
 * One compact Providers row: icon, name, status chip and one line of what Burnrate sees, then the
 * single action that moves it forward (Sign in, Add key, Install). Saved accounts expand inline.
 */
export function ProviderListRow({
  provider,
  accent,
  expanded,
  onToggle,
  onChanged,
  onAddKey,
  onSignIn,
  onRefresh,
  onOpenSettings,
  onHide,
}: {
  readonly provider: ProviderInfo;
  readonly accent?: string | undefined;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onChanged: () => void;
  readonly onAddKey: () => void;
  /** `addAccount` asks for a name first (a second Claude account); otherwise one click signs in. */
  readonly onSignIn: (options: { readonly addAccount: boolean }) => void;
  readonly onRefresh: () => void;
  readonly onOpenSettings: () => void;
  readonly onHide: () => void;
}) {
  const gt = useGT();
  const status = providerStatus(provider);
  const action = primaryAction(provider);
  const more = canAddAccount(provider);
  const isClaude = provider.id === CLAUDE_PROVIDER_ID;
  const hasAccounts = provider.accounts.length > 0;
  const panelId = `provider-accounts-${provider.id}`;
  const accountsLabel = gt("Accounts for {provider}", { provider: provider.label });
  const actionsLabel = gt("Actions for {provider}", { provider: provider.label });

  return (
    <li className="border-b last:border-b-0" data-provider={provider.id} data-status={status}>
      <div className="flex items-center gap-2.5 py-2.5 ps-3 pe-2">
        <ProviderIcon driver={provider.id} label={provider.label} className="size-6 shrink-0" accent={accent} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate text-sm font-medium">{provider.label}</span>
            <StatusChip status={status} />
          </div>
          <p className="truncate text-xs text-muted-foreground">{providerSubtitle(provider, gt)}</p>
        </div>

        {action.kind === "signIn" ? (
          <Button size="sm" onClick={() => onSignIn({ addAccount: false })}>
            <T>Sign in</T>
          </Button>
        ) : action.kind === "addKey" ? (
          <Button size="sm" variant="outline" onClick={onAddKey}>
            <PlusIcon />
            <T>Add key</T>
          </Button>
        ) : action.kind === "install" ? (
          <Button size="sm" variant="outline" render={<a href={action.url} target="_blank" rel="noreferrer" />}>
            <T>Install</T>
            <ExternalLinkIcon />
          </Button>
        ) : null}

        {hasAccounts ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  aria-label={accountsLabel}
                  onClick={onToggle}
                />
              }
            >
              <ChevronDownIcon
                className={cn("transition-transform motion-reduce:transition-none", expanded && "rotate-180")}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">{accountsLabel}</TooltipPopup>
          </Tooltip>
        ) : null}

        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={<Button size="icon-sm" variant="ghost-muted" aria-label={actionsLabel} />}
                />
              }
            >
              <EllipsisIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">{actionsLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            {more === "signIn" ? (
              <MenuItem onClick={() => onSignIn({ addAccount: true })}>
                <PlusIcon />
                <T>Add another account</T>
              </MenuItem>
            ) : null}
            {more === "addKey" && hasAccounts ? (
              <MenuItem onClick={onAddKey}>
                <PlusIcon />
                <T>Add another key</T>
              </MenuItem>
            ) : null}
            <MenuItem onClick={onRefresh}>
              <RefreshCwIcon />
              <T>Refresh</T>
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={onOpenSettings}>
              <SettingsIcon />
              <T>Provider settings</T>
            </MenuItem>
            <MenuItem onClick={onHide}>
              <EyeOffIcon />
              <T>Hide provider</T>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      {hasAccounts ? (
        <ul id={panelId} hidden={!expanded} className="flex flex-col gap-1.5 pb-3 ps-3 pe-3 sm:ps-12">
          {expanded ? provider.accounts.map((account) => (
            <ProviderAccountRow
              key={account.id}
              account={account}
              providerId={provider.id}
              kind={isClaude ? "claude" : "key"}
              onChanged={onChanged}
            />
          )) : null}
        </ul>
      ) : null}
    </li>
  );
}
