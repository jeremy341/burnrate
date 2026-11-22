/**
 * Client for the declarative provider-definition API (docs/CONTRACTS.md section 4).
 * All calls go through the shared `request` helper so error codes are humanised once.
 */
import { request } from "~/api/http";
import type { LimitsAccount } from "~/contracts";

export type DefinitionStatus = "stable" | "experimental" | "disabled";
export type DefinitionSource = "builtin" | "user";
export type DefinitionAuth = "apiKey" | "none";

/** One row of `GET /api/defs`. */
export interface DefinitionInfo {
  readonly id: string;
  readonly label: string;
  readonly color?: string;
  readonly status: DefinitionStatus;
  readonly source: DefinitionSource;
  readonly auth: DefinitionAuth;
  readonly docs?: string;
  readonly plan?: string;
  readonly pollSeconds?: number;
  /** Present for user definitions when the server returns the source text. */
  readonly toml?: string;
}

/** One row of `GET /api/defs/catalog` (built from models.dev by package 20). */
export interface DefinitionCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly baseUrl?: string;
  readonly docs?: string;
  readonly envVars?: readonly string[];
  readonly hasDefinition: boolean;
  readonly note?: string;
}

/** A lint error from `POST /api/defs/validate`. Servers may return plain strings or {field, message}. */
export type DefinitionIssue = string | { readonly field?: string; readonly message: string };

/** A side-effect-free summary of what the definition would produce (no network access). */
export interface DefinitionPreview {
  readonly id?: string;
  readonly label?: string;
  readonly status?: DefinitionStatus;
  readonly auth?: DefinitionAuth;
  readonly keyHosts?: readonly string[];
  readonly pollSeconds?: number;
  readonly plan?: string;
  readonly requests?: readonly {
    readonly id: string;
    readonly method: string;
    readonly url: string;
    readonly optional?: boolean;
  }[];
  readonly windows?: readonly { readonly id: string; readonly kind: string; readonly label?: string }[];
  readonly balances?: readonly { readonly id: string; readonly kind: string; readonly label?: string }[];
}

export interface ValidateDefinitionResult {
  readonly ok: boolean;
  readonly errors: readonly DefinitionIssue[];
  readonly preview?: DefinitionPreview;
}

/**
 * `POST /api/defs/test` returns the mapped account (with the key redacted). Some server versions
 * return it directly, others wrap it in `{ account, error }`; accept both so the UI is tolerant.
 */
export interface TestDefinitionResult {
  readonly ok?: boolean;
  readonly account?: LimitsAccount;
  readonly error?: string;
  readonly id?: string;
  readonly driver?: string;
  readonly label?: string;
  readonly plan?: string;
  readonly limits?: LimitsAccount["limits"];
}

/** List built-in and user definitions, with their status and source. */
export function listDefinitions(): Promise<DefinitionInfo[]> {
  return request<DefinitionInfo[]>("/api/defs");
}

/** Parse + lint a definition without contacting the provider. */
export function validateDefinition(toml: string): Promise<ValidateDefinitionResult> {
  return request<ValidateDefinitionResult>("/api/defs/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toml }),
  });
}

/** Run a definition's requests once with a stored key. `keyName` is never sent as a header. */
export function testDefinition(input: {
  readonly toml?: string;
  readonly id?: string;
  readonly keyName: string;
}): Promise<TestDefinitionResult> {
  return request<TestDefinitionResult>("/api/defs/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** Atomically write `<data>/providers.d/<id>.toml`. The server rejects a mismatched `id`. */
export function saveUserDefinition(id: string, toml: string): Promise<void> {
  return request<void>(`/api/defs/user/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toml }),
  });
}

export function deleteUserDefinition(id: string): Promise<void> {
  return request<void>(`/api/defs/user/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** The catalog is optional until the defs engine lands; callers should tolerate a 404. */
export function listCatalog(): Promise<DefinitionCatalogEntry[]> {
  return request<DefinitionCatalogEntry[]>("/api/defs/catalog");
}

/** Human-readable text for a validation issue, whatever shape the server used. */
export function issueText(issue: DefinitionIssue): string {
  if (typeof issue === "string") return issue;
  return issue.field ? `${issue.field}: ${issue.message}` : issue.message;
}

/** Resolve the mapped account from either supported `/api/defs/test` response shape. */
export function mappedAccount(result: TestDefinitionResult): LimitsAccount | null {
  if (result.account) return result.account;
  if (result.id && result.driver && result.label && result.limits) {
    return {
      id: result.id,
      driver: result.driver,
      label: result.label,
      plan: result.plan,
      limits: result.limits,
    };
  }
  return null;
}

/**
 * Best-effort client-side read of the top-level `id` so the PUT URL can be built before the server
 * validates the whole file. Only lines before the first TOML table are considered.
 */
export function parseDefinitionId(toml: string): string | null {
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) break;
    const match = /^id\s*=\s*"([a-z0-9-]{1,40})"\s*(?:#.*)?$/.exec(line);
    if (match) return match[1] ?? null;
  }
  return null;
}
