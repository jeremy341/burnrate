import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenVsxDisabledError,
  downloadOpenVsxTheme,
  isValidExtensionId,
  searchOpenVsxThemes,
} from "./themes";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Open VSX proxy client", () => {
  it("validates extension ids before they become urls", () => {
    expect(isValidExtensionId("demo.midnight")).toBe(true);
    expect(isValidExtensionId("GitHub.github-vscode-theme")).toBe(true);
    expect(isValidExtensionId("../etc/passwd")).toBe(false);
    expect(isValidExtensionId("demo")).toBe(false);
    expect(isValidExtensionId("demo.theme.extra")).toBe(false);
    expect(isValidExtensionId("demo%2etheme")).toBe(false);
  });

  it("turns 403 disabled into the enable-in-settings error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "disabled" }, 403)),
    );
    await expect(searchOpenVsxThemes("nord")).rejects.toBeInstanceOf(OpenVsxDisabledError);
    await expect(downloadOpenVsxTheme("demo.midnight")).rejects.toBeInstanceOf(
      OpenVsxDisabledError,
    );
  });

  it("sanitises search results and trims the query", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        extensions: [
          {
            id: "demo.midnight",
            publisher: "demo",
            extensionName: "midnight",
            name: "Midnight",
            description: "A dark theme",
            version: "1.0.0",
            downloadCount: 12.9,
            iconUrl: "https://open-vsx.org/api/icon.png",
            secretToken: "must not leak",
          },
          { id: "../bad", publisher: "bad", extensionName: "bad", name: "Bad" },
          {
            id: "demo.untrusted",
            publisher: "demo",
            extensionName: "untrusted",
            name: "Untrusted",
            downloadCount: Number.NaN,
            iconUrl: "https://evil.example/icon.png",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchOpenVsxThemes("  midnight ");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/themes/openvsx/search?q=midnight",
      expect.objectContaining({ headers: { "X-Burnrate": "1" } }),
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.downloadCount).toBe(12);
    expect(results[0]!.iconUrl).toBe("https://open-vsx.org/api/icon.png");
    expect(results[1]!.iconUrl).toBeNull();
    expect(results[1]!.downloadCount).toBe(0);
    expect(results[0]).not.toHaveProperty("secretToken");
  });

  it("returns no results for an empty query without calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchOpenVsxThemes("   ")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads raw VSIX bytes and derives the version from the filename", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("PK\u0003\u0004vsix", {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": 'attachment; filename="midnight-1.2.3.vsix"',
            },
          }),
      ),
    );
    const download = await downloadOpenVsxTheme("demo.midnight");
    expect(new TextDecoder().decode(download.bytes)).toBe("PK\u0003\u0004vsix");
    expect(download.filename).toBe("midnight-1.2.3.vsix");
    expect(download.version).toBe("1.2.3");
  });

  it("rejects oversized packages before reading the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("tiny", {
            status: 200,
            headers: { "content-length": String(6 * 1024 * 1024) },
          }),
      ),
    );
    await expect(downloadOpenVsxTheme("demo.midnight")).rejects.toThrow(/too large/);
  });

  it("refuses invalid ids without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadOpenVsxTheme("../evil")).rejects.toThrow(/not valid/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
