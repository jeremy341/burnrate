import { CheckIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { deleteBudget, emptyBudget, listBudgets, saveBudget, type Budget } from "~/api/budgets";
import { Button, InlineButton } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { msg, useGT } from "~/i18n";
import { SettingsNotice } from "~/settings/layout";

type Translate = (message: string) => string;

/** Only the two fields a budget needs inline; currency, reset day and matching keep their saved values. */
interface Draft {
  budget: Budget;
  label: string;
  amount: string;
  isNew: boolean;
}

function errorText(error: unknown, gt: Translate): string {
  return error instanceof Error && error.message ? error.message : gt("Unknown error");
}

/**
 * One row per budget with inline edit (T3 keeps settings that small or drops them). Spend is read
 * from local usage records; the only editable fields are the name and the monthly amount.
 */
export function BudgetEditor() {
  const gt = useGT();
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // `useGT()` returns a fresh function each render, so the one-shot load must not depend on it.
  useEffect(() => {
    setLoading(true);
    listBudgets().then(
      (list) => {
        setBudgets(list);
        setLoadError(null);
        setLoading(false);
      },
      (error: unknown) => {
        setLoadError(error instanceof Error && error.message ? error.message : msg("Unknown error"));
        setLoading(false);
      },
    );
  }, []);

  const openNew = () => {
    setDraft({ budget: emptyBudget("USD"), label: "", amount: "", isNew: true });
    setFormError(null);
    setConfirmDelete(null);
  };

  const openEdit = (budget: Budget) => {
    setDraft({ budget, label: budget.label, amount: String(budget.monthlyBudget), isNew: false });
    setFormError(null);
    setConfirmDelete(null);
  };

  const onSave = async () => {
    if (draft === null || saving) return;
    const label = draft.label.trim();
    if (!label) {
      setFormError(gt("Enter a name for the budget."));
      return;
    }
    const monthlyBudget = Number(draft.amount);
    if (!Number.isFinite(monthlyBudget) || monthlyBudget <= 0) {
      setFormError(gt("Monthly budget must be greater than 0."));
      return;
    }
    const next: Budget = { ...draft.budget, label, monthlyBudget };
    setSaving(true);
    setFormError(null);
    try {
      const saved = await saveBudget(next.id, next);
      setBudgets((previous) =>
        [...previous.filter((entry) => entry.id !== saved.id), saved].sort((a, b) =>
          a.label.localeCompare(b.label),
        ),
      );
      setDraft(null);
      setStatus(gt("Budget saved."));
    } catch (error) {
      setFormError(errorText(error, gt));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (id: string) => {
    try {
      await deleteBudget(id);
      setBudgets((previous) => previous.filter((entry) => entry.id !== id));
      setConfirmDelete(null);
      setStatus(gt("Budget deleted."));
    } catch (error) {
      setStatus(gt("Could not delete budget: {error}", { error: errorText(error, gt) }));
    }
  };

  return (
    <div className="flex flex-col divide-y divide-border">
      <div data-slot="settings-row" className="flex min-h-14 items-center justify-between gap-3 px-4 py-3">
        <p className="min-w-0 text-xs text-muted-foreground">
          {loading
            ? gt("Loading budgets…")
            : budgets.length === 0 && !loadError
              ? draft?.isNew
                ? gt("New budget")
                : gt("No budgets yet. Add one to track a provider's monthly spend.")
              : gt("{count, plural, one {{count} budget} other {{count} budgets}}", { count: budgets.length })}
        </p>
        <Button size="sm" variant="outline" onClick={openNew} disabled={draft !== null}>
          <PlusIcon aria-hidden />
          {gt("Add budget")}
        </Button>
      </div>

      {loadError ? (
        <SettingsNotice kind="error">{gt("Could not load budgets: {error}", { error: loadError })}</SettingsNotice>
      ) : null}

      {loading || (budgets.length === 0 && draft === null) ? null : (
        <ul className="divide-y divide-border">
          {draft?.isNew ? (
            <li className="px-4 py-3">
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onSave();
                }}
              >
                <Input
                  aria-label={gt("Budget name")}
                  autoFocus
                  value={draft.label}
                  placeholder={gt("e.g. Personal API key")}
                  className="min-w-40 flex-1"
                  onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setDraft(null);
                    }
                  }}
                />
                <Input
                  aria-label={gt("Monthly budget amount")}
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  value={draft.amount}
                  placeholder="100"
                  className="w-24"
                  onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
                />
                <span className="text-xs text-muted-foreground">{gt("USD / month")}</span>
                <Button type="submit" size="icon-xs" variant="ghost" aria-label={gt("Save budget")} disabled={saving}>
                  <CheckIcon aria-hidden />
                </Button>
                <Button type="button" size="icon-xs" variant="ghost" aria-label={gt("Cancel")} onClick={() => setDraft(null)}>
                  <XIcon aria-hidden />
                </Button>
                {formError ? <p role="alert" className="w-full text-xs text-destructive-foreground">{formError}</p> : null}
              </form>
            </li>
          ) : null}
          {budgets.map((budget) => {
            const editing = draft?.budget.id === budget.id && !draft.isNew;
            const deleting = confirmDelete === budget.id;
            return (
              <li key={budget.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                {editing ? (
                  <form
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void onSave();
                    }}
                  >
                    <Input
                      aria-label={gt("Budget name")}
                      autoFocus
                      value={draft.label}
                      className="min-w-40 flex-1"
                      onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setDraft(null);
                        }
                      }}
                    />
                    <Input
                      aria-label={gt("Monthly budget amount")}
                      type="number"
                      min={0}
                      step="any"
                      inputMode="decimal"
                      value={draft.amount}
                      className="w-24"
                      onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
                    />
                    <span className="text-xs text-muted-foreground">{gt("USD / month")}</span>
                    <Button type="submit" size="icon-xs" variant="ghost" aria-label={gt("Save budget")} disabled={saving}>
                      <CheckIcon aria-hidden />
                    </Button>
                    <Button type="button" size="icon-xs" variant="ghost" aria-label={gt("Cancel")} onClick={() => setDraft(null)}>
                      <XIcon aria-hidden />
                    </Button>
                    {formError ? <p role="alert" className="w-full text-xs text-destructive-foreground">{formError}</p> : null}
                  </form>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="wrap-anywhere text-sm">{budget.label}</div>
                      <div className="wrap-anywhere text-xs text-muted-foreground">
                        {gt("{amount} {currency} / month · resets day {day}", {
                          amount: budget.monthlyBudget,
                          currency: budget.currency,
                          day: budget.resetDay,
                        })}
                      </div>
                    </div>
                    {deleting ? (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">{gt("Delete?")}</span>
                        <InlineButton
                          tone="destructive"
                          className="min-h-6 rounded-sm px-1.5 text-destructive-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={gt("Confirm delete budget {label}", { label: budget.label })}
                          onClick={() => void onDelete(budget.id)}
                        >
                          {gt("Delete")}
                        </InlineButton>
                        <InlineButton
                          tone="muted"
                          autoFocus
                          className="min-h-6 rounded-sm px-1.5 focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => setConfirmDelete(null)}
                        >
                          {gt("Cancel")}
                        </InlineButton>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={gt("Edit budget {label}", { label: budget.label })}
                          onClick={() => openEdit(budget)}
                        >
                          <PencilIcon aria-hidden />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={gt("Delete budget {label}", { label: budget.label })}
                          onClick={() => setConfirmDelete(budget.id)}
                        >
                          <Trash2Icon aria-hidden />
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {status ? (
        <p role="status" aria-live="polite" className="px-4 py-3 text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
    </div>
  );
}
