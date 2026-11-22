// Shape validators for the documented Burnrate API (docs/CONTRACTS.md).
// Deliberately dependency-free: api.mjs runs with plain Node 24.
// Each validator throws ShapeError with a path ("accounts[2].windows[0].usedPercent: ...").

export class ShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ShapeError";
  }
}

export const PROVENANCE_VALUES = ["official", "unofficial", "statusline", "local", "estimated"];
export const WINDOW_KIND_VALUES = ["session", "weekly", "monthly", "other"];
export const WINDOW_STATE_VALUES = ["ok", "warn", "critical", "unavailable"];
export const BALANCE_KIND_VALUES = ["credit", "spend", "cap"];
export const DEFINITION_STATUS_VALUES = ["stable", "experimental", "disabled"];
export const DEFINITION_SOURCE_VALUES = ["builtin", "user"];
export const ALERT_KIND_VALUES = ["threshold", "runout", "reset", "login"];
export const ALERT_SEVERITY_VALUES = ["info", "warn", "critical"];

export function expect(condition, message) {
  if (!condition) throw new ShapeError(message);
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function expectObject(value, path) {
  expect(value !== null && typeof value === "object" && !Array.isArray(value), `${path}: expected object, got ${typeOf(value)}`);
  return value;
}

export function expectArray(value, path) {
  expect(Array.isArray(value), `${path}: expected array, got ${typeOf(value)}`);
  return value;
}

export function expectString(value, path, { optional = false } = {}) {
  if (optional && value === undefined) return value;
  expect(typeof value === "string", `${path}: expected string, got ${typeOf(value)}`);
  return value;
}

export function expectNumber(value, path, { optional = false, min, max, integer = false } = {}) {
  if (optional && value === undefined) return value;
  expect(typeof value === "number" && Number.isFinite(value), `${path}: expected finite number, got ${typeOf(value)}`);
  if (integer) expect(Number.isInteger(value), `${path}: expected integer, got ${value}`);
  if (min !== undefined) expect(value >= min, `${path}: expected >= ${min}, got ${value}`);
  if (max !== undefined) expect(value <= max, `${path}: expected <= ${max}, got ${value}`);
  return value;
}

export function expectBoolean(value, path, { optional = false } = {}) {
  if (optional && value === undefined) return value;
  expect(typeof value === "boolean", `${path}: expected boolean, got ${typeOf(value)}`);
  return value;
}

export function expectEnum(value, values, path) {
  expect(values.includes(value), `${path}: expected one of ${values.join("|")}, got ${JSON.stringify(value)}`);
  return value;
}

export function expectIsoDate(value, path) {
  expectString(value, path);
  expect(!Number.isNaN(Date.parse(value)), `${path}: expected an ISO date, got ${JSON.stringify(value)}`);
  return value;
}

export function expectArrayOf(value, path, validate) {
  const list = expectArray(value, path);
  list.forEach((item, index) => validate(item, `${path}[${index}]`));
  return list;
}

/** Runs a validator only when the field is present and not null. */
export function expectOptional(value, path, validate) {
  if (value === undefined || value === null) return value;
  return validate(value, path);
}

export function expectStringArray(value, path) {
  return expectArrayOf(value, path, (item, itemPath) => expectString(item, itemPath));
}

/** Accepts an array or an object whose `keys` hold the array (envelopes are not pinned yet). */
export function unwrapList(value, keys, path) {
  if (Array.isArray(value)) return value;
  expectObject(value, path);
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  expect(false, `${path}: expected an array or {${keys.join("|")}: []}, got ${JSON.stringify(Object.keys(value))}`);
}

/** Structural equality that ignores object key order (the mirrors are serialized independently). */
export function deepEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (typeof left !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key]));
}

export function validateBalance(value, path = "balance") {
  expectObject(value, path);
  expectString(value.id, `${path}.id`);
  expectString(value.label, `${path}.label`);
  expectEnum(value.kind, BALANCE_KIND_VALUES, `${path}.kind`);
  expectNumber(value.amount, `${path}.amount`);
  expectString(value.currency, `${path}.currency`);
  expectOptional(value.limit, `${path}.limit`, expectNumber);
  expectOptional(value.resetsAt, `${path}.resetsAt`, expectIsoDate);
  expectOptional(value.provenance, `${path}.provenance`, (entry, entryPath) => expectEnum(entry, PROVENANCE_VALUES, entryPath));
  return value;
}

