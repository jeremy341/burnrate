import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";

import {
  createOpenVsxSearch,
  finalizeOpenVsxThemes,
  openVsxCollectionId,
  openVsxThemeId,
  parseVsixThemes,
  type OpenVsxSearchView,
  type OpenVsxThemeExtension,
} from "~/openVsxThemes";
import { getThemeModes } from "~/themePalette";

const encoder = new TextEncoder();

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

interface ZipFixtureEntry {
  name: string;
  text?: string;
  bytes?: Uint8Array;
  method?: 0 | 8;
  /** Override the size written to the central directory (for limit tests). */
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
}

/** Minimal ZIP writer for tests: local headers, central directory, EOCD. */
function pushAll(target: number[], bytes: ArrayLike<number>): void {
  for (let index = 0; index < bytes.length; index += 1) target.push(bytes[index]!);
}

function buildZip(entries: ReadonlyArray<ZipFixtureEntry>): Uint8Array {
  const body: number[] = [];
  const central: number[] = [];
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = entry.bytes ?? encoder.encode(entry.text ?? "");
    const method = entry.method ?? 0;
    const compressed =
      method === 8 ? new Uint8Array(deflateRawSync(Buffer.from(raw))) : raw;
    const localOffset = body.length;
    body.push(
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(compressed.byteLength),
      ...u32(raw.byteLength),
      ...u16(name.byteLength),
      ...u16(0),
    );
    pushAll(body, name);
    pushAll(body, compressed);
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(entry.declaredCompressedSize ?? compressed.byteLength),
      ...u32(entry.declaredUncompressedSize ?? raw.byteLength),
      ...u16(name.byteLength),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(localOffset),
    );
    pushAll(central, name);
  }
  const directoryOffset = body.length;
  pushAll(body, central);
  body.push(
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(directoryOffset),
    ...u16(0),
  );
  return new Uint8Array(body);
}

const manifest = (themes: Array<{ label: string; uiTheme: string; path: string }>) =>
  JSON.stringify({
    publisher: "demo",
    name: "midnight",
    version: "1.0.0",
    displayName: "Midnight",
    contributes: { themes },
  });

const darkTheme = JSON.stringify({
  name: "midnight",
  type: "dark",
  colors: {
    "editor.background": "#101014",
    "editor.foreground": "#d8d8e0",
    focusBorder: "#7aa2f7",
    "button.background": "#7aa2f7",
    "button.foreground": "#ffffff",
    "sideBar.background": "#0b0b0e",
  },
});

const lightTheme = JSON.stringify({
  name: "midnight-light",
  type: "light",
  colors: {
    "editor.background": "#f7f7fb",
    "editor.foreground": "#23232b",
    focusBorder: "#4b5bd6",
    "sideBar.background": "#ededf4",
  },
});

function multiThemeVsix(method: 0 | 8 = 0): Uint8Array {
  return buildZip([
    {
      name: "extension/package.json",
      text: manifest([
        { label: "Midnight", uiTheme: "vs-dark", path: "./themes/midnight-color-theme.json" },
        { label: "Midnight Light", uiTheme: "vs", path: "themes/midnight-light.json" },
      ]),
      method,
    },
    { name: "extension/themes/midnight-color-theme.json", text: darkTheme, method },
    { name: "extension/themes/midnight-light.json", text: lightTheme, method },
    // Not declared in contributes.themes: must never be read.
    { name: "extension/themes/undeclared.json", text: "{ this is not json", method },
  ]);
}

