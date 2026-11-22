import { describe, expect, it } from "vitest";

import {
  ShapeError,
  SMOKE_DEFINITION_TOML,
  deepEqual,
  validateAlertEventList,
  validateAlertsState,
  validateBudgets,
  validateCatalog,
  validateCompactStatus,
  validateDefinitionCheck,
  validateDefinitions,
  validateDiagnostics,
  validateHistory,
  validateLimitsReport,
  validateSecretList,
  validateSettings,
  validateSettingsExport,
  validateUpdateCheck,
  validateUsageSummary,
} from "./shapes.mjs";

const settings = () => ({
  schemaVersion: 2,
  general: {},
  appearance: { themeMode: "system" },
  usage: {
    refreshIntervalSec: 120,
    historyDays: 90,
    usagePriceOverrides: { "gpt-5": { input: 1 } },
    usageModelAliases: { "gpt-5-latest": "gpt-5" },
  },
  providers: {},
  notifications: {},
  shell: {},
  advanced: {},
  usagePriceOverrides: { "gpt-5": { input: 1 } },
  usageModelAliases: { "gpt-5-latest": "gpt-5" },
});

const window = (overrides = {}) => ({
  id: "session",
  kind: "session",
  label: "Session",
  usedPercent: 27,
  remainingPercent: 73,
  state: "ok",
  ...overrides,
});

const status = (overrides = {}) => ({
  checkedAt: "2026-11-20T10:00:00.000Z",
  hostLabel: "smoke-pc",
  accounts: [
    {
      id: "claude-default",
      provider: "claudeAgent",
      label: "Claude",
      windows: [window()],
    },
  ],
  notices: [],
  ...overrides,
});

const alertEvent = (overrides = {}) => ({
  id: "evt-1",
  ts: "2026-11-20T10:00:00.000Z",
  kind: "threshold",
  accountId: "claude-default",
  provider: "claudeAgent",
  title: "Session at 80%",
  body: "Claude session passed 80% used.",
  severity: "warn",
  ...overrides,
});

const diagnostics = () => ({
  version: "0.1.0",
  os: "windows",
  arch: "x86_64",
  dataDir: "C:\\temp\\burnrate",
  uptimeSec: 12,
  memoryMB: null,
  settingsSizeBytes: 1200,
  cacheSizes: { providers: 3 },
  providers: [{ id: "claudeAgent", lastProbeMs: 42, lastError: null }],
});

