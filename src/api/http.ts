import { m } from "~/i18n";

/** An HTTP failure, keeping the raw server code (for special UI) and status (for 404 handling). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** The setting/field the server rejected (e.g. "appearance.fontFamily"), when it says which. */
  readonly field: string | null;

  constructor(message: string, status: number, code: string | null, field: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/**
 * The server sends short machine codes for expected failures. Never surface them verbatim —
 * translate them here so every dialog can show `error.message` directly.
 */
export function humanMessage(code: string): string {
  switch (code) {
    case "claude-not-found":
      return m("Claude Code CLI was not found on this computer. Install it, then try again.");
    case "already-connected":
      return m("This account is already connected. Choose another name or sign out first.");
    case "invalid-name":
    case "invalid name":
      return m(
        "Use 1-64 letters, digits, underscores, dots or hyphens, and do not end the name with a dot.",
      );
    case "sign-in-failed":
      return m("Claude sign-in failed. Try again.");
    case "already-running":
      return m("A sign-in for this account is already running. Wait for it to finish.");
    case "too-many-flows":
      return m("Too many sign-ins are in progress. Wait for one to finish and try again.");
    default:
      return code;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "X-Burnrate": "1", ...init?.headers } });
  if (!res.ok) {
    // The server returns {"error":"..."} for expected failures. Map known codes to human text;
    // other strings are server-written messages and can be shown as-is.
    let code: string | null = null;
    let field: string | null = null;
    try {
      const body = (await res.json()) as { error?: unknown; field?: unknown };
      if (typeof body?.error === "string" && body.error) code = body.error;
      if (typeof body?.field === "string" && body.field) field = body.field;
    } catch {
      // A non-JSON error still becomes an Error with the status code.
    }
    const message = code ? humanMessage(code) : `HTTP ${res.status}`;
    throw new ApiError(message, res.status, code, field);
  }
  return (await res.json()) as T;
}

