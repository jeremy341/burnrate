import { useMemo, useRef, useState, type ChangeEvent } from "react";

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
import { Radio, RadioGroup } from "~/components/ui/radio-group";
import { m, useGT } from "~/i18n";
import { toast } from "~/lib/toast";
import type { AppSettings } from "../schema";
import { SettingsNotice, SettingsNoticeStack, SettingsRow, SettingsSection } from "../layout";
import { flushSettings, getSettings, loadSettings, useSettings } from "../store";
import { applyUsageDefaults } from "../usageDefaults";
import { SECTION_GROUPS, type SectionDef } from "../types";
import {
  clearHistory,
  errorMessage,
  exportSettingsFile,
  hasResetLosses,
  importSettings,
  parseSettingsImport,
  previewImport,
  replaceImportLosses,
  resetLosses,
  resetSettings,
  type ImportMode,
  type ResetLosses,
} from "../transfer";

interface PendingImport {
  settings: Record<string, unknown>;
}

/** One short sentence naming the user-made content a destructive action would delete. */
function LossList({ losses }: { losses: ResetLosses }) {
  const gt = useGT();
  if (!hasResetLosses(losses)) return null;
  const parts: string[] = [];
  if (losses.customThemes > 0) parts.push(gt("{count} custom theme(s)", { count: losses.customThemes }));
  if (losses.priceOverrides > 0) parts.push(gt("{count} custom model price(s)", { count: losses.priceOverrides }));
  if (losses.modelAliases > 0) parts.push(gt("{count} model alias(es)", { count: losses.modelAliases }));
  if (losses.providerOverrides > 0) parts.push(gt("{count} provider override(s)", { count: losses.providerOverrides }));
  return (
    <p role="alert" className="rounded-md border border-warning/40 bg-warning/8 p-2 text-xs text-foreground">
      {gt("This permanently deletes {items}. Export your settings first if you want to keep them.", {
        items: parts.join(", "),
      })}
    </p>
  );
}

/** Put every setting back to a snapshot taken before an import or reset (the Undo toast action). */
async function restoreSettings(before: AppSettings): Promise<void> {
  await flushSettings();
  await importSettings(before, "replace");
  await loadSettings();
  applyUsageDefaults(getSettings().usage);
}

