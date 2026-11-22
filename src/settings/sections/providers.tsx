import { ExternalLinkIcon, PlusIcon, TrashIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useState } from "react";

import { useProviders } from "~/api";
import { deleteUserDefinition, listDefinitions, type DefinitionInfo } from "~/api/defs";
import {
  Alert,
  AlertDescription,
} from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import {
  isProviderConnected,
  primaryAction,
  providerSubtitle,
  type PrimaryAction,
} from "~/components/providers/providersList";
import { importLocalKey } from "~/api/catalog";
import { localImportOffer } from "~/components/providers/agentTiles";
import { notifyProvidersChanged } from "~/providers/reload";
import type { ProviderInfo } from "~/contracts";
import { m, msg, T, useGT, Var } from "~/i18n";
import { normalizeAccentColor } from "~/providers/presentation";
import { ProviderIcon } from "~/providers/ProviderIcon";
import type { SettingsPatch } from "~/settings/schema";
import { useSettings, updateSettings } from "~/settings/store";
import {
  SettingsEmptyRow,
  SettingsNotice,
  SettingsNoticeStack,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
  useSettingsSearchTargetId,
} from "~/settings/layout";
import { SourceFolderBlocks } from "~/settings/SourceFolders";
import { SOURCE_FOR_PROVIDER, SOURCE_IDS, sourcePathsFor, type SourceId, type SourceStatus } from "~/settings/sources";
import { SECTION_GROUPS, type SectionDef } from "~/settings/types";

// The sign-in and key dialogs are the same ones the Providers screen uses; load them on first use.
const LoginFlowDialog = lazy(() =>
  import("~/components/providers/LoginFlowDialog").then((module) => ({ default: module.LoginFlowDialog })),
);
const AddKeyDialog = lazy(() =>
  import("~/components/providers/AddKeyDialog").then((module) => ({ default: module.AddKeyDialog })),
);

// The TOML editor is the heaviest piece of this page; load it only when opened.
const DefinitionEditor = lazy(() =>
  import("~/components/definitions/DefinitionEditor").then((module) => ({
    default: module.DefinitionEditor,
  })),
);

interface ProviderRow {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly connected: boolean;
  /** The single line shown under the name, never a badge or a dot. */
  readonly status: string;
  /** What the row offers when it is not connected: sign in, add a key, install, or nothing to do. */
  readonly action: PrimaryAction;
  /** A second plain-words line for rows people mix up (OpenCode vs OpenCode Go). */
  readonly note?: string;
  /** Present while a local login can be used with one click (OpenCode Go, Mistral Vibe). */
  readonly localImport?: { readonly source: string };
  readonly provider?: ProviderInfo;
}

/** The one place the two OpenCode things are told apart, in plain words. */
export function providerNote(id: string): string | undefined {
  if (id === "opencode-go") {
    return msg("Go plan limits only. OpenCode's own usage and cost are read from its local logs and need no setup.");
  }
  return undefined;
}

type LocalImportState =
  | { readonly id: string; readonly phase: "working" }
  | { readonly id: string; readonly phase: "done" | "error"; readonly text: string };

/** The honest sentence after a one-click local import: what was read, or why nothing was. */
export function localImportResultText(
  providerId: string,
  source: string,
  result: { readonly summary?: string; readonly imported?: readonly string[] },
): string {
  if (result.summary) return msg("Connected: {summary}.", { summary: result.summary });
  if (providerId === "mistral" && result.imported?.length) {
    return msg("Imported {names} from {source}.", { names: result.imported.join(", "), source });
  }
  return msg("Connected using {source}.", { source });
}

/** Connection requirements come from the same metadata the Providers screen uses. */
export function providerAccessLabel({ auth, category }: Pick<ProviderInfo, "auth" | "category">): string {
  if (category === "admin") return msg("Organization admin key");
  if (auth === "localLogin") return msg("Local sign-in");
  if (auth === "localLogs") return msg("Local session files");
  return msg("Account API key");
}

const MIN_POLL_SECONDS = 60;
const MAX_POLL_SECONDS = 86_400;

export function parsePollInterval(draft: string): { value: number | undefined } | null {
  const trimmed = draft.trim();
  if (!trimmed) return { value: undefined };
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= MIN_POLL_SECONDS && value <= MAX_POLL_SECONDS
    ? { value }
    : null;
}

