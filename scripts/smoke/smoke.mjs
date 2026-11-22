#!/usr/bin/env node
// Burnrate browser smoke test: headless Edge/Chrome over CDP, no npm dependencies.
//
// It starts the built server on port 13850 with a throwaway BURNRATE_DATA and an isolated HOME
// (so no real logins are read or refreshed), drives the real UI, writes screenshots, and fails on
// console errors, page exceptions, HTTP 5xx responses or missing key texts.
//
// Usage: node scripts/smoke/smoke.mjs [--out DIR] [--port N] [--exe FILE] [--web DIR] [--headed] [--keep]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CdpClient,
  anyTextPresentExpression,
  captureScreenshot,
  clickAriaLabelExpression,
  clickGroupItemExpression,
  dialogLabelExpression,
  evaluate,
  findBrowser,
  findPageTarget,
  groupItemsExpression,
  launchBrowser,
  openScreenMenuExpression,
  pickScreenExpression,
  pressedGroupItemExpression,
  pressEscape,
  textPresentExpression,
  waitFor,
} from "./cdp.mjs";
import { auditAccessibility, auditReducedMotion, blockingFindings } from "./accessibility.mjs";
import { removeTmpRoot, resolveServerExe, resolveWebDir, startServer } from "./server.mjs";
import {
  dedupe,
  describeError,
  isIgnoredConsoleError,
  isoNow,
  optionBoolean,
  optionNumber,
  optionString,
  parseArgs,
  slug,
  tail,
} from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const PROVIDER_TEXTS = [
  "Claude",
  "Codex",
  "Cursor",
  "Grok",
  "Mistral",
  "OpenCode",
  "Antigravity",
  "OpenRouter",
  "DeepSeek",
  "Copilot",
];
const SETTINGS_TEXTS = [
  "General",
  "Appearance",
  "Usage",
  "Providers",
  "Notifications",
  "Shortcuts",
  "Shell",
  "Advanced",
  "Data",
  "About",
];
const LIMITS_TEXTS = [
  "Connect an agent",
  "reports subscription limits",
  "No provider",
  "No accounts",
  "Add a provider",
  "Usage limits",
  "remaining",
];

