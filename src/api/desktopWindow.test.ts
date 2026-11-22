import { afterEach, describe, expect, it, vi } from "vitest";

import { desktopWindow, hasDesktopWindowControls } from "./desktopWindow";

afterEach(() => vi.unstubAllGlobals());

describe("desktopWindow", () => {
  it("requires a Tauri invoke bridge before the controls can appear", async () => {
    vi.stubGlobal("window", { __TAURI__: {} });
    expect(hasDesktopWindowControls()).toBe(false);
    await expect(desktopWindow.close()).rejects.toThrow("Desktop window controls are unavailable");
  });

  it("invokes the main-window commands and passes the native maximize state through", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });

    expect(hasDesktopWindowControls()).toBe(true);
    await desktopWindow.minimize();
    expect(await desktopWindow.isMaximized()).toBe(true);
    expect(await desktopWindow.toggleMaximize()).toBe(false);
    await desktopWindow.close();
    expect(invoke.mock.calls).toEqual([
      ["shell_minimize_main"],
      ["shell_main_is_maximized"],
      ["shell_toggle_main_maximize"],
      ["shell_close_main"],
    ]);
  });

  it("lets the caller handle a rejected native command", async () => {
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: { invoke: vi.fn().mockRejectedValue("window is closing") },
    });
    await expect(desktopWindow.minimize()).rejects.toBe("window is closing");
  });
});
