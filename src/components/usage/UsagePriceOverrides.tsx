import { useAtomValue } from "~/t3-shims/effectAtomReact";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  sessionGrantsScope,
} from "~/t3-shims/t3Contracts";
import { PlusIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { AsyncResult, Atom } from "~/t3-shims/effectReactivity";
import { msg, T, useGT, useMessages, Var } from "~/t3-shims/gt-react";
import { useId, useRef, useState, type RefObject } from "react";

import { cn } from "../../lib/utils";
import { environmentPresentations } from "~/t3-shims/statePresentation";
import { serverEnvironment } from "~/t3-shims/stateServer";
import { environmentSession, readEnvironmentScope } from "~/t3-shims/stateSession";
import { useAtomCommand } from "~/t3-shims/useAtomCommand";
import { notifyUsagePricesChanged, type EnvironmentUsageStatus } from "~/state/usage";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { UsageTableRegion } from "./UsageTableRegion";
import { isUsagePriceEdit, USAGE_PRICE_FIELDS } from "./usagePriceForm";
import {
  isEmptyUsagePriceDraft,
  usageAliasCell,
  usagePriceCell,
  usagePriceTableChanges,
  usagePriceTableErrors,
  type UsagePriceDraft,
  type UsagePriceField,
} from "./usagePriceTable";
import {
  writeUsagePrices,
  type UsagePriceTarget,
  type UsagePriceWriteResult,
} from "./usagePriceTargets";

const priceTargetsAtom = Atom.make((get): readonly UsagePriceTarget[] =>
  [...get(environmentPresentations.presentationsAtom)].map(([environmentId, environment]) => {
    const settings = get(serverEnvironment.settingsValueAtom(environmentId));
    const session = get(environmentSession.sessionStateAtom(environmentId));
    const sessionData = AsyncResult.getOrElse(session, () => null);
    const access =
      session._tag === "Failure"
        ? "denied"
        : sessionData === null
          ? session.waiting
            ? "pending"
            : "denied"
          : sessionGrantsScope(sessionData, AuthSettingsWriteScope)
            ? "granted"
            : "denied";
    return {
      environmentId,
      label: environment.entry.target.label,
      prices: settings?.usagePriceOverrides ?? null,
      aliases:
        environment.serverConfig?.environment.capabilities.usageModelAliases === true
          ? (settings?.usageModelAliases ?? null)
          : null,
      unavailable:
        environment.connection.phase !== "connected"
          ? msg("Offline")
          : settings === null
            ? msg("Prices not loaded")
            : access === "pending"
              ? msg("Checking permissions…")
              : access === "denied"
                ? msg("Read-only access")
                : null,
    };
  }),
);

type SaveAttempt = {
  readonly drafts: readonly UsagePriceDraft[];
  readonly destinations: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }[];
  readonly results: ReadonlyMap<
    EnvironmentId,
    UsagePriceWriteResult | { readonly status: "saving" }
  >;
};