describe("validateSettings", () => {
  it("accepts AppSettings v2 with matching legacy mirrors", () => {
    expect(validateSettings(settings(), { legacyMirrors: true }).appearance.themeMode).toBe("system");
  });

  it("does not require the legacy mirrors outside GET /api/settings", () => {
    const value = settings();
    delete value.usagePriceOverrides;
    delete value.usageModelAliases;
    expect(() => validateSettings(value)).not.toThrow();
    expect(() => validateSettings(value, { legacyMirrors: true })).toThrow(/legacy mirror/);
  });

  it("compares the mirrors structurally, ignoring key order", () => {
    expect(deepEqual({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("rejects v1 and mismatched mirrors", () => {
    expect(() => validateSettings({ ...settings(), schemaVersion: 1 })).toThrow(ShapeError);
    expect(() =>
      validateSettings({ ...settings(), usagePriceOverrides: { other: true } }, { legacyMirrors: true }),
    ).toThrow(/legacy mirror/);
  });

  it("rejects a refresh interval below the documented minimum", () => {
    const value = settings();
    value.usage.refreshIntervalSec = 5;
    expect(() => validateSettings(value)).toThrow(/refreshIntervalSec/);
  });
});

describe("validateCompactStatus", () => {
  it("accepts a compact status with worst and balances", () => {
    const value = status({
      accounts: [
        {
          id: "a",
          provider: "claudeAgent",
          label: "Claude",
          windows: [window({ provenance: "official", paceDelta: 3 })],
          balances: [{ id: "credits", label: "Credits", kind: "credit", amount: 4.5, currency: "USD" }],
        },
      ],
      worst: {
        accountId: "a",
        provider: "claudeAgent",
        windowId: "session",
        label: "Session",
        remainingPercent: 73,
      },
    });
    expect(() => validateCompactStatus(value)).not.toThrow();
  });

  it("rejects an out-of-range percent and a missing remainingPercent", () => {
    expect(() => validateCompactStatus(status({ accounts: [{ id: "a", provider: "p", label: "P", windows: [window({ usedPercent: 120 })] }] }))).toThrow(
      /usedPercent/,
    );
    const missing = window();
    delete missing.remainingPercent;
    expect(() => validateCompactStatus(status({ accounts: [{ id: "a", provider: "p", label: "P", windows: [missing] }] }))).toThrow(
      /remainingPercent/,
    );
  });

  it("validates worst when present", () => {
    expect(() => validateCompactStatus(status({ worst: { accountId: "a" } }))).toThrow(/worst\.provider/);
  });
});

describe("definition shapes", () => {
  it("accepts an array or a definitions envelope", () => {
    const entry = { id: "openrouter", status: "stable", source: "builtin" };
    expect(validateDefinitions([entry])).toHaveLength(1);
    expect(validateDefinitions({ definitions: [entry] })).toHaveLength(1);
  });

  it("rejects unknown status/source", () => {
    expect(() => validateDefinitions([{ id: "x", status: "beta", source: "builtin" }])).toThrow(/status/);
    expect(() => validateDefinitions([{ id: "x", status: "stable", source: "market" }])).toThrow(/source/);
  });

  it("accepts catalog entries and requires hasDefinition", () => {
    expect(validateCatalog({ catalog: [{ id: "x", label: "X", hasDefinition: true }] })).toHaveLength(1);
    expect(() => validateCatalog([{ id: "x", label: "X" }])).toThrow(/hasDefinition/);
  });

  it("requires errors when validate says not ok", () => {
    expect(() => validateDefinitionCheck({ ok: true, errors: [] })).not.toThrow();
    expect(() => validateDefinitionCheck({ ok: false, errors: [] })).toThrow(/must explain/);
  });

  it("ships a definition that targets example.com only", () => {
    expect(SMOKE_DEFINITION_TOML).toContain('id = "smoke-test"');
    expect(SMOKE_DEFINITION_TOML).toContain('url = "https://example.com/');
  });
});

describe("validateBudgets", () => {
  const budget = {
    id: "team",
    label: "Team",
    monthlyBudget: 25,
    currency: "USD",
    resetDay: 1,
    match: { providers: ["claude"], models: ["gpt-"] },
  };

  it("accepts the documented Budget shape", () => {
    expect(validateBudgets([budget])).toHaveLength(1);
  });

  it("rejects resetDay outside 1..28", () => {
    expect(() => validateBudgets([{ ...budget, resetDay: 29 }])).toThrow(/resetDay/);
  });
});

describe("validateHistory", () => {
  it("accepts points and enforces the 500 point cap", () => {
    expect(
      validateHistory({ series: [{ accountId: "a", windowId: "w", points: [[1, 10], [2, 11]] }] }),
    ).toBeTruthy();
    const points = Array.from({ length: 501 }, (_, index) => [index, 1]);
    expect(() => validateHistory({ series: [{ accountId: "a", windowId: "w", points }] })).toThrow(/500/);
  });

  it("rejects malformed points", () => {
    expect(() => validateHistory({ series: [{ accountId: "a", windowId: "w", points: [[1]] }] })).toThrow(
      /tsMs, usedPercent/,
    );
  });
});

describe("secrets", () => {
  it("accepts set flags and rejects leaked values", () => {
    expect(validateSecretList([{ name: "ntfy", set: true }])).toHaveLength(1);
    expect(() => validateSecretList([{ name: "ntfy", set: true, value: "x" }])).toThrow(/never return/);
    expect(() => validateSecretList([{ name: "ntfy", set: false }])).toThrow(/set/);
  });
});

describe("alerts", () => {
  it("accepts enough state to be useful and validates events", () => {
    expect(() => validateAlertsState({ snoozedUntil: null, lastEvents: [alertEvent()] })).not.toThrow();
    expect(() => validateAlertsState({ events: [] })).not.toThrow();
    expect(() => validateAlertsState({ state: { snoozedUntil: null }, events: [] })).not.toThrow();
    expect(() => validateAlertsState({})).toThrow(/snoozedUntil or an events array/);
    expect(() => validateAlertEventList([alertEvent({ severity: "urgent" })])).toThrow(/severity/);
    expect(validateAlertEventList({ recent: [alertEvent()] })).toHaveLength(1);
  });
});

describe("other documented payloads", () => {
  it("accepts diagnostics with a null RSS reading", () => {
    expect(() => validateDiagnostics(diagnostics())).not.toThrow();
    const missing = diagnostics();
    delete missing.version;
    expect(() => validateDiagnostics(missing)).toThrow(/version/);
  });

  it("accepts the UsageSummary shape", () => {
    expect(() =>
      validateUsageSummary({
        contractVersion: 6,
        readAt: "2026-11-20T10:00:00.000Z",
        timeZone: "UTC",
        sinceDay: "2026-11-13",
        untilDay: "2026-11-20",
        buckets: [],
        sources: [],
        pricing: {},
        scanDurationMs: 3,
      }),
    ).not.toThrow();
  });

  it("validates the export document and update check", () => {
    expect(() =>
      validateSettingsExport({
        app: "burnrate",
        schemaVersion: 2,
        exportedAt: "2026-11-20T10:00:00.000Z",
        settings: settings(),
      }),
    ).not.toThrow();
    expect(() =>
      validateUpdateCheck({ current: "0.1.0", latest: "0.1.0", url: "https://example.com", newer: false }),
    ).not.toThrow();
  });

  it("validates LimitsReport accounts", () => {
    expect(() =>
      validateLimitsReport({
        createdAt: "2026-11-20T10:00:00.000Z",
        accounts: [
          {
            id: "a",
            driver: "claudeAgent",
            label: "Claude",
            limits: { checkedAt: "2026-11-20T10:00:00.000Z", windows: [] },
          },
        ],
        notices: [],
      }),
    ).not.toThrow();
  });
});