export function validateWindow(value, path = "window") {
  expectObject(value, path);
  expectString(value.id, `${path}.id`);
  expectEnum(value.kind, WINDOW_KIND_VALUES, `${path}.kind`);
  expectString(value.label, `${path}.label`);
  expectNumber(value.usedPercent, `${path}.usedPercent`, { min: 0, max: 100 });
  expectOptional(value.resetsAt, `${path}.resetsAt`, expectIsoDate);
  expectOptional(value.windowDurationMins, `${path}.windowDurationMins`, (entry, entryPath) => expectNumber(entry, entryPath, { min: 0 }));
  expectOptional(value.provenance, `${path}.provenance`, (entry, entryPath) => expectEnum(entry, PROVENANCE_VALUES, entryPath));
  return value;
}

export function validateUsageLimits(value, path = "limits") {
  expectObject(value, path);
  expectIsoDate(value.checkedAt, `${path}.checkedAt`);
  expectArrayOf(value.windows, `${path}.windows`, validateWindow);
  expectOptional(value.balances, `${path}.balances`, (list, listPath) =>
    expectArrayOf(list, listPath, validateBalance),
  );
  expectOptional(value.unavailable, `${path}.unavailable`, (entry, entryPath) => {
    expectObject(entry, entryPath);
    expectEnum(entry.reason, ["unsupported", "probeFailed"], `${entryPath}.reason`);
    expectOptional(entry.message, `${entryPath}.message`, expectString);
  });
  return value;
}

export function validateLimitsAccount(value, path = "account") {
  expectObject(value, path);
  expectString(value.id, `${path}.id`);
  expectString(value.driver, `${path}.driver`);
  expectString(value.label, `${path}.label`);
  expectOptional(value.plan, `${path}.plan`, expectString);
  validateUsageLimits(value.limits, `${path}.limits`);
  return value;
}

/** `GET /api/limits`: the existing LimitsReport shape (createdAt, accounts, notices). */
export function validateLimitsReport(value) {
  expectObject(value, "limitsReport");
  expectIsoDate(value.createdAt, "limitsReport.createdAt");
  expectArrayOf(value.accounts, "limitsReport.accounts", validateLimitsAccount);
  expectStringArray(value.notices, "limitsReport.notices");
  return value;
}

export function validateCompactWindow(value, path = "window") {
  expectObject(value, path);
  expectString(value.id, `${path}.id`);
  expectEnum(value.kind, WINDOW_KIND_VALUES, `${path}.kind`);
  expectString(value.label, `${path}.label`);
  expectNumber(value.usedPercent, `${path}.usedPercent`, { min: 0, max: 100 });
  expectNumber(value.remainingPercent, `${path}.remainingPercent`, { min: 0, max: 100 });
  expectEnum(value.state, WINDOW_STATE_VALUES, `${path}.state`);
  expectOptional(value.resetsAt, `${path}.resetsAt`, expectIsoDate);
  expectOptional(value.windowMinutes, `${path}.windowMinutes`, (entry, entryPath) => expectNumber(entry, entryPath, { min: 0 }));
  expectOptional(value.paceDelta, `${path}.paceDelta`, expectNumber);
  expectOptional(value.provenance, `${path}.provenance`, (entry, entryPath) => expectEnum(entry, PROVENANCE_VALUES, entryPath));
  return value;
}

export function validateCompactAccount(value, path = "account") {
  expectObject(value, path);
  expectString(value.id, `${path}.id`);
  expectString(value.provider, `${path}.provider`);
  expectString(value.label, `${path}.label`);
  expectOptional(value.plan, `${path}.plan`, expectString);
  expectArrayOf(value.windows, `${path}.windows`, validateCompactWindow);
  expectOptional(value.balances, `${path}.balances`, (list, listPath) =>
    expectArrayOf(list, listPath, validateBalance),
  );
  expectOptional(value.unavailable, `${path}.unavailable`, expectObject);
  return value;
}

/** `GET /api/status` (docs/CONTRACTS.md section 8). */
export function validateCompactStatus(value) {
  expectObject(value, "status");
  expectIsoDate(value.checkedAt, "status.checkedAt");
  expectString(value.hostLabel, "status.hostLabel");
  expectArrayOf(value.accounts, "status.accounts", validateCompactAccount);
  expectStringArray(value.notices, "status.notices");
  expectOptional(value.worst, "status.worst", (entry, path) => {
    expectObject(entry, path);
    expectString(entry.accountId, `${path}.accountId`);
    expectString(entry.provider, `${path}.provider`);
    expectString(entry.windowId, `${path}.windowId`);
    expectString(entry.label, `${path}.label`);
    expectNumber(entry.remainingPercent, `${path}.remainingPercent`, { min: 0, max: 100 });
    expectOptional(entry.resetsAt, `${path}.resetsAt`, expectIsoDate);
  });
  return value;
}

