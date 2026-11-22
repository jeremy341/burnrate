import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import { useId, useState } from "react";

import { importLocalKey } from "~/api/catalog";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import type { ProviderInfo } from "~/contracts";
import { T, useGT } from "~/i18n";
import { cn } from "~/lib/utils";
import { ProviderIcon } from "~/providers/ProviderIcon";

import {
  accountPickerAddsKey,
  accountPickerLabels,
  agentAddedLabel,
  agentAddedState,
  agentDotTone,
  agentSignInLinks,
  explicitAgentAction,
  hasAccountPicker,
  isAdminProvider,
  requiresExplicitConnect,
} from "./agentTiles";
import { AddKeyDialog } from "./AddKeyDialog";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { LoginFlowDialog } from "./LoginFlowDialog";
import { ProviderAccountRow } from "./ProviderAccountRow";
import { claudeUsedNames } from "./providerWizard";
import { CLAUDE_PROVIDER_ID, providerLogin, providerSubtitle } from "./providersList";

/**
 * The single panel shown after a tile is chosen in "Choose an agent". Every connection starts with
 * an explicit click here. No effect in this component starts a flow on mount, so OpenCode Go can
 * never auto-connect.
 */
export function AgentConnectPanel({
  provider,
  onConnected,
  onRecheck,
  onOpenSettings,
  onBack,
  className,
}: {
  readonly provider: ProviderInfo;
  readonly onConnected: () => void;
  readonly onRecheck: () => void;
  readonly onOpenSettings: () => void;
  readonly onBack?: (() => void) | undefined;
  readonly className?: string | undefined;
}) {
  const gt = useGT();
  const accountHeadingId = useId();
  const [loginTarget, setLoginTarget] = useState<{ readonly addAccount: boolean } | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);

  const action = explicitAgentAction(provider);
  const links = agentSignInLinks(provider, action);
  const login = providerLogin(provider);
  const added = agentAddedLabel(agentAddedState(provider));
  const dotLabel = added ? `${provider.label} — ${added}` : `${provider.label} — ${gt("Not connected")}`;
  const picker = hasAccountPicker(provider) ? accountPickerLabels(provider) : null;
  const addsKey = accountPickerAddsKey(provider);
  const admin = isAdminProvider(provider);
  // A connected provider with nothing left to do shows only its accounts, not a "Connect" block.
  const showConnect = admin || action.kind !== "none";

  const importLocal = () => {
    if (importing) return;
    setImporting(true);
    setImportError(null);
    importLocalKey(provider.id === "opencode-go" ? "opencode-go" : "mistral").then(
      (result) => {
        setImporting(false);
        if (result.summary) setImportNote(gt("Connected: {summary}.", { summary: result.summary }));
        done();
      },
      (error: unknown) => {
        setImporting(false);
        setImportError(error instanceof Error ? error.message : gt("Could not import the key."));
      },
    );
  };

  const done = () => {
    setLoginTarget(null);
    setKeyOpen(false);
    onConnected();
  };

  return (
    <div className={cn("grid gap-4", className)} data-slot="agent-connect-panel" data-provider={provider.id} data-auto-connect="false">
      <div className="flex items-start gap-3">
        {onBack ? (
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={gt("Back to agents")}
            onClick={onBack}
          >
            <ArrowLeftIcon />
          </Button>
        ) : null}
        <ProviderIcon
          driver={provider.id}
          label={provider.label}
          className="size-9 shrink-0 rounded-lg border border-border/70 bg-card p-1.5"
          accent={provider.color}
        />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{provider.label}</span>
            {added ? (
              <span className="shrink-0 text-2xs text-muted-foreground">{added}</span>
            ) : null}
            <ConnectionStatusDot tone={agentDotTone(provider)} label={dotLabel} className="ms-auto" />
          </div>
          <p className="text-xs text-muted-foreground">{providerSubtitle(provider, gt)}</p>
        </div>
      </div>

      {showConnect ? (
      <div className="grid gap-2 rounded-lg border border-border/70 bg-card/40 p-3" data-slot="agent-connect-action">
        <p className="text-sm font-medium">{gt("Connect {provider}", { provider: provider.label })}</p>

        {admin ? (
          <>
            <p className="text-xs text-muted-foreground">
              <T>
                An organization admin key reads workspace-wide API spend. Personal usage does not
                need one; connect the agent with its own sign-in instead.
              </T>
            </p>
            <Button size="sm" variant="outline" className="w-fit" onClick={onOpenSettings}>
              <T>Open provider setup</T>
            </Button>
          </>
        ) : null}

        {action.kind === "signIn" ? (
          <>
            <p className="text-xs text-muted-foreground">
              {provider.id === "antigravity" ? (
                gt(
                  "Sign in happens inside the Antigravity app. Choosing Sign in opens it; Burnrate starts reading once you have used it.",
                )
              ) : (
                <T>
                  Burnrate runs the agent&apos;s own sign-in on this computer. Nothing starts until you
                  choose Sign in.
                </T>
              )}
            </p>
            <Button size="sm" className="w-fit" onClick={() => setLoginTarget({ addAccount: false })}>
              {action.label}
            </Button>
          </>
        ) : null}

        {action.kind === "importLocal" ? (
          <>
            <p className="text-xs text-muted-foreground">
              {provider.id === "opencode-go" ? (
                gt("OpenCode is on this computer. Use its login and Burnrate reads your Go plan limits with the key OpenCode already holds. Nothing is read until you choose. OpenCode's own usage and cost need no setup.")
              ) : (
                <T>
                  {gt("{source} is signed in on this computer. Importing copies the key it holds into Burnrate, after Mistral accepts it. Nothing is read until you choose Import.", { source: action.source })}
                </T>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="w-fit" disabled={importing} aria-busy={importing} onClick={importLocal}>
                {importing
                  ? provider.id === "opencode-go" ? gt("Connecting…") : gt("Importing…")
                  : provider.id === "opencode-go" ? gt("Use my local OpenCode login") : action.label}
              </Button>
              <Button size="sm" variant="outline" className="w-fit" onClick={() => setKeyOpen(true)}>
                {provider.id === "opencode-go" ? gt("Paste Go key") : <T>Add key</T>}
              </Button>
              {provider.id === "opencode-go" && provider.keyUrl && /^https:\/\//i.test(provider.keyUrl) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-fit"
                  render={<a href={provider.keyUrl} target="_blank" rel="noreferrer" />}
                >
                  {gt("Get a Go key")}
                  <ExternalLinkIcon aria-hidden />
                </Button>
              ) : null}
            </div>
            {importNote ? (
              <p role="status" className="text-xs text-success-foreground">{importNote}</p>
            ) : null}
            {importError ? (
              <Alert variant="error" role="alert">
                <AlertDescription>{importError}</AlertDescription>
              </Alert>
            ) : null}
          </>
        ) : null}

        {action.kind === "addKey" ? (
          <>
            <p className="text-xs text-muted-foreground">
              <T>Add a key to read this provider&apos;s quota on this computer.</T>
            </p>
            <Button size="sm" variant="outline" className="w-fit" onClick={() => setKeyOpen(true)}>
              {action.label}
            </Button>
          </>
        ) : null}

        {action.kind === "install" ? (
          <>
            <p className="text-xs text-muted-foreground">
              <T>Install the agent on this computer, then check again.</T>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                render={<a href={action.url} target="_blank" rel="noreferrer" />}
              >
                {action.label}
                <ExternalLinkIcon />
              </Button>
              <Button size="sm" variant="ghost-muted" onClick={onRecheck}>
                <T>Check again</T>
              </Button>
            </div>
          </>
        ) : null}

        {action.kind === "providerLink" ? (
          <>
            <p className="text-xs text-muted-foreground" data-slot={requiresExplicitConnect(provider) ? "opencode-go-explicit" : undefined}>
              {requiresExplicitConnect(provider) ? (
                <T>Sign in on the website, copy your Go key, then paste it with Add key. Burnrate never connects on its own.</T>
              ) : (
                <T>Open the provider&apos;s page to get a key, then paste it with Add key.</T>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setKeyOpen(true)}>
                <T>Add key</T>
              </Button>
              <Button
                size="sm"
                variant="outline"
                render={<a href={action.url} target="_blank" rel="noreferrer" />}
              >
                {action.label}
                <ExternalLinkIcon />
              </Button>
            </div>
          </>
        ) : null}

        {action.kind === "none" && !admin ? (
          <p className="text-xs text-muted-foreground">
            <T>This agent is connected. Manage its accounts or keys below.</T>
          </p>
        ) : null}

        {login && !login.installed && action.kind !== "install" && !admin ? (
          <Alert variant="warning">
            <AlertDescription>
              <T>{gt("{command} is not installed on this computer.", { command: login.command })}</T>
            </AlertDescription>
          </Alert>
        ) : null}

        {links.openBrowserUrl ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-2">
            <a
              href={links.openBrowserUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground underline underline-offset-4"
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
              <T>Open browser</T>
            </a>
          </div>
        ) : null}
      </div>
      ) : null}

      {picker ? (
        <section className="grid gap-2" aria-labelledby={accountHeadingId}>
          <h3 id={accountHeadingId} className="text-sm font-medium">
            {picker.heading}
          </h3>
          <ul className="grid gap-1.5">
            {provider.accounts.map((account) => addsKey || provider.id === CLAUDE_PROVIDER_ID ? (
              <ProviderAccountRow
                key={account.id}
                account={account}
                providerId={provider.id}
                kind={addsKey ? "key" : "claude"}
                onChanged={onRecheck}
              />
            ) : (
              <li
                key={account.id}
                className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-sm"
              >
                <ConnectionStatusDot tone="ready" label={gt("{account} connected", { account: account.label })} />
                <span className="min-w-0 truncate">{account.label}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{picker.help}</p>
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            onClick={() => (addsKey ? setKeyOpen(true) : setLoginTarget({ addAccount: true }))}
          >
            {picker.add}
          </Button>
        </section>
      ) : null}

      {loginTarget ? (
        <LoginFlowDialog
          key={`${provider.id}:${loginTarget.addAccount ? "add" : "first"}`}
          provider={provider}
          open
          onOpenChange={(open) => {
            if (!open) setLoginTarget(null);
          }}
          onConnected={done}
          onRecheck={onRecheck}
          askName={loginTarget.addAccount && provider.id === "claudeAgent"}
          usedNames={claudeUsedNames(provider)}
        />
      ) : null}
      {keyOpen ? (
        <AddKeyDialog
          provider={provider}
          open
          onOpenChange={(open) => {
            if (!open) setKeyOpen(false);
          }}
          onSaved={done}
        />
      ) : null}
    </div>
  );
}
