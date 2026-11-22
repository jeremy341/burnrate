import { afterEach, describe, expect, it, vi } from "vitest";

import { importLocalKey } from "~/api/catalog";

function respond(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => vi.unstubAllGlobals());

describe("importLocalKey", () => {
  it("posts to the Mistral import route with the CSRF header and returns the source", async () => {
    respond(200, { ok: true, source: "OS keyring" });
    await expect(importLocalKey("mistral")).resolves.toEqual({ source: "OS keyring" });
    const [path, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/accounts/mistral/import-local");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Burnrate"]).toBe("1");
  });

  it("returns the account names the server saved for a multi-profile import, and nothing else", async () => {
    respond(200, { ok: true, source: "Mistral Vibe", imported: ["Vibe", "Vibe 2", 7, ""] });
    await expect(importLocalKey("mistral")).resolves.toEqual({
      source: "Mistral Vibe",
      imported: ["Vibe", "Vibe 2"],
    });
  });

  it("explains an empty Vibe instead of surfacing the raw error code", async () => {
    respond(404, { error: "no-local-key" });
    await expect(importLocalKey("mistral")).rejects.toThrow(/Vibe/);
  });

  it("passes through the server's rejection message", async () => {
    respond(400, { error: "Mistral did not accept the key Vibe holds (The key was rejected)." });
    await expect(importLocalKey("mistral")).rejects.toThrow(/did not accept/);
  });

  it("opts in to OpenCode Go and returns the real usage the server read", async () => {
    respond(200, { ok: true, source: "OpenCode", summary: "Go session 0% used" });
    await expect(importLocalKey("opencode-go")).resolves.toEqual({
      source: "OpenCode",
      summary: "Go session 0% used",
    });
    const [path] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(path).toBe("/api/accounts/opencode-go/import-local");
  });

  it("says there is no Go key in OpenCode and points at pasting one", async () => {
    respond(404, { error: "no-local-key" });
    await expect(importLocalKey("opencode-go")).rejects.toThrow(/No Go key found in OpenCode.*Paste/);
  });

  it("passes through why OpenCode's key was not usable", async () => {
    respond(400, { error: "OpenCode holds a key, but it has no Go plan or Go refused it. Paste a Go key instead." });
    await expect(importLocalKey("opencode-go")).rejects.toThrow(/no Go plan/);
  });
});
