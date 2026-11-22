import {
  ActivityIcon,
  CheckIcon,
  CommandIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  Settings2Icon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, humanMessage } from "~/api";
import { ConnectAgents } from "~/components/providers/ConnectAgents";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import {
  useWizardStepFocus,
  WizardFooter,
  WizardHeader,
  WizardPanel,
  WizardPopup,
} from "~/components/ui/wizard";
import type { ProviderInfo } from "~/contracts";
import { T, useGT } from "~/i18n";
import { dispatchPaletteAction } from "~/palette/actions";
import { healthText } from "~/providers/health";
import { ProviderIcon } from "~/providers/ProviderIcon";
import { useLiveHealth } from "~/providers/useLiveHealth";

import { clampStep, detectAgents, ONBOARDING_STEPS, tourLandingView, type OnboardingStep } from "./logic";

/** Screen 1: a short hello plus the agents found on this machine, each with a one-click Connect. */
function WelcomeStep({
  providers,
  reload,
  onAddProvider,
  onConnectedDone,
}: {
  readonly providers: readonly ProviderInfo[];
  readonly reload: () => void;
  readonly onAddProvider: () => void;
  readonly onConnectedDone: () => void;
}) {
  const gt = useGT();
  const { connected } = detectAgents(providers);
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        <T>
          Burnrate reads the limits from the agents already on this computer. Connect one to see
          its usage — everything stays local.
        </T>
      </p>
      {connected.length > 0 ? (
        <ul className="grid gap-2" aria-label={gt("Connected agents")}>
          {connected.map((provider) => (
            <li
              key={provider.id}
              className="flex min-h-10 items-center gap-3 rounded-lg border bg-card/40 px-3"
            >
              <ProviderIcon
                driver={provider.id}
                label={provider.label}
                className="size-7 shrink-0 rounded-md border border-border/70 bg-card p-1"
                iconClassName="size-4"
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{provider.label}</span>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
                <CheckIcon className="size-3.5" aria-hidden />
                <T>Connected</T>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <ConnectAgents
        providers={providers}
        onConnected={reload}
        onRecheck={reload}
        onAddProvider={onAddProvider}
        onFinished={onConnectedDone}
        variant="plain"
      />
    </div>
  );
}

/** One connected agent with what it reads right now: the first real number, before the tour even ends. */
function ConnectedLine({ provider }: { readonly provider: ProviderInfo }) {
  const gt = useGT();
  const health = useLiveHealth(true, { provider });
  const text = health ? healthText(health, gt) : null;
  return (
    <li className="flex min-h-10 items-center gap-3 rounded-lg border bg-card/40 px-3" data-slot="tour-connected">
      <ProviderIcon
        driver={provider.id}
        label={provider.label}
        className="size-7 shrink-0 rounded-md border border-border/70 bg-card p-1"
        iconClassName="size-4"
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{provider.label}</span>
      <span
        className={`shrink-0 text-xs ${health?.kind === "expired" ? "text-destructive-foreground" : "text-muted-foreground"}`}
      >
        {health === null ? gt("Reading your limits…") : (text ?? gt("Connected"))}
      </span>
    </li>
  );
}

/** Screen 2: what is connected (with a live number), then a tiny map of where everything lives. */
function DoneStep({ connected }: { readonly connected: readonly ProviderInfo[] }) {
  const gt = useGT();
  const places = [
    { icon: LayoutDashboardIcon, name: gt("Usage"), hint: gt("Limits, burn rate and history in one place.") },
    { icon: ActivityIcon, name: gt("Limits"), hint: gt("How close each account is to its limit.") },
    { icon: KeyRoundIcon, name: gt("Providers"), hint: gt("Connect more agents or add an API key.") },
    { icon: Settings2Icon, name: gt("Settings"), hint: gt("The gear opens every preference.") },
    { icon: CommandIcon, name: gt("Command palette"), hint: gt("Ctrl+K (Cmd+K on Mac) reaches anything.") },
  ];
  return (
    <div className="grid gap-4">
      {connected.length > 0 ? (
        <ul className="grid gap-2" aria-label={gt("Connected agents")}>
          {connected.map((provider) => (
            <ConnectedLine key={provider.id} provider={provider} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          <T>Nothing is connected yet. You can connect an agent any time from Providers.</T>
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        <T>Here's where everything lives.</T>
      </p>
      <ul className="grid gap-1">
        {places.map(({ icon: Icon, name, hint }) => (
          <li key={name} className="flex min-h-10 items-center gap-3 rounded-lg px-2">
            <span
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"
              aria-hidden
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{name}</span>
              <span className="block text-xs text-muted-foreground">{hint}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** First-run welcome tour: Welcome, Done. Closing it any way counts as done. */
export function OnboardingDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const gt = useGT();
  const [step, setStep] = useState<OnboardingStep>(0);
  const [providers, setProviders] = useState<readonly ProviderInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const panelRef = useWizardStepFocus(step);
  const actionRef = useRef<HTMLButtonElement>(null);

  const reload = useCallback(() => {
    const request = ++requestRef.current;
    setLoading(true);
    setLoadError(null);
    api.providers().then(
      (list) => {
        if (request !== requestRef.current) return;
        setProviders(list);
        setLoading(false);
      },
      (error: unknown) => {
        if (request !== requestRef.current) return;
        setLoading(false);
        setLoadError(humanMessage(error instanceof Error ? error.message : String(error)));
      },
    );
  }, []);
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setLoadError(null);
    reload();
    return () => {
      requestRef.current += 1;
    };
  }, [open, reload]);

  const labels = ONBOARDING_STEPS.map((label) => gt(label));
  const last = step === ONBOARDING_STEPS.length - 1;

  const { connected } = detectAgents(providers);
  const anyConnected = connected.length > 0;
  // Land where the next thing to do is: the limits when something is connected, Providers when not.
  const finish = () => {
    onClose();
    dispatchPaletteAction({ type: "switchView", viewId: tourLandingView(anyConnected) });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <WizardPopup
        size="default"
        data-setup-tour
        initialFocus={(type) => (type === "touch" ? true : actionRef.current)}
        finalFocus={() => {
          const active = document.activeElement;
          return active === document.body
            ? document.querySelector<HTMLElement>('[data-slot="app-palette"]') ?? true
            : true;
        }}
      >
        <WizardHeader
          title={gt("Welcome to Burnrate")}
          description={<T>A quick tour, then you're on your way.</T>}
        />
        <WizardPanel ref={panelRef} role="group" aria-label={labels[step]}>
          <div role="status" className="sr-only">{loading ? gt("Checking for installed agents…") : ""}</div>
          {loadError ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-sm text-destructive-foreground">{loadError}</p>
              <Button size="sm" variant="outline" onClick={reload}>{gt("Retry detection")}</Button>
            </div>
          ) : null}
          {step === 0 ? (
            <WelcomeStep
              providers={providers}
              reload={reload}
              onAddProvider={onClose}
              onConnectedDone={() => setStep(1)}
            />
          ) : null}
          {step === 1 ? <DoneStep connected={connected} /> : null}
        </WizardPanel>
        <WizardFooter
          leading={
            last ? undefined : (
              <Button variant="ghost" onClick={onClose}>
                <T>Skip for now</T>
              </Button>
            )
          }
        >
          {last ? (
            <Button variant="outline" onClick={() => setStep(clampStep(step - 1))}>
              <T>Back</T>
            </Button>
          ) : null}
          <Button ref={actionRef} onClick={last ? finish : () => setStep(clampStep(step + 1))}>
            {last ? (anyConnected ? gt("Open Usage") : gt("Connect an agent")) : step === 0 ? gt("Get started") : gt("Next")}
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
