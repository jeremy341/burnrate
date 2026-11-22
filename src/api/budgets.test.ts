import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deleteBudget,
  emptyBudget,
  listBudgets,
  saveBudget,
  type Budget,
} from "./budgets";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const budget: Budget = {
  id: "personal",
  label: "Personal API key",
  monthlyBudget: 25,
  currency: "USD",
  resetDay: 5,
  match: { providers: ["anthropic"], models: ["claude-"] },
  color: "#6467f2",
};

describe("emptyBudget", () => {
  it("creates a blank draft with the default currency", () => {
    expect(emptyBudget("EUR")).toMatchObject({
      label: "",
      monthlyBudget: 0,
      currency: "EUR",
      resetDay: 1,
      match: { providers: [], models: [] },
    });
    expect(emptyBudget("EUR")).not.toHaveProperty("color");
  });

  it("falls back to USD and generates a safe, unique id", () => {
    const first = emptyBudget("");
    const second = emptyBudget("");
    expect(first.currency).toBe("USD");
    expect(first.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.id.length).toBeGreaterThan(0);
    expect(first.id.length).toBeLessThanOrEqual(18);
    expect(first.id).not.toBe(second.id);
  });
});

describe("listBudgets", () => {
  it("returns only entries with a string id and label", async () => {
    const calls = mockFetch(() =>
      jsonResponse([budget, { id: "partial", label: "Partial" }, { id: "no-label" }, null, 7, "text"]),
    );
    const result = await listBudgets();
    expect(result.map((entry) => entry.id)).toEqual(["personal", "partial"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/budgets");
    expect(calls[0]!.init?.method).toBeUndefined();
  });

  it("returns an empty list when the server does not send an array", async () => {
    mockFetch(() => jsonResponse({ budgets: [budget] }));
    await expect(listBudgets()).resolves.toEqual([]);
  });
});

describe("saveBudget", () => {
  it("PUTs the budget to an encoded id and returns the saved value", async () => {
    const calls = mockFetch(({ url }) => jsonResponse({ ...budget, id: url }));
    const saved = await saveBudget("personal/budget 1", budget);

    expect(saved.id).toBe("/api/budgets/personal%2Fbudget%201");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/budgets/personal%2Fbudget%201");
    expect(calls[0]!.init?.method).toBe("PUT");
    expect(calls[0]!.init?.body).toBe(JSON.stringify(budget));
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Burnrate"]).toBe("1");
  });
});

describe("deleteBudget", () => {
  it("accepts an empty 204 response without reading a body", async () => {
    let jsonCalls = 0;
    mockFetch(
      () =>
        ({
          ok: true,
          status: 204,
          json: async () => {
            jsonCalls += 1;
            throw new Error("no body");
          },
        }) as unknown as Response,
    );
    await expect(deleteBudget("personal/budget")).resolves.toBeUndefined();
    expect(jsonCalls).toBe(0);
  });

  it("sends DELETE to the encoded id", async () => {
    const calls = mockFetch(() => jsonResponse(undefined));
    await deleteBudget("a b/c");
    expect(calls[0]!.url).toBe("/api/budgets/a%20b%2Fc");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  it("uses the server error message when there is one", async () => {
    mockFetch(() => jsonResponse({ error: "budget is in use" }, false, 409));
    await expect(deleteBudget("personal")).rejects.toThrow("budget is in use");
  });

  it("falls back to the status code for non-JSON errors", async () => {
    mockFetch(
      () =>
        ({
          ok: false,
          status: 500,
          json: async () => {
            throw new Error("not json");
          },
        }) as unknown as Response,
    );
    await expect(deleteBudget("personal")).rejects.toThrow("HTTP 500");
  });
});
