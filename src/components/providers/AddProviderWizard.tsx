import { ArrowLeftIcon, CircleAlertIcon, SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";

import { fetchCatalog, fetchDefinitions, type CatalogEntry, type DefinitionInfo } from "~/api/catalog";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Command,
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "~/components/ui/command";
import { Dialog } from "~/components/ui/dialog";
import {
  useWizardStepFocus,
  WizardFooter,
  WizardHeader,
  WizardPanel,
  WizardPopup,
  WizardSteps,
} from "~/components/ui/wizard";
import type { ProviderInfo } from "~/contracts";
import { m, T, useGT } from "~/i18n";
import { cn } from "~/lib/utils";
import { ProviderIcon } from "~/providers/ProviderIcon";

import { suggestAccountName } from "./addKeyDialog.logic";
import { AddKeyDialog } from "./AddKeyDialog";
import { LocalImportCard } from "./LocalImportCard";
import { localImportOffer } from "./agentTiles";
import { LoginFlowDialog } from "./LoginFlowDialog";
import {
  buildWizardOptions,
  claudeUsedNames,
  filterWizardOptions,
  isActionableOption,
  wizardAuthKind,
  wizardGroups,
  type WizardOption,
} from "./providerWizard";

const STEPS = ["Provider", "Authentication"] as const;

/**
 * The "Add provider" wizard: a searchable list of providers, then one authentication step — sign in
 * through the browser (the agent's own CLI flow) or paste an API key. Everything else (colour
 * swatches, a separate name step, "Advanced" folds) is gone. Loaded lazily by `ProvidersPage`.
 */
export default function AddProviderWizard({
  open,
  onOpenChange,
  providers,
  onChanged,
  onOpenSettings,
  finalFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providers: readonly ProviderInfo[];
  readonly onChanged: () => void;
  readonly onOpenSettings: () => void;
  readonly finalFocus?: ComponentProps<typeof WizardPopup>["finalFocus"];
}) {
  const gt = useGT();
  const [step, setStep] = useState(0);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [definitions, setDefinitions] = useState<readonly DefinitionInfo[]>([]);
  const [catalog, setCatalog] = useState<readonly CatalogEntry[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useWizardStepFocus(step);
  const [authActions, setAuthActions] = useState<HTMLDivElement | null>(null);

  // Every open starts at the provider list with an empty search.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setQuery("");
    setSelectedKey(null);
    setSourcesError(null);
  }, [open]);

  // Definitions and the catalog are optional: /api/defs answers 404 until the engine lands.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSourcesLoading(true);
    Promise.allSettled([fetchDefinitions(), fetchCatalog()]).then(([defs, entries]) => {
      if (cancelled) return;
      if (defs.status === "fulfilled") setDefinitions(defs.value);
      if (entries.status === "fulfilled") setCatalog(entries.value);
      if (defs.status === "rejected" || entries.status === "rejected") {
        setSourcesError(m("Could not load the full provider list. Installed providers still work."));
      }
      setSourcesLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const options = useMemo(
    () => buildWizardOptions({ providers, definitions, catalog }),
    [providers, definitions, catalog],
  );
  const visible = useMemo(() => filterWizardOptions(options, query), [options, query]);
  const groups = useMemo(() => wizardGroups(visible, { showAdvanced: true }), [visible]);
  const optionsByKey = useMemo(
    () => new Map(visible.map((option) => [option.key, option] as const)),
    [visible],
  );
  const selected = selectedKey ? options.find((option) => option.key === selectedKey) : undefined;
  const authKind = wizardAuthKind(selected);

  const close = () => onOpenChange(false);
  const complete = () => {
    onChanged();
    close();
  };
  const choose = (option: WizardOption) => {
    if (option.source === "custom") {
      close();
      onOpenSettings();
      return;
    }
    if (!isActionableOption(option)) return;
    // Picking a provider is the decision: go straight to signing in, no separate Next click.
    setSelectedKey(option.key);
    setStep(1);
  };

  const summaries: (string | null)[] = [selected?.label ?? null, null];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <WizardPopup
        size="wide"
        data-provider-dialog
        initialFocus={(type) => (type === "touch" ? true : searchRef.current)}
        finalFocus={finalFocus}
      >
        <div className="flex max-h-[min(85dvh,44rem)] flex-col overflow-hidden">
          <WizardHeader
            title={gt("Add provider")}
            description={<T>Pick a provider, then sign in or paste a key.</T>}
          >
            <WizardSteps
              steps={STEPS.map((label) => gt(label))}
              currentStep={step}
              summaries={summaries}
              onStepChange={(next) => {
                if (next < step) setStep(next);
              }}
              isStepDisabled={(index) => index >= step}
            />
          </WizardHeader>

          {step === 0 ? (
            <WizardPanel ref={panelRef} role="group" aria-label={gt(STEPS[0])} className="flex-1 space-y-0">
              <div role="status" className="sr-only">
                {sourcesLoading ? gt("Looking for providers…") : ""}
              </div>
              <div className="flex min-h-18 flex-col">
                <Command value={query} onValueChange={setQuery} mode="none">
                  <div className="flex min-h-0 flex-col rounded-xl border border-border">
                    <CommandInput
                      ref={searchRef}
                      placeholder={gt("Search providers")}
                      aria-label={gt("Search providers")}
                    />
                    <CommandPanel className="max-h-88">
                      {groups.length === 0 ? (
                        <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
                          <T>No providers match your search.</T>
                        </p>
                      ) : null}
                      <CommandList>
                        {groups.map((group) => (
                          <CommandGroup
                            key={group.id}
                            items={group.options.map((option) => option.key)}
                          >
                            <CommandGroupLabel>{gt(group.label)}</CommandGroupLabel>
                            <CommandCollection>
                              {(key: string) => {
                                const option = optionsByKey.get(key);
                                if (!option) return null;
                                const actionable = isActionableOption(option);
                                const custom = option.source === "custom";
                                const detail =
                                  option.unavailableReason ??
                                  option.note ??
                                  option.hint ??
                                  (option.source === "provider"
                                    ? option.auth === "apiKey"
                                      ? gt("Add an API key for {provider}.", { provider: option.label })
                                      : option.auth === "localLogin"
                                        ? gt("Uses the sign-in already on this computer.")
                                        : gt("Reads usage from local session files.")
                                    : option.baseUrl);
                                return (
                                  <CommandItem
                                    key={option.key}
                                    value={option.key}
                                    disabled={!actionable && !custom}
                                    onClick={() => choose(option)}
                                    className={cn(
                                      "group items-start",
                                      selectedKey === option.key && "bg-foreground/[0.06]",
                                    )}
                                  >
                                    {custom ? (
                                      <span className="grid size-5 shrink-0 place-items-center rounded-md border bg-card">
                                        <SettingsIcon className="size-3" aria-hidden />
                                      </span>
                                    ) : (
                                      <ProviderIcon
                                        driver={option.id}
                                        label={option.label}
                                        className="size-5"
                                        accent={option.color}
                                      />
                                    )}
                                    <span className="flex min-w-0 flex-1 flex-col">
                                      <span className="truncate text-sm font-medium">{option.label}</span>
                                      <span className="min-w-0 truncate text-xs text-muted-foreground group-data-highlighted:text-foreground">
                                        {detail}
                                      </span>
                                    </span>
                                  </CommandItem>
                                );
                              }}
                            </CommandCollection>
                          </CommandGroup>
                        ))}
                      </CommandList>
                    </CommandPanel>
                  </div>
                </Command>
              </div>
              {sourcesError ? (
                <Alert variant="warning" role="status">
                  <CircleAlertIcon />
                  <AlertDescription>{sourcesError}</AlertDescription>
                </Alert>
              ) : null}
            </WizardPanel>
          ) : null}

          {step === 1 && selected ? (
            <WizardPanel ref={panelRef} role="group" aria-label={gt(STEPS[1])} className="flex-1 space-y-0">
              <div className="flex items-center gap-3">
                <ProviderIcon driver={selected.id} label={selected.label} className="size-8" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{selected.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {authKind === "key"
                      ? gt("Connect with an API key")
                      : authKind === "login"
                        ? gt("Sign in with this agent")
                        : gt("Uses the login on this computer")}
                  </p>
                </div>
              </div>

              {authKind === "key" && selected.provider ? (
                <div className="grid gap-3">
                  {localImportOffer(selected.provider) ? (
                    <LocalImportCard
                      provider={selected.provider}
                      onImported={() => {
                        onChanged();
                        close();
                      }}
                    />
                  ) : null}
                  <p className="text-sm text-muted-foreground">
                    {localImportOffer(selected.provider) ? (
                      <T>Or paste an API key to read this provider&apos;s quota on this computer.</T>
                    ) : (
                      <T>Paste an API key to read this provider&apos;s quota on this computer.</T>
                    )}
                  </p>
                  <AddKeyDialog
                    secondary={localImportOffer(selected.provider) !== null}
                    inline
                    inlineActionsTarget={authActions}
                    open
                    provider={selected.provider}
                    initialName={suggestAccountName(selected.provider)}
                    onOpenChange={(next) => {
                      if (!next) close();
                    }}
                    onSaved={onChanged}
                  />
                </div>
              ) : authKind === "login" && selected.provider ? (
                <LoginFlowDialog
                  inline
                  inlineActionsTarget={authActions}
                  open
                  provider={selected.provider}
                  askName={selected.provider.id === "claudeAgent"}
                  usedNames={claudeUsedNames(selected.provider)}
                  onConnected={onChanged}
                  onRecheck={onChanged}
                  onOpenChange={(next) => {
                    if (!next) complete();
                  }}
                />
              ) : (
                <div className="grid gap-2">
                  <p className="text-sm text-muted-foreground">
                    <T>
                      This provider reads usage from this computer. There is nothing to sign in to.
                    </T>
                  </p>
                </div>
              )}
            </WizardPanel>
          ) : null}

          <WizardFooter
            leading={
              <Button variant="ghost-muted" size="sm" onClick={step === 0 ? close : () => setStep(0)}>
                {step === 0 ? <T>Cancel</T> : <><ArrowLeftIcon /><T>Back</T></>}
              </Button>
            }
          >
            {step === 0 ? null : authKind === "none" || authKind === "unavailable" ? (
              <Button size="sm" onClick={complete}>
                <T>Done</T>
              </Button>
            ) : (
              <div ref={setAuthActions} className="flex flex-wrap justify-end gap-2" />
            )}
          </WizardFooter>
        </div>
      </WizardPopup>
    </Dialog>
  );
}