describe("VSIX parsing", () => {
  it("reads only the themes declared in package.json (stored entries)", async () => {
    const result = await parseVsixThemes(multiThemeVsix(0));
    expect(result.failures).toEqual([]);
    expect(result.themes.map((entry) => entry.theme.label)).toEqual(["Midnight", "Midnight Light"]);
    expect(result.themes[0]!.theme.appearance).toBe("dark");
    expect(result.themes[1]!.theme.appearance).toBe("light");
    expect(result.themes[0]!.sourcePath).toBe("extension/themes/midnight-color-theme.json");
  });

  it("inflates deflated entries", async () => {
    const result = await parseVsixThemes(multiThemeVsix(8));
    expect(result.themes.map((entry) => entry.theme.label)).toEqual(["Midnight", "Midnight Light"]);
  });

  it("resolves include chains inside the package", async () => {
    const zip = buildZip([
      {
        name: "extension/package.json",
        text: manifest([{ label: "Included", uiTheme: "vs-dark", path: "themes/child.json" }]),
      },
      {
        name: "extension/themes/base.json",
        text: JSON.stringify({
          colors: {
            "editor.background": "#101014",
            "editor.foreground": "#d8d8e0",
            focusBorder: "#7aa2f7",
          },
        }),
      },
      {
        name: "extension/themes/child.json",
        text: JSON.stringify({
          include: "./base.json",
          colors: { "sideBar.background": "#0b0b0e" },
        }),
      },
    ]);
    const result = await parseVsixThemes(zip);
    const theme = result.themes[0]!.theme;
    expect(theme.label).toBe("Included");
    expect(theme.colors.sidebar).toBeTruthy();
    expect(theme.colors.canvas).toBeTruthy();
  });

  it("keeps the readable themes when one declared theme is broken", async () => {
    const zip = buildZip([
      {
        name: "extension/package.json",
        text: manifest([
          { label: "Broken", uiTheme: "vs-dark", path: "themes/broken.json" },
          { label: "Working", uiTheme: "vs-dark", path: "themes/working.json" },
        ]),
      },
      { name: "extension/themes/broken.json", text: JSON.stringify({ colors: {} }) },
      { name: "extension/themes/working.json", text: darkTheme },
    ]);
    const result = await parseVsixThemes(zip);
    expect(result.themes.map((entry) => entry.theme.label)).toEqual(["Working"]);
    expect(result.failures).toHaveLength(1);
  });

  it("refuses packages whose manifest does not match the selected extension", async () => {
    await expect(
      parseVsixThemes(multiThemeVsix(), { expected: { id: "other.extension" } }),
    ).rejects.toThrow(/does not match/);
    await expect(
      parseVsixThemes(multiThemeVsix(), { expected: { id: "demo.midnight", version: "9.9.9" } }),
    ).rejects.toThrow(/does not match/);
    await expect(
      parseVsixThemes(multiThemeVsix(), { expected: { id: "demo.midnight", version: "1.0.0" } }),
    ).resolves.toBeTruthy();
  });

  it("rejects path traversal, duplicate entries and zip bombs", async () => {
    await expect(
      parseVsixThemes(
        buildZip([
          { name: "extension/package.json", text: manifest([]) },
          { name: "../evil.json", text: "{}" },
        ]),
      ),
    ).rejects.toThrow(/safe relative package path|escapes the extension package/);

    await expect(
      parseVsixThemes(
        buildZip([
          { name: "extension/package.json", text: manifest([]) },
          { name: "extension/themes/a.json", text: darkTheme },
          { name: "extension/themes/a.json", text: lightTheme },
        ]),
      ),
    ).rejects.toThrow(/duplicate files/);

    await expect(
      parseVsixThemes(
        buildZip([
          {
            name: "extension/package.json",
            text: manifest([]),
            declaredCompressedSize: 10,
            declaredUncompressedSize: 10_000_000,
          },
        ]),
      ),
    ).rejects.toThrow(/compression ratio|safe import limit/);

    await expect(parseVsixThemes(new Uint8Array([1, 2, 3]))).rejects.toThrow(/ZIP directory/);
  });

  it("caps a single theme file at 256 KiB", async () => {
    const huge = `{"colors":{"editor.background":"#101014"},"padding":"${randomBytes(220 * 1024).toString("base64")}"}`;
    const zip = buildZip([
      {
        name: "extension/package.json",
        text: manifest([
          { label: "Huge", uiTheme: "vs-dark", path: "themes/huge.json" },
          { label: "Small", uiTheme: "vs-dark", path: "themes/small.json" },
        ]),
      },
      { name: "extension/themes/huge.json", text: huge, method: 8 },
      { name: "extension/themes/small.json", text: darkTheme, method: 8 },
    ]);
    const result = await parseVsixThemes(zip);
    expect(result.themes.map((entry) => entry.theme.label)).toEqual(["Small"]);
    expect(result.failures.join(" ")).toMatch(/too large/);
  });

  it("rejects packages without themes", async () => {
    await expect(
      parseVsixThemes(
        buildZip([{ name: "extension/package.json", text: manifest([]) }]),
      ),
    ).rejects.toThrow(/does not contain color themes/);
  });
});

