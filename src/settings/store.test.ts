import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "./schema";
import { DEBOUNCE_MS, MIRROR_KEY } from "./store";
import { deepMerge, type StorageLike } from "./migrate";
import type { AppSettings } from "./schema";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

interface Harness {
  calls: FetchCall[];
  memory: Map<string, string>;
  serverState: () => unknown;
  store: typeof import("./store");
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

let harness: Harness | null = null;

async function setup(options: { server?: unknown; failPatch?: boolean } = {}): Promise<Harness> {
  vi.resetModules();
  const calls: FetchCall[] = [];
  const memory = new Map<string, string>();
  let serverState: unknown = options.server ?? structuredClone(DEFAULT_SETTINGS);
  const failPatch = options.failPatch ?? false;

  const storage: StorageLike = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, String(value));
    },
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url !== "/api/settings") return jsonResponse({}, false, 404);
      if (method === "PATCH") {
        if (failPatch) {
          return jsonResponse({ error: "invalid settings", field: "general.hideSensitive" }, false, 400);
        }
        serverState = deepMerge(serverState, (body as { patch: unknown }).patch);
        return jsonResponse(serverState);
      }
      return jsonResponse(serverState);
    }),
  );

  const store = await import("./store");
  harness = { calls, memory, serverState: () => serverState, store };
  return harness;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  harness = null;
});

/** Fake `/api/stream` + `document` so SSE snapshots can be driven in tests. */
function installFakeStream() {
  const listeners = new Map<string, Array<() => void>>();
  let hidden = false;
  vi.stubGlobal("document", {
    get hidden() {
      return hidden;
    },
    addEventListener: (type: string, cb: () => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), cb]);
    },
    removeEventListener: (type: string, cb: () => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== cb));
    },
  });
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    readonly events = new Map<string, Array<(event: unknown) => void>>();
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(readonly url: string) {
      FakeEventSource.instances.push(this);
    }
    addEventListener(type: string, cb: (event: unknown) => void) {
      this.events.set(type, [...(this.events.get(type) ?? []), cb]);
    }
    emit(type: string, data: unknown) {
      this.events.get(type)?.forEach((cb) => cb({ data: JSON.stringify(data) }));
    }
    close() {
      this.closed = true;
    }
  }
  vi.stubGlobal("EventSource", FakeEventSource);
  return { instances: FakeEventSource.instances, listeners, setHidden: (value: boolean) => { hidden = value; } };
}

