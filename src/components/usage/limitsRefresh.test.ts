import { afterEach, expect, it, vi } from "vitest";

import { api } from "~/api";

afterEach(() => vi.unstubAllGlobals());

it("forces explicit limits reads while ordinary reads use the scheduler cache", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  await api.limits();
  await api.limits(true);
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/limits", "/api/limits?force=1"]);
});