/** A number field that commits on blur or Enter, so typing does not fire a PATCH per keystroke. */
function PollSecondsField({
  value,
  label,
  descriptionId,
  onCommit,
}: {
  readonly value: number | undefined;
  readonly label: string;
  readonly descriptionId?: string;
  readonly onCommit: (seconds: number | undefined) => void;
}) {
  const gt = useGT();
  const errorId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined ? "" : String(value));
  const invalid = draft !== null && parsePollInterval(draft) === null;
  const commit = () => {
    if (draft === null) return;
    const next = parsePollInterval(draft);
    if (!next) return;
    setDraft(null);
    if (next.value !== value) onCommit(next.value);
  };
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-2">
      <div className="grid min-w-0 gap-1">
        <Input
          inputMode="numeric"
          className="w-28"
          value={shown}
          placeholder={gt("Default")}
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={[descriptionId, invalid ? errorId : undefined].filter(Boolean).join(" ") || undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape" && draft !== null) {
              event.preventDefault();
              event.stopPropagation();
              setDraft(null);
            }
          }}
        />
        {invalid ? (
          <span id={errorId} className="max-w-48 text-xs text-destructive-foreground" role="alert">
            {gt("Use a whole number from 60 to 86,400.")}
          </span>
        ) : null}
      </div>
      {value !== undefined ? (
        <Button variant="ghost" size="sm" onClick={() => {
          setDraft(null);
          onCommit(undefined);
        }}>
          {gt("Reset to default")}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The one list the page draws: one row per provider the server can really connect, connected ones
 * first, then alphabetically. Definitions the server has not loaded (experimental ones) are left out:
 * they have nothing to switch on and nothing to set up, so a row would be a dead end.
 */
export function buildProviderRows(providers: readonly ProviderInfo[] | undefined): ProviderRow[] {
  return (providers ?? [])
    .map((provider): ProviderRow => ({
      id: provider.id,
      label: provider.label,
      color: provider.color ?? "var(--foreground)",
      connected: isProviderConnected(provider),
      status: providerSubtitle(provider),
      action: primaryAction(provider),
      ...(providerNote(provider.id) ? { note: providerNote(provider.id) } : {}),
      // Only offered while there is nothing connected yet; a second Mistral profile is added on the Providers screen.
      ...(!isProviderConnected(provider) && localImportOffer(provider) ? { localImport: localImportOffer(provider) ?? undefined } : {}),
      provider,
    }))
    .sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
}

/**
 * Which agent source folders get a block. Claude Code and Mistral Vibe are always offered; every
 * other agent only when it is on this computer (detected or connected), already has folders, or the
 * current deep link points straight at its block — the Providers screen's "Add folder" links there
 * precisely when the agent is not detected yet.
 */
export function visibleSourceIds(
  sources: Readonly<Partial<Record<SourceId, readonly string[]>>>,
  providers: readonly ProviderInfo[] | undefined,
  searchTargetId: string | null,
): readonly SourceId[] {
  return SOURCE_IDS.filter(
    (id) =>
      id === "claude" ||
      id === "vibe" ||
      searchTargetId === `providers-sources-${id}` ||
      sourcePathsFor(sources, id).length > 0 ||
      (providers ?? []).some(
        (entry) =>
          SOURCE_FOR_PROVIDER[entry.id] === id &&
          (entry.connected || (entry as { readonly detected?: boolean }).detected === true),
      ),
  );
}

function ProvidersSettings() {
  const gt = useGT();
  const providers = useProviders();
  const hidden = useSettings((settings) => settings.providers.hidden);
  const claudeOAuthProbe = useSettings((settings) => settings.providers.claudeOAuthProbe);
  const customDefinitions = useSettings((settings) => settings.providers.customDefinitions);
  const overrides = useSettings((settings) => settings.providers.overrides);
  const sources = useSettings((settings) => settings.providers.sources);
  const hideSensitive = useSettings((settings) => settings.general.hideSensitive);

  const [defs, setDefs] = useState<readonly DefinitionInfo[]>([]);
  const [defsVersion, setDefsVersion] = useState(0);
  const [defsLoading, setDefsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingDef, setEditingDef] = useState<DefinitionInfo | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [pollTarget, setPollTarget] = useState<string>("");
  const [signInTarget, setSignInTarget] = useState<ProviderInfo | null>(null);
  const [keyTarget, setKeyTarget] = useState<ProviderInfo | null>(null);
  const [localImport, setLocalImport] = useState<LocalImportState | null>(null);

  const reloadDefs = useCallback(() => {
    setDefsLoading(true);
    setLoadError(null);
    setDefsVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listDefinitions().then(
      (list) => {
        if (!cancelled) {
          setDefs(list);
          setLoadError(null);
          setDefsLoading(false);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : m("Could not load definitions."));
          setDefsLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [defsVersion]);

  const apply = (patch: SettingsPatch) => {
    setActionError(null);
    void updateSettings(patch).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : gt("Could not save settings."));
    });
  };

  // One row per provider: connected first, then alphabetically. Manual reordering is gone.
  const rows = useMemo(() => buildProviderRows(providers.data ?? undefined), [providers.data]);
  const connectedRows = useMemo(() => rows.filter((row) => row.connected), [rows]);

  // A deep link straight to an agent's source folder (the Providers screen's
  // "Add folder") has to render that block even when the agent is not detected
  // yet, which is exactly when the user needs it.
  const searchTargetId = useSettingsSearchTargetId();

  /** A sign-in or key changed: refresh this list and tell the other screens. */
  const connectionChanged = () => {
    notifyProvidersChanged();
    providers.reload();
  };

  /** One explicit click: bring in the login another tool already holds, then say what happened. */
  const runLocalImport = (row: ProviderRow) => {
    const id = row.id === "opencode-go" ? "opencode-go" : row.id === "mistral" ? "mistral" : null;
    if (!id || !row.localImport || localImport?.phase === "working") return;
    const source = row.localImport.source;
    setLocalImport({ id: row.id, phase: "working" });
    importLocalKey(id).then(
      (result) => {
        setLocalImport({ id: row.id, phase: "done", text: localImportResultText(row.id, source, result) });
        connectionChanged();
      },
      (cause: unknown) => {
        setLocalImport({
          id: row.id,
          phase: "error",
          text: cause instanceof Error ? cause.message : gt("Could not connect."),
        });
      },
    );
  };

  const setEnabled = (id: string, enabled: boolean) => {
    apply({
      providers: {
        hidden: enabled ? hidden.filter((hiddenId) => hiddenId !== id) : [...hidden, id],
      },
    });
  };

  const setSourcePaths = (id: SourceId, paths: string[]) => {
    apply({ providers: { sources: { [id]: paths } } });
    // The server re-checks the folders on the next listing; ask for it so "not found" updates.
    window.setTimeout(() => providers.reload(), 400);
  };

  /** What the server says about the folders configured for one agent (absent on older servers). */
  const sourceStatus = (id: SourceId): readonly SourceStatus[] | undefined => {
    const provider = providers.data?.find((entry) => SOURCE_FOR_PROVIDER[entry.id] === id);
    return (provider as unknown as { sources?: readonly SourceStatus[] } | undefined)?.sources;
  };

  // Claude Code and Mistral Vibe are always offered; every other agent only when it is on this computer
  // (detected or connected), already has folders, or the current deep link points at it, so the section
  // does not list agents nobody has.
  const shownSourceIds = visibleSourceIds(sources, providers.data ?? undefined, searchTargetId);

  const setPollSeconds = (id: string, seconds: number | undefined) => {
    apply({
      providers: { overrides: { [id]: { pollSeconds: seconds ?? null } } },
    });
  };

  const deleteDefinition = (id: string) => {
    setActionError(null);
    setConfirmDelete(null);
    void deleteUserDefinition(id).then(
      () => {
        reloadDefs();
        providers.reload();
      },
      (error: unknown) => {
        setActionError(error instanceof Error ? error.message : gt("Could not delete the definition."));
      },
    );
  };

  const userDefinitions = defs.filter((def) => def.source === "user");
  // Polling only means something for a provider that is being read.
  const pollRow = connectedRows.find((row) => row.id === pollTarget) ?? connectedRows[0];
  const loading = providers.loading || defsLoading;
  const editorKeyNames = editingDef
    ? (providers.data?.find((entry) => entry.id === editingDef.id)?.accounts ?? []).map((account) =>
        account.id.startsWith(`${editingDef.id}-`) ? account.id.slice(editingDef.id.length + 1) : account.id,
      )
    : [];

  return (
    <div className="flex flex-col gap-6">
      <SettingsNoticeStack>
        <SettingsNotice kind="error">{providers.error ?? loadError}</SettingsNotice>
        <SettingsNotice kind="error">{actionError}</SettingsNotice>
      </SettingsNoticeStack>

      {providers.error || loadError ? (
        <div>
          <Button size="sm" variant="outline" onClick={() => {
            providers.reload();
            reloadDefs();
          }}>
            {gt("Retry loading providers")}
          </Button>
        </div>
      ) : null}

      <SettingsSection
        title={gt("Providers")}
        description={gt("Connect an agent, then switch it on or off here. Changes apply instantly.")}
      >
        {rows.length === 0 ? (
          <SettingsEmptyRow>
            {loading
              ? <span role="status">{gt("Loading providers…")}</span>
              : providers.error || loadError
                ? gt("The provider list is unavailable.")
                : gt("No providers found yet.")}
          </SettingsEmptyRow>
        ) : null}
        <ul aria-label={gt("Providers")} className="divide-y divide-border">
          {rows.map((row) => {
            const enabled = !hidden.includes(row.id);
            return (
              <li key={row.id} data-slot="settings-row" className="min-h-16 px-4 py-3">
                <div className="flex min-h-10 items-center gap-3">
                  <ProviderIcon
                    driver={row.id}
                    label={row.label}
                    accent={normalizeAccentColor(row.color)}
                    className="size-5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">{row.label}</div>
                    <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{row.status}</div>
                  </div>
                  {row.connected ? (
                    <Switch
                      checked={enabled}
                      onCheckedChange={(checked) => setEnabled(row.id, checked)}
                      aria-label={gt("Show {name} in Burnrate", { name: row.label })}
                    />
                  ) : row.localImport ? null : row.action.kind === "signIn" && row.provider ? (
                    <Button size="sm" onClick={() => setSignInTarget(row.provider ?? null)}>
                      {gt("Sign in")}
                    </Button>
                  ) : row.action.kind === "addKey" && row.provider ? (
                    <Button size="sm" variant="outline" onClick={() => setKeyTarget(row.provider ?? null)}>
                      <PlusIcon aria-hidden />
                      {gt("Add key")}
                    </Button>
                  ) : row.action.kind === "install" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      render={<a href={row.action.url} target="_blank" rel="noreferrer" />}
                    >
                      {gt("Install")}
                    </Button>
                  ) : null}
                </div>
                {row.note ? <p className="mt-1 ps-8 text-xs text-muted-foreground">{gt(row.note)}</p> : null}
                {row.localImport && row.provider ? (
                  <div className="mt-2 flex flex-col gap-2 ps-8">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        disabled={localImport?.phase === "working"}
                        aria-busy={localImport?.phase === "working" && localImport.id === row.id}
                        onClick={() => runLocalImport(row)}
                      >
                        {localImport?.phase === "working" && localImport.id === row.id
                          ? gt("Connecting…")
                          : row.id === "opencode-go"
                            ? gt("Use my local OpenCode login")
                            : gt("Import from {source}", { source: row.localImport.source })}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setKeyTarget(row.provider ?? null)}>
                        {row.id === "opencode-go" ? gt("Paste Go key") : gt("Add key")}
                      </Button>
                      {row.id === "opencode-go" && row.provider.keyUrl && /^https:\/\//i.test(row.provider.keyUrl) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          render={<a href={row.provider.keyUrl} target="_blank" rel="noreferrer" />}
                        >
                          {gt("Get a Go key")}
                          <ExternalLinkIcon aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {localImport && localImport.id === row.id && localImport.phase !== "working" ? (
                  <p
                    role={localImport.phase === "error" ? "alert" : "status"}
                    className={
                      localImport.phase === "error"
                        ? "mt-2 ps-8 text-xs text-destructive-foreground"
                        : "mt-2 ps-8 text-xs text-success-foreground"
                    }
                  >
                    {localImport.text}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </SettingsSection>

      <SettingsSection
        id="providers-sources"
        title={gt("Local sources")}
        description={gt("Extra folders Burnrate reads agent files from, in addition to the usual locations.")}
      >
        <SourceFolderBlocks
          sources={sources}
          status={sourceStatus}
          hideSensitive={hideSensitive}
          onChange={setSourcePaths}
          visibleIds={shownSourceIds}
        />
      </SettingsSection>

      <SettingsSection title={gt("Advanced")}>
        <SettingsSwitchRow
          id="providers-claude-login-probe"
          title={gt("Read the local Claude login for limits")}
          checked={claudeOAuthProbe}
          onCheckedChange={(checked) => apply({ providers: { claudeOAuthProbe: checked } })}
          description={gt(
            "Uses the local Claude CLI token for live quota from Anthropic; the endpoint is undocumented.",
          )}
        />
        <SettingsSwitchRow
          id="providers-custom-definitions"
          title={gt("Load user provider definitions")}
          checked={customDefinitions}
          onCheckedChange={(checked) => apply({ providers: { customDefinitions: checked } })}
          description={
            <T>
              Read provider TOML files from the <Var>providers.d</Var> folder in the data directory.
            </T>
          }
        />
        {userDefinitions.length > 0 ? (
          <div
            aria-label={gt("User definitions")}
            tabIndex={0}
            className="max-h-72 divide-y overflow-y-auto scroll-py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {userDefinitions.map((def) => (
              <div
                key={def.id}
                data-slot="settings-row"
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="wrap-anywhere text-sm">{def.label}</div>
                  <div className="text-xs text-muted-foreground">
                    <Var>{def.id}</Var>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditingDef(def);
                      setEditorOpen(true);
                    }}
                  >
                    <T>Edit</T>
                  </Button>
                  <Button
                    variant="ghost-destructive"
                    size="sm"
                    aria-label={gt("Delete definition {name}", { name: def.label })}
                    onClick={() => setConfirmDelete(def.id)}
                  >
                    <TrashIcon />
                    {gt("Delete")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <div className="px-4 py-3" data-slot="settings-row">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditingDef(null);
              setEditorOpen(true);
            }}
          >
            <PlusIcon />
            <T>New definition</T>
          </Button>
        </div>
        {editorOpen ? (
          <div className="flex flex-col gap-3 px-4 py-4" data-slot="settings-row">
            {editingDef && !editingDef.toml ? (
              <Alert variant="info" role="status">
                <AlertDescription>
                  <T>
                    The server did not return the source for this definition. Paste its TOML below
                    before saving changes.
                  </T>
                </AlertDescription>
              </Alert>
            ) : null}
            <Suspense
              fallback={
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {gt("Loading definition editor…")}
                </p>
              }
            >
              <DefinitionEditor
                defId={editingDef?.id}
                initialToml={editingDef?.toml}
                keyNames={editorKeyNames}
                onChanged={() => {
                  reloadDefs();
                  providers.reload();
                }}
                onCancel={() => setEditorOpen(false)}
              />
            </Suspense>
          </div>
        ) : null}
        {pollRow ? (
          <SettingsRow
            id="providers-polling"
            title={gt("Polling overrides")}
            description={gt("How often a provider is read, in seconds. Minimum 60; empty uses the provider's own interval.")}
            control={({ "aria-describedby": descriptionId }) => (
              <div className="flex min-w-0 flex-wrap items-start gap-2">
                <Select value={pollRow.id} onValueChange={(value) => value && setPollTarget(value)}>
                  <SelectTrigger
                    id="poll-provider"
                    size="sm"
                    className="w-full sm:w-44"
                    aria-label={gt("Provider to override")}
                    aria-describedby={descriptionId}
                  >
                    <SelectValue>{pollRow.label}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false} data-settings-overlay="">
                    {connectedRows.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {row.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <PollSecondsField
                  key={pollRow.id}
                  value={overrides[pollRow.id]?.pollSeconds}
                  descriptionId={descriptionId}
                  label={gt("Poll interval for {name} in seconds", { name: pollRow.label })}
                  onCommit={(seconds) => setPollSeconds(pollRow.id, seconds)}
                />
              </div>
            )}
          />
        ) : null}
      </SettingsSection>

      {signInTarget ? (
        <Suspense fallback={null}>
          <LoginFlowDialog
            key={signInTarget.id}
            provider={signInTarget}
            open
            onOpenChange={(open) => {
              if (!open) setSignInTarget(null);
            }}
            onConnected={connectionChanged}
            onRecheck={connectionChanged}
            usedNames={signInTarget.accounts.map((account) => account.label)}
          />
        </Suspense>
      ) : null}

      {keyTarget ? (
        <Suspense fallback={null}>
          <AddKeyDialog
            provider={keyTarget}
            open
            onOpenChange={(open) => {
              if (!open) setKeyTarget(null);
            }}
            onSaved={() => {
              setKeyTarget(null);
              connectionChanged();
            }}
          />
        </Suspense>
      ) : null}

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogPopup data-settings-overlay="">
          <AlertDialogHeader className="overflow-y-auto overscroll-contain scroll-py-3">
            <AlertDialogTitle>{gt("Delete this definition?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {gt("The TOML file for {name} is removed from your providers folder. Bundled definitions are not affected.", {
                name: userDefinitions.find((def) => def.id === confirmDelete)?.label ?? confirmDelete ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{gt("Cancel")}</AlertDialogClose>
            <Button variant="destructive" onClick={() => confirmDelete && deleteDefinition(confirmDelete)}>
              {gt("Delete definition")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

export const section: SectionDef = {
  id: "providers",
  title: msg("Providers"),
  order: 40,
  group: msg(SECTION_GROUPS.preferences),
  Component: ProvidersSettings,
};

/** Extra search terms for the flat settings index. */
export const keywords = ["providers", "accounts", "definitions", "toml", "polling", "claude", "codex", "chatgpt", "opencode", "sources", "folders", "paths", "directory", "vibe", "mistral", "config", "location"];
