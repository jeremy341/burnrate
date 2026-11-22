import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ApiError, request } from "~/api/http";
import { loginClient, normalizeErrorCode, type LoginClient } from "~/api/providers";
import { m } from "~/i18n";

/**
 * The CLI sign-in state machine behind every "Sign in" button. It is plain TypeScript (no React,
 * injectable client and timers) so the polling rules are unit-tested with a fake server; the
 * `useLoginFlow` hook below only adapts it to React.
 */

export type LoginStatus =
  | "idle"
  | "starting"
  | "waitingForBrowser"
  | "connected"
  | "failed"
  | "cancelled";

export interface LoginSnapshot {
  readonly status: LoginStatus;
  readonly flowId: string | null;
  /** The sign-in page the CLI printed. */
  readonly url: string | null;
  /** Human text for a failure, already translated. */
  readonly error: string | null;
  /** Machine code behind `error` (`cli-not-found`, `flow-lost`, ...), when there is one. */
  readonly errorCode: string | null;
  /** A code submission is in flight. */
  readonly submittingCode: boolean;
  /** The last code submission failed. */
  readonly codeError: string | null;
}

export const IDLE_LOGIN: LoginSnapshot = {
  status: "idle",
  flowId: null,
  url: null,
  error: null,
  errorCode: null,
  submittingCode: false,
  codeError: null,
};

export interface LoginFlowOptions {
  readonly providerId: string;
  readonly client?: LoginClient;
  /** Called once when the flow reports `connected`. */
  readonly onConnected?: () => void;
  /** Called once per distinct https link the CLI prints, to open the browser. */
  readonly onOpenUrl?: (url: string) => void;
  /** Starts a sign-in that renews a login that already exists (`force: true`). Test hook. */
  readonly forceStart?: (providerId: string, name?: string) => Promise<{ readonly flowId: string }>;
  readonly pollIntervalMs?: number;
  /** Consecutive status failures tolerated before the flow is declared lost. */
  readonly maxPollFailures?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export function isActiveStatus(status: LoginStatus): boolean {
  return status === "starting" || status === "waitingForBrowser";
}

export function isHttpsUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && /^https:\/\//i.test(value);
}

const KNOWN_CODES: ReadonlySet<string> = new Set([
  "cli-not-found",
  "already-connected",
  "invalid-name",
  "invalid name",
  "already-running",
  "too-many-flows",
  "sign-in-failed",
]);

/** The machine code inside a server error string, or null when it is free text. */
export function knownErrorCode(value: string | null | undefined): string | null {
  const code = normalizeErrorCode(value?.trim());
  return code && KNOWN_CODES.has(code) ? code : null;
}

/** Text for a server error code or message coming out of a login flow. */
export function describeLoginError(code: string | null, fallback: string | null): string {
  switch (knownErrorCode(code ?? fallback)) {
    case "cli-not-found":
      return m("The command line tool was not found on this computer. Install it, then try again.");
    case "already-connected":
      return m("This account is already connected. Choose another name or sign out first.");
    case "invalid-name":
    case "invalid name":
      return m(
        "Use 1-64 letters, digits, underscores, dots or hyphens, and do not end the name with a dot.",
      );
    case "already-running":
      return m("A sign-in for this account is already running. Wait for it to finish.");
    case "too-many-flows":
      return m("Too many sign-ins are in progress. Wait for one to finish and try again.");
    case "sign-in-failed":
      return m("Sign-in failed. Try again.");
    default:
      return fallback?.trim() || m("Sign-in failed. Try again.");
  }
}

export class LoginFlowController {
  private snapshot: LoginSnapshot = IDLE_LOGIN;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private timer: unknown = null;
  private pollFailures = 0;
  private polling = false;
  private connectedNotified = false;
  private openedUrl: string | null = null;
  private options: LoginFlowOptions;

  constructor(options: LoginFlowOptions) {
    this.options = options;
  }

  /** Callbacks change every render; the flow itself must not restart because of that. */
  configure(options: Partial<Pick<LoginFlowOptions, "onConnected" | "onOpenUrl">>): void {
    this.options = { ...this.options, ...options };
  }

  private get client(): LoginClient {
    return this.options.client ?? loginClient;
  }

  private get intervalMs(): number {
    return this.options.pollIntervalMs ?? 1000;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): LoginSnapshot => this.snapshot;

