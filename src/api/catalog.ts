import { ApiError, request } from "~/api/http";

/**
 * Provider definitions and the models.dev catalog (docs/CONTRACTS.md section 4 and 14).
 *
 * The defs engine (package 03) owns both routes. Until it lands `GET /api/defs` and
 * `GET /api/defs/catalog` answer 404, so every loader here treats 404 as "no data" and
 * lets the provider wizard keep working with the providers `/api/providers` already lists.
 */

/** One models.dev provider as served by `GET /api/defs/catalog`. */
export interface CatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly baseUrl?: string;
  readonly docs?: string;
  readonly envVars?: readonly string[];
  readonly hasDefinition?: boolean;
  readonly note?: string;
}

export type DefinitionStatus = "stable" | "experimental" | "disabled";
export type DefinitionSource = "builtin" | "user";

/** One declarative provider definition as served by `GET /api/defs`. */
export interface DefinitionInfo {
  readonly id: string;
  readonly label: string;
  readonly status: DefinitionStatus;
  readonly source: DefinitionSource;
  /**
   * Whether the server has this definition loaded and polling (`enabled` in `GET /api/defs`).
   * Absent when the server does not say, so callers must not treat "absent" as "off".
   */
  readonly enabled?: boolean;
  readonly color?: string;
  readonly docs?: string;
  readonly hasDefinition?: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rows(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  const obj = record(value);
  if (!obj) return [];
  for (const key of ["defs", "definitions", "catalog", "items"] as const) {
    if (Array.isArray(obj[key])) return obj[key] as readonly unknown[];
  }
  return [];
}

/** Normalises the catalog response, skipping entries that cannot be shown. */
export function normalizeCatalog(value: unknown): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows(value)) {
    const entry = record(row);
    if (!entry) continue;
    const id = text(entry.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const baseUrl = text(entry.baseUrl) ?? text(entry.base_url);
    const docs = text(entry.docs);
    const note = text(entry.note);
    const envVars = Array.isArray(entry.envVars)
      ? entry.envVars.filter((name): name is string => typeof name === "string" && !!name.trim())
      : undefined;
    out.push({
      id,
      label: text(entry.label) ?? text(entry.name) ?? id,
      ...(baseUrl ? { baseUrl } : {}),
      ...(docs ? { docs } : {}),
      ...(envVars && envVars.length > 0 ? { envVars } : {}),
      hasDefinition: entry.hasDefinition === true || entry.has_definition === true,
      ...(note ? { note } : {}),
    });
  }
  return out;
}

/** Normalises the definitions response, skipping entries that cannot be shown. */
export function normalizeDefinitions(value: unknown): DefinitionInfo[] {
  const out: DefinitionInfo[] = [];
  const seen = new Set<string>();
  for (const row of rows(value)) {
    const entry = record(row);
    if (!entry) continue;
    const id = text(entry.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rawStatus = text(entry.status);
    const status: DefinitionStatus =
      rawStatus === "experimental" || rawStatus === "disabled" ? rawStatus : "stable";
    const rawSource = text(entry.source);
    const source: DefinitionSource = rawSource === "user" ? "user" : "builtin";
    const color = text(entry.color);
    const docs = text(entry.docs);
    out.push({
      id,
      label: text(entry.label) ?? text(entry.name) ?? id,
      status,
      source,
      ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
      ...(color ? { color } : {}),
      ...(docs ? { docs } : {}),
      hasDefinition: entry.hasDefinition !== false,
    });
  }
  return out;
}

async function load(path: string): Promise<unknown | null> {
  try {
    return await request<unknown>(path);
  } catch (error) {
    // The engine is not installed yet (or the route is absent): an empty picker is correct.
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** `GET /api/defs/catalog`; 404 means the defs engine is not available yet. */
export async function fetchCatalog(): Promise<CatalogEntry[]> {
  const value = await load("/api/defs/catalog");
  return value === null ? [] : normalizeCatalog(value);
}

/** `GET /api/defs`; 404 means the defs engine is not available yet. */
export async function fetchDefinitions(): Promise<DefinitionInfo[]> {
  const value = await load("/api/defs");
  return value === null ? [] : normalizeDefinitions(value);
}

/**
 * `POST /api/accounts/<provider>/import-local`: one explicit click that brings in what another tool
 * already holds on this computer. Mistral: copies the Vibe key (after Mistral accepts it). OpenCode
 * Go: opts in to the Go key OpenCode holds and reads the usage once; `summary` is that real answer
 * ("Go session 0% used"). Never called on load.
 */
export type LocalImportProvider = "mistral" | "opencode-go";

const NO_LOCAL_KEY: Record<LocalImportProvider, string> = {
  mistral: "Mistral Vibe holds no API key that Burnrate has not already imported. Sign in with `vibe --setup`, or paste a key.",
  "opencode-go": "No Go key found in OpenCode. Paste a Go key instead.",
};

export async function importLocalKey(
  providerId: LocalImportProvider,
): Promise<{ readonly source: string; readonly imported?: readonly string[]; readonly summary?: string }> {
  try {
    const result = await request<{
      readonly source?: unknown;
      readonly imported?: unknown;
      readonly summary?: unknown;
    }>(`/api/accounts/${providerId}/import-local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const source = typeof result.source === "string" ? result.source : providerId === "mistral" ? "Mistral Vibe" : "OpenCode";
    const summary = typeof result.summary === "string" && result.summary.trim() ? result.summary.trim() : undefined;
    // The server may name the accounts it saved ("Vibe", "Vibe 2"); only names, never keys.
    const imported = Array.isArray(result.imported)
      ? result.imported.filter((name): name is string => typeof name === "string" && name.length > 0)
      : [];
    return { source, ...(imported.length > 0 ? { imported } : {}), ...(summary ? { summary } : {}) };
  } catch (error) {
    if (error instanceof ApiError && error.code === "no-local-key") {
      throw new ApiError(NO_LOCAL_KEY[providerId], error.status, error.code, error.field);
    }
    throw error;
  }
}