const HELP = `Burnrate browser smoke test (headless Edge/Chrome over CDP)

Usage:
  node scripts/smoke/smoke.mjs [options]

Options:
  --out DIR      Screenshot + report directory (default: scripts/smoke/.out)
  --port N       Server port (default: 13850)
  --exe FILE     burnrate-server binary (default: BURNRATE_SERVER_EXE, CARGO_TARGET_DIR, target/)
  --web DIR      Web build directory (default: BURNRATE_WEB or dist/web)
  --browser FILE Chromium-family executable (or set SMOKE_BROWSER)
  --timeout MS   Per-wait timeout (default: 20000)
  --headed       Show the browser window instead of headless
  --keep         Keep the temporary data/home/profile directory for debugging
  --help         Show this help

Exit codes: 0 pass, 1 the app failed a check, 2 setup problem (missing build/browser/port).
`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function describeRemoteObject(argument) {
  if (!argument) return "";
  if (argument.type === "string") return String(argument.value ?? "");
  if (Object.prototype.hasOwnProperty.call(argument, "value")) return String(argument.value);
  return String(argument.description ?? argument.type ?? "");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const port = optionNumber(options, "port", 13_850);
  const timeoutMs = optionNumber(options, "timeout", 20_000);
  const headed = optionBoolean(options, "headed");
  const keep = optionBoolean(options, "keep");
  const outDir = path.resolve(ROOT, optionString(options, "out", path.join(HERE, ".out")));
  const exeOption = optionString(options, "exe", "");
  const webOption = optionString(options, "web", "");
  const browserOption = optionString(options, "browser", "");

  const serverExe = exeOption ? path.resolve(ROOT, exeOption) : resolveServerExe({ root: ROOT });
  if (!serverExe) {
    throw new Error(
      "No server binary found. Build it (cargo build --manifest-path server-rs/Cargo.toml) " +
        "or pass --exe / set BURNRATE_SERVER_EXE. The integrator's release build works too.",
    );
  }
  const webDir = webOption ? path.resolve(ROOT, webOption) : resolveWebDir({ root: ROOT });
  if (!webDir) {
    throw new Error("No dist/web build found. Run `corepack pnpm build` first, or pass --web.");
  }
  const browserExe = browserOption ? path.resolve(ROOT, browserOption) : findBrowser();
  if (!browserExe) {
    throw new Error("No Edge/Chrome found. Install one or set SMOKE_BROWSER to its executable.");
  }

  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = isoNow();
  const steps = [];
  const consoleErrors = [];
  const pageErrors = [];
  const httpErrors = [];
  const screenshots = [];
  let server = null;
  let browser = null;
  let cdp = null;

  const recordConsole = (text, url = "") => {
    const message = String(text ?? "").trim();
    if (!message) return;
    if (isIgnoredConsoleError(`${message} ${url}`)) return;
    if (!consoleErrors.includes(message)) consoleErrors.push(message);
  };
  const recordPageError = (text) => {
    const message = String(text ?? "").trim();
    if (!message) return;
    if (!pageErrors.includes(message)) pageErrors.push(message);
  };

  const screenshot = async (name) => {
    const file = path.join(outDir, name);
    await captureScreenshot(cdp, file);
    screenshots.push(file);
    return file;
  };

  const runStep = async (name, action) => {
    try {
      await action();
      steps.push({ name, ok: true });
      console.log(`ok   ${name}`);
    } catch (error) {
      const message = describeError(error);
      steps.push({ name, ok: false, error: message });
      console.error(`FAIL ${name}: ${message}`);
      try {
        await screenshot(`failed-${slug(name)}.png`);
      } catch {
        // the page may be gone; the report still has the error
      }
    }
  };

  const backToUsage = async () => {
    await pressEscape(cdp);
    try {
      await waitFor(cdp, `${dialogLabelExpression()} === "Usage"`, {
        label: "Usage after Esc",
        timeoutMs: 3_000,
      });
      return;
    } catch {
      // Fall through to the header close button.
    }
    const clicked = await evaluate(cdp, clickAriaLabelExpression("Back to Usage"));
    assert(clicked, "neither Esc nor the Back to Usage button returned to the Usage view");
    await waitFor(cdp, `${dialogLabelExpression()} === "Usage"`, { label: "Usage after Close" });
  };

  // Screens are reached through the T3 "Usage" breadcrumb menu (also Ctrl+, for Settings).
  const goToScreen = async (name) => {
    const opened = await evaluate(cdp, openScreenMenuExpression());
    assert(opened, 'the "Usage" breadcrumb screen menu was not found');
    await waitFor(cdp, `!!document.querySelector('[role="menuitemradio"]')`, { label: "screen menu" });
    const picked = await evaluate(cdp, pickScreenExpression(name));
    assert(picked, `the screen menu has no "${name}" item`);
    await waitFor(cdp, `${dialogLabelExpression()} === ${JSON.stringify(name)}`, {
      label: `${name} screen`,
    });
  };

  let fatalError = null;
  let ok = false;

  try {
    server = await startServer({ root: ROOT, exe: serverExe, webDir, port });
    const profileDir = path.join(server.tmpRoot, "browser-profile");
    browser = await launchBrowser({ exe: browserExe, profileDir, headed });
    const page = await findPageTarget(browser.port);
    cdp = await CdpClient.connect(page.webSocketDebuggerUrl);

    cdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type !== "error") return;
      recordConsole((args ?? []).map(describeRemoteObject).join(" "));
    });
    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      recordPageError(
        exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? "Uncaught page exception",
      );
    });
    cdp.on("Log.entryAdded", ({ entry }) => {
      if (!entry || entry.level !== "error") return;
      recordConsole(entry.text ?? "", entry.url ?? "");
    });
    cdp.on("Network.responseReceived", ({ response }) => {
      if (!response?.url?.startsWith(`${server.baseUrl}/api/`)) return;
      if (response.status >= 400) httpErrors.push({ status: response.status, url: response.url });
    });
    cdp.on("Inspector.targetCrashed", () => recordPageError("The page crashed."));
    cdp.on("Page.javascriptDialogOpening", ({ message }) => {
      recordPageError(`Unexpected browser dialog: ${message}`);
      void cdp.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
    });

    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Log.enable"),
      cdp.send("Network.enable"),
    ]);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

    console.log("Burnrate smoke");
    console.log(`  server:      ${serverExe}`);
    console.log(`  web:         ${webDir}`);
    console.log(`  browser:     ${browserExe}`);
    console.log(`  url:         ${server.baseUrl}/`);
    console.log(`  data:        ${server.dataDir}`);
    console.log(`  screenshots: ${outDir}`);
    console.log("");

    await runStep("server serves the web build", async () => {
      const response = await fetch(`${server.baseUrl}/`);
      assert(response.ok, `GET / -> HTTP ${response.status}`);
      const html = await response.text();
      assert(html.includes('id="root"'), "index.html does not contain the React root element");
    });

    await cdp.send("Page.navigate", { url: `${server.baseUrl}/` });

    await runStep("usage view loads with Cost/Tokens/Limits", async () => {
      await waitFor(cdp, `document.readyState === "complete"`, { label: "document ready", timeoutMs });
      await waitFor(cdp, `!!document.querySelector('[data-slot="app-shell"]')`, {
        label: "app frame",
        timeoutMs,
      });
      await waitFor(cdp, textPresentExpression("Usage"), { label: "Usage heading", timeoutMs });
      const labels = await evaluate(cdp, groupItemsExpression("Usage metric"));
      assert(Array.isArray(labels), 'the "Usage metric" toggle group was not found');
      for (const expected of ["Cost", "Tokens", "Limits"]) {
        assert(
          labels.includes(expected),
          `Usage metric toggle is missing "${expected}" (found: ${labels.join(", ") || "none"})`,
        );
      }
      await screenshot("01-usage-cost.png");
    });

    await runStep("usage: Tokens tab", async () => {
      const clicked = await evaluate(cdp, clickGroupItemExpression("Usage metric", "Tokens"));
      assert(clicked?.ok, `could not click Tokens: ${clicked?.reason ?? "unknown"}`);
      await waitFor(cdp, `${pressedGroupItemExpression("Usage metric")} === "Tokens"`, {
        label: "Tokens selected",
      });
      await waitFor(
        cdp,
        anyTextPresentExpression(["Processed tokens", "Tokens by type", "Totals", "No activity"]),
        { label: "tokens content", timeoutMs },
      );
      await screenshot("02-usage-tokens.png");
    });

    await runStep("usage: Limits tab", async () => {
      const clicked = await evaluate(cdp, clickGroupItemExpression("Usage metric", "Limits"));
      assert(clicked?.ok, `could not click Limits: ${clicked?.reason ?? "unknown"}`);
      await waitFor(cdp, `${pressedGroupItemExpression("Usage metric")} === "Limits"`, {
        label: "Limits selected",
      });
      await waitFor(cdp, anyTextPresentExpression(LIMITS_TEXTS), {
        label: "limits content",
        timeoutMs,
      });
      await screenshot("03-usage-limits.png");
    });

    await runStep("accessibility audit: usage", async () => {
      const report = await auditAccessibility(cdp, { label: "usage-limits" });
      const blocking = blockingFindings(report);
      assert(
        blocking.length === 0,
        `blocking a11y findings (${blocking.length}): ${blocking.slice(0, 3).map((f) => f.rule + ": " + f.message).join(" | ")}`,
      );
      const motion = await auditReducedMotion(cdp);
      assert(blockingFindings(motion).length === 0, "infinite animations still run under prefers-reduced-motion");
      console.log(`  a11y: ${report.counts?.checked ?? "?"} checks, ${report.findings.length} finding(s), 0 blocking`);
    });

    await runStep("providers view", async () => {
      await goToScreen("Providers");
      await waitFor(cdp, anyTextPresentExpression(PROVIDER_TEXTS), {
        label: "a provider row",
        timeoutMs,
      });
      await screenshot("04-providers.png");
    });

    await runStep("return to usage after Providers", backToUsage);

    await runStep("settings view", async () => {
      await goToScreen("Settings");
      await waitFor(cdp, textPresentExpression("Settings"), { label: "Settings heading", timeoutMs });
      await waitFor(cdp, anyTextPresentExpression(SETTINGS_TEXTS), {
        label: "a settings section",
        timeoutMs,
      });
      await screenshot("05-settings.png");
    });

    await runStep("return to usage after Settings", backToUsage);
  } catch (error) {
    fatalError = error;
  } finally {
    cdp?.close();
    if (browser) await browser.close();
    if (server) await server.stop();

    const consoleErrorList = dedupe(consoleErrors);
    const pageErrorList = dedupe(pageErrors);
    const serverErrorList = httpErrors.filter((entry) => entry.status >= 500);
    const clientErrorList = httpErrors.filter((entry) => entry.status >= 400 && entry.status < 500);
    const failedSteps = steps.filter((step) => !step.ok);
    ok =
      fatalError === null &&
      steps.length >= 7 &&
      failedSteps.length === 0 &&
      consoleErrorList.length === 0 &&
      pageErrorList.length === 0 &&
      serverErrorList.length === 0;

    const report = {
      ok,
      startedAt,
      finishedAt: isoNow(),
      baseUrl: server?.baseUrl ?? null,
      serverExe,
      webDir,
      browserExe,
      error: fatalError ? describeError(fatalError) : null,
      steps,
      screenshots,
      consoleErrors: consoleErrorList,
      pageErrors: pageErrorList,
      httpErrors,
      serverLog: server ? tail(server.logs) : [],
    };
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

    console.log("");
    if (fatalError) console.error(`smoke: ${describeError(fatalError)}`);
    if (consoleErrorList.length > 0) {
      console.error(`console errors (${consoleErrorList.length}):`);
      for (const error of consoleErrorList) console.error(`  - ${error}`);
    }
    if (pageErrorList.length > 0) {
      console.error(`page exceptions (${pageErrorList.length}):`);
      for (const error of pageErrorList) console.error(`  - ${error}`);
    }
    if (serverErrorList.length > 0) {
      console.error("HTTP 5xx from the API:");
      for (const entry of serverErrorList) console.error(`  - ${entry.status} ${entry.url}`);
    }
    if (clientErrorList.length > 0) {
      console.warn("HTTP 4xx from the API (also visible as console errors):");
      for (const entry of dedupe(clientErrorList.map((entry) => `${entry.status} ${entry.url}`))) {
        console.warn(`  - ${entry}`);
      }
    }
    console.log(
      `${ok ? "PASS" : "FAIL"}: ${steps.length - failedSteps.length}/${steps.length} steps, ` +
        `${screenshots.length} screenshot(s), ${consoleErrorList.length} console error(s), ` +
        `${pageErrorList.length} page exception(s)`,
    );
    console.log(`screenshots: ${outDir}`);
    console.log(`report:      ${path.join(outDir, "report.json")}`);

    if (keep && server) {
      console.log(`kept:        ${server.tmpRoot}`);
    } else if (server) {
      removeTmpRoot(server.tmpRoot);
    }
  }

  if (fatalError) return 2;
  return ok ? 0 : 1;
}

try {
  const code = await main();
  process.exit(code);
} catch (error) {
  console.error(`smoke: ${describeError(error)}`);
  process.exit(2);
}