/** `GET /api/providers` (pre-existing route: ProviderInfo[]). */
export function validateProviderInfo(value, path = "provider") {
  expectObject(value, path);
  expectString(value.id, `${path}.id`);
  expectString(value.label, `${path}.label`);
  expectString(value.color, `${path}.color`);
  expectString(value.auth, `${path}.auth`);
  expectBoolean(value.connected, `${path}.connected`);
  expectArrayOf(value.accounts, `${path}.accounts`, (account, accountPath) => {
    expectObject(account, accountPath);
    expectString(account.id, `${accountPath}.id`);
    expectString(account.label, `${accountPath}.label`);
  });
  return value;
}

export function validateProviders(value) {
  return expectArrayOf(value, "providers", validateProviderInfo);
}

/** `GET /api/usage`: the existing UsageSummary shape (contractVersion, buckets, sources, pricing). */
export function validateUsageSummary(value) {
  expectObject(value, "usage");
  expectNumber(value.contractVersion, "usage.contractVersion", { integer: true, min: 1 });
  expectIsoDate(value.readAt, "usage.readAt");
  expectString(value.timeZone, "usage.timeZone");
  expectString(value.sinceDay, "usage.sinceDay");
  expectString(value.untilDay, "usage.untilDay");
  expectArray(value.buckets, "usage.buckets");
  expectArray(value.sources, "usage.sources");
  expectObject(value.pricing, "usage.pricing");
  expectNumber(value.scanDurationMs, "usage.scanDurationMs", { min: 0 });
  return value;
}

/** `GET /api/settings`: AppSettings v2. `legacyMirrors` also requires the two top-level mirrors. */
export function validateSettings(value, { legacyMirrors = false } = {}) {
  expectObject(value, "settings");
  expectNumber(value.schemaVersion, "settings.schemaVersion", { integer: true });
  expect(value.schemaVersion === 2, `settings.schemaVersion: expected 2, got ${value.schemaVersion}`);
  for (const section of [
    "general",
    "appearance",
    "usage",
    "providers",
    "notifications",
    "shell",
    "advanced",
  ]) {
    expectObject(value[section], `settings.${section}`);
  }
  expectEnum(value.appearance.themeMode, ["system", "light", "dark"], "settings.appearance.themeMode");
  expectNumber(value.usage.refreshIntervalSec, "settings.usage.refreshIntervalSec", { min: 30 });
  expectNumber(value.usage.historyDays, "settings.usage.historyDays", { min: 0 });
  expectObject(value.usage.usagePriceOverrides, "settings.usage.usagePriceOverrides");
  expectObject(value.usage.usageModelAliases, "settings.usage.usageModelAliases");
  if (legacyMirrors) {
    // Kept until the UI migrates (CONTRACTS section 2): they must equal the nested maps.
    expectObject(value.usagePriceOverrides, "settings.usagePriceOverrides (legacy mirror)");
    expectObject(value.usageModelAliases, "settings.usageModelAliases (legacy mirror)");
    expect(
      deepEqual(value.usagePriceOverrides, value.usage.usagePriceOverrides),
      "settings.usagePriceOverrides (legacy mirror): does not equal settings.usage.usagePriceOverrides",
    );
    expect(
      deepEqual(value.usageModelAliases, value.usage.usageModelAliases),
      "settings.usageModelAliases (legacy mirror): does not equal settings.usage.usageModelAliases",
    );
  }
  return value;
}

/** `POST /api/settings/export`: no secrets, just the settings document. */
export function validateSettingsExport(value) {
  expectObject(value, "export");
  expect(value.app === "burnrate", `export.app: expected "burnrate", got ${JSON.stringify(value.app)}`);
  expect(value.schemaVersion === 2, `export.schemaVersion: expected 2, got ${value.schemaVersion}`);
  expectIsoDate(value.exportedAt, "export.exportedAt");
  validateSettings(value.settings);
  return value;
}

export function validateDefinition(value, path = "definition") {
  expectObject(value, path);
  expectString(value.id, `${path}.id`);
  expectEnum(value.status, DEFINITION_STATUS_VALUES, `${path}.status`);
  expectEnum(value.source, DEFINITION_SOURCE_VALUES, `${path}.source`);
  expectOptional(value.label, `${path}.label`, expectString);
  return value;
}

