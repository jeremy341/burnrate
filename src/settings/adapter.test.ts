import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "./schema";
import type { StorageLike } from "./migrate";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

let bodies: unknown[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  bodies = [];
});

describe("useSettings adapter", () => {
  it("maps the legacy keys to v2 paths and never sends them to the server", async () => {
    vi.resetModules();
    bodies = [];
    vi.stubGlobal(
      "localStorage",
      { getItem: () => null, setItem: () => {} } satisfies StorageLike,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url !== "/api/settings") return jsonResponse({}, false);
        if (method === "PATCH") {
          bodies.push(JSON.parse(String(init!.body)));
          return jsonResponse(structuredClone(DEFAULT_SETTINGS));
        }
        return jsonResponse(structuredClone(DEFAULT_SETTINGS));
      }),
    );
    // Import after the fetch stub so both modules share one fresh store instance.
    const adapter = await import("~/hooks/useSettings");
    const store = await import("~/settings/store");

    const pending = adapter.updateSettings({
      theme: "dark",
      timestampFormat: "24-hour",
      hideSensitive: true,
    });
    await store.flushSettings();
    await pending;

    expect(bodies).toEqual([
      {
        patch: {
          appearance: { themeMode: "dark" },
          general: { timestampFormat: "24-hour", hideSensitive: true },
        },
      },
    ]);
  });
});
