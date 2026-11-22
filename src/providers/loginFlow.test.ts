import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "~/api/http";
import { createLoginClient, type LoginClient, type LoginFlowResult } from "~/api/providers";

import { LoginFlowController, describeLoginError, knownErrorCode } from "./loginFlow";

/** A scripted server: `states` are returned one per poll, the last one repeats. */
function fakeClient(states: Array<LoginFlowResult | Error>, startError?: Error) {
  let index = 0;
  const calls = { start: [] as Array<[string, string | undefined]>, state: 0, code: [] as string[], cancel: [] as string[] };
  const client: LoginClient = {
    start: async (providerId, name) => {
      calls.start.push([providerId, name]);
      if (startError) throw startError;
      return { flowId: "flow-1" };
    },
    state: async () => {
      calls.state += 1;
      const next = states[Math.min(index, states.length - 1)]!;
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    code: async (_flowId, code) => {
      calls.code.push(code);
    },
    cancel: async (flowId) => {
      calls.cancel.push(flowId);
    },
  };
  return { client, calls };
}

async function flush() {
  // Let pending promise continuations run without advancing timers.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("LoginFlowController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renews an expired login with a forced start in the account's own folder, never the plain start", async () => {
    const { client, calls } = fakeClient([{ state: "connected" }]);
    const forced: Array<[string, string | undefined]> = [];
    const flow = new LoginFlowController({
      providerId: "claudeAgent",
      client,
      forceStart: async (providerId, name) => {
        forced.push([providerId, name]);
        return { flowId: "flow-force" };
      },
    });
    await flow.start("acc2", true);
    await flush();
    expect(forced).toEqual([["claudeAgent", "acc2"]]);
    expect(calls.start).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.getSnapshot().status).toBe("connected");
  });

  it("starts, polls once a second, opens the browser once and reports connected once", async () => {
    const { client, calls } = fakeClient([
      { state: "starting" },
      { state: "waitingForBrowser", url: "https://claude.ai/login?x=1" },
      { state: "waitingForBrowser", url: "https://claude.ai/login?x=1" },
      { state: "connected" },
    ]);
    const opened: string[] = [];
    let connected = 0;
    const flow = new LoginFlowController({
      providerId: "codex",
      client,
      onOpenUrl: (url) => opened.push(url),
      onConnected: () => (connected += 1),
    });

    await flow.start("work");
    await flush();
    expect(calls.start).toEqual([["codex", "work"]]);
    expect(flow.getSnapshot().status).toBe("starting");

    await vi.advanceTimersByTimeAsync(1000);
    expect(flow.getSnapshot()).toMatchObject({ status: "waitingForBrowser", url: "https://claude.ai/login?x=1" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(opened).toEqual(["https://claude.ai/login?x=1"]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(flow.getSnapshot().status).toBe("connected");
    expect(connected).toBe(1);

    // Terminal: no more polling.
    const polls = calls.state;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.state).toBe(polls);
  });

  it("never opens a non-https link", async () => {
    const { client } = fakeClient([{ state: "waitingForBrowser", url: "javascript:alert(1)" }]);
    const opened: string[] = [];
    const flow = new LoginFlowController({ providerId: "codex", client, onOpenUrl: (u) => opened.push(u) });
    await flow.start();
    await flush();
    expect(opened).toEqual([]);
  });

  it("surfaces a failed state with a known code and stops polling", async () => {
    const { client, calls } = fakeClient([{ state: "failed", error: "cli-not-found" }]);
    const flow = new LoginFlowController({ providerId: "codex", client });
    await flow.start();
    await flush();
    expect(flow.getSnapshot()).toMatchObject({ status: "failed", errorCode: "cli-not-found" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.state).toBe(1);
  });

  it("keeps free-text failures as the message without inventing a code", async () => {
    const { client } = fakeClient([{ state: "failed", error: "The browser window was closed." }]);
    const flow = new LoginFlowController({ providerId: "codex", client });
    await flow.start();
    await flush();
    expect(flow.getSnapshot()).toMatchObject({
      status: "failed",
      errorCode: null,
      error: "The browser window was closed.",
    });
  });

  it("maps a start error code (cli-not-found, already-connected) to a failed state", async () => {
    const { client } = fakeClient([], new ApiError("cli-not-found", 400, "cli-not-found"));
    const flow = new LoginFlowController({ providerId: "codex", client });
    await flow.start();
    expect(flow.getSnapshot()).toMatchObject({ status: "failed", errorCode: "cli-not-found" });
  });

  it("gives up after three failed status checks, but tolerates two", async () => {
    const { client } = fakeClient([new Error("net"), new Error("net"), { state: "waitingForBrowser" }]);
    const flow = new LoginFlowController({ providerId: "codex", client });
    await flow.start();
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(flow.getSnapshot().status).toBe("waitingForBrowser");

    const second = fakeClient([new Error("net")]);
    const dead = new LoginFlowController({ providerId: "codex", client: second.client });
    await dead.start();
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    expect(dead.getSnapshot()).toMatchObject({ status: "failed", errorCode: "status-unreachable" });
    expect(second.calls.state).toBe(3);
  });

  it("treats a 404 on status as a lost flow immediately", async () => {
    const { client } = fakeClient([new ApiError("HTTP 404", 404, null)]);
    const flow = new LoginFlowController({ providerId: "codex", client });
    await flow.start();
    await flush();
    expect(flow.getSnapshot()).toMatchObject({ status: "failed", errorCode: "flow-lost" });
  });

  it("cancel stops polling, tells the server, and reports cancelled", async () => {
    const { client, calls } = fakeClient([{ state: "waitingForBrowser" }]);
    const flow = new LoginFlowController({ providerId: "codex", client });
    await flow.start();
    await flush();
    await flow.cancel();
    expect(flow.getSnapshot().status).toBe("cancelled");
    expect(calls.cancel).toEqual(["flow-1"]);
    const polls = calls.state;
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls.state).toBe(polls);
  });

  it("drops a flow whose start resolves after a reset", async () => {
    let resolveStart: (value: { flowId: string }) => void = () => undefined;
    const cancelled: string[] = [];
    const client: LoginClient = {
      start: () => new Promise((resolve) => (resolveStart = resolve)),
      state: async () => ({ state: "waitingForBrowser" }),
      code: async () => undefined,
      cancel: async (id) => {
        cancelled.push(id);
      },
    };
    const flow = new LoginFlowController({ providerId: "codex", client });
    const started = flow.start();
    flow.reset();
    resolveStart({ flowId: "late" });
    await started;
    expect(cancelled).toEqual(["late"]);
    expect(flow.getSnapshot().status).toBe("idle");
  });

  it("ignores a second start while one is running", async () => {
    const { client, calls } = fakeClient([{ state: "waitingForBrowser" }]);
    const flow = new LoginFlowController({ providerId: "codex", client });
    await flow.start();
    await flow.start();
    expect(calls.start).toHaveLength(1);
  });

  it("submits a trimmed code only while a flow is running and reports failures", async () => {
    const { client, calls } = fakeClient([{ state: "waitingForBrowser" }]);
    const flow = new LoginFlowController({ providerId: "codex", client });
    await flow.submitCode("abc");
    expect(calls.code).toEqual([]);
    await flow.start();
    await flush();
    await flow.submitCode("  abc123  ");
    expect(calls.code).toEqual(["abc123"]);

    const failing: LoginClient = { ...client, code: async () => Promise.reject(new Error("Bad code")) };
    const other = new LoginFlowController({ providerId: "codex", client: failing });
    await other.start();
    await flush();
    await other.submitCode("x");
    expect(other.getSnapshot().codeError).toBe("Bad code");
  });

  it("abandon cancels a running flow on the server", async () => {
    const { client, calls } = fakeClient([{ state: "waitingForBrowser" }]);
    const flow = new LoginFlowController({ providerId: "codex", client });
    await flow.start();
    await flush();
    flow.abandon();
    expect(calls.cancel).toEqual(["flow-1"]);
  });
});

