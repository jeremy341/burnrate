// Shared helpers for the settings audit (agent E). Starts the built server on its own port with a
// throwaway BURNRATE_DATA, launches headless Edge over CDP and exposes small DOM helpers.
// Usage from a script: const h = await boot({ port: 13921, realHome: false }); ... await h.close();
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CdpClient, captureScreenshot, evaluate, findPageTarget, launchBrowser } from "../smoke/cdp.mjs";
import { isolatedServerEnv, resolveServerExe, stopProcess } from "../smoke/server.mjs";
import { sleep } from "../smoke/util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
export const SHOTS = path.join(ROOT, "docs", "reviews", "06-settings-audit");
const EXE_CANDIDATES = [
  process.env.BURNRATE_SERVER_EXE,
  path.join(os.tmpdir(), "burnrate-target", "debug", "burnrate-server.exe"),
  path.join(os.tmpdir(), "burnrate-target", "debug", "burnrate-server"),
];
export const SERVER_EXE = EXE_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;

export async function boot({ port = 13921, realHome = false, viewport = [1100, 860], dark = true, keepData = null } = {}) {
  const work = keepData ?? fs.mkdtempSync(path.join(os.tmpdir(), "burnrate-audit-"));
  const dataDir = path.join(work, "data");
  const home = path.join(work, "home");
  fs.mkdirSync(dataDir, { recursive: true });
  for (const d of [home, path.join(home, ".claude"), path.join(home, ".codex"), path.join(home, "AppData", "Roaming"), path.join(home, "AppData", "Local")])
    fs.mkdirSync(d, { recursive: true });
  const exe = SERVER_EXE && fs.existsSync(SERVER_EXE) ? SERVER_EXE : resolveServerExe({ root: ROOT });
  const web = path.join(ROOT, "dist", "web");
  const env = realHome
    ? { ...process.env, BURNRATE_PORT: String(port), BURNRATE_DATA: dataDir, BURNRATE_WEB: web }
    : isolatedServerEnv({ home, port, dataDir, webDir: web });
  const logs = [];
  const server = spawn(exe, [], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const cap = (b) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => { logs.push(l); if (logs.length > 200) logs.shift(); });
  server.stdout.on("data", cap);
  server.stderr.on("data", cap);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/api/providers`, { signal: AbortSignal.timeout(800) }); if (r.status < 500) break; } catch {}
    await sleep(150);
  }
  const profile = path.join(work, "edge");
  const browser = await launchBrowser({ profileDir: profile });
  const target = await findPageTarget(browser.port);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  const consoleErrors = [];
  const exceptions = [];
  cdp.on("Runtime.consoleAPICalled", (p) => { if (p.type === "error") consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ")); });
  cdp.on("Runtime.exceptionThrown", (p) => exceptions.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  // The first-run wizard is being removed by another agent; keep it out of the way of the audit.
  if (process.env.AUDIT_KEEP_ONBOARDING !== "1")
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "try{if(!sessionStorage.getItem('__audit_fresh'))localStorage.setItem('burnrate.onboarded','true')}catch{}" });
  const h = {
    base, port, cdp, server, logs, dataDir, work, consoleErrors, exceptions,
    ev: (expr) => evaluate(cdp, expr),
    sleep,
    async viewport(w, hgt) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: hgt, deviceScaleFactor: 1, mobile: false });
    },
    async colorScheme(scheme) {
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    },
    async goto(hash = "") {
      await cdp.send("Page.navigate", { url: `${base}/${hash}` });
      await sleep(400);
      await h.waitFor("document.readyState==='complete' && !!document.querySelector('#root')?.children.length", 15000);
      await sleep(300);
    },
    async reload() { await cdp.send("Page.reload"); await sleep(500); await h.waitFor("document.readyState==='complete'", 15000); await sleep(400); },
    async waitFor(expr, timeout = 8000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) { try { if (await evaluate(cdp, expr)) return true; } catch {} await sleep(100); }
      throw new Error("timeout waiting for " + expr);
    },
    async shot(name) {
      fs.mkdirSync(SHOTS, { recursive: true });
      return captureScreenshot(cdp, path.join(SHOTS, `${name}.png`));
    },
    async api(p, init) {
      const r = await fetch(base + p, init);
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, json: j, text: t };
    },
    async clickText(text, sel = "button,[role=button],[role=tab],[role=menuitem],a,label,[role=switch],[role=option],[role=radio]") {
      const ok = await evaluate(cdp, `(()=>{const t=${JSON.stringify(text)};const els=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>e.offsetParent!==null&&[(e.innerText||'').trim(),(e.getAttribute('aria-label')||'').trim()].includes(t));if(!els.length)return false;els[0].click();return true})()`);
      if (!ok) throw new Error("clickText: no element with text " + text);
      await sleep(150);
    },
    async key(key, opts = {}) {
      const map = { Tab: 9, Enter: 13, Escape: 27, " ": 32, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 };
      const p = { key, code: key === " " ? "Space" : key, windowsVirtualKeyCode: map[key] ?? key.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: map[key] ?? 0, modifiers: opts.modifiers ?? 0 };
      if (key.length === 1 && key !== " ") p.text = key;
      if (key === " ") p.text = " ";
      if (key === "Enter") p.text = "\r";
      await cdp.send("Input.dispatchKeyEvent", { type: p.text ? "keyDown" : "rawKeyDown", ...p });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
      await sleep(80);
    },
    async close() {
      try { cdp.close(); } catch {}
      await browser.close().catch(() => {});
      await stopProcess(server);
      if (!keepData) { await sleep(500); try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 }); } catch {} }
    },
  };
  await h.viewport(...viewport);
  await h.colorScheme(dark ? "dark" : "light");
  return h;
}
