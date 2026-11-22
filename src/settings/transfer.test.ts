import { afterEach, describe, expect, it, vi } from "vitest";

import { cloneDefaults } from "./migrate";
import type { AppSettings } from "./schema";
import {
  buildExportFileName,
  diffSettings,
  downloadTextFile,
  errorMessage,
  EXPORT_APP,
  EXPORT_SCHEMA_VERSION,
  formatBytes,
  hasResetLosses,
  parseSettingsImport,
  previewImport,
  replaceImportLosses,
  resetLosses,
  resetSettings,
  serializeSettingsExport,
  type SettingsExport,
} from "./transfer";

afterEach(() => {
  vi.unstubAllGlobals();
});

const sampleExport: SettingsExport = {
  app: EXPORT_APP,
  schemaVersion: EXPORT_SCHEMA_VERSION,
  exportedAt: "2026-11-20T10:30:00.000Z",
  settings: { general: { language: "en" }, usage: { currency: "USD" } } as unknown as AppSettings,
};

describe("buildExportFileName", () => {
  it("uses the UTC date of the export", () => {
    expect(buildExportFileName("2026-11-20T10:30:00Z")).toBe("burnrate-settings-2026-11-20.json");
    expect(buildExportFileName("2026-01-02T23:59:00Z")).toBe("burnrate-settings-2026-01-02.json");
  });

  it("accepts numbers and Date instances", () => {
    expect(buildExportFileName(Date.UTC(2026, 0, 2, 23, 59))).toBe("burnrate-settings-2026-01-02.json");
    expect(buildExportFileName(new Date(Date.UTC(2026, 11, 31, 0, 0)))).toBe(
      "burnrate-settings-2026-12-31.json",
    );
  });

  it("handles an invalid date", () => {
    expect(buildExportFileName("not-a-date")).toBe("burnrate-settings-unknown.json");
    expect(buildExportFileName(new Date(Number.NaN))).toBe("burnrate-settings-unknown.json");
  });
});

describe("serializeSettingsExport", () => {
  it("produces stable, pretty JSON ending in a newline", () => {
    const text = serializeSettingsExport(sampleExport);
    expect(text).toBe(`${JSON.stringify(sampleExport, null, 2)}\n`);
    expect(text).toContain('"app": "burnrate"');
    expect(text.endsWith("}\n")).toBe(true);
  });
});

describe("parseSettingsImport", () => {
  it("extracts settings from a valid export", () => {
    const parsed = parseSettingsImport(JSON.stringify(sampleExport));
    expect(parsed.settings).toEqual(sampleExport.settings);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.exportedAt).toBe("2026-11-20T10:30:00.000Z");
  });

  it("accepts v1 exports", () => {
    expect(parseSettingsImport(JSON.stringify({ ...sampleExport, schemaVersion: 1 })).schemaVersion).toBe(1);
  });

  it("keeps unknown wrapper fields out and tolerates missing metadata", () => {
    const parsed = parseSettingsImport(
      JSON.stringify({ app: EXPORT_APP, settings: { general: {} }, extra: "ignored" }),
    );
    expect(parsed).toEqual({ settings: { general: {} }, schemaVersion: null, exportedAt: null });
  });

  it("rejects malformed, foreign and broken files", () => {
    expect(() => parseSettingsImport("{")).toThrow(/not valid JSON/);
    expect(() => parseSettingsImport("[]")).toThrow(/Burnrate settings export/);
    expect(() => parseSettingsImport("null")).toThrow(/Burnrate settings export/);
    expect(() => parseSettingsImport(JSON.stringify({ ...sampleExport, app: "other" }))).toThrow(
      /not a Burnrate/,
    );
    expect(() => parseSettingsImport(JSON.stringify({ ...sampleExport, schemaVersion: 9 }))).toThrow(
      /unsupported version/,
    );
    expect(() => parseSettingsImport(JSON.stringify({ ...sampleExport, settings: null }))).toThrow(
      /missing its settings/,
    );
    expect(() => parseSettingsImport(JSON.stringify({ ...sampleExport, settings: [] }))).toThrow(
      /missing its settings/,
    );
  });
});