describe("login errors", () => {
  it("recognises the codes in the contract and the legacy Claude spelling", () => {
    expect(knownErrorCode("cli-not-found")).toBe("cli-not-found");
    expect(knownErrorCode("claude-not-found")).toBe("cli-not-found");
    expect(knownErrorCode("too-many-flows")).toBe("too-many-flows");
    expect(knownErrorCode("Something odd")).toBeNull();
    expect(knownErrorCode(undefined)).toBeNull();
  });

  it("describes codes in plain words and passes free text through", () => {
    expect(describeLoginError("cli-not-found", null)).toMatch(/not found/);
    expect(describeLoginError(null, "Closed the window")).toBe("Closed the window");
    expect(describeLoginError(null, null)).toMatch(/failed/i);
  });
});

describe("createLoginClient", () => {
  type Call = { path: string; init?: RequestInit | undefined };
  function recorder(handler: (call: Call) => unknown) {
    const calls: Call[] = [];
    const send = async <T>(path: string, init?: RequestInit): Promise<T> => {
      const call = { path, init };
      calls.push(call);
      const out = handler(call);
      if (out instanceof Error) throw out;
      return out as T;
    };
    return { calls, send };
  }

  it("uses the generic routes", async () => {
    const { calls, send } = recorder(({ path }) =>
      path.endsWith("/login/start") ? { flowId: "f" } : { state: "waitingForBrowser", url: "https://x.test" },
    );
    const client = createLoginClient(send);
    await client.start("codex");
    expect(calls[0]!.path).toBe("/api/accounts/codex/login/start");
    expect(calls[0]!.init?.body).toBe("{}");
    expect(await client.state("f")).toEqual({ state: "waitingForBrowser", url: "https://x.test" });
    expect(calls[1]!.path).toBe("/api/accounts/flows/f");
    await client.code("f", "123");
    expect(calls[2]!.path).toBe("/api/accounts/flows/f/code");
    await client.cancel("f");
    expect(calls[3]).toMatchObject({ path: "/api/accounts/flows/f", init: { method: "DELETE" } });
  });

  it("falls back to the old Claude routes when the generic ones are missing", async () => {
    const { calls, send } = recorder(({ path }) => {
      if (path === "/api/accounts/claudeAgent/login/start") return new ApiError("HTTP 404", 404, null);
      if (path === "/api/accounts/claude/start") return { flowId: "old" };
      return { state: "connected" };
    });
    const client = createLoginClient(send);
    await expect(client.start("claudeAgent")).resolves.toEqual({ flowId: "old" });
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ name: "main" });
    expect(await client.state("old")).toEqual({ state: "connected" });
    expect(calls[2]!.path).toBe("/api/accounts/claude/old");
    await client.code("old", "c");
    expect(calls[3]!.path).toBe("/api/accounts/claude/old/code");
  });

  it("does not fall back for other providers, or for errors other than 404", async () => {
    const missing = recorder(() => new ApiError("HTTP 404", 404, null));
    await expect(createLoginClient(missing.send).start("codex")).rejects.toBeInstanceOf(ApiError);
    expect(missing.calls).toHaveLength(1);

    const busy = recorder(() => new ApiError("already-running", 409, "already-running"));
    await expect(createLoginClient(busy.send).start("claudeAgent")).rejects.toMatchObject({ code: "already-running" });
    expect(busy.calls).toHaveLength(1);
  });
});
