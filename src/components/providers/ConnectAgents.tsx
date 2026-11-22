import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "~/api";
import { Button } from "~/components/ui/button";
import type { ProviderInfo } from "~/contracts";
import { T, useGT } from "~/i18n";
import { cn } from "~/lib/utils";
import { ProviderIcon } from "~/providers/ProviderIcon";
import { notifyProvidersChanged, onProvidersStale, requestAddProvider } from "~/providers/reload";

import { agentDotTone } from "./agentTiles";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { LoginFlowDialog } from "./LoginFlowDialog";
import { claudeUsedNames } from "./providerWizard";
import { detectedAgentsToConnect, providerSubtitle, shouldOfferConnect } from "./providersList";

/** The provider list for surfaces outside the Providers screen. Reloads when something connects. */
export function useProviderList(): {
  readonly providers: readonly ProviderInfo[] | null;
  readonly error: boolean;
  readonly reload: () => void;
} {
  const [providers, setProviders] = useState<readonly ProviderInfo[] | null>(null);
  const [error, setError] = useState(false);
  const generationRef = useRef(0);
  const reload = useCallback(() => {
    const generation = ++generationRef.current;
    api.providers().then(
      (list) => {
        if (generation !== generationRef.current) return;
        setProviders(list);
        setError(false);
      },
      () => {
        if (generation === generationRef.current) setError(true);
      },
    );
  }, []);
  useEffect(() => {
    reload();
    const off = onProvidersStale(reload);
    return () => {
      generationRef.current += 1;
      off();
    };
  }, [reload]);
  return { providers, error, reload };
}

/** One agent found on this computer, with its one-click Connect. */
export function ConnectAgentRow({
  provider,
  onConnect,
}: {
  readonly provider: ProviderInfo;
  readonly onConnect: () => void;
}) {
  const gt = useGT();
  const label = gt("Connect {provider}", { provider: provider.label });
  return (
    <li className="min-w-0" data-provider={provider.id}>
      <button
        type="button"
        aria-label={label}
        onClick={onConnect}
        className={cn(
          "group flex min-h-18 w-full items-center gap-3 rounded-lg border border-border/70 bg-card/40 px-3 py-2.5 text-start transition-colors hover:bg-muted/30 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <ProviderIcon
          driver={provider.id}
          label={provider.label}
          className="size-8 shrink-0 rounded-md border border-border/70 bg-card p-1"
        />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">{provider.label}</span>
          <span className="truncate text-xs text-muted-foreground">{providerSubtitle(provider, gt)}</span>
        </span>
        <ConnectionStatusDot tone={agentDotTone(provider)} label={label} />
      </button>
    </li>
  );
}

/**
 * Agents installed on this computer that are not connected yet, each with Connect, plus Add
 * provider. Shows nothing when every agent found is already connected. Used by the Usage empty
 * state and the onboarding dialog, which open no wizard of their own.
 */
export function ConnectAgents({
  providers,
  onConnected,
  onRecheck,
  onAddProvider,
  onFinished,
  variant = "card",
}: {
  readonly providers: readonly ProviderInfo[];
  readonly onConnected: () => void;
  readonly onRecheck?: () => void;
  readonly onAddProvider?: () => void;
  /** The sign-in dialog was closed after connecting: the caller can move on (the tour goes to its last screen). */
  readonly onFinished?: () => void;
  readonly variant?: "card" | "plain";
}) {
  const gt = useGT();
  const [targetId, setTargetId] = useState<string | null>(null);
  const connectedRef = useRef(false);
  const toConnect = detectedAgentsToConnect(providers);
  const target = targetId ? providers.find((provider) => provider.id === targetId) : undefined;

  // Everything detected is already connected: there is nothing to offer.
  if (!shouldOfferConnect(providers)) return null;

  const addProvider = () => {
    onAddProvider?.();
    requestAddProvider();
  };

  const content = (
    <>
      <div className="grid gap-1">
        {variant === "card" ? (
          <h2 className="text-sm font-medium">
            <T>Connect an agent</T>
          </h2>
        ) : null}
        {/* The tour already says what Burnrate does; only the card (Usage empty state) needs the sentence. */}
        {variant === "card" || toConnect.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {toConnect.length > 0
              ? gt("Burnrate found these on this computer. Connect one to see its limits and usage.")
              : gt(
                  "Burnrate did not find Claude Code or Codex on this computer. Install one, or add a provider with an API key.",
                )}
          </p>
        ) : null}
      </div>
      {toConnect.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label={gt("Agents found on this computer")}>
          {toConnect.map((provider) => (
            <ConnectAgentRow key={provider.id} provider={provider} onConnect={() => setTargetId(provider.id)} />
          ))}
        </ul>
      ) : null}
      <div>
        <Button size="sm" variant="outline" onClick={addProvider}>
          <PlusIcon />
          <T>Add provider</T>
        </Button>
      </div>
      {target ? (
        <LoginFlowDialog
          key={target.id}
          provider={target}
          open
          onOpenChange={(open) => {
            if (open) return;
            setTargetId(null);
            if (connectedRef.current) {
              connectedRef.current = false;
              onFinished?.();
            }
          }}
          onConnected={() => {
            connectedRef.current = true;
            onConnected();
            notifyProvidersChanged();
          }}
          onRecheck={onRecheck ?? onConnected}
          usedNames={claudeUsedNames(target)}
        />
      ) : null}
    </>
  );

  return variant === "card" ? (
    <section
      className="flex flex-col gap-3 rounded-xl border bg-card/20 p-4 sm:p-5"
      data-slot="connect-agents"
    >
      {content}
    </section>
  ) : (
    <div className="flex flex-col gap-3" data-slot="connect-agents">
      {content}
    </div>
  );
}