function Data() {
  const gt = useGT();
  const fileInput = useRef<HTMLInputElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);
  const currentSettings = useSettings();

  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const setStatus = (text: string) => setFeedback(text ? { kind: "success", text } : null);
  const setError = (error: unknown) => setFeedback({ kind: "error", text: errorMessage(error) });
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>("merge");
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const confirmationOpen = pending !== null || confirmReset || confirmClearHistory;
  const confirmationError = feedback?.kind === "error" ? feedback.text : null;

  // The preview depends on the mode: merge keeps what the file omits, replace resets it to the defaults.
  const importDiff = useMemo(
    () => (pending ? previewImport(currentSettings, pending.settings, importMode) : []),
    [currentSettings, pending, importMode],
  );
  const importLosses = useMemo(
    () => (pending && importMode === "replace" ? replaceImportLosses(currentSettings, pending.settings) : null),
    [currentSettings, pending, importMode],
  );
  const resetLossSummary = useMemo(
    () => (confirmReset ? resetLosses(currentSettings) : null),
    [currentSettings, confirmReset],
  );

  const displayValue = (value: unknown): string => {
    if (value === undefined) return gt("not set");
    if (value === null) return "null";
    if (Array.isArray(value)) return gt("{count} items", { count: value.length });
    if (typeof value === "object") return "{…}";
    const text = String(value);
    return text.length > 40 ? `${text.slice(0, 37)}…` : text;
  };

  const onFileChosen = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = ""; // allow choosing the same file again
    if (!file) return;
    setStatus("");
    try {
      const parsed = parseSettingsImport(await file.text());
      setPending({ settings: parsed.settings });
      setImportMode("merge");
    } catch (error) {
      setError(error);
    }
  };

  const doExport = async (): Promise<void> => {
    setBusy(true);
    setStatus("");
    try {
      await flushSettings();
      await exportSettingsFile();
      setStatus(gt("Settings exported to a file."));
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };

  /** Report a finished import or reset as a toast that can put the previous settings back. */
  const announceUndoable = (message: string, before: AppSettings): void => {
    toast.success(message, {
      action: {
        label: gt("Undo"),
        onClick: () => {
          void restoreSettings(before).then(
            () => toast.info(gt("Settings restored.")),
            (error: unknown) => setError(error),
          );
        },
      },
    });
  };

  const doImport = async (): Promise<void> => {
    if (!pending) return;
    setBusy(true);
    setStatus("");
    try {
      await flushSettings();
      const before = getSettings();
      await importSettings(pending.settings as unknown as AppSettings, importMode);
      await loadSettings();
      applyUsageDefaults(getSettings().usage);
      setPending(null);
      announceUndoable(gt("Settings imported."), before);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };

  const doReset = async (): Promise<void> => {
    setBusy(true);
    setStatus("");
    try {
      await flushSettings();
      const before = getSettings();
      await resetSettings();
      await loadSettings();
      applyUsageDefaults(getSettings().usage);
      setConfirmReset(false);
      announceUndoable(gt("Settings reset."), before);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };

  const doClearHistory = async (): Promise<void> => {
    setBusy(true);
    setStatus("");
    try {
      await clearHistory();
      setStatus(gt("Usage history cleared."));
      setConfirmClearHistory(false);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsNoticeStack>
        <SettingsNotice kind={feedback?.kind ?? "info"}>{confirmationOpen ? null : feedback?.text}</SettingsNotice>
      </SettingsNoticeStack>

      <SettingsSection title={gt("Backup and restore")} description={gt("Your settings never contain secrets such as API keys or notification tokens.")}>
        <SettingsRow
          id="data-export"
          title={gt("Export settings")}
          description={gt("Download all settings as a JSON file you can keep or move to another computer.")}
          control={<Button size="sm" variant="outline" disabled={busy} onClick={() => void doExport()}>{gt("Export")}</Button>}
        />
        <SettingsRow
          id="data-import"
          title={gt("Import settings")}
          description={gt("Load settings from a JSON file. Review the changes before applying them.")}
          control={
            <>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                tabIndex={-1}
                aria-label={gt("Choose a settings file")}
                onChange={(event) => void onFileChosen(event)}
              />
              <Button ref={importButton} size="sm" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>{gt("Import")}</Button>
            </>
          }
        />
      </SettingsSection>

      <SettingsSection title={gt("Local data")}>
        <SettingsRow
          id="data-clear-history"
          title={gt("Clear usage history")}
          description={gt("Permanently delete recorded limit samples. Your current limits are not affected.")}
          control={<Button size="sm" variant="destructive-outline" disabled={busy} onClick={() => { setStatus(""); setConfirmClearHistory(true); }}>{gt("Clear history")}</Button>}
        />
        <SettingsRow
          id="data-reset-all"
          title={gt("Reset all settings")}
          description={gt("Restore every setting to its default. Saved keys and usage data are not affected.")}
          control={<Button size="sm" variant="destructive-outline" disabled={busy} onClick={() => { setStatus(""); setConfirmReset(true); }}>{gt("Reset all")}</Button>}
        />
      </SettingsSection>

      {/* Import confirmation: mode + a short summary of what will change. */}
      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <AlertDialogPopup finalFocus={importButton} data-settings-overlay="">
          <AlertDialogHeader className="overflow-y-auto overscroll-contain scroll-py-3">
            <AlertDialogTitle>{gt("Import settings?")}</AlertDialogTitle>
            <AlertDialogDescription id="data-import-summary" className="max-h-none shrink-0 overflow-visible">
              {importDiff.length === 0
                ? gt("This file would not change anything. Choose how to apply it anyway, or cancel.")
                : gt("This file changes {count} setting(s). Choose how to apply them.", { count: importDiff.length })}
            </AlertDialogDescription>
            <SettingsNotice kind="error">{confirmationError}</SettingsNotice>
            <RadioGroup
              aria-label={gt("Import mode")}
              aria-describedby="data-import-summary"
              value={importMode}
              onValueChange={(value) => setImportMode(value === "replace" ? "replace" : "merge")}
              className="gap-1.5 py-1 text-sm"
            >
              <label className="flex min-h-10 cursor-pointer items-center gap-2">
                <Radio value="merge" />
                {gt("Merge: keep settings that are not in the file")}
              </label>
              <label className="flex min-h-10 cursor-pointer items-center gap-2">
                <Radio value="replace" />
                {gt("Replace: reset everything the file does not mention to defaults")}
              </label>
            </RadioGroup>
            {importLosses ? <LossList losses={importLosses} /> : null}
            {importDiff.length > 0 ? (
              <ul tabIndex={0} className="max-h-48 shrink-0 overflow-y-auto scroll-py-2 rounded-md bg-muted p-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" aria-label={gt("Changes this import would make")}>
                {importDiff.slice(0, 40).map((entry) => (
                  <li key={entry.path} className="flex flex-wrap gap-1 py-0.5">
                    <span className="wrap-anywhere font-mono">{entry.path}</span>
                    <span className="wrap-anywhere text-muted-foreground">{displayValue(entry.before)} → {displayValue(entry.after)}</span>
                  </li>
                ))}
                {importDiff.length > 40 ? <li className="pt-1 text-muted-foreground">{gt("…and {count} more", { count: importDiff.length - 40 })}</li> : null}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{gt("No differences from your current settings.")}</p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{gt("Cancel")}</AlertDialogClose>
            <Button disabled={busy} onClick={() => void doImport()}>{gt("Import")}</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      {/* Reset confirmation. */}
      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogPopup data-settings-overlay="">
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Reset all settings?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {gt("Every setting on this device will return to its default value. Saved keys and usage data are not affected.")}
            </AlertDialogDescription>
            <SettingsNotice kind="error">{confirmationError}</SettingsNotice>
            {resetLossSummary ? <LossList losses={resetLossSummary} /> : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{gt("Cancel")}</AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void doReset()}>{gt("Reset all")}</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      {/* Clear-history confirmation. */}
      <AlertDialog open={confirmClearHistory} onOpenChange={setConfirmClearHistory}>
        <AlertDialogPopup data-settings-overlay="">
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Clear usage history?")}</AlertDialogTitle>
            <AlertDialogDescription>{gt("This permanently deletes the recorded limit samples. Your current limits are not affected.")}</AlertDialogDescription>
            <SettingsNotice kind="error">{confirmationError}</SettingsNotice>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{gt("Cancel")}</AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void doClearHistory()}>{gt("Clear history")}</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

export const section: SectionDef = {
  id: "data",
  title: m("Data"),
  order: 90,
  group: m(SECTION_GROUPS.system),
  Component: Data,
};

/** Extra search terms for the flat settings index. */
export const keywords = ["backup", "restore", "export", "import", "reset", "history"];
