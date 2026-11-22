import { PlusIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { api, type Loaded } from "~/api";
import { ApiError } from "~/api/http";
import { loginClient, normalizeErrorCode } from "~/api/providers";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import type { LimitsReport, ProviderInfo } from "~/contracts";
import { T, useGT } from "~/i18n";
import { accountHealth, healthText, providerHealth, type AccountHealth } from "~/providers/health";
import { hasLocalLogsPanel } from "~/providers/localLogs";
import { describeLoginError } from "~/providers/loginFlow";
import {
  consumeAddProviderRequest,
  notifyProvidersChanged,
  onAddProviderRequested,
  onProvidersStale,
} from "~/providers/reload";

import { isAdminProvider } from "~/components/providers/agentTiles";
import { AddKeyDialog } from "~/components/providers/AddKeyDialog";
import { LocalLogsPanel } from "~/components/providers/LocalLogsPanel";
import { LoginFlowDialog } from "~/components/providers/LoginFlowDialog";
import { ProviderAccountRow } from "~/components/providers/ProviderAccountRow";
import { ProviderPlanRow } from "~/components/providers/ProviderPlanRow";
import { ProvidersSection } from "~/components/providers/ProvidersSection";
import { providerSection, type ProviderSectionId } from "~/components/providers/providerSections";
import {
  CLAUDE_PROVIDER_ID,
  isProviderConnected,
  primaryAction,
  providerLogin,
  providerSubtitle,
} from "~/components/providers/providersList";
import {
  connectedStatus,
  extraSlots,
  providerRowPlan,
  type PlanSlot,
} from "~/components/providers/rowPlan";
import { ProviderRowsSkeleton } from "~/components/skeletons/ProvidersSkeleton";
import { toast } from "~/lib/toast";
import { useSettings } from "~/settings/store";

// The wizard is only needed on demand; keep it out of the Providers first paint.
const AddProviderWizard = lazy(() => import("~/components/providers/AddProviderWizard"));

type Row =
  | {
      readonly kind: "account";
      readonly key: string;
      readonly provider: ProviderInfo;
      readonly account: { readonly id: string; readonly label: string };
      /** Claude sign-outs happen in their own folder, Codex signs its CLI out, keys are removed here. */
      readonly accountKind: "claude" | "codex" | "key";
    }
  | {
      readonly kind: "provider";
      readonly key: string;
      readonly provider: ProviderInfo;
      /** `main`: the provider itself; `import`/`local`: a second line for something else it can read. */
      readonly slot: PlanSlot;
    };

/**
 * Providers is a clean list of what is actually connected: one row per saved account, with its
 * status in words and its actions in a single `…` menu. Everything else starts from "Add provider",
 * which opens the searchable add-provider wizard (pick a provider, then sign in or paste a key).
 * Rows are grouped under visible headings: Connected, then Available, with Not found and Hidden folded.
 * Refresh belongs to the screen header, so the page repeats no refresh control.
 */
export function ProvidersPage({
  providers,
  limits,
}: {
  providers: Loaded<readonly ProviderInfo[]>;
  /** The last limits read: gives each row its live percent and shows an expired login. */
  limits?: Loaded<LimitsReport>;
}) {
  const gt = useGT();
  const hiddenIds = useSettings((settings) => settings.providers.hidden);
  const list = providers.data ?? [];
  const [wizardOpen, setWizardOpen] = useState(false);
  const [signInTarget, setSignInTarget] = useState<ProviderInfo | null>(null);
  const [keyTarget, setKeyTarget] = useState<ProviderInfo | null>(null);
  // Renewing a login that expired: Claude/Codex/... sign in again, in the account's own folder.
  const [reauth, setReauth] = useState<{
    readonly provider: ProviderInfo;
    readonly account?: { readonly id: string; readonly label: string };
  } | null>(null);
  // Replacing a key the provider no longer accepts: the same name, a new key.
  const [keyReplace, setKeyReplace] = useState<{
    readonly provider: ProviderInfo;
    readonly account: { readonly id: string; readonly label: string };
  } | null>(null);
  // Antigravity signs in inside its own app, not in a browser: the flow asks the server to open
  // it (the server owns the flow) and this page just waits for its data to be readable again.
  const [appLaunch, setAppLaunch] = useState<{ readonly provider: ProviderInfo; readonly flowId: string } | null>(null);
  // The shell passes its limits when it can; until then the page reads them itself, once, and again
  // after a sign-in (the first read of a new account lags a moment).
  const [ownLimits, setOwnLimits] = useState<LimitsReport | null>(null);
  const hasShellLimits = limits !== undefined;
  useEffect(() => {
    if (hasShellLimits) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      api.limits().then(
        (report) => {
          if (!cancelled) setOwnLimits(report);
        },
        () => undefined,
      );
    };
    read();
    const off = onProvidersStale(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(read, 1500);
    });
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      off();
    };
  }, [hasShellLimits]);
  const limitsData = limits?.data ?? ownLimits;
  const addProviderRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Another surface may have connected something while this page was not mounted.
  const reloadRef = useRef(providers.reload);
  reloadRef.current = providers.reload;
  useEffect(() => {
    reloadRef.current();
    return onProvidersStale(() => reloadRef.current());
  }, []);

  // "Add provider" from the Usage empty state or onboarding lands on the wizard.
  useEffect(() => {
    if (consumeAddProviderRequest()) setWizardOpen(true);
    return onAddProviderRequested(() => {
      if (consumeAddProviderRequest()) setWizardOpen(true);
    });
  }, []);

  const changed = () => notifyProvidersChanged();
  const changedRef = useRef(changed);
  changedRef.current = changed;

  // Antigravity has no sign-in Burnrate can run in a browser: "Sign in" opens the app itself.
  const isAppSignIn = (provider: ProviderInfo) => provider.id === "antigravity";
  const launchAppSignIn = (provider: ProviderInfo) => {
    if (appLaunch?.provider.id === provider.id) return;
    loginClient.start(provider.id).then(
      ({ flowId }) => setAppLaunch({ provider, flowId }),
      (cause: unknown) => {
        const code = cause instanceof ApiError ? normalizeErrorCode(cause.code) : null;
        if (code === "cli-not-found") {
          // The honest failure; the refreshed row offers the download page instead of a Sign in.
          toast.error(gt("{provider} is not installed on this computer.", { provider: provider.label }));
          changedRef.current();
        } else {
          toast.error(describeLoginError(code, cause instanceof Error ? cause.message : null));
        }
      },
    );
  };
  const cancelAppLaunch = () => {
    const flowId = appLaunch?.flowId;
    setAppLaunch(null);
    if (flowId) void loginClient.cancel(flowId).catch(() => undefined);
  };

  // While the app is open, watch its flow: the row shows "Signed in" once the server sees data again.
  useEffect(() => {
    if (!appLaunch) return;
    let stopped = false;
    let missed = 0;
    const flowId = appLaunch.flowId;
    const poll = async () => {
      if (document.hidden) return; // no polling while the window is hidden
      try {
        const state = await loginClient.state(flowId);
        if (stopped) return;
        missed = 0;
        if (state.state === "connected" || state.state === "failed") {
          setAppLaunch(null);
          changedRef.current();
          if (state.state === "failed") {
            toast.error(state.error ?? gt("Sign-in failed. Try again."));
          }
        } else if (state.state === "cancelled") {
          setAppLaunch(null);
        }
      } catch {
        if (stopped) return;
        missed += 1;
        if (missed >= 3) {
          setAppLaunch(null);
          toast.error(gt("Could not check the sign-in status. Start again."));
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // The flow, not the providers list, decides here; a provider refresh alone must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appLaunch]);
  // The replace-key and sign-in-again dialogs open from a menu that unmounts, so focus has nowhere to
  // go back to: put it on the account's own actions button.
  const focusRowActions = (providerId: string, accountId: string | undefined) => {
    if (!accountId) return;
    window.setTimeout(() => {
      for (const row of document.querySelectorAll<HTMLElement>("[data-providers-list] li[data-account]")) {
        if (row.dataset.provider === providerId && row.dataset.account === accountId) {
          row.querySelector<HTMLElement>("[data-row-actions]")?.focus();
        }
      }
    }, 60);
  };
  const openSettings = () => {
    window.location.hash = "#settings/providers";
  };
  const openWizard = (trigger?: HTMLElement) => {
    restoreFocusRef.current = trigger ?? addProviderRef.current;
    setWizardOpen(true);
  };

  const rows = useMemo<Row[]>(() => {
    // Anything connected comes first, then what can be signed in, then what needs a key.
    const rank = (provider: ProviderInfo): number => {
      if (provider.accounts.length > 0) return 0;
      if (isProviderConnected(provider)) return 1;
      if (primaryAction(provider).kind === "signIn") return 2;
      if (primaryAction(provider).kind === "addKey") return 3;
      return 4;
    };
    const ordered = [...list]
      .filter((provider) => !isAdminProvider(provider))
      .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
    const result: Row[] = [];
    for (const provider of ordered) {
      if (provider.accounts.length > 0) {
        for (const account of provider.accounts) {
          result.push({
            kind: "account",
            key: `${provider.id}:${account.id}`,
            provider,
            account,
            accountKind:
              provider.id === CLAUDE_PROVIDER_ID ? "claude" : provider.id === "codex" ? "codex" : "key",
          });
        }
        for (const slot of extraSlots(provider)) {
          result.push({ kind: "provider", key: `${provider.id}:${slot}`, provider, slot });
        }
      } else {
        result.push({ kind: "provider", key: provider.id, provider, slot: "main" });
      }
    }
    return result;
  }, [list]);

  // Account rows and the second lines of a connected provider are connected; a provider-level row is
  // sorted by its own state, and a hidden one waits in Hidden.
  const grouped = useMemo(() => {
    const groups: Record<ProviderSectionId, Row[]> = { connected: [], available: [], notFound: [], hidden: [] };
    for (const row of rows) {
      const section =
        row.kind === "provider" && row.slot === "main"
          ? providerSection(row.provider, hiddenIds.includes(row.provider.id))
          : "connected";
      groups[section].push(row);
    }
    return groups;
  }, [rows, hiddenIds]);

  const addProviderButton = () => (
    <Button ref={addProviderRef} size="sm" onClick={(event) => openWizard(event.currentTarget)}>
      <PlusIcon />
      <T>Add provider</T>
    </Button>
  );

  const renderRow = (row: Row) =>
    row.kind === "account" ? (
      <ProviderAccountRow
        key={row.key}
        account={row.account}
        providerId={row.provider.id}
        providerLabel={row.provider.label}
        kind={row.accountKind}
        menu
        health={accountHealth(limitsData, row.provider, row.account)}
        onReauth={
          row.accountKind === "key"
            ? undefined
            : () => setReauth({ provider: row.provider, account: row.account })
        }
        onReplaceKey={
          row.accountKind === "key"
            ? () => setKeyReplace({ provider: row.provider, account: row.account })
            : undefined
        }
        onFix={
          row.accountKind === "key"
            ? () => setKeyReplace({ provider: row.provider, account: row.account })
            : () => setReauth({ provider: row.provider, account: row.account })
        }
        onChanged={changed}
      />
    ) : (
      <ProviderRow
        key={row.key}
        provider={row.provider}
        slot={row.slot}
        hidden={hiddenIds.includes(row.provider.id)}
        health={providerHealth(limitsData, row.provider)}
        launching={appLaunch?.provider.id === row.provider.id}
        onSignIn={() =>
          isAppSignIn(row.provider) ? launchAppSignIn(row.provider) : setSignInTarget(row.provider)
        }
        onSignInAgain={() =>
          isAppSignIn(row.provider) ? launchAppSignIn(row.provider) : setReauth({ provider: row.provider })
        }
        onLaunchCancel={cancelAppLaunch}
        onAddKey={() => setKeyTarget(row.provider)}
        onChanged={changed}
      />
    );

  return (
    <div className="flex min-w-0 flex-col gap-6" data-providers-page>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="min-w-0 text-sm text-muted-foreground">
          <T>Connect an agent or add an API key to track its usage here.</T>
        </p>
        {addProviderButton()}
      </div>
      <div role="status" className="sr-only">
        {providers.loading && list.length > 0 ? gt("Refreshing providers…") : ""}
      </div>

      {providers.error ? (
        <Alert variant="error" role="alert">
          <AlertTitle>{gt("Couldn't refresh providers")}</AlertTitle>
          <AlertDescription>{providers.error}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={providers.reload} disabled={providers.loading}>
              <T>Try again</T>
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {providers.loading && list.length === 0 ? (
        <div role="status" aria-live="polite">
          <span className="sr-only">
            <T>Looking for providers on this computer…</T>
          </span>
          <ProviderRowsSkeleton />
        </div>
      ) : providers.error !== null ? null : rows.length === 0 ? (
        <div data-slot="providers-empty" className="rounded-xl border border-border bg-card px-4 py-4">
          <p className="text-sm font-medium">
            <T>No providers yet</T>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <T>Add a provider to start tracking usage on this computer.</T>
          </p>
        </div>
      ) : (
        <>
          <ProvidersSection
            id="connected"
            title={gt("Connected")}
            count={grouped.connected.length}
            emptyText={gt("Nothing connected yet. Sign in to an agent or add a key below.")}
            listSlot="connected-accounts"
          >
            {grouped.connected.map(renderRow)}
          </ProvidersSection>
          {grouped.available.length > 0 ? (
            <ProvidersSection id="available" title={gt("Available")} count={grouped.available.length}>
              {grouped.available.map(renderRow)}
            </ProvidersSection>
          ) : null}
          {grouped.notFound.length > 0 ? (
            <ProvidersSection
              id="notFound"
              title={gt("Not found on this computer")}
              count={grouped.notFound.length}
              folded
            >
              {grouped.notFound.map(renderRow)}
            </ProvidersSection>
          ) : null}
          {grouped.hidden.length > 0 ? (
            <ProvidersSection id="hidden" title={gt("Hidden")} count={grouped.hidden.length} folded>
              {grouped.hidden.map(renderRow)}
            </ProvidersSection>
          ) : null}
        </>
      )}

      {wizardOpen ? (
        <Suspense fallback={null}>
          <AddProviderWizard
            open
            onOpenChange={(open) => {
              if (!open) setWizardOpen(false);
            }}
            providers={list}
            onChanged={changed}
            onOpenSettings={openSettings}
            finalFocus={restoreFocusRef}
          />
        </Suspense>
      ) : null}

      {signInTarget ? (
        <LoginFlowDialog
          key={signInTarget.id}
          provider={signInTarget}
          open
          onOpenChange={(open) => {
            if (!open) setSignInTarget(null);
          }}
          onConnected={changed}
          onRecheck={changed}
          usedNames={signInTarget.accounts.map((account) => account.label)}
        />
      ) : null}

      {keyTarget ? (
        <AddKeyDialog
          provider={keyTarget}
          open
          onOpenChange={(open) => {
            if (!open) setKeyTarget(null);
          }}
          onSaved={() => {
            setKeyTarget(null);
            changed();
          }}
        />
      ) : null}

      {reauth ? (
        <LoginFlowDialog
          key={`${reauth.provider.id}:reauth:${reauth.account?.id ?? "main"}`}
          provider={reauth.provider}
          open
          signInAgain={{
            // The account's folder name: `claude-acc2` lives in `~/.claude-acc2`, the main `claude` in `~/.claude`.
            name: reauth.account?.id.startsWith("claude-") ? reauth.account.id.slice("claude-".length) : undefined,
            label: reauth.account?.label,
            accountId: reauth.account?.id,
          }}
          onOpenChange={(open) => {
            if (!open) {
              focusRowActions(reauth.provider.id, reauth.account?.id);
              setReauth(null);
            }
          }}
          onConnected={changed}
          onRecheck={changed}
        />
      ) : null}

      {keyReplace ? (
        <AddKeyDialog
          // Every other name stays taken; this account's own name is reused on purpose.
          provider={{
            ...keyReplace.provider,
            accounts: keyReplace.provider.accounts.filter((account) => account.id !== keyReplace.account.id),
          }}
          open
          replacing
          initialName={keyReplace.account.id}
          onOpenChange={(open) => {
            if (!open) {
              focusRowActions(keyReplace.provider.id, keyReplace.account.id);
              setKeyReplace(null);
            }
          }}
          onSaved={() => {
            toast.success(gt("Replaced the {provider} key.", { provider: keyReplace.provider.label }));
            focusRowActions(keyReplace.provider.id, keyReplace.account.id);
            setKeyReplace(null);
            changed();
          }}
        />
      ) : null}
    </div>
  );
}

/** A provider-level row: its status in words and the actions its plan allows (see `rowPlan.ts`). */
function ProviderRow({
  provider,
  slot,
  hidden,
  health,
  launching,
  onSignIn,
  onSignInAgain,
  onLaunchCancel,
  onAddKey,
  onChanged,
}: {
  readonly provider: ProviderInfo;
  readonly slot: PlanSlot;
  readonly hidden: boolean;
  readonly health: AccountHealth;
  /** An app sign-in is running for this provider: the row says so and offers Cancel. */
  readonly launching: boolean;
  readonly onSignIn: () => void;
  readonly onSignInAgain: () => void;
  readonly onLaunchCancel: () => void;
  readonly onAddKey: () => void;
  readonly onChanged: () => void;
}) {
  const gt = useGT();
  // Pi and Muse Code have no sign-in and no quota: their whole row is what their local files say,
  // plus the folder actions that work (open, add in Settings, stop tracking).
  if (slot === "main" && hasLocalLogsPanel(provider)) {
    return <LocalLogsPanel provider={provider} hidden={hidden} onChanged={onChanged} />;
  }
  const connected = isProviderConnected(provider);
  const expired = slot === "main" && connected && health.kind === "expired" && providerLogin(provider) !== null;
  let plan = providerRowPlan(provider, { hidden, expired, slot }, gt);
  const live = connected && slot === "main" ? healthText(health, gt) : null;
  let status: string;
  if (slot === "import") {
    status = gt("Another key is waiting in {source}.", { source: plan.lead?.kind === "importLocal" ? plan.lead.source : provider.label });
  } else if (slot === "local") {
    status = gt("Also using your OpenCode login");
  } else if (plan.mode === "hidden") {
    status = gt("Not tracked");
  } else if (expired) {
    status = gt("Sign-in expired");
  } else if (plan.mode === "connected") {
    const base = connectedStatus(provider, gt);
    status = live ? `${base} · ${live}` : base;
  } else if (plan.mode === "idle" && provider.auth === "localLogs" && plan.note) {
    // Nothing to click: the one explanatory line is the status.
    status = plan.note;
    plan = { ...plan, note: null };
  } else {
    status = providerSubtitle(provider, gt);
  }
  // Waiting for the user to sign in inside the provider's own app: say so, and offer a way out.
  if (launching) {
    status = gt("Waiting for {provider}… open it and sign in", { provider: provider.label });
    plan = { ...plan, lead: { kind: "cancelWait", label: gt("Cancel") }, secondary: null, note: null };
  }
  const bad = expired || (plan.mode === "connected" && slot === "main" && health.kind === "error");
  return (
    <ProviderPlanRow
      provider={provider}
      plan={plan}
      status={status}
      tone={bad && !launching ? "error" : "muted"}
      onSignIn={onSignIn}
      onSignInAgain={onSignInAgain}
      onLaunchCancel={onLaunchCancel}
      onAddKey={onAddKey}
      onChanged={onChanged}
    />
  );
}
