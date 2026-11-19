import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { LimitsAccount, LimitsReport, ProviderInfo } from "../src/contracts.ts";
import { createKeyStore } from "./keys.ts";
import { PROVIDERS } from "./providers/index.ts";
import { createUsageEngine } from "./usage/engine.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.BURNRATE_PORT ?? 13790);
const dataDir = resolve(process.env.BURNRATE_DATA ?? join(root, "data"));
const webDir = join(root, "dist", "web");
const keys = createKeyStore(dataDir);
const usage = createUsageEngine({ dataDir });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16_384) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function providerInfo(): ProviderInfo[] {
  return PROVIDERS.map((p) => {
    const names = p.auth === "apiKey" ? keys.names(p.id) : [];
    const connected = p.auth === "apiKey" ? names.length > 0 : (p.hasLogin?.() ?? false);
    return {
      id: p.id,
      label: p.label,
      color: p.color,
      auth: p.auth,
      connected,
      accounts: names.map((name) => ({ id: name, label: name })),
    };
  });
}

async function limitsReport(): Promise<LimitsReport> {
  const settled = await Promise.allSettled(PROVIDERS.map((p) => p.read(keys)));
  const accounts: LimitsAccount[] = [];
  const notices: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") accounts.push(...result.value);
    else notices.push(`${PROVIDERS[index]!.label}: could not read usage.`);
  });
  for (const a of accounts) {
    if (a.limits.unavailable?.message) notices.push(`${a.displayName ?? a.label}: ${a.limits.unavailable.message}`);
  }
  return { createdAt: new Date().toISOString(), accounts, notices };
}

const KEY_ROUTE = /^\/api\/providers\/([a-z0-9-]+)\/keys(?:\/([A-Za-z0-9_.-]{1,64}))?$/;

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "GET") {
    // Cross-site pages cannot send this header without a CORS preflight, which is never granted.
    if (req.headers["x-burnrate"] !== "1") return json(res, 403, { error: "forbidden" });
    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(new URL(origin).host)) return json(res, 403, { error: "forbidden" });
  }
  if (path === "/api/providers" && method === "GET") return json(res, 200, providerInfo());
  if (path === "/api/limits" && method === "GET") return json(res, 200, await limitsReport());
  if (path === "/api/usage" && method === "GET") {
    const q = new URL(req.url ?? "", "http://x").searchParams;
    const since = q.get("since") ?? "";
    const until = q.get("until") ?? "";
    if (!DAY.test(since) || !DAY.test(until)) return json(res, 400, { error: "invalid window" });
    const timeZone = q.get("tz") || "UTC";
    const resolution = q.get("resolution") === "hour" ? "hour" : "day";
    return json(res, 200, await usage.summary({ sinceDay: since, untilDay: until, timeZone, resolution }));
  }
  const match = KEY_ROUTE.exec(path);
  if (match) {
    const provider = PROVIDERS.find((p) => p.id === match[1] && p.auth === "apiKey");
    if (!provider) return json(res, 404, { error: "unknown provider" });
    if (method === "POST" && !match[2]) {
      const body = (await readBody(req)) as { name?: unknown; apiKey?: unknown };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || apiKey.length < 8 || apiKey.length > 4096) {
        return json(res, 400, { error: "invalid name or key" });
      }
      keys.set(provider.id, name, apiKey);
      return json(res, 200, { ok: true });
    }
    if (method === "DELETE" && match[2]) {
      keys.remove(provider.id, match[2]);
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { error: "not found" });
}

function serveStatic(res: ServerResponse, path: string): void {
  const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "");
  let file = resolve(webDir, rel);
  if (!file.startsWith(webDir)) return void res.writeHead(403).end();
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDir, "index.html");
  if (!existsSync(file)) return void res.writeHead(404).end("Build the web app first: pnpm build");
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Cache-Control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600",
  });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  // Reject DNS-rebinding: only our own loopback host names are served.
  if (!allowedHosts.has(req.headers.host ?? "")) return void res.writeHead(403).end();
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url.pathname).catch(() => json(res, 500, { error: "server error" }));
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Burnrate listening on http://127.0.0.1:${port}`);
  // Read the transcripts once in the background so the first Cost view does not wait for a cold scan.
  const today = new Date().toISOString().slice(0, 10);
  void usage.summary({ sinceDay: today, untilDay: today, timeZone: "UTC" }).catch(() => undefined);
});