describe("settings store", () => {
  it("loads server settings, fills defaults and writes the first-paint mirror", async () => {
    const { store, memory } = await setup({
      server: { schemaVersion: 2, appearance: { radius: 0.4 } },
    });
    await store.loadSettings();
    expect(store.getSettings().appearance.radius).toBe(0.4);
    expect(store.getSettings().general.language).toBe(DEFAULT_SETTINGS.general.language);
    expect(JSON.parse(memory.get(MIRROR_KEY)!).appearance.radius).toBe(0.4);
  });

  it("coalesces rapid patches into one debounced PATCH", async () => {
    const { store, calls } = await setup();
    vi.useFakeTimers();
    await store.loadSettings();

    const first = store.updateSettings({ appearance: { radius: 0.8 } });
    const second = store.updateSettings({
      general: { hideSensitive: true },
      usage: { usageModelAliases: { foo: "bar" } },
    });
    expect(store.getSettings().appearance.radius).toBe(0.8); // optimistic
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);

    const patches = calls.filter((call) => call.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({
      patch: {
        appearance: { radius: 0.8 },
        general: { hideSensitive: true },
        usage: { usageModelAliases: { foo: "bar" } },
      },
    });
    expect(store.getSettings().general.hideSensitive).toBe(true);
    expect(store.getSettingsError()).toBeNull();
  });

  it("rolls back to the confirmed state and surfaces the error on a failed PATCH", async () => {
    const { store, memory } = await setup({ failPatch: true });
    vi.useFakeTimers();
    await store.loadSettings();
    const before = store.getSettings();

    const rejected = expect(store.updateSettings({ general: { hideSensitive: true } })).rejects.toThrow(
      "invalid settings",
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await rejected;

    expect(store.getSettings()).toEqual(before);
    expect(store.getSettingsError()?.message).toContain("invalid settings");
    expect(store.getSettingsError()?.field).toBe("general.hideSensitive"); // ApiError keeps the rejected field
    expect(JSON.parse(memory.get(MIRROR_KEY)!).general.hideSensitive).toBe(before.general.hideSensitive);
    store.clearSettingsError();
    expect(store.getSettingsError()).toBeNull();
  });

  it("deletes map entries with null and folds legacy top-level mirrors into usage", async () => {
    const server = structuredClone(DEFAULT_SETTINGS);
    server.usage.usagePriceOverrides = {};
    server.usage.usageModelAliases = { a: "b", c: "d" };
    const { store, serverState } = await setup({ server });
    vi.useFakeTimers();
    await store.loadSettings();

    const apply = store.updateSettings({ usage: { usageModelAliases: { a: null } } });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await apply;

    expect((serverState() as AppSettings).usage.usageModelAliases).toEqual({ c: "d" });
    expect(store.getSettings().usage.usageModelAliases).toEqual({ c: "d" });
  });

  it("does not let a refetch clobber unconfirmed optimistic edits", async () => {
    const { store } = await setup();
    vi.useFakeTimers();
    await store.loadSettings();
    const pending = store.updateSettings({ general: { hideSensitive: true } });
    await store.loadSettings();
    expect(store.getSettings().general.hideSensitive).toBe(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await pending;
    expect(store.getSettings().general.hideSensitive).toBe(true);
  });

  it("signals a failed pending save to operations waiting to use the saved settings", async () => {
    const { store } = await setup({ failPatch: true });
    void store.updateSettings({ general: { hideSensitive: true } });
    await expect(store.flushSettings()).rejects.toThrow("invalid settings");
  });

  it("ignores a delayed GET that predates a confirmed write", async () => {
    const { store, memory } = await setup();
    await store.loadSettings();
    const stale = store.getSettings();
    const fetchSettings = vi.mocked(globalThis.fetch);
    let finishRead!: (response: Response) => void;
    fetchSettings.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));

    const read = store.loadSettings();
    const write = store.updateSettings({ appearance: { radius: 0.75 } });
    await store.flushSettings();
    await write;
    finishRead(jsonResponse(stale));
    await read;

    expect(store.getSettings().appearance.radius).toBe(0.75);
    expect(JSON.parse(memory.get(MIRROR_KEY)!).appearance.radius).toBe(0.75);
  });

  it("applies pushed settings while visible and pauses the stream when hidden", async () => {
    const { store } = await setup();

    const listeners = new Map<string, Array<() => void>>();
    let hidden = false;
    vi.stubGlobal("document", {
      get hidden() {
        return hidden;
      },
      addEventListener: (type: string, cb: () => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), cb]);
      },
      removeEventListener: (type: string, cb: () => void) => {
        listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== cb));
      },
    });

    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      readonly events = new Map<string, Array<(event: unknown) => void>>();
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
      }
      addEventListener(type: string, cb: (event: unknown) => void) {
        this.events.set(type, [...(this.events.get(type) ?? []), cb]);
      }
      emit(type: string, data: unknown) {
        this.events.get(type)?.forEach((cb) => cb({ data: JSON.stringify(data) }));
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);

    store.startSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the initial GET settle
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe("/api/stream");

    const pushed = structuredClone(DEFAULT_SETTINGS);
    pushed.appearance.radius = 0.75;
    FakeEventSource.instances[0]!.emit("settings", pushed);
    expect(store.getSettings().appearance.radius).toBe(0.75);

    hidden = true;
    listeners.get("visibilitychange")?.forEach((cb) => cb());
    expect(FakeEventSource.instances[0]!.closed).toBe(true);

    hidden = false;
    listeners.get("visibilitychange")?.forEach((cb) => cb());
    expect(FakeEventSource.instances).toHaveLength(2);

    store.stopSettingsSync();
    expect(FakeEventSource.instances[1]!.closed).toBe(true);
  });

  it("applies an edit immediately, without waiting for the network", async () => {
    const { store } = await setup();
    vi.useFakeTimers();
    await store.loadSettings();

    let resolvePatch!: (response: Response) => void;
    vi.mocked(globalThis.fetch).mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolvePatch = resolve; }),
    );

    const pending = store.updateSettings({ general: { hideSensitive: true } });
    // No await: the optimistic value is already in the store (and therefore on screen).
    expect(store.getSettings().general.hideSensitive).toBe(true);
    expect(store.getSettingsError()).toBeNull();

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    // The PATCH is in flight; the UI still shows the typed value.
    expect(store.getSettings().general.hideSensitive).toBe(true);

    const server = structuredClone(DEFAULT_SETTINGS);
    server.general.hideSensitive = true;
    resolvePatch(jsonResponse(server));
    await pending;
    expect(store.getSettings().general.hideSensitive).toBe(true);
  });

  it("rolls back and publishes a toast when a save fails", async () => {
    const { store } = await setup({ failPatch: true });
    const { toast } = await import("~/lib/toast");
    vi.useFakeTimers();
    await store.loadSettings();
    toast.clear();
    const before = store.getSettings();

    const rejected = expect(store.updateSettings({ general: { hideSensitive: true } })).rejects.toThrow("invalid settings");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await rejected;

    expect(store.getSettings()).toEqual(before);
    expect(toast.getSnapshot().some((item) => item.type === "error" && item.message.includes("invalid settings"))).toBe(true);
    toast.clear();
  });

  it("loads a server snapshot full of deprecated keys without erroring", async () => {
    const server = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
    const appearance = server.appearance as Record<string, unknown>;
    appearance.radius = "wide";
    appearance.density = 9;
    appearance.uiScale = -2;
    const advanced = server.advanced as Record<string, unknown>;
    advanced.experimental = { openVsx: "yes", random: [1, 2] };
    server.onboarded = "not-a-bool";

    const { store } = await setup({ server });
    await store.loadSettings();
    expect(store.getSettingsError()).toBeNull();
    const value = store.getSettings() as unknown as Record<string, unknown>;
    expect((value.appearance as Record<string, unknown>).radius).toBe("wide");
    expect((value.advanced as Record<string, unknown>).experimental).toEqual({ openVsx: "yes", random: [1, 2] });
    expect(value.onboarded).toBe("not-a-bool");
    // Live fields still work normally.
    expect(store.getSettings().general.hideSensitive).toBe(DEFAULT_SETTINGS.general.hideSensitive);
  });

  it("does not let a pushed snapshot overwrite a value the user is still typing", async () => {
    const { store } = await setup();
    const stream = installFakeStream();
    store.startSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0)); // initial GET
    vi.useFakeTimers();

    const pending = store.updateSettings({ general: { hideSensitive: true } });
    // The server still has the old value; its SSE snapshot must not clobber the optimistic edit.
    stream.instances[0]!.emit("settings", structuredClone(DEFAULT_SETTINGS));
    expect(store.getSettings().general.hideSensitive).toBe(true);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await pending;
    store.stopSettingsSync();
  });

  it("does not notify subscribers for an identical pushed snapshot", async () => {
    const { store } = await setup();
    const stream = installFakeStream();
    store.startSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0)); // initial GET

    const listener = vi.fn();
    store.subscribe(listener);
    stream.instances[0]!.emit("settings", structuredClone(DEFAULT_SETTINGS));
    expect(listener).not.toHaveBeenCalled();

    store.stopSettingsSync();
  });
});
