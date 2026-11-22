#!/usr/bin/env node
// Checks every endpoint documented in docs/CONTRACTS.md against a real Burnrate server:
// status codes and required fields. Mutations run against a throwaway BURNRATE_DATA directory.
//
// Usage: node scripts/smoke/api.mjs [--port N] [--exe FILE] [--web DIR] [--base URL] [--keep] [--json]
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SMOKE_DEFINITION_TOML,
  deepEqual,
  expect,
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
  validateProviders,
  validateSecretList,
  validateSettings,
  validateSettingsExport,
  validateUpdateCheck,
  validateUsageSummary,
} from "./shapes.mjs";
import { removeTmpRoot, resolveServerExe, resolveWebDir, startServer } from "./server.mjs";
import {
  describeError,
  isoDay,
  isoNow,
  optionBoolean,
  optionNumber,
  optionString,
  parseArgs,
  sleep,
} from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const HELP = `Burnrate API contract check (docs/CONTRACTS.md)

Usage:
  node scripts/smoke/api.mjs [options]

Options:
  --port N       Server port when starting one (default: 13850)
  --exe FILE     burnrate-server binary (default: BURNRATE_SERVER_EXE / CARGO_TARGET_DIR / target/)
  --web DIR      Web build directory (default: BURNRATE_WEB or dist/web)
  --base URL     Check an already running server and leave it alone
  --open-data-dir  Also call POST /api/diagnostics/open-data-dir (opens the OS file manager)
  --keep         Keep the temporary data/home directory
  --json         Print a machine-readable summary
  --help         Show this help

Exit codes: 0 pass, 1 one or more checks failed, 2 setup problem.
`;

function truncate(text, limit = 300) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

