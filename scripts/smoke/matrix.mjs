// Capture a full screenshot matrix: every screen, responsive widths, the chooser dialog and
// light/dark themes. Uses the same isolated server + CDP helpers as the smoke test, but
// produces screenshots only (no assertions).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CdpClient,
  captureScreenshot,
  clickGroupItemExpression,
  evaluate,
  findBrowser,
  findPageTarget,
  launchBrowser,
  openScreenMenuExpression,
  pickScreenExpression,
  pressEscape,
  waitFor,
} from "./cdp.mjs";
import { removeTmpRoot, resolveServerExe, resolveWebDir, startServer, stopProcess } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const OUT = path.join(HERE, ".out", "matrix");
const PORT = 13_870;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const exe = resolveServerExe({ root: ROOT });
  const webDir = resolveWebDir({ root: ROOT });
  const browserExe = findBrowser();
  if (!exe || !webDir || !browserExe) throw new Error("Missing server binary, web build, or browser");

  fs.mkdirSync(OUT, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "burnrate-matrix-"));
  let server = null;
  let browser = null;
  let cdp = null;
  const files = [];

  try {
    server = await startServer({ root: ROOT, exe, webDir, port: PORT, tmpRoot: workspace });
    browser = await launchBrowser({ exe: browserExe, profileDir: path.join(workspace, "profile") });
    const page = await findPageTarget(browser.port);
    cdp = await CdpClient.connect(page.webSocketDebuggerUrl);

    const viewport = async (width, height) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    };
    const goto = async (url) => {
      await cdp.send("Page.navigate", { url });
      await waitFor(cdp, `document.readyState === "complete"`, { label: `ready ${url}`, timeoutMs: 20_000 });
    };
    const shot = async (name) => {
      const file = path.join(OUT, `${name}.png`);
      await captureScreenshot(cdp, file);
      files.push(file);
      console.log(`shot ${name}`);
    };
    const patch = async (patchObj) => {
      const result = await evaluate(
        cdp,
        `fetch('/api/settings', {method:'PATCH', headers:{'Content-Type':'application/json','X-Burnrate':'1'}, body:${JSON.stringify(JSON.stringify({ patch: patchObj }))}}).then(r=>r.ok)`,
      );
      if (!result) throw new Error(`settings patch failed: ${JSON.stringify(patchObj)}`);
      await sleep(250);
    };
    const nav = async (label) => {
      // Set the hash directly: the app's hash router drives the view, and this avoids relying on
      // breadcrumb-menu pointer events (which can be blocked by a retained Base UI dialog portal).
      const id = label.toLowerCase();
      await evaluate(cdp, `window.location.hash = ${JSON.stringify("#" + id)}`);
      await waitFor(cdp, `document.querySelector('main[aria-label]')?.getAttribute('aria-label') === ${JSON.stringify(label)}`, { label: `${label} screen` });
    };
    const clickText = async (text) => {
      const ok = await evaluate(
        cdp,
        `(() => { const el = [...document.querySelectorAll('button,[role="button"],a')].find(x => (x.textContent||'').trim().includes(${JSON.stringify(text)}) && x.getClientRects().length); if(!el) return false; el.click(); return true; })()`,
      );
      return !!ok;
    };
    const clickAria = async (label) => {
      const ok = await evaluate(
        cdp,
        `(() => { const el = document.querySelector('[aria-label=${JSON.stringify(label)}]'); if(!el) return false; el.click(); return true; })()`,
      );
      return !!ok;
    };

    // Seed a fresh Claude statusline snapshot so the usage charts show real values instead of
    // their empty states. The isolated server has no credentials by design.
    await patch({ providers: { claudeOAuthProbe: false } });
    const fixtureValue = JSON.parse(fs.readFileSync(path.join(ROOT, "server-rs", "src", "providers", "claude-statusline.json"), "utf8"));
    // Remove transcript_path so the ingest lands under the fallback key that every local Claude
    // config dir reads, instead of the fixture author's home directory.
    delete fixtureValue.transcript_path;
    const fixture = JSON.stringify(fixtureValue);
    await evaluate(
      cdp,
      `fetch('/api/ingest/claude-statusline', {method:'POST', headers:{'Content-Type':'application/json','X-Burnrate':'1'}, body:${JSON.stringify(fixture)}}).then(r=>r.ok)`,
    );
    // The scheduler caches compact status for 30s; wait out a cache built before the seed.
    await sleep(31_000);
    const seeded = await evaluate(cdp, `Promise.all([fetch('/api/status').then(r=>r.json()), fetch('/api/settings').then(r=>r.json())]).then(([st,s])=>({statusAccounts:(st.accounts||[]).length, probe:s.providers?.claudeOAuthProbe}))`);
    console.log("seeded status:", JSON.stringify(seeded));
    console.log("account:", JSON.stringify(await evaluate(cdp, `fetch('/api/status').then(r=>r.json()).then(j=>j.accounts?.[0] ?? null)`)));
    await patch({ appearance: { themeMode: "light" } });
    await viewport(1280, 800);
    await goto(`${server.baseUrl}/`);
    await waitFor(cdp, `!!document.querySelector('[data-slot="app-shell"]')`, { label: "app shell" });
    await sleep(600);
    await shot("01-usage-cost-light");

    await evaluate(cdp, clickGroupItemExpression("Usage metric", "Tokens"));
    await sleep(400);
    await shot("02-usage-tokens-light");
    await evaluate(cdp, clickGroupItemExpression("Usage metric", "Limits"));
    await sleep(400);
    await shot("03-usage-limits-light");

    await nav("Providers");
    await sleep(500);
    await shot("04-providers-light");
    if (await clickText("Add provider")) {
      await sleep(500);
      await shot("05-choose-agent-dialog-light");
      await pressEscape(cdp);
      await waitFor(cdp, `!document.querySelector('[data-slot="dialog-popup"]')`, { label: "dialog closed" });
      await sleep(300);
    }

    await nav("Settings");
    await waitFor(cdp, `document.querySelector('main[aria-label]')?.getAttribute('aria-label') === "Settings"`, { label: "settings" });
    await sleep(500);
    await shot("06-settings-light");
    if (await clickText("Appearance")) {
      await sleep(500);
      await shot("07-settings-appearance-light");
    }

    // Dark main-app screens    await patch({ appearance: { themeMode: "dark" } });
    await viewport(1280, 800);
    await goto(`${server.baseUrl}/`);
    await sleep(700);
    await shot("09-usage-cost-dark");
    await nav("Providers");
    await sleep(500);
    await shot("10-providers-dark");
    await nav("Settings");
    await sleep(500);
    await shot("11-settings-dark");

    // Responsive light screens
    await patch({ appearance: { themeMode: "light" } });
    await goto(`${server.baseUrl}/`);
    await sleep(500);
    await viewport(320, 720);
    await sleep(500);
    await shot("13-usage-mobile-320");
    await viewport(640, 800);
    await sleep(500);
    await shot("14-usage-tablet-640");

    console.log(`\n${files.length} screenshots in ${OUT}`);
  } finally {
    if (cdp) cdp.close();
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    if (server) await server.stop();
    removeTmpRoot(server ? server.tmpRoot : workspace);
  }
}

main().then((code) => process.exit(code ?? 0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