describe("diffSettings", () => {
  it("lists only changed leaves with dotted paths", () => {
    const before = { general: { language: "en", hideSensitive: false }, usage: { currency: "USD" } };
    const after = { general: { language: "de", hideSensitive: false }, usage: { currency: "USD" } };
    expect(diffSettings(before, after)).toEqual([
      { path: "general.language", before: "en", after: "de" },
    ]);
  });

  it("treats arrays and scalars atomically and reports additions/removals", () => {
    expect(diffSettings({ a: [1, 2] }, { a: [1, 3] })).toEqual([
      { path: "a", before: [1, 2], after: [1, 3] },
    ]);
    expect(diffSettings({ a: 1 }, {})).toEqual([{ path: "a", before: 1, after: undefined }]);
    expect(diffSettings({}, { b: 2 })).toEqual([{ path: "b", before: undefined, after: 2 }]);
  });

  it("returns sorted paths and honours a base path", () => {
    expect(diffSettings({ b: 1, a: 1 }, { b: 2, a: 2 }, "settings")).toEqual([
      { path: "settings.a", before: 1, after: 2 },
      { path: "settings.b", before: 1, after: 2 },
    ]);
  });

  it("returns no entries for identical objects", () => {
    expect(diffSettings({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([]);
    expect(diffSettings({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("formats bytes, KB, MB and GB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });

  it("renders an unknown size", () => {
    expect(formatBytes(null)).toBe("Unknown");
    expect(formatBytes(-1)).toBe("Unknown");
    expect(formatBytes(Number.NaN)).toBe("Unknown");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("Unknown");
  });
});

describe("downloadTextFile", () => {
  it("is a no-op outside a browser", () => {
    expect(() => downloadTextFile("x.json", "{}")).not.toThrow();
  });

  it("creates, clicks and removes a download anchor in a browser", () => {
    const anchor = {
      href: "",
      download: "",
      style: {} as Record<string, string>,
      click: vi.fn(),
      remove: vi.fn(),
    };
    const create = vi.fn(() => anchor);
    vi.stubGlobal("document", { createElement: create, body: { appendChild: vi.fn() } });
    vi.stubGlobal("Blob", class {});
    const createObjectURL = vi.fn(() => "blob:x");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    downloadTextFile("x.json", "{}");

    expect(create).toHaveBeenCalledWith("a");
    expect(anchor.href).toBe("blob:x");
    expect(anchor.download).toBe("x.json");
    expect(anchor.style.display).toBe("none");
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });
});

describe("misc helpers", () => {
  it("turns thrown values into messages", () => {
    expect(errorMessage(new Error("oops"))).toBe("oops");
    expect(errorMessage("bad")).toMatch(/try again/);
  });

  it("resetSettings posts a full reset with no section", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await resetSettings();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/settings/reset");
    expect(JSON.parse(String(init?.body))).toEqual({ scope: "all" });
  });
});

describe("previewImport (the import dialog's diff, per mode)", () => {
  const current = {
    ...cloneDefaults(),
    general: { ...cloneDefaults().general, language: "de", hideSensitive: true },
    appearance: {
      ...cloneDefaults().appearance,
      radius: 0.9,
      customThemes: { mine: { id: "mine", label: "Mine" } },
    },
    usage: { ...cloneDefaults().usage, usagePriceOverrides: { "gpt-x": {} }, usageModelAliases: { a: "b" } },
  } as unknown as AppSettings;
  const file = { general: { language: "fr" } };

  it("merge only lists what the file actually changes (it used to list every setting the file omits as 'not set')", () => {
    const paths = previewImport(current, file, "merge").map((entry) => entry.path);
    expect(paths).toEqual(["general.language"]);
  });

  it("replace also lists everything the file does not mention going back to its default", () => {
    const paths = previewImport(current, file, "replace").map((entry) => entry.path);
    expect(paths).toContain("general.language");
    expect(paths).toContain("general.hideSensitive");
    expect(paths).toContain("appearance.radius");
    expect(paths.some((path) => path.startsWith("appearance.customThemes.mine"))).toBe(true);
  });

  it("a file identical to the current settings changes nothing in either mode", () => {
    expect(previewImport(current, current as unknown as Record<string, unknown>, "merge")).toEqual([]);
    expect(previewImport(current, current as unknown as Record<string, unknown>, "replace")).toEqual([]);
  });

  it("folds the legacy top-level price map under usage like the server does", () => {
    const paths = previewImport(current, { usagePriceOverrides: { "gpt-y": { inputCostPerMillionTokens: 1 } } }, "merge").map(
      (entry) => entry.path,
    );
    expect(paths.some((path) => path.startsWith("usage.usagePriceOverrides.gpt-y"))).toBe(true);
    expect(paths.some((path) => path.startsWith("usagePriceOverrides"))).toBe(false);
  });
});

describe("reset and replace warnings", () => {
  const settings = {
    appearance: { customThemes: { a: {}, b: {} } },
    usage: { usagePriceOverrides: { m1: {} }, usageModelAliases: { x: "y", z: "y" } },
    providers: { overrides: { openrouter: { pollSeconds: 300 } } },
  } as unknown as AppSettings;

  it("'Reset all' counts custom themes, price overrides, aliases and provider overrides", () => {
    expect(resetLosses(settings)).toEqual({
      customThemes: 2,
      priceOverrides: 1,
      modelAliases: 2,
      providerOverrides: 1,
    });
  });

  it("nothing is lost when there is no user-made content", () => {
    expect(hasResetLosses(resetLosses({} as unknown as AppSettings))).toBe(false);
  });

  it("a replace import only loses entries the file does not bring back", () => {
    const losses = replaceImportLosses(settings, {
      appearance: { customThemes: { a: {} } },
      usage: { usagePriceOverrides: { m1: {} } },
    });
    expect(losses).toEqual({ customThemes: 1, priceOverrides: 0, modelAliases: 2, providerOverrides: 1 });
  });
});

