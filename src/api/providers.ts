import { ApiError, request } from "~/api/http";
import type { LoginFlowPhase } from "~/contracts";

/**
 * Generic CLI sign-in flows (docs/work/FLOW-BRIEF.md).
 *
 *   POST   /api/accounts/<providerId>/login/start   {name?}  -> {flowId}
 *   GET    /api/accounts/flows/<flowId>                      -> {state, url?, error?}
 *   POST   /api/accounts/flows/<flowId>/code        {code}
 *   DELETE /api/accounts/flows/<flowId>
 *
 * Servers from before the generic routes only know Claude (`/api/accounts/claude/*`), so for
 * Claude a 404 on start falls back to those routes and the flow is remembered as "legacy".
 */

export interface LoginFlowResult {
  readonly state: LoginFlowPhase;
  readonly url?: string;
  readonly error?: string;
}

export interface LoginClient {
  start(providerId: string, name?: string): Promise<{ readonly flowId: string }>;
  state(flowId: string): Promise<LoginFlowResult>;
  code(flowId: string, code: string): Promise<void>;
  cancel(flowId: string): Promise<void>;
}

const CLAUDE_PROVIDER_ID = "claudeAgent";
const DEFAULT_CLAUDE_NAME = "main";

type Requester = <T>(path: string, init?: RequestInit) => Promise<T>;

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const PHASES: readonly LoginFlowPhase[] = [
  "starting",
  "waitingForBrowser",
  "connected",
  "failed",
  "cancelled",
];

/** Tolerates a server that answers with an unknown state: treat it as still starting. */
export function normalizeFlowResult(value: unknown): LoginFlowResult {
  const row = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const state = PHASES.find((phase) => phase === row.state) ?? "starting";
  const url = typeof row.url === "string" && row.url.trim() ? row.url.trim() : undefined;
  const error = typeof row.error === "string" && row.error.trim() ? row.error.trim() : undefined;
  return { state, ...(url ? { url } : {}), ...(error ? { error } : {}) };
}

/** `claude-not-found` is the old spelling of `cli-not-found`. */
export function normalizeErrorCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return code === "claude-not-found" ? "cli-not-found" : code;
}

export function createLoginClient(send: Requester = request): LoginClient {
  const legacyFlows = new Set<string>();
  const flowPath = (flowId: string, suffix = "") =>
    legacyFlows.has(flowId)
      ? `/api/accounts/claude/${encodeURIComponent(flowId)}${suffix}`
      : `/api/accounts/flows/${encodeURIComponent(flowId)}${suffix}`;

  return {
    async start(providerId, name) {
      const body = name ? { name } : {};
      try {
        return await send<{ flowId: string }>(
          `/api/accounts/${encodeURIComponent(providerId)}/login/start`,
          json("POST", body),
        );
      } catch (error) {
        if (providerId !== CLAUDE_PROVIDER_ID || !(error instanceof ApiError) || error.status !== 404) {
          throw error;
        }
        const result = await send<{ flowId: string }>(
          "/api/accounts/claude/start",
          json("POST", { name: name ?? DEFAULT_CLAUDE_NAME }),
        );
        legacyFlows.add(result.flowId);
        return result;
      }
    },
    async state(flowId) {
      return normalizeFlowResult(await send<unknown>(flowPath(flowId)));
    },
    async code(flowId, code) {
      await send(flowPath(flowId, "/code"), json("POST", { code }));
    },
    async cancel(flowId) {
      try {
        await send(flowPath(flowId), { method: "DELETE" });
      } finally {
        legacyFlows.delete(flowId);
      }
    },
  };
}

/** The client the app uses. */
export const loginClient: LoginClient = createLoginClient();

/**
 * Disconnect actions the server can do for a login that lives outside Burnrate's own key store
 * (docs: accounts_api.rs).
 *
 *   POST /api/accounts/codex/signout          deletes the Codex CLI's `auth.json`, like `codex logout`
 *   POST /api/accounts/opencode-go/disconnect turns "use my OpenCode login" off (nothing is deleted)
 *
 * The caller must have asked the user first: the Codex one signs the Codex CLI out too.
 */
export type LocalDisconnect = "codex" | "opencode-go";

const DISCONNECT_PATH: Record<LocalDisconnect, string> = {
  codex: "/api/accounts/codex/signout",
  "opencode-go": "/api/accounts/opencode-go/disconnect",
};

/** Plain words for the codes those two routes answer with. */
export function disconnectMessage(code: string | null, provider: LocalDisconnect): string {
  if (code === "no-login") return "Codex is already signed out.";
  if (code === "sign-out-failed") {
    return provider === "codex"
      ? "Could not delete the Codex login file. Close Codex and try again."
      : "Could not turn the OpenCode login off. Try again.";
  }
  return provider === "codex" ? "Could not sign Codex out." : "Could not disconnect OpenCode Go.";
}

export async function disconnectLocalLogin(
  provider: LocalDisconnect,
  send: Requester = request,
): Promise<void> {
  try {
    await send(DISCONNECT_PATH[provider], { method: "POST" });
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError(disconnectMessage(error.code, provider), error.status, error.code, error.field);
    }
    throw error;
  }
}
