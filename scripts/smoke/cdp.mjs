// A tiny Chrome DevTools Protocol client: launches Edge/Chrome headless and drives the page.
// No Playwright/Puppeteer dependency; Node 24's global WebSocket and fetch are enough.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { stopProcess } from "./server.mjs";
import { sleep, tail } from "./util.mjs";

/** Chromium-family executables in the usual install locations. */
export function browserCandidates(env = process.env, platform = process.platform) {
  const candidates = [];
  const add = (...parts) => {
    if (parts.every((part) => typeof part === "string" && part.length > 0)) {
      candidates.push(path.join(...parts));
    }
  };
  if (env.SMOKE_BROWSER || env.BURNRATE_BROWSER) {
    candidates.push(env.SMOKE_BROWSER || env.BURNRATE_BROWSER);
  }
  if (platform === "win32") {
    const programFiles = env.ProgramFiles;
    const programFilesX86 = env["ProgramFiles(x86)"];
    const localAppData = env.LOCALAPPDATA;
    add(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe");
    add(programFiles, "Microsoft", "Edge", "Application", "msedge.exe");
    add(localAppData, "Microsoft", "Edge", "Application", "msedge.exe");
    add(programFiles, "Google", "Chrome", "Application", "chrome.exe");
    add(programFilesX86, "Google", "Chrome", "Application", "chrome.exe");
    add(localAppData, "Google", "Chrome", "Application", "chrome.exe");
    add(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe");
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }
  return candidates;
}

export function findBrowser({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  return browserCandidates(env, platform).find((candidate) => exists(candidate)) ?? null;
}

async function readJson(url, timeoutMs = 1_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

/**
 * Launches a headless Chromium with remote debugging on an ephemeral port.
 * Resolves once DevToolsActivePort exists, so no port guessing is needed.
 */
export async function launchBrowser({
  exe,
  profileDir,
  headed = false,
  timeoutMs = 20_000,
  env = process.env,
} = {}) {
  const browserExe = exe ?? findBrowser({ env });
  if (!browserExe) {
    throw new Error(
      "No Edge/Chrome found. Install Microsoft Edge or Google Chrome, or set SMOKE_BROWSER to the executable.",
    );
  }
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${path.resolve(profileDir)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=Translate,msEdgeFirstRunExperience,MediaRouter,OptimizationHints",
    "--metrics-recording-only",
    "--mute-audio",
    "--window-size=1280,900",
    ...(headed ? [] : ["--headless=new", "--hide-scrollbars", "--disable-gpu"]),
    "about:blank",
  ];
  if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0) {
    args.unshift("--no-sandbox");
  }

  const stderr = [];
  const child = spawn(browserExe, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  child.stderr?.on("data", (buffer) => {
    for (const line of buffer.toString().split(/\r?\n/)) {
      if (!line) continue;
      stderr.push(line);
      if (stderr.length > 60) stderr.shift();
    }
  });

  const portFile = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Browser exited with code ${child.exitCode}.\n${tail(stderr, 20).join("\n")}`);
    }
    try {
      const [port] = fs.readFileSync(portFile, "utf8").split(/\r?\n/);
      if (port && Number(port) > 0) {
        return {
          exe: browserExe,
          port: Number(port),
          child,
          stderr,
          close: async () => {
            await stopProcess(child);
          },
        };
      }
    } catch {
      // DevToolsActivePort is written once the browser is listening.
    }
    await sleep(150);
  }
  await stopProcess(child);
  throw new Error(`Browser did not open a DevTools port within ${timeoutMs} ms.\n${tail(stderr, 20).join("\n")}`);
}

/** Finds (or creates) the about:blank page target and returns its WebSocket URL. */
export async function findPageTarget(port, timeoutMs = 10_000) {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let createAttempted = false;
  while (Date.now() < deadline) {
    try {
      const targets = await readJson(`${base}/json/list`);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // /json/list is not up yet
    }
    if (!createAttempted) {
      createAttempted = true;
      for (const method of ["PUT", "GET"]) {
        try {
          const response = await fetch(`${base}/json/new?about:blank`, { method });
          if (response.ok) break;
        } catch {
          // try the other method
        }
      }
    }
    await sleep(150);
  }
  throw new Error(`No page target appeared on the browser at ${base} within ${timeoutMs} ms.`);
}

/** Minimal CDP client: one socket, request ids, event listeners. */
export class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`${message.error.message ?? "CDP error"} (${message.error.code ?? "?"})`));
        } else {
          pending.resolve(message.result ?? {});
        }
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
        for (const listener of this.listeners.get("*") ?? []) listener(message);
      }
    });
    socket.addEventListener("close", () => {
      const error = new Error("The DevTools WebSocket closed.");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  static async connect(url, timeoutMs = 10_000) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // ignore
        }
        reject(new Error(`Timed out connecting to the DevTools WebSocket after ${timeoutMs} ms.`));
      }, timeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`Could not open the DevTools WebSocket at ${url}.`));
        },
        { once: true },
      );
    });
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const list = this.listeners.get(method) ?? [];
    list.push(listener);
    this.listeners.set(method, list);
    return () => {
      const current = this.listeners.get(method) ?? [];
      this.listeners.set(
        method,
        current.filter((entry) => entry !== listener),
      );
    };
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }
}

/** Evaluates an expression in the page and returns its JSON value. */
export async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const description =
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed";
    throw new Error(`Page evaluation failed: ${description}`);
  }
  return result.result?.value;
}

/** Re-evaluates `expression` until it is truthy or the timeout expires. */
export async function waitFor(cdp, expression, { label = expression, timeoutMs = 20_000, intervalMs = 120 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, expression)) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError ? ` (last error: ${lastError.message})` : "";
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}${suffix}`);
}

export async function bodyText(cdp) {
  return (await evaluate(cdp, "document.body?.innerText ?? ''")) ?? "";
}

export async function captureScreenshot(cdp, file) {
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

export async function pressEscape(cdp) {
  const params = {
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
}

const groupLookup = (groupLabel) =>
  `[...document.querySelectorAll('[aria-label]')].find((candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(groupLabel)})`;

const groupItems = `[...group.querySelectorAll('button, [role="tab"], [role="radio"], [data-slot="toggle"]')]`;

/** Expression: click the item whose trimmed text equals `text` inside the group with `groupLabel`. */
export function clickGroupItemExpression(groupLabel, text) {
  return `(() => {
    const group = ${groupLookup(groupLabel)};
    if (!group) return { ok: false, reason: "group ${groupLabel} not found" };
    const items = ${groupItems};
    const wanted = ${JSON.stringify(text)};
    const item = items.find((candidate) => (candidate.textContent || "").trim() === wanted);
    if (!item) {
      return { ok: false, reason: "item " + wanted + " not found", items: items.map((candidate) => (candidate.textContent || "").trim()) };
    }
    item.scrollIntoView({ block: "center", inline: "center" });
    item.click();
    return { ok: true };
  })()`;
}

/** Expression: text of the pressed item in a toggle group (Base UI uses data-pressed, aria-pressed is a fallback). */
export function pressedGroupItemExpression(groupLabel) {
  return `(() => {
    const group = ${groupLookup(groupLabel)};
    if (!group) return null;
    const items = ${groupItems};
    const pressed = items.find((candidate) =>
      candidate.getAttribute("aria-pressed") === "true" ||
      candidate.hasAttribute("data-pressed") ||
      candidate.getAttribute("data-state") === "on",
    );
    return pressed ? (pressed.textContent || "").trim() : null;
  })()`;
}

/** Expression: item labels inside a toggle group, for error messages. */
export function groupItemsExpression(groupLabel) {
  return `(() => {
    const group = ${groupLookup(groupLabel)};
    if (!group) return null;
    const items = ${groupItems};
    return items.map((candidate) => (candidate.textContent || "").trim());
  })()`;
}

/** Expression: click a button by its exact aria-label (the app toolbar uses view titles). */
export function clickAriaLabelExpression(label) {
  return `(() => {
    const element = [...document.querySelectorAll('button, [role="button"]')]
      .find((candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!element) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return true;
  })()`;
}

/** Expression: label of the screen the app frame shows ("Usage", "Settings", ...). */
export function dialogLabelExpression() {
  // The active screen's name lives on the single <main> landmark (AppMain); the outer shell is now
  // a plain frame so the header can be the page banner (accessibility fix).
  return `document.querySelector('main[aria-label]')?.getAttribute('aria-label') ?? document.querySelector('[data-slot="app-shell"]')?.getAttribute('aria-label') ?? null`;
}

/** Expression: open the screen switcher (the "Usage" breadcrumb segment of the visible header). */
export function openScreenMenuExpression() {
  return `(() => {
    const trigger = [...document.querySelectorAll('[aria-label^="Go to"], [aria-label$="switch screen"]')]
      .find((candidate) => candidate.getClientRects().length > 0);
    if (!trigger) return false;
    trigger.click();
    return true;
  })()`;
}

/** Expression: pick a screen in the open switcher menu by its visible name. */
export function pickScreenExpression(name) {
  return `(() => {
    const item = [...document.querySelectorAll('[role="menuitemradio"]')]
      .find((candidate) => (candidate.textContent || "").trim().startsWith(${JSON.stringify(name)}));
    if (!item) return false;
    item.click();
    return true;
  })()`;
}

/** Expression: whether `text` appears in the visible page (case-insensitive). */
export function textPresentExpression(text) {
  return `((document.body?.innerText ?? "").toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))`;
}

/** Expression: any of `texts` appears in the visible page. */
export function anyTextPresentExpression(texts) {
  const lowered = texts.map((text) => text.toLowerCase());
  return `(() => {
    const body = (document.body?.innerText ?? "").toLowerCase();
    return ${JSON.stringify(lowered)}.some((text) => body.includes(text));
  })()`;
}