  private set(patch: Partial<LoginSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private schedule(delayMs: number, generation: number): void {
    const setTimer = this.options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.timer = setTimer(() => {
      this.timer = null;
      void this.tick(generation);
    }, delayMs);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    const clearTimer = this.options.clearTimer ?? ((handle) => clearTimeout(handle as never));
    clearTimer(this.timer);
    this.timer = null;
  }

  /**
   * Starts a flow. Ignored while one is already running. `force` renews a login that already exists
   * (an expired one): without it the server refuses with "already connected".
   */
  async start(name?: string, force = false): Promise<void> {
    if (isActiveStatus(this.snapshot.status)) return;
    const generation = ++this.generation;
    this.stopTimer();
    this.pollFailures = 0;
    this.connectedNotified = false;
    this.openedUrl = null;
    this.snapshot = { ...IDLE_LOGIN, status: "starting" };
    this.set({});
    try {
      const { flowId } = force
        ? await (this.options.forceStart ?? forceStart)(this.options.providerId, name)
        : await this.client.start(this.options.providerId, name);
      if (generation !== this.generation) {
        // Cancelled or reset while the request was in flight: do not adopt the flow.
        void this.client.cancel(flowId).catch(() => undefined);
        return;
      }
      this.set({ flowId });
      void this.tick(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      const code = error instanceof ApiError ? knownErrorCode(error.code) : null;
      this.set({
        status: "failed",
        errorCode: code,
        error: describeLoginError(code, error instanceof Error ? error.message : null),
      });
    }
  }

  private async tick(generation: number): Promise<void> {
    const flowId = this.snapshot.flowId;
    if (generation !== this.generation || !flowId || this.polling) return;
    this.polling = true;
    try {
      const result = await this.client.state(flowId);
      if (generation !== this.generation) return;
      this.pollFailures = 0;
      if (isHttpsUrl(result.url) && result.url !== this.openedUrl) {
        this.openedUrl = result.url;
        this.options.onOpenUrl?.(result.url);
      }
      const url = result.url ?? this.snapshot.url;
      if (result.state === "connected") {
        this.set({ status: "connected", url, error: null, errorCode: null });
        if (!this.connectedNotified) {
          this.connectedNotified = true;
          this.options.onConnected?.();
        }
        return;
      }
      if (result.state === "failed" || result.state === "cancelled") {
        const code = result.state === "failed" ? knownErrorCode(result.error) : null;
        this.set({
          status: result.state,
          url,
          errorCode: code,
          error: result.state === "failed" ? describeLoginError(code, result.error ?? null) : null,
        });
        return;
      }
      this.set({ status: result.state, url, error: null, errorCode: null });
      this.schedule(this.intervalMs, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.pollFailures += 1;
      // 404: the server forgot the flow (restart). Retrying cannot bring it back.
      const gone = error instanceof ApiError && error.status === 404;
      if (gone || this.pollFailures >= (this.options.maxPollFailures ?? 3)) {
        this.set({
          status: "failed",
          errorCode: gone ? "flow-lost" : "status-unreachable",
          error: gone
            ? m("The sign-in session was lost. Start again.")
            : m("Could not check the sign-in status. Start again."),
        });
        return;
      }
      this.schedule(this.intervalMs, generation);
    } finally {
      this.polling = false;
    }
  }

  /** Sends the code the user pasted from the browser page. */
  async submitCode(code: string): Promise<void> {
    const flowId = this.snapshot.flowId;
    const trimmed = code.trim();
    if (!flowId || !trimmed || this.snapshot.submittingCode || !isActiveStatus(this.snapshot.status)) {
      return;
    }
    const generation = this.generation;
    this.set({ submittingCode: true, codeError: null });
    try {
      await this.client.code(flowId, trimmed);
      if (generation === this.generation) this.set({ submittingCode: false });
    } catch (error) {
      if (generation !== this.generation) return;
      this.set({
        submittingCode: false,
        codeError: error instanceof Error ? error.message : m("Could not submit the code."),
      });
    }
  }

  /** Stops the running flow (best effort on the server) and reports `cancelled`. */
  async cancel(): Promise<void> {
    const { flowId, status } = this.snapshot;
    if (!isActiveStatus(status)) return;
    this.generation += 1;
    this.stopTimer();
    this.set({ status: "cancelled", error: null, errorCode: null, submittingCode: false });
    if (flowId) await this.client.cancel(flowId).catch(() => undefined);
  }

  /** Back to the start (used by Retry and when the dialog reopens). Cancels a running flow. */
  reset(): void {
    const { flowId, status } = this.snapshot;
    this.generation += 1;
    this.stopTimer();
    this.polling = false;
    if (flowId && isActiveStatus(status)) void this.client.cancel(flowId).catch(() => undefined);
    this.snapshot = IDLE_LOGIN;
    this.set({});
  }

  /** Unmount/close: abandon the CLI flow so it does not linger on the server. */
  abandon(): void {
    const { flowId, status } = this.snapshot;
    this.generation += 1;
    this.stopTimer();
    this.polling = false;
    if (flowId && isActiveStatus(status)) {
      void this.client.cancel(flowId).catch(() => undefined);
      this.snapshot = { ...this.snapshot, status: "cancelled" };
    } else if (status === "starting") {
      this.snapshot = IDLE_LOGIN;
    }
  }
}

/** `POST login/start {force: true}`: the generic client has no force flag, so this one call is made here. */
function forceStart(providerId: string, name?: string): Promise<{ readonly flowId: string }> {
  return request<{ flowId: string }>(`/api/accounts/${encodeURIComponent(providerId)}/login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(name ? { name } : {}), force: true }),
  });
}

function openInBrowser(url: string): void {
  if (isHttpsUrl(url)) window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * React adapter. `enabled` is the dialog's open state: closing it abandons a running flow, and
 * nothing polls while it is closed.
 */
export function useLoginFlow(
  providerId: string,
  options: {
    readonly enabled: boolean;
    readonly onConnected?: () => void;
    readonly client?: LoginClient;
  },
): { readonly snapshot: LoginSnapshot; readonly controller: LoginFlowController } {
  const [controller] = useState(
    () =>
      new LoginFlowController({
        providerId,
        ...(options.client ? { client: options.client } : {}),
        onOpenUrl: openInBrowser,
      }),
  );
  const onConnectedRef = useRef(options.onConnected);
  onConnectedRef.current = options.onConnected;
  controller.configure({ onConnected: () => onConnectedRef.current?.() });

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  const { enabled } = options;
  useEffect(() => {
    if (enabled) controller.reset();
    return () => controller.abandon();
  }, [controller, enabled]);

  return { snapshot, controller };
}
