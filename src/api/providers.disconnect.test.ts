import { describe, expect, it, vi } from "vitest";

import { ApiError } from "~/api/http";
import { disconnectLocalLogin, disconnectMessage } from "~/api/providers";

describe("disconnectLocalLogin", () => {
  it("posts to the Codex sign-out and the OpenCode Go disconnect routes", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    await disconnectLocalLogin("codex", send);
    await disconnectLocalLogin("opencode-go", send);
    expect(send).toHaveBeenNthCalledWith(1, "/api/accounts/codex/signout", { method: "POST" });
    expect(send).toHaveBeenNthCalledWith(2, "/api/accounts/opencode-go/disconnect", { method: "POST" });
  });

  it("turns the server codes into plain words", async () => {
    const send = vi.fn().mockRejectedValue(new ApiError("sign-out-failed", 500, "sign-out-failed"));
    await expect(disconnectLocalLogin("codex", send)).rejects.toThrow("Could not delete the Codex login file");
    expect(disconnectMessage("no-login", "codex")).toBe("Codex is already signed out.");
    expect(disconnectMessage(null, "opencode-go")).toBe("Could not disconnect OpenCode Go.");
  });
});