/** `GET /api/defs`: the envelope is not pinned; accept [] or {definitions|defs|items}.[]. */
export function validateDefinitions(value) {
  const list = unwrapList(value, ["definitions", "defs", "items"], "defs");
  list.forEach((entry, index) => validateDefinition(entry, `defs[${index}]`));
  return list;
}

/** `GET /api/defs/catalog`: catalog.json is an array; accept {catalog} too. */
export function validateCatalog(value) {
  const list = unwrapList(value, ["catalog", "definitions", "items"], "catalog");
  list.forEach((entry, index) => {
    const path = `catalog[${index}]`;
    expectObject(entry, path);
    expectString(entry.id, `${path}.id`);
    expectString(entry.label, `${path}.label`);
    expectBoolean(entry.hasDefinition, `${path}.hasDefinition`);
    expectOptional(entry.baseUrl, `${path}.baseUrl`, expectString);
    expectOptional(entry.docs, `${path}.docs`, expectString);
    expectOptional(entry.note, `${path}.note`, expectString);
    expectOptional(entry.envVars, `${path}.envVars`, expectStringArray);
  });
  return list;
}

/** `POST /api/defs/validate` -> {ok, errors[]}. */
export function validateDefinitionCheck(value) {
  expectObject(value, "validate");
  expectBoolean(value.ok, "validate.ok");
  // Entries are plain strings or `{ field?, message }` objects; the UI accepts both.
  expect(Array.isArray(value.errors), "validate.errors: expected an array");
  value.errors.forEach((entry, i) =>
    expect(typeof entry === "string" || (entry && typeof entry === "object" && typeof entry.message === "string"), `validate.errors[${i}]: expected a string or {message}`),
  );
  if (!value.ok) expect(value.errors.length > 0, "validate.errors: must explain why a definition is invalid");
  return value;
}

export function validateBudget(value, path = "budget") {
  expectObject(value, path);
  expectString(value.id, `${path}.id`);
  expectString(value.label, `${path}.label`);
  expectNumber(value.monthlyBudget, `${path}.monthlyBudget`, { min: 0 });
  expectString(value.currency, `${path}.currency`);
  expectNumber(value.resetDay, `${path}.resetDay`, { integer: true, min: 1, max: 28 });
  expectObject(value.match, `${path}.match`);
  expectOptional(value.match.providers, `${path}.match.providers`, expectStringArray);
  expectOptional(value.match.models, `${path}.match.models`, expectStringArray);
  expectOptional(value.color, `${path}.color`, expectString);
  return value;
}

/** `GET /api/budgets` -> Budget[]. */
export function validateBudgets(value) {
  return expectArrayOf(value, "budgets", validateBudget);
}

/** `GET /api/secrets/<scope>` -> [{name, set: true}] (values are never returned). */
export function validateSecretList(value) {
  return expectArrayOf(value, "secrets", (entry, path) => {
    expectObject(entry, path);
    expectString(entry.name, `${path}.name`);
    expect(entry.set === true, `${path}.set: expected true`);
    expect(!("value" in entry), `${path}: the server must never return secret values`);
  });
}

/** `GET /api/history` -> {series: [{accountId, windowId, points:[[tsMs, usedPercent]]}]}. */
export function validateHistory(value) {
  expectObject(value, "history");
  expectArrayOf(value.series, "history.series", (series, path) => {
    expectObject(series, path);
    expectString(series.accountId, `${path}.accountId`);
    expectString(series.windowId, `${path}.windowId`);
    const points = expectArray(series.points, `${path}.points`);
    expect(points.length <= 500, `${path}.points: expected at most 500 downsampled points, got ${points.length}`);
    points.forEach((point, index) => {
      const pointPath = `${path}.points[${index}]`;
      expectArray(point, pointPath);
      expect(point.length === 2, `${pointPath}: expected [tsMs, usedPercent]`);
      expectNumber(point[0], `${pointPath}[0]`);
      expectNumber(point[1], `${pointPath}[1]`, { min: 0, max: 100 });
    });
  });
  return value;
}

export function validateAlertEvent(value, path = "alert") {
  expectObject(value, path);
  expectString(value.id, `${path}.id`);
  const ts = value.ts;
  expect(
    (typeof ts === "string" && !Number.isNaN(Date.parse(ts))) || (typeof ts === "number" && Number.isFinite(ts)),
    `${path}.ts: expected an ISO string or epoch milliseconds`,
  );
  expectEnum(value.kind, ALERT_KIND_VALUES, `${path}.kind`);
  expectString(value.accountId, `${path}.accountId`);
  expectString(value.provider, `${path}.provider`);
  expectString(value.title, `${path}.title`);
  expectString(value.body, `${path}.body`);
  expectEnum(value.severity, ALERT_SEVERITY_VALUES, `${path}.severity`);
  expectOptional(value.windowId, `${path}.windowId`, expectString);
  expectOptional(value.usedPercent, `${path}.usedPercent`, expectNumber);
  return value;
}