export function UsagePriceOverrides({
  usage = [],
  modelSuggestions = [],
  initialSelectedEnvironmentIds = null,
  initialModel,
  onOpenChange,
  returnFocusRef,
}: {
  readonly usage?: readonly EnvironmentUsageStatus[];
  readonly modelSuggestions?: readonly string[] | undefined;
  /** Burnrate has one environment; a missing value means "all environments". */
  readonly initialSelectedEnvironmentIds?: ReadonlySet<EnvironmentId> | null;
  readonly initialModel?: string | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const gt = useGT();
  const messages = useMessages();
  const id = useId();
  const modelListId = `${id}-models`;
  const aliasListId = `${id}-aliases`;
  const environments = useAtomValue(priceTargetsAtom).map((target) =>
    target.unavailable === null ? target : { ...target, unavailable: messages(target.unavailable) },
  );
  // This app always runs on this PC: there is no destination picker, so every local target is selected.
  const selectedIds = initialSelectedEnvironmentIds;
  const selected = environments.filter(
    (environment) => selectedIds === null || selectedIds.has(environment.environmentId),
  );
  const [drafts, setDrafts] = useState<readonly UsagePriceDraft[]>(() =>
    initialModel === undefined ||
    selected.some(
      (environment) =>
        Object.hasOwn(environment.prices ?? {}, initialModel) ||
        Object.hasOwn(environment.aliases ?? {}, initialModel),
    )
      ? []
      : [{ id: "new:initial", model: initialModel, isNew: true, values: {} }],
  );
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(true);
  const [attempt, setAttempt] = useState<SaveAttempt | null>(null);
  const focusRowRef = useRef<string | null>(null);
  const nextRowId = useRef(0);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const customModels = [
    ...new Set(
      selected.flatMap((environment) => [
        ...Object.keys(environment.prices ?? {}),
        ...Object.keys(environment.aliases ?? {}),
      ]),
    ),
  ].sort();
  const models = [
    ...new Set([
      ...customModels,
      ...modelSuggestions,
      ...usage
        .filter((environment) =>
          selected.some((target) => target.environmentId === environment.environmentId),
        )
        .flatMap((environment) => environment.summary?.buckets.map((bucket) => bucket.model) ?? []),
    ]),
  ].sort();
  const newModels = new Set(
    drafts.filter((draft) => draft.isNew).map((draft) => draft.model.trim()),
  );
  const rows: readonly UsagePriceDraft[] = [
    ...customModels
      .filter((model) => attempt === null || !newModels.has(model))
      .map(
        (model) =>
          drafts.find((draft) => draft.id === `model:${model}`) ?? {
            id: `model:${model}`,
            model,
            isNew: false,
            values: {},
          },
      ),
    ...drafts.filter((draft) => draft.isNew),
  ];
  const stagedDrafts = drafts.filter((draft) => !isEmptyUsagePriceDraft(draft));
  const errors = usagePriceTableErrors(selected, stagedDrafts, messages);
  // New rows still block Save, but show a price error only once a price or mapping is typed.
  const awaitingPrice = new Set<string>();
  for (const draft of stagedDrafts) {
    if (!draft.isNew) continue;
    if (draft.model.trim() === "") errors.set(draft.id, gt("Enter a model ID."));
    else if (
      attempt === null &&
      (customModels.includes(draft.model.trim()) ||
        drafts.some((other) => other.id !== draft.id && other.model.trim() === draft.model.trim()))
    )
      errors.set(draft.id, gt("This model already has a row. Edit its prices there."));
    else if (
      (draft.alias ?? "").trim() === "" &&
      Object.values(draft.values).every((value) => value.trim() === "")
    )
      awaitingPrice.add(draft.id);
  }
  const failedDestinations =
    attempt?.destinations.filter(
      (destination) => attempt.results.get(destination.environmentId)?.status === "failed",
    ) ?? [];
  const locked = pending || failedDestinations.length > 0;
  const hasChanges = stagedDrafts.length > 0;
  const discard = () => {
    setDrafts([]);
    setAttempt(null);
  };
  const updateDraft = (draft: UsagePriceDraft) => {
    setDrafts((previous) =>
      previous.some((entry) => entry.id === draft.id)
        ? previous.map((entry) => (entry.id === draft.id ? draft : entry))
        : [...previous, draft],
    );
    setAttempt(null);
  };
  const matchesSaved = (
    row: UsagePriceDraft,
    cell: { value: string; placeholder: string },
    value: string,
  ) =>
    !row.isNew &&
    cell.placeholder !== gt("Mixed") &&
    cell.placeholder !== gt("Unavailable") &&
    value === cell.value;
  const updateOrDropDraft = (draft: UsagePriceDraft) => {
    if (!draft.isNew && Object.keys(draft.values).length === 0 && draft.alias === undefined)
      setDrafts((previous) => previous.filter((entry) => entry.id !== draft.id));
    else updateDraft(draft);
  };
  const editCell = (row: UsagePriceDraft, field: UsagePriceField, value: string) => {
    const values = { ...row.values, [field]: value };
    const original = usagePriceCell(selected, row.model, field, messages);
    if (matchesSaved(row, original, value)) delete values[field];
    updateOrDropDraft({ ...row, values });
  };
  const editAlias = (row: UsagePriceDraft, value: string) => {
    const { alias: _alias, ...rest } = row;
    const original = usageAliasCell(selected, row.model, messages);
    updateOrDropDraft(matchesSaved(row, original, value) ? rest : { ...rest, alias: value });
  };
  const save = async (retry = false) => {
    if (pending) return;
    const destinations = retry ? failedDestinations : selected;
    const edits = retry && attempt ? attempt.drafts : stagedDrafts;
    if (destinations.length === 0 || edits.length === 0) return;
    const targets = destinations.map(
      (destination) =>
        environments.find(
          (environment) => environment.environmentId === destination.environmentId,
        ) ?? {
          ...destination,
          prices: null,
          aliases: null,
          unavailable: gt("Environment removed"),
        },
    );
    const changes = new Map(
      targets.map((target) => [
        target.environmentId,
        usagePriceTableChanges(target, edits, messages),
      ]),
    );
    setPending(true);
    setAttempt((previous) => ({
      drafts: edits,
      destinations: retry && previous ? previous.destinations : targets,
      results: new Map([
        ...(retry && previous ? previous.results : []),
        ...targets.map((target) => [target.environmentId, { status: "saving" } as const] as const),
      ]),
    }));
    let failed = false;
    await writeUsagePrices({
      targets: targets.map((target) => ({
        ...target,
        unavailable:
          target.unavailable ?? [...changes.get(target.environmentId)!.errors.values()][0] ?? null,
      })),
      changes: new Map([...changes].map(([id, plan]) => [id, plan.changes])),
      write: async (input) => {
        const result = readEnvironmentScope(input.environmentId, AuthSettingsWriteScope)
          ? await updateSettings(input)
          : ({ _tag: "Failure" } as const);
        if (result._tag === "Success") notifyUsagePricesChanged();
        return result;
      },
      onResult: (environmentId, result) => {
        if (result.status === "failed") failed = true;
        setAttempt((previous) =>
          previous === null
            ? null
            : { ...previous, results: new Map(previous.results).set(environmentId, result) },
        );
      },
    });
    setPending(false);
    if (!failed) setDrafts([]);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <DialogPopup finalFocus={returnFocusRef} className="max-w-4xl motion-reduce:transition-none">
        <DialogHeader>
          <DialogTitle>
            <T>Model prices</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Prices and mappings apply to all past and future usage on this PC.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              <T>USD / million tokens</T>
            </span>
            {selected.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={locked}
                onClick={() => {
                  const id = `new:${nextRowId.current++}`;
                  focusRowRef.current = id;
                  updateDraft({ id, model: "", isNew: true, values: {} });
                }}
              >
                <PlusIcon aria-hidden />
                <T>Add model</T>
              </Button>
            ) : null}
          </div>
          {selected.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {gt("Model prices aren't available on this PC yet.")}
            </p>
          ) : (
            <>
              <UsageTableRegion label={gt("Custom model prices")} className="max-h-[min(24rem,50dvh)] rounded-lg border border-border [--usage-table-surface:var(--popover)]">
                <Table className="min-w-180 table-fixed" aria-label={gt("Custom model prices")}>
                  <colgroup>
                    <col className="w-[22%]" />
                    <col className="w-[18%]" />
                    {USAGE_PRICE_FIELDS.map((field) => (
                      <col key={field.key} />
                    ))}
                    <col className="w-10" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">
                        <T>Model ID</T>
                      </TableHead>
                      <TableHead scope="col">
                        <T>Map to</T>
                      </TableHead>
                      {USAGE_PRICE_FIELDS.map((field) => (
                        <TableHead key={field.key} scope="col">{messages(field.label)}</TableHead>
                      ))}
                      <TableHead scope="col">
                        <span className="sr-only">{gt("Actions")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="whitespace-normal">
                          {/* Pinned to the visible left edge so it stays readable when the table scrolls sideways. */}
                          <p className="sticky start-0 max-w-80 py-6 text-muted-foreground">
                            {selected.some((environment) => environment.prices === null)
                              ? gt("Some environment prices are unavailable.")
                              : gt("No custom prices or mappings. Add a row to set one.")}
                          </p>
                        </TableCell>
                      </TableRow>
                    ) : (
                      rows.map((row) => {
                        const aliasCell = usageAliasCell(selected, row.model, messages);
                        const alias = (row.alias ?? aliasCell.value).trim();
                        const error = awaitingPrice.has(row.id) ? undefined : errors.get(row.id);
                        return (
                          <TableRow key={row.id} data-row-id={row.id}>
                            <TableCell className="whitespace-normal">
                              {row.isNew ? (
                                <Input
                                  size="compact"
                                  value={row.model}
                                  ref={(node) => {
                                    if (node && focusRowRef.current === row.id) {
                                      node.focus();
                                      focusRowRef.current = null;
                                    }
                                  }}
                                  aria-label={gt("New model ID")}
                                  aria-invalid={
                                    (row.model.trim() !== "" && error !== undefined) || undefined
                                  }
                                  list={modelListId}
                                  placeholder={gt("Model ID")}
                                  autoComplete="off"
                                  spellCheck={false}
                                  disabled={locked}
                                  onChange={(event) =>
                                    updateDraft({ ...row, model: event.target.value })
                                  }
                                />
                              ) : (
                                <span
                                  className={cn(
                                    "block break-all",
                                    row.removed && "text-muted-foreground line-through",
                                  )}
                                >
                                  {row.model}
                                </span>
                              )}
                              {error !== undefined &&
                              (row.model.trim() !== "" ||
                                Object.values(row.values).some((value) => value !== "")) ? (
                                <p role="alert" className="mt-1 text-xs text-destructive">
                                  {error}
                                </p>
                              ) : null}
                            </TableCell>
                            {row.removed ? (
                              <TableCell colSpan={5}>
                                <span className="text-muted-foreground">
                                  <T>Automatic pricing after saving</T>
                                </span>
                              </TableCell>
                            ) : (
                              <TableCell>
                                <Input
                                  size="compact"
                                  value={row.alias ?? aliasCell.value}
                                  aria-label={gt("Map {model} to model", {
                                    model: row.model || gt("new model"),
                                  })}
                                  list={aliasListId}
                                  placeholder={row.isNew ? gt("Optional") : aliasCell.placeholder}
                                  autoComplete="off"
                                  spellCheck={false}
                                  disabled={locked}
                                  onChange={(event) => editAlias(row, event.target.value)}
                                />
                              </TableCell>
                            )}
                            {row.removed ? null : alias !== "" ? (
                              <TableCell colSpan={4} className="whitespace-normal">
                                <span className="break-all text-muted-foreground">
                                  <T>
                                    Counted as <Var>{alias}</Var>
                                  </T>
                                </span>
                              </TableCell>
                            ) : (
                              USAGE_PRICE_FIELDS.map((field) => {
                                const cell = usagePriceCell(
                                  selected,
                                  row.model,
                                  field.key,
                                  messages,
                                );
                                const value =
                                  row.values[field.key] ?? (row.isNew ? "" : cell.value);
                                return (
                                  <TableCell key={field.key}>
                                    <Input
                                      size="compact"
                                      inputMode="decimal"
                                      aria-label={gt("{field} price for {model}", {
                                        field: messages(field.label),
                                        model: row.model || gt("new model"),
                                      })}
                                      value={value}
                                      placeholder={
                                        row.isNew
                                          ? field.optional
                                            ? gt("Input rate")
                                            : "0.00"
                                          : cell.placeholder
                                      }
                                      autoComplete="off"
                                      disabled={locked}
                                      font="mono"
                                      onChange={(event) => {
                                        if (isUsagePriceEdit(value, event.target.value))
                                          editCell(row, field.key, event.target.value);
                                      }}
                                    />
                                  </TableCell>
                                );
                              })
                            )}
                            <TableCell>
                              <Tooltip>
                                <TooltipTrigger
                                  render={<Button size="icon-sm" variant="ghost" />}
                                  disabled={locked}
                                  aria-label={
                                    row.removed
                                      ? gt("Undo reset for {model}", { model: row.model })
                                      : row.isNew
                                        ? gt("Remove new model")
                                        : gt("Reset price for {model} to automatic", {
                                            model: row.model,
                                          })
                                  }
                                  onClick={() => {
                                    if (row.isNew)
                                      setDrafts((previous) =>
                                        previous.filter((entry) => entry.id !== row.id),
                                      );
                                    else if (row.removed)
                                      updateOrDropDraft({ ...row, removed: false });
                                    else updateDraft({ ...row, removed: true });
                                  }}
                                >
                                  {row.isNew ? (
                                    <XIcon aria-hidden />
                                  ) : (
                                    <RotateCcwIcon aria-hidden />
                                  )}
                                </TooltipTrigger>
                                <TooltipPopup>
                                  {row.removed
                                    ? gt("Undo reset")
                                    : row.isNew
                                      ? gt("Remove row")
                                      : gt("Reset to automatic")}
                                </TooltipPopup>
                              </Tooltip>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </UsageTableRegion>
              <datalist id={modelListId}>
                {models
                  .filter((model) => !customModels.includes(model))
                  .map((model) => (
                    <option key={model} value={model} />
                  ))}
              </datalist>
              <datalist id={aliasListId}>
                {models
                  .filter((model) =>
                    selected.every(
                      (environment) => !Object.hasOwn(environment.aliases ?? {}, model),
                    ),
                  )
                  .map((model) => (
                    <option key={model} value={model} />
                  ))}
              </datalist>
              <p className="text-xs text-muted-foreground">
                {gt(
                  "Blank cache rates use the input price. Enter 0 for free tokens. A mapped model’s usage counts as the model it maps to.",
                )}
                {selected.length > 1
                  ? ` ${gt("Mixed cells keep each environment’s rate until you edit them.")}`
                  : ""}
              </p>
            </>
          )}
          {attempt ? (
            <div role="status" className="grid gap-1 text-xs">
              {attempt.destinations.map((destination) => {
                const result = attempt.results.get(destination.environmentId);
                return (
                  <div key={destination.environmentId} className="flex justify-between gap-3">
                    <span className="truncate text-muted-foreground">{destination.label}</span>
                    <span
                      className={
                        result?.status === "failed"
                          ? "text-right text-destructive"
                          : "text-muted-foreground"
                      }
                    >
                      {result?.status === "failed"
                        ? gt("Not saved · {error}", { error: result.error })
                        : result?.status === "saved"
                          ? gt("Saved")
                          : gt("Saving…")}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare" className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {hasChanges ? gt("Changes apply on this PC") : ""}
          </span>
          <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
            {hasChanges ? (
              <Button variant="ghost" disabled={pending} onClick={discard}>
                {failedDestinations.length > 0
                  ? gt("Discard pending changes")
                  : gt("Discard changes")}
              </Button>
            ) : null}
            <Button
              disabled={
                pending ||
                (!hasChanges && failedDestinations.length === 0) ||
                (failedDestinations.length === 0 && (errors.size > 0 || selected.length === 0))
              }
              onClick={() => void save(failedDestinations.length > 0)}
            >
              {pending
                ? gt("Saving…")
                : failedDestinations.length > 0
                  ? gt("Retry failed saves")
                  : gt("Save changes")}
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
