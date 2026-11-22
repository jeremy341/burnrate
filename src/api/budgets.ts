/**
 * Client for the local budgets store (docs/CONTRACTS.md section 5).
 *
 * A budget measures spend for providers/keys that have no usage API locally,
 * from the engine's cost records. The server keeps the canonical list in
 * `<data>/budgets.json`; this module is a thin, typed HTTP wrapper.
 */
import { request } from "./http";

/** Which records count towards a budget. Empty arrays mean "no restriction". */
export interface BudgetMatch {
  /** Provider / definition ids, e.g. ["anthropic", "budget"]. */
  providers?: string[];
  /** Model id prefixes. */
  models?: string[];
}

export interface Budget {
  /** Stable id, also used in the `/api/budgets/<id>` route and as `budget-<id>` in limits. */
  id: string;
  label: string;
  /** Monthly spend allowance in major units (e.g. dollars). */
  monthlyBudget: number;
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
  /** Day of the month the budget resets, 1..28. */
  resetDay: number;
  match: BudgetMatch;
  /** Optional accent colour for the limits report / UI. */
  color?: string;
}

/** GET /api/budgets -> Budget[] */
export async function listBudgets(): Promise<Budget[]> {
  const data = await request<unknown>("/api/budgets");
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is Budget => {
    if (typeof item !== "object" || item === null) return false;
    const b = item as Partial<Budget>;
    return typeof b.id === "string" && typeof b.label === "string";
  });
}

/** PUT /api/budgets/<id> body Budget -> the saved budget */
export async function saveBudget(id: string, budget: Budget): Promise<Budget> {
  return request<Budget>(`/api/budgets/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(budget),
  });
}

/** DELETE /api/budgets/<id>. Tolerates an empty 2xx body (204 No Content). */
export async function deleteBudget(id: string): Promise<void> {
  const res = await fetch(`/api/budgets/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Burnrate": "1" },
  });
  if (res.ok) return;
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error) message = body.error;
  } catch {
    // A non-JSON error still becomes an Error with the status code.
  }
  throw new Error(message);
}

/** A blank budget draft for the editor. `id` is generated locally and never changed by the UI. */
export function emptyBudget(defaultCurrency: string): Budget {
  return {
    id: newBudgetId(),
    label: "",
    monthlyBudget: 0,
    currency: defaultCurrency || "USD",
    resetDay: 1,
    match: { providers: [], models: [] },
  };
}

function newBudgetId(): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return random.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 18) || "new";
}
