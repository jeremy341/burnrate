// Shared harness for the design scripts (resize.mjs, a11y.mjs): own server + headless browser + page helpers.
// Dependency free. Never touches the real install: a throwaway BURNRATE_DATA, and either an empty HOME
// (a brand-new user) or the real HOME (read only measurements of local transcripts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { CdpClient, evaluate, findPageTarget, launchBrowser, waitFor } from "./cdp.mjs";
import { resolveServerExe, resolveWebDir, startServer, stopProcess } from "./server.mjs";
import { sleep } from "./util.mjs";

/** Starts the server and a browser. `home: "real"` keeps the real profile directories visible to the server. */
export async function openApp({ root = process.cwd(), port = 13_950, home = "empty", width = 1100, height = 860, scheme = "dark" } = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "burnrate-design-"));
  let server;
  if (home === "real") {
    const exe = resolveServerExe({ root });
    const web = resolveWebDir({ root });
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const child = spawn(exe, [], {
      cwd: root,
      env: { ...process.env, BURNRATE_PORT: String(port), BURNRATE_DATA: dataDir, BURNRATE_WEB: web },
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 25_000;
    for (;;) {
      try {
        const response = await fetch(`${baseUrl}/api/providers`, { signal: AbortSignal.timeout(1_000) });
        if (response.status < 500) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error("server did not start");
      await sleep(150);
    }
    server = { baseUrl, tmpRoot, stop: () => stopProcess(child) };
  } else {
    server = await startServer({ root, port, tmpRoot });
  }
  const browser = await launchBrowser({ profileDir: path.join(tmpRoot, "profile") });
  const target = await findPageTarget(browser.port);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const errors = [];
  cdp.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails?.exception?.description ?? "exception"));
  const app = {
    cdp,
    server,
    errors,
    baseUrl: server.baseUrl,
    async setViewport(w, h, { dpr = 1, mobile = false } = {}) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile });
    },
    async setScheme(next) {
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: next }] });
    },
    /** Persists the theme through the settings API (the app's real mechanism) and reports the root class after reload. */
    async setTheme(mode) {
      const response = await fetch(`${server.baseUrl}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Burnrate": "1" },
        body: JSON.stringify({ patch: { appearance: { themeMode: mode } } }),
      });
      if (!response.ok) throw new Error(`PATCH /api/settings -> ${response.status}`);
    },
    /** Fresh page load (never a hash-only jump, which keeps old screens mounted but hidden), then waits for settled content. */
    async goto(hash = "", { settle = true } = {}) {
      await cdp.send("Page.navigate", { url: "about:blank" });
      await cdp.send("Page.navigate", { url: `${server.baseUrl}/${hash ? `#${hash}` : ""}` });
      await sleep(250);
      await waitFor(cdp, "document.readyState === 'complete' && !!document.querySelector('button')", { timeoutMs: 20_000 });
      if (settle) {
        try {
          await waitFor(cdp, "![...document.querySelectorAll('[data-slot=skeleton]')].some((n) => n.offsetParent !== null)", { timeoutMs: 12_000 });
        } catch {
          // a skeleton that outlives 12 s is itself a finding; the caller still gets a screenshot
        }
      }
      await sleep(350);
    },
    /** True when the root carries the dark class. */
    isDark: () => evaluate(cdp, "document.documentElement.classList.contains('dark')"),
    async shot(file) {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      return file;
    },
    eval: (expression) => evaluate(cdp, expression),
    async click(selectorOrText) {
      return evaluate(
        cdp,
        `(() => { const q = ${JSON.stringify(selectorOrText)}; let el = null; try { el = document.querySelector(q); } catch {}
          if (!el) el = [...document.querySelectorAll('button,[role=tab],[role=menuitem],[role=radio],a,[role=option]')].find((n) => (n.getAttribute('aria-label') || n.textContent || '').trim() === q);
          if (!el) return false; el.click(); return true; })()`,
      );
    },
    async key(key, { ctrl = false, shift = false } = {}) {
      const params = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, modifiers: (ctrl ? 2 : 0) | (shift ? 8 : 0) };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...params, text: key.length === 1 && !ctrl ? key : undefined });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    },
    async close() {
      cdp.close();
      await browser.close();
      await server.stop();
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
  await app.setViewport(width, height);
  await app.setScheme(scheme);
  return app;
}