export function validateAlertEventList(value, path = "alerts") {
  const list = Array.isArray(value) ? value : unwrapList(value, ["events", "recent", "alerts"], path);
  list.forEach((entry, index) => validateAlertEvent(entry, `${path}[${index}]`));
  return list;
}

/** `GET /api/alerts/state`: snooze + last events. The envelope is loose, the event shape is not. */
export function validateAlertsState(value) {
  expectObject(value, "alertsState");
  const nested =
    value.state !== null && typeof value.state === "object" && !Array.isArray(value.state)
      ? value.state
      : null;
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const hasSnooze = hasOwn(value, "snoozedUntil") || (nested !== null && hasOwn(nested, "snoozedUntil"));
  const events =
    value.lastEvents ?? value.events ?? value.recent ?? nested?.lastEvents ?? nested?.events;
  expect(hasSnooze || Array.isArray(events), "alertsState: expected snoozedUntil or an events array");
  if (hasSnooze) {
    const snoozedUntil = hasOwn(value, "snoozedUntil") ? value.snoozedUntil : nested?.snoozedUntil;
    expect(
      snoozedUntil === null || typeof snoozedUntil === "string",
      "alertsState.snoozedUntil: expected an ISO string or null",
    );
    if (typeof snoozedUntil === "string") expectIsoDate(snoozedUntil, "alertsState.snoozedUntil");
  }
  if (events !== undefined) validateAlertEventList(events, "alertsState.events");
  return value;
}

/** `GET /api/diagnostics`. */
export function validateDiagnostics(value) {
  expectObject(value, "diagnostics");
  expectString(value.version, "diagnostics.version");
  expectString(value.os, "diagnostics.os");
  expectString(value.arch, "diagnostics.arch");
  expectString(value.dataDir, "diagnostics.dataDir");
  expectNumber(value.uptimeSec, "diagnostics.uptimeSec", { min: 0 });
  expect(
    value.memoryMB === null || (typeof value.memoryMB === "number" && Number.isFinite(value.memoryMB)),
    "diagnostics.memoryMB: expected a number or null",
  );
  expectNumber(value.settingsSizeBytes, "diagnostics.settingsSizeBytes", { min: 0 });
  expectObject(value.cacheSizes, "diagnostics.cacheSizes");
  expectArrayOf(value.providers, "diagnostics.providers", (provider, path) => {
    expectObject(provider, path);
    expectString(provider.id, `${path}.id`);
    expect(
      provider.lastProbeMs === null || (typeof provider.lastProbeMs === "number" && Number.isFinite(provider.lastProbeMs)),
      `${path}.lastProbeMs: expected a number or null`,
    );
    expect(
      provider.lastError === null || typeof provider.lastError === "string",
      `${path}.lastError: expected a string or null`,
    );
  });
  return value;
}

/** `GET /api/update-check` (only when general.checkForUpdates is true). */
export function validateUpdateCheck(value) {
  expectObject(value, "updateCheck");
  expectString(value.current, "updateCheck.current");
  // `latest` and `url` are null while checking for updates is off (the default) or no release is known.
  expect(value.latest === null || typeof value.latest === "string", "updateCheck.latest: expected a string or null");
  expect(value.url === null || typeof value.url === "string", "updateCheck.url: expected a string or null");
  expectBoolean(value.newer, "updateCheck.newer");
  return value;
}

/**
 * A valid definition used by `POST /api/defs/validate` and the user-definition round-trip.
 * It points at example.com and is only ever parsed, never fetched (except defs/test with a
 * deliberately missing key, which must fail before the network).
 */
export const SMOKE_DEFINITION_TOML = `# Burnrate smoke definition (never fetched)
schema = 1
id = "smoke-test"
label = "Smoke Test"
color = "#6467f2"
status = "experimental"
docs = "https://example.com/burnrate-smoke"
auth = "apiKey"
key_hosts = ["example.com"]
poll_seconds = 300
plan = "Smoke"

[[request]]
id = "key"
method = "GET"
url = "https://example.com/api/v1/key"
headers = { Authorization = "Bearer {{key}}" }
timeout_seconds = 10

[[window]]
id = "key_limit"
kind = "monthly"
label = "Key limit"
from = "key"
used = "$.data.used"
limit = "$.data.limit"
provenance = "official"
`;
