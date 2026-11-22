// Locates and runs the built Burnrate server for the smoke suite.
// The server is killed by PID (or PID tree on Windows), never by executable name.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { sleep, tail } from "./util.mjs";

const execFileAsync = promisify(execFile);

export const SERVER_BINARY = process.platform === "win32" ? "burnrate-server.exe" : "burnrate-server";

function existsSync(pathname) {
  try {
    return fs.statSync(pathname).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolution order: BURNRATE_SERVER_EXE, then CARGO_TARGET_DIR/{release,debug},
 * then <repo>/server-rs/target/{release,debug} and <repo>/target/{release,debug}.
 * Building the server is the integrator's job; this only finds what is already there.
 */
export function resolveServerExe({ root = process.cwd(), env = process.env, exists = existsSync } = {}) {
  const candidates = [];
  if (env.BURNRATE_SERVER_EXE) {
    candidates.push(path.resolve(root, env.BURNRATE_SERVER_EXE));
  }
  if (env.CARGO_TARGET_DIR) {
    const target = path.resolve(root, env.CARGO_TARGET_DIR);
    candidates.push(path.join(target, "release", SERVER_BINARY));
    candidates.push(path.join(target, "debug", SERVER_BINARY));
  }
  for (const profile of ["release", "debug"]) {
    candidates.push(path.join(root, "server-rs", "target", profile, SERVER_BINARY));
    candidates.push(path.join(root, "target", profile, SERVER_BINARY));
  }
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** The web build the server must serve (vite outputs to dist/web). */
export function resolveWebDir({ root = process.cwd(), env = process.env, exists = existsSync } = {}) {
  const candidates = [
    env.BURNRATE_WEB ? path.resolve(root, env.BURNRATE_WEB) : path.join(root, "dist", "web"),
    path.join(root, "dist", "web"),
  ];
  for (const candidate of candidates) {
    if (exists(path.join(candidate, "index.html"))) return candidate;
  }
  return null;
}

/**
 * Everything the server can discover on the developer's computer is redirected into `home`.
 * The smoke run must never read or refresh a real Claude/Codex/OpenCode login.
 */
export function isolatedServerEnv({ home, port, dataDir, webDir, env = process.env }) {
  const isolatedHome = path.resolve(home);
  return {
    ...env,
    BURNRATE_PORT: String(port),
    BURNRATE_DATA: path.resolve(dataDir),
    BURNRATE_WEB: path.resolve(webDir),
    USERPROFILE: isolatedHome,
    HOME: isolatedHome,
    APPDATA: path.join(isolatedHome, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(isolatedHome, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
    XDG_DATA_HOME: path.join(isolatedHome, ".local", "share"),
    XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),
    CLAUDE_CONFIG_DIR: path.join(isolatedHome, ".claude"),
    CODEX_HOME: path.join(isolatedHome, ".codex"),
  };
}

function prepareDirs(home) {
  const dirs = [
    home,
    path.join(home, "AppData", "Roaming"),
    path.join(home, "AppData", "Local"),
    path.join(home, ".config"),
    path.join(home, ".local", "share"),
    path.join(home, ".cache"),
    path.join(home, ".claude"),
    path.join(home, ".codex"),
  ];
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
}

async function portAnswers(baseUrl) {
  try {
    await fetch(`${baseUrl}/api/providers`, { signal: AbortSignal.timeout(800) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the server on its own port with a throwaway BURNRATE_DATA and an isolated HOME.
 * Returns a handle whose `stop()` kills only this child (PID tree on Windows).
 */
export async function startServer({
  root = process.cwd(),
  exe = null,
  webDir = null,
  port = 13_850,
  tmpRoot = null,
  readyTimeoutMs = 25_000,
  env = process.env,
} = {}) {
  const serverExe = exe ?? resolveServerExe({ root, env });
  if (!serverExe) {
    throw new Error(
      "No Burnrate server binary found. Build it (cargo build --manifest-path server-rs/Cargo.toml) " +
        "or point BURNRATE_SERVER_EXE / --exe at an existing burnrate-server executable.",
    );
  }
  const web = webDir ?? resolveWebDir({ root, env });
  if (!web) {
    throw new Error("No web build found. Run `corepack pnpm build` first (vite writes dist/web), or set BURNRATE_WEB.");
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  if (await portAnswers(baseUrl)) {
    throw new Error(`Port ${port} is already answering on ${baseUrl}; stop that process or pass --port.`);
  }

  const workspace = tmpRoot
    ? path.resolve(tmpRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), "burnrate-smoke-"));
  const dataDir = path.join(workspace, "data");
  const home = path.join(workspace, "home");
  fs.mkdirSync(dataDir, { recursive: true });
  prepareDirs(home);

  const logs = [];
  const child = spawn(serverExe, [], {
    cwd: root,
    env: isolatedServerEnv({ home, port, dataDir, webDir: web, env }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // POSIX: own process group, so stopProcess can kill -pid without touching the test runner.
    detached: process.platform !== "win32",
  });
  const capture = (buffer) => {
    for (const line of buffer.toString().split(/\r?\n/)) {
      if (!line) continue;
      logs.push(line);
      if (logs.length > 300) logs.shift();
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Server exited with code ${child.exitCode} before it was ready.\n${tail(logs).join("\n")}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/providers`, { signal: AbortSignal.timeout(1_000) });
      if (response.status < 500) {
        ready = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await sleep(150);
  }
  if (!ready) {
    await stopProcess(child);
    throw new Error(`Server did not become ready on ${baseUrl} within ${readyTimeoutMs} ms.\n${tail(logs).join("\n")}`);
  }

  return {
    baseUrl,
    port,
    exe: serverExe,
    webDir: web,
    dataDir,
    home,
    tmpRoot: workspace,
    logs,
    child,
    stop: () => stopProcess(child),
  };
}

/** Waits for a child process to exit, resolving even when it ignores gentle signals. */
async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Terminates only the given PID (and its children on Windows). */
export async function stopProcess(child) {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  const pid = child.pid;
  try {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
      if (!(await waitForExit(child, 3_000))) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          process.kill(pid, "SIGKILL");
        }
      }
    }
  } catch {
    // The process may already be gone; nothing else to clean up.
  }
}

export function removeTmpRoot(workspace) {
  if (!workspace) return;
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // Windows may still hold a log handle for a moment; the temp dir is harmless.
  }
}