describe("Open VSX identity", () => {
  const extension: OpenVsxThemeExtension = {
    id: "demo.midnight",
    publisher: "demo",
    extensionName: "midnight",
    name: "Midnight",
    description: "",
    version: "1.0.0",
    downloadCount: 12,
    iconUrl: null,
    collectionId: openVsxCollectionId("demo.midnight"),
  };

  it("builds valid, stable theme and collection ids", async () => {
    expect(extension.collectionId).toBe("open-vsx:demo.midnight");
    expect(openVsxThemeId("Demo.Midnight", "a")).toBe(openVsxThemeId("demo.midnight", "a"));
    expect(openVsxThemeId("demo.midnight", "a")).toMatch(/^ovx-theme-[a-f0-9]{12}$/);

    const { themes } = await parseVsixThemes(multiThemeVsix());
    const first = finalizeOpenVsxThemes(extension, themes);
    const again = finalizeOpenVsxThemes(extension, themes);
    expect(first.map((theme) => theme.id)).toEqual(again.map((theme) => theme.id));
    expect(new Set(first.map((theme) => theme.id)).size).toBe(first.length);
    expect(first.every((theme) => theme.collection?.id === "open-vsx:demo.midnight")).toBe(true);
  });

  it("pairs matching light and dark themes before assigning ids", async () => {
    const zip = buildZip([
      {
        name: "extension/package.json",
        text: manifest([
          { label: "Nord Dark", uiTheme: "vs-dark", path: "themes/nord-dark.json" },
          { label: "Nord Light", uiTheme: "vs", path: "themes/nord-light.json" },
        ]),
      },
      { name: "extension/themes/nord-dark.json", text: darkTheme },
      { name: "extension/themes/nord-light.json", text: lightTheme },
    ]);
    const { themes } = await parseVsixThemes(zip);
    const final = finalizeOpenVsxThemes(extension, themes);
    expect(final).toHaveLength(1);
    expect(final[0]!.label).toBe("Nord");
    expect(getThemeModes(final[0]!)).toEqual(["light", "dark"]);
  });
});

describe("search session controller", () => {
  const extension: OpenVsxThemeExtension = {
    id: "demo.midnight",
    publisher: "demo",
    extensionName: "midnight",
    name: "Midnight",
    description: "dark",
    version: "1.0.0",
    downloadCount: 2,
    iconUrl: null,
    collectionId: openVsxCollectionId("demo.midnight"),
  };

  function view() {
    const state: {
      results: ReadonlyArray<OpenVsxThemeExtension> | null;
      error: string | null;
      isSearching: boolean;
    } = { results: null, error: null, isSearching: false };
    const controller: OpenVsxSearchView = {
      setResults: (results) => {
        state.results = results;
      },
      setError: (error) => {
        state.error = error;
      },
      setIsSearching: (isSearching) => {
        state.isSearching = isSearching;
      },
    };
    return { state, controller };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces typing and shows the results", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => [extension]);
    const { state, controller } = view();
    const session = createOpenVsxSearch(controller, new AbortController().signal, {
      search: search as never,
      debounceMs: 350,
    });

    session.setQuery("drac");
    await vi.advanceTimersByTimeAsync(349);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("drac", { signal: expect.any(AbortSignal) });
    expect(state.results).toEqual([extension]);
    expect(state.isSearching).toBe(false);
  });

  it("searches immediately on Enter and reports errors", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => {
      throw new Error("Open VSX search is off.");
    });
    const { state, controller } = view();
    const session = createOpenVsxSearch(controller, new AbortController().signal, {
      search: search as never,
      debounceMs: 350,
    });

    session.setQuery("nord");
    session.searchNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(search).toHaveBeenCalledTimes(1);
    expect(state.error).toBe("Open VSX search is off.");
    expect(state.results).toBeNull();
  });

  it("cancels a pending debounce when the dialog closes", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => [extension]);
    const abort = new AbortController();
    const { controller } = view();
    const session = createOpenVsxSearch(controller, abort.signal, {
      search: search as never,
      debounceMs: 350,
    });

    session.setQuery("tokyo");
    abort.abort();
    await vi.advanceTimersByTimeAsync(500);
    expect(search).not.toHaveBeenCalled();
  });

  it("clears results when the query is emptied", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => [extension]);
    const { state, controller } = view();
    const session = createOpenVsxSearch(controller, new AbortController().signal, {
      search: search as never,
      debounceMs: 1,
    });
    session.setQuery("nord");
    await vi.advanceTimersByTimeAsync(1);
    expect(state.results).toEqual([extension]);
    session.setQuery("");
    expect(state.results).toBeNull();
    expect(state.error).toBeNull();
  });
});