async function waitForServer(baseUrl, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/providers`, { signal: AbortSignal.timeout(1_000) });
      if (response.status < 500) return;
    } catch {
      // not listening yet
    }
    await sleep(150);
  }
  throw new Error(`No Burnrate server answered on ${baseUrl} within ${timeoutMs} ms.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const port = optionNumber(options, "port", 13_850);
  const keep = optionBoolean(options, "keep");
  const asJson = optionBoolean(options, "json");
  const openDataDir = optionBoolean(options, "openDataDir");
  const baseOption = optionString(options, "base", "");
  const exeOption = optionString(options, "exe", "");
  const webOption = optionString(options, "web", "");

  let server = null;
  let baseUrl = baseOption ? baseOption.replace(/\/+$/, "") : "";
  if (!baseUrl) {
    const exe = exeOption ? path.resolve(ROOT, exeOption) : resolveServerExe({ root: ROOT });
    if (!exe) {
      throw new Error(
        "No server binary found. Build it (cargo build --manifest-path server-rs/Cargo.toml), " +
          "pass --exe, or set BURNRATE_SERVER_EXE.",
      );
    }
    const webDir = webOption ? path.resolve(ROOT, webOption) : resolveWebDir({ root: ROOT });
    // The API check does not render pages, so a web build is optional; the server still needs
    // a directory for BURNRATE_WEB, and the repo's dist/web is the normal one.
    server = await startServer({
      root: ROOT,
      exe,
      webDir: webDir ?? path.join(ROOT, "dist", "web"),
      port,
    });
    baseUrl = server.baseUrl;
  } else {
    await waitForServer(baseUrl);
  }

  const startedAt = isoNow();
  const results = [];
  if (!asJson) {
    console.log("Burnrate API contract check");
    console.log(`  base: ${baseUrl}`);
    if (server) console.log(`  data: ${server.dataDir}`);
    console.log("");
  }

  const check = async (name, action) => {
    const started = Date.now();
    try {
      await action();
      results.push({ name, ok: true, ms: Date.now() - started });
      if (!asJson) console.log(`ok   ${name}`);
      return true;
    } catch (error) {
      const message = describeError(error);
      results.push({ name, ok: false, error: message, ms: Date.now() - started });
      if (!asJson) console.error(`FAIL ${name}: ${message}`);
      return false;
    }
  };
  const skip = (name, reason) => {
    results.push({ name, ok: true, skipped: true, reason });
    if (!asJson) console.log(`skip ${name} (${reason})`);
  };

  const request = async (method, pathname, { body, headers = {}, timeoutMs = 20_000 } = {}) => {
    const requestHeaders = {
      ...(method === "GET" || method === "HEAD" ? {} : { "X-Burnrate": "1" }),
      ...headers,
    };
    let payload;
    if (body !== undefined) {
      requestHeaders["Content-Type"] = "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }
    const response = await fetch(baseUrl + pathname, {
      method,
      headers: requestHeaders,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  };

  const expectStatus = (result, expected, label) => {
    const allowed = Array.isArray(expected) ? expected : [expected];
    expect(
      allowed.includes(result.status),
      `${label}: expected HTTP ${allowed.join(" or ")}, got ${result.status} (${truncate(result.text)})`,
    );
    return result;
  };
  const expectJson = (result, label) => {
    expect(result.json !== null, `${label}: expected JSON, got ${truncate(result.text)}`);
    return result.json;
  };
  const hasId = (list, id) => list.some((entry) => entry.id === id);
  const findSnoozeTimestamp = (value, depth = 0) => {
    if (depth > 3 || value === null || typeof value !== "object") return undefined;
    for (const [key, entry] of Object.entries(value)) {
      if (/snooze/i.test(key) && entry != null) {
        if (typeof entry === "string") return entry;
        if (typeof entry === "object") {
          const date = Object.values(entry).find(
            (child) => typeof child === "string" && !Number.isNaN(Date.parse(child)),
          );
          if (date !== undefined) return date;
        }
      }
      if (entry !== null && typeof entry === "object") {
        const nested = findSnoozeTimestamp(entry, depth + 1);
        if (nested !== undefined) return nested;
      }
    }
    return undefined;
  };

  try {
    // ---------------------------------------------------------------- settings (CONTRACTS 2)
    await check("GET /api/settings -> AppSettings v2 + legacy mirrors", async () => {
      const result = await request("GET", "/api/settings");
      expectStatus(result, 200, "GET /api/settings");
      validateSettings(expectJson(result, "GET /api/settings"), { legacyMirrors: true });
    });

    await check("PATCH /api/settings deep-merges and keeps sibling fields", async () => {
      const result = await request("PATCH", "/api/settings", {
        body: { patch: { appearance: { radius: 0.42 } } },
      });
      expectStatus(result, 200, "PATCH /api/settings");
      const body = expectJson(result, "PATCH /api/settings");
      // The contract pins the merge, not whether PATCH echoes the document; accept {ok:true} + GET.
      const settings =
        body.appearance === undefined
          ? expectJson(await request("GET", "/api/settings"), "GET /api/settings after PATCH")
          : body;
      validateSettings(settings);
      expect(settings.appearance.radius === 0.42, `settings.appearance.radius: expected 0.42, got ${settings.appearance.radius}`);
      expect(
        settings.appearance.density === "comfortable",
        "PATCH replaced the whole appearance section instead of deep-merging it",
      );
    });

    await check("PATCH /api/settings rejects a bad field with {error,field}", async () => {
      const result = await request("PATCH", "/api/settings", {
        body: { patch: { appearance: { radius: "big" } } },
      });
      expectStatus(result, 400, "invalid PATCH /api/settings");
      const body = expectJson(result, "invalid PATCH /api/settings");
      expect(body.error === "invalid settings", `error: expected "invalid settings", got ${JSON.stringify(body.error)}`);
      expect(
        body.field === "appearance.radius",
        `field: expected "appearance.radius", got ${JSON.stringify(body.field)}`,
      );
    });

    await check("PATCH /api/settings rejects bodies over 1 MiB", async () => {
      try {
        const result = await request("PATCH", "/api/settings", {
          body: { patch: { general: { language: "x".repeat(1_100_000) } } },
          timeoutMs: 30_000,
        });
        expectStatus(result, [400, 413], "oversized PATCH /api/settings");
      } catch (error) {
        // A server that stops reading at the cap can reset the socket; that is still a rejection.
        if (!/fetch failed|ECONNRESET|socket|other side closed/i.test(describeError(error))) throw error;
      }
    });

    await check("non-GET /api requests require the X-Burnrate header", async () => {
      const response = await fetch(`${baseUrl}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: {} }),
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status === 403, `expected HTTP 403 without X-Burnrate, got ${response.status}`);
    });

    let exported = null;
    await check("POST /api/settings/export -> burnrate v2 document without secrets", async () => {
      const result = await request("POST", "/api/settings/export");
      expectStatus(result, 200, "POST /api/settings/export");
      exported = validateSettingsExport(expectJson(result, "POST /api/settings/export"));
      expect(
        !/\bsk-[A-Za-z0-9]|\bBearer\s+[A-Za-z0-9]/.test(result.text),
        "export looks like it contains a key or bearer token",
      );
    });

    await check("POST /api/settings/import merge returns the new settings", async () => {
      const result = await request("POST", "/api/settings/import", {
        body: { settings: { appearance: { radius: 0.55 } }, mode: "merge" },
      });
      expectStatus(result, 200, "POST /api/settings/import");
      const settings = validateSettings(expectJson(result, "POST /api/settings/import"));
      expect(settings.appearance.radius === 0.55, `settings.appearance.radius: expected 0.55, got ${settings.appearance.radius}`);
      expect(exported !== null, "export must pass before import is checked");
    });

    await check("POST /api/settings/reset {scope:all} restores defaults", async () => {
      const result = await request("POST", "/api/settings/reset", { body: { scope: "all" } });
      expectStatus(result, 200, "POST /api/settings/reset");
      const settings = validateSettings(expectJson(result, "POST /api/settings/reset"));
      expect(settings.appearance.radius === 0.5, `settings.appearance.radius: expected default 0.5, got ${settings.appearance.radius}`);
    });

    await check("POST /api/settings/reset {scope:section} resets one section", async () => {
      const changed = await request("PATCH", "/api/settings", {
        body: { patch: { appearance: { radius: 0.66 } } },
      });
      expectStatus(changed, 200, "PATCH before section reset");
      const result = await request("POST", "/api/settings/reset", {
        body: { scope: "section", section: "appearance" },
      });
      expectStatus(result, 200, "POST /api/settings/reset section");
      const settings = validateSettings(expectJson(result, "POST /api/settings/reset section"));
      expect(settings.appearance.radius === 0.5, `settings.appearance.radius: expected default 0.5, got ${settings.appearance.radius}`);
      expect(typeof settings.general.language === "string", "resetting one section must keep the others");
    });

    await check("legacy usagePriceOverrides PATCH stays accepted", async () => {
      const result = await request("PATCH", "/api/settings", {
        body: { patch: { usagePriceOverrides: { "smoke-model": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 } } } },
      });
      expectStatus(result, 200, "legacy PATCH /api/settings");
      validateSettings(expectJson(result, "legacy PATCH /api/settings"));
      // The mirrors are documented on GET, so verify them there.
      const after = await request("GET", "/api/settings");
      expectStatus(after, 200, "GET /api/settings after legacy patch");
      const settings = validateSettings(expectJson(after, "GET /api/settings after legacy patch"), {
        legacyMirrors: true,
      });
      expect(
        settings.usage.usagePriceOverrides["smoke-model"] !== undefined,
        "legacy patch did not reach settings.usage.usagePriceOverrides",
      );
      expect(
        deepEqual(settings.usagePriceOverrides, settings.usage.usagePriceOverrides),
        "legacy patch left the top-level mirror out of sync",
      );
    });

    // ---------------------------------------------------------------- status / core (CONTRACTS 8)
    await check("GET /api/status -> compact status", async () => {
      const result = await request("GET", "/api/status");
      expectStatus(result, 200, "GET /api/status");
      validateCompactStatus(expectJson(result, "GET /api/status"));
    });

    await check("GET /api/providers -> ProviderInfo[]", async () => {
      const result = await request("GET", "/api/providers");
      expectStatus(result, 200, "GET /api/providers");
      validateProviders(expectJson(result, "GET /api/providers"));
    });

    let apiKeyProviderId = null;
    await check("key management routes can store a throwaway API key", async () => {
      const list = await request("GET", "/api/providers");
      expectStatus(list, 200, "GET /api/providers for key management");
      const providers = validateProviders(expectJson(list, "GET /api/providers for key management"));
      const provider = providers.find((entry) => entry.auth === "apiKey");
      expect(provider !== undefined, "no API-key provider is exposed by GET /api/providers");
      apiKeyProviderId = provider.id;
      // A fake key: the smoke suite never uses a real credential and never probes the provider.
      const added = await request("POST", `/api/providers/${encodeURIComponent(provider.id)}/keys`, {
        body: { name: "smoke", apiKey: "smoke-key-0000000000" },
      });
      expectStatus(added, 200, "POST /api/providers/<id>/keys");
      const withKey = await request("GET", "/api/providers");
      const current = validateProviders(expectJson(withKey, "GET /api/providers after key add"));
      const target = current.find((entry) => entry.id === provider.id);
      expect(target?.accounts.some((account) => account.id === "smoke"), "the added key is not listed as an account");
      const renamed = await request(
        "PATCH",
        `/api/providers/${encodeURIComponent(provider.id)}/keys/smoke`,
        { body: { name: "smoke-renamed" } },
      );
      expectStatus(renamed, 200, "PATCH /api/providers/<id>/keys/<name>");
      const removed = await request(
        "DELETE",
        `/api/providers/${encodeURIComponent(provider.id)}/keys/smoke-renamed`,
      );
      expectStatus(removed, 200, "DELETE /api/providers/<id>/keys/<name>");
      const after = await request("GET", "/api/providers");
      const finalProviders = validateProviders(expectJson(after, "GET /api/providers after key delete"));
      const finalTarget = finalProviders.find((entry) => entry.id === provider.id);
      expect(
        !finalTarget?.accounts.some((account) => account.id === "smoke-renamed"),
        "the deleted key is still listed",
      );
    });
    if (apiKeyProviderId === null) {
      skip("key management routes", "no API-key provider is enabled in this build");
    }

    await check("GET /api/limits -> LimitsReport", async () => {
      const result = await request("GET", "/api/limits");
      expectStatus(result, 200, "GET /api/limits");
      validateLimitsReport(expectJson(result, "GET /api/limits"));
    });

    await check("GET /api/usage -> UsageSummary", async () => {
      const query = `?since=${isoDay(-7)}&until=${isoDay(0)}&tz=UTC`;
      const result = await request("GET", `/api/usage${query}`);
      expectStatus(result, 200, "GET /api/usage");
      validateUsageSummary(expectJson(result, "GET /api/usage"));
    });

    // ---------------------------------------------------------------- definitions (CONTRACTS 4)
    await check("GET /api/defs -> definitions with status + source", async () => {
      const result = await request("GET", "/api/defs");
      expectStatus(result, 200, "GET /api/defs");
      const definitions = validateDefinitions(expectJson(result, "GET /api/defs"));
      expect(definitions.length > 0, "GET /api/defs returned no built-in definitions");
    });

    await check("GET /api/defs/catalog -> catalog entries", async () => {
      const result = await request("GET", "/api/defs/catalog");
      expectStatus(result, 200, "GET /api/defs/catalog");
      const catalog = validateCatalog(expectJson(result, "GET /api/defs/catalog"));
      expect(catalog.length > 0, "catalog is empty (run scripts/build-catalog.mjs)");
    });

    await check("POST /api/defs/validate accepts a documented definition", async () => {
      const result = await request("POST", "/api/defs/validate", {
        body: { toml: SMOKE_DEFINITION_TOML },
      });
      expectStatus(result, 200, "POST /api/defs/validate");
      const body = validateDefinitionCheck(expectJson(result, "POST /api/defs/validate"));
      expect(body.ok, `validation rejected the smoke definition: ${body.errors.join("; ")}`);
    });

    await check("POST /api/defs/validate rejects TOML with errors", async () => {
      const result = await request("POST", "/api/defs/validate", { body: { toml: "schema = 1" } });
      expectStatus(result, 200, "POST /api/defs/validate (invalid)");
      const body = validateDefinitionCheck(expectJson(result, "POST /api/defs/validate (invalid)"));
      expect(!body.ok, "an incomplete definition must validate as ok=false");
    });

    await check("POST /api/defs/test with a missing key fails without a probe", async () => {
      const result = await request("POST", "/api/defs/test", {
        body: { toml: SMOKE_DEFINITION_TOML, keyName: "smoke-missing-key" },
      });
      expectStatus(result, [200, 400], "POST /api/defs/test");
      expectJson(result, "POST /api/defs/test");
    });

    await check("PUT/DELETE /api/defs/user/<id> round-trips a user definition", async () => {
      const put = await request("PUT", "/api/defs/user/smoke-test", {
        body: { toml: SMOKE_DEFINITION_TOML },
      });
      expectStatus(put, [200, 201, 204], "PUT /api/defs/user/smoke-test");
      const list = await request("GET", "/api/defs");
      expectStatus(list, 200, "GET /api/defs after PUT");
      const definitions = validateDefinitions(expectJson(list, "GET /api/defs after PUT"));
      const saved = definitions.find((entry) => entry.id === "smoke-test");
      expect(saved !== undefined, "the user definition is missing from GET /api/defs");
      expect(saved.source === "user", `saved definition source: expected "user", got ${JSON.stringify(saved.source)}`);
      const remove = await request("DELETE", "/api/defs/user/smoke-test");
      expectStatus(remove, [200, 204], "DELETE /api/defs/user/smoke-test");
      const after = await request("GET", "/api/defs");
      const remaining = validateDefinitions(expectJson(after, "GET /api/defs after DELETE"));
      expect(!hasId(remaining, "smoke-test"), "the deleted user definition is still listed");
    });

    // ---------------------------------------------------------------- budgets (CONTRACTS 5)
    await check("GET /api/budgets -> Budget[]", async () => {
      const result = await request("GET", "/api/budgets");
      expectStatus(result, 200, "GET /api/budgets");
      validateBudgets(expectJson(result, "GET /api/budgets"));
    });

    await check("PUT/GET/DELETE /api/budgets/<id> round-trips a budget", async () => {
      const budget = {
        id: "smoke-budget",
        label: "Smoke budget",
        monthlyBudget: 10,
        currency: "USD",
        resetDay: 1,
        match: { providers: ["claude"] },
        color: "#6467f2",
      };
      const put = await request("PUT", "/api/budgets/smoke-budget", { body: budget });
      expectStatus(put, [200, 201, 204], "PUT /api/budgets/smoke-budget");
      const list = await request("GET", "/api/budgets");
      expectStatus(list, 200, "GET /api/budgets after PUT");
      const budgets = validateBudgets(expectJson(list, "GET /api/budgets after PUT"));
      expect(hasId(budgets, "smoke-budget"), "the saved budget is missing from GET /api/budgets");
      const remove = await request("DELETE", "/api/budgets/smoke-budget");
      expectStatus(remove, [200, 204], "DELETE /api/budgets/smoke-budget");
      const after = await request("GET", "/api/budgets");
      const remaining = validateBudgets(expectJson(after, "GET /api/budgets after DELETE"));
      expect(!hasId(remaining, "smoke-budget"), "the deleted budget is still listed");
    });

    // ---------------------------------------------------------------- secrets (CONTRACTS 6)
    await check("PUT/GET/DELETE /api/secrets/<scope>/<name> never returns values", async () => {
      const secret = `smoke-secret-${Date.now()}`;
      const put = await request("PUT", "/api/secrets/alerts/smoke-token", { body: { value: secret } });
      expectStatus(put, [200, 201, 204], "PUT /api/secrets/alerts/smoke-token");
      const list = await request("GET", "/api/secrets/alerts");
      expectStatus(list, 200, "GET /api/secrets/alerts");
      const secrets = validateSecretList(expectJson(list, "GET /api/secrets/alerts"));
      expect(secrets.some((entry) => entry.name === "smoke-token"), "the stored secret is not listed");
      expect(!list.text.includes(secret), "GET /api/secrets returned the secret value");
      const remove = await request("DELETE", "/api/secrets/alerts/smoke-token");
      expectStatus(remove, [200, 204], "DELETE /api/secrets/alerts/smoke-token");
      const after = await request("GET", "/api/secrets/alerts");
      const remaining = validateSecretList(expectJson(after, "GET /api/secrets/alerts after DELETE"));
      expect(!remaining.some((entry) => entry.name === "smoke-token"), "the deleted secret is still listed");
    });

    // ---------------------------------------------------------------- history (CONTRACTS 9)
    await check("GET /api/history -> series with at most 500 points", async () => {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const until = new Date().toISOString();
      const result = await request(
        "GET",
        `/api/history?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&step=300`,
      );
      expectStatus(result, 200, "GET /api/history");
      validateHistory(expectJson(result, "GET /api/history"));
    });

    await check("DELETE /api/history clears the store", async () => {
      const remove = await request("DELETE", "/api/history");
      expectStatus(remove, [200, 204], "DELETE /api/history");
      const result = await request("GET", "/api/history");
      expectStatus(result, 200, "GET /api/history after DELETE");
      const history = validateHistory(expectJson(result, "GET /api/history after DELETE"));
      expect(history.series.length === 0, "history still has series after DELETE");
    });

    // ---------------------------------------------------------------- alerts (CONTRACTS 10)
    await check("GET /api/alerts/state -> snooze + last events", async () => {
      const result = await request("GET", "/api/alerts/state");
      expectStatus(result, 200, "GET /api/alerts/state");
      validateAlertsState(expectJson(result, "GET /api/alerts/state"));
    });

    await check("POST /api/alerts/test returns a JSON result", async () => {
      const result = await request("POST", "/api/alerts/test", { body: {} });
      expectStatus(result, [200, 202, 204], "POST /api/alerts/test");
      if (result.status !== 204) expectJson(result, "POST /api/alerts/test");
    });

    await check("POST/DELETE /api/alerts/snooze toggles the snooze state", async () => {
      const snooze = await request("POST", "/api/alerts/snooze", { body: { minutes: 5 } });
      expectStatus(snooze, [200, 204], "POST /api/alerts/snooze");
      const snoozed = await request("GET", "/api/alerts/state");
      const state = validateAlertsState(expectJson(snoozed, "GET /api/alerts/state (snoozed)"));
      // The contract pins the route, not the state key; accept snoozedUntil or any *snooze* field.
      const snoozedUntil = findSnoozeTimestamp(state);
      expect(
        typeof snoozedUntil === "string" && !Number.isNaN(Date.parse(snoozedUntil)),
        `alerts state: expected an ISO snooze timestamp after POST /api/alerts/snooze, got ${JSON.stringify(state)}`,
      );
      const clear = await request("DELETE", "/api/alerts/snooze");
      expectStatus(clear, [200, 204], "DELETE /api/alerts/snooze");
      const cleared = await request("GET", "/api/alerts/state");
      const clearedState = validateAlertsState(expectJson(cleared, "GET /api/alerts/state (cleared)"));
      expect(
        findSnoozeTimestamp(clearedState) === undefined,
        "alerts state still has a snooze value after DELETE /api/alerts/snooze",
      );
    });

    await check("GET /api/alerts/recent -> AlertEvent[]", async () => {
      const result = await request("GET", "/api/alerts/recent");
      expectStatus(result, 200, "GET /api/alerts/recent");
      validateAlertEventList(expectJson(result, "GET /api/alerts/recent"));
    });

    // ---------------------------------------------------------------- ingest (CONTRACTS 8)
    await check("POST /api/ingest/claude-statusline accepts statusline JSON", async () => {
      const payload = {
        rate_limits: {
          five_hour: {
            used_percentage: 12.5,
            resets_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          seven_day: {
            used_percentage: 34.5,
            resets_at: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
      };
      const result = await request("POST", "/api/ingest/claude-statusline", { body: payload });
      expectStatus(result, 200, "POST /api/ingest/claude-statusline");
      expectJson(result, "POST /api/ingest/claude-statusline");
    });

    // ---------------------------------------------------------------- stream
    await check("GET /api/stream responds as text/event-stream", async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4_000);
      try {
        const response = await fetch(`${baseUrl}/api/stream`, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });
        expect(response.status === 200, `GET /api/stream: expected HTTP 200, got ${response.status}`);
        const contentType = response.headers.get("content-type") ?? "";
        expect(
          contentType.toLowerCase().startsWith("text/event-stream"),
          `content-type: expected text/event-stream, got ${JSON.stringify(contentType)}`,
        );
        expect(response.body !== null, "GET /api/stream returned no body");
        await response.body?.cancel().catch(() => {});
      } catch (error) {
        if (controller.signal.aborted) throw new Error("GET /api/stream did not send headers within 4 s");
        throw error;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    });

    // ---------------------------------------------------------------- themes (CONTRACTS 3)
    await check("GET /api/themes/openvsx/search is disabled by default", async () => {
      const result = await request("GET", "/api/themes/openvsx/search?q=smoke");
      if (result.status === 403) {
        const body = expectJson(result, "GET /api/themes/openvsx/search");
        expect(
          body.error === "disabled",
          `error: expected "disabled" when advanced.experimental.openVsx is off, got ${JSON.stringify(body.error)}`,
        );
        return;
      }
      expectStatus(result, 200, "GET /api/themes/openvsx/search (enabled)");
      expectJson(result, "GET /api/themes/openvsx/search");
    });

    await check("GET /api/themes/openvsx/download is disabled by default", async () => {
      const result = await request("GET", "/api/themes/openvsx/download?id=__smoke_missing__");
      if (result.status === 403) {
        const body = expectJson(result, "GET /api/themes/openvsx/download");
        expect(
          body.error === "disabled",
          `error: expected "disabled" when advanced.experimental.openVsx is off, got ${JSON.stringify(body.error)}`,
        );
        return;
      }
      // Enabled builds may reject an unknown id without contacting open-vsx.
      expectStatus(result, [200, 400, 404], "GET /api/themes/openvsx/download (enabled)");
    });

    // ---------------------------------------------------------------- diagnostics (CONTRACTS 5/7)
    await check("GET /api/diagnostics -> documented fields", async () => {
      const result = await request("GET", "/api/diagnostics");
      expectStatus(result, 200, "GET /api/diagnostics");
      validateDiagnostics(expectJson(result, "GET /api/diagnostics"));
    });

    await check("GET /api/update-check is documented when enabled", async () => {
      const result = await request("GET", "/api/update-check");
      if (result.status === 200) {
        validateUpdateCheck(expectJson(result, "GET /api/update-check"));
        return;
      }
      // general.checkForUpdates defaults to false; a disabled answer is documented behavior.
      expect([403, 404].includes(result.status), `GET /api/update-check: expected 200, 403 or 404, got ${result.status}`);
      expectJson(result, "GET /api/update-check (disabled)");
    });

    if (openDataDir) {
      await check("POST /api/diagnostics/open-data-dir opens the data folder", async () => {
        const result = await request("POST", "/api/diagnostics/open-data-dir", { body: {} });
        expectStatus(result, [200, 202, 204], "POST /api/diagnostics/open-data-dir");
        if (result.status !== 204) expectJson(result, "POST /api/diagnostics/open-data-dir");
      });
    } else {
      skip(
        "POST /api/diagnostics/open-data-dir",
        "opens the OS file manager; pass --open-data-dir to include it",
      );
    }

    // Leave the settings at defaults after the mutation checks.
    await request("POST", "/api/settings/reset", { body: { scope: "all" } }).catch(() => {});
  } finally {
    if (server) {
      await server.stop();
      if (keep) console.log(`kept: ${server.tmpRoot}`);
      else removeTmpRoot(server.tmpRoot);
    }
  }

  const failed = results.filter((entry) => !entry.ok);
  const skipped = results.filter((entry) => entry.skipped);
  const executed = results.length - skipped.length;
  const passed = executed - failed.length;
  const summary = {
    ok: failed.length === 0,
    startedAt,
    finishedAt: isoNow(),
    baseUrl,
    passed,
    failed: failed.length,
    skipped: skipped.length,
    checks: results,
  };
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("");
    if (failed.length > 0) {
      console.error(`FAIL: ${passed}/${executed} checks passed${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}`);
      for (const entry of failed) console.error(`  - ${entry.name}: ${entry.error}`);
    } else {
      console.log(`PASS: ${passed}/${executed} checks passed${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}`);
    }
  }
  return failed.length === 0 ? 0 : 1;
}

try {
  process.exit(await main());
} catch (error) {
  console.error(`api: ${describeError(error)}`);
  process.exit(2);
}
