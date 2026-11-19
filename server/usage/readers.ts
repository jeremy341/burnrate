// Transcript readers. Formats and rules derived from T3 Code's usage readers (MIT, see NOTICE).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { UsageTokenTotals } from "../../src/contracts.ts";
import { parseTimestampMs, tokenCount, totalTokens, type UsageRecord, type UsageSpeed } from "./types.ts";

export interface ReadResult {
  readonly records: UsageRecord[];
  readonly malformed: number;
}

export interface SourceReader {
  readonly provider: string;
  /** Directory or file to look at, used for status display. */
  dir(): string;
  /** Files whose change should trigger a re-read. Empty for database sources. */
  files(): Array<{ path: string; size: number; mtimeMs: number }>;
  /** Parse one file (or the whole database when `path` is the database). */
  read(path: string, sinceMs: number): ReadResult;
  /** The same session can sit in more than one file (for example moved to an archive): keep one copy. */
  readonly sharedSessionsAcrossFiles?: true;
}

function walk(root: string, accept: (name: string) => boolean, out: Array<{ path: string; size: number; mtimeMs: number }> = []) {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(root, name);
    try {
      const st = statSync(path);
      if (st.isDirectory()) walk(path, accept, out);
      else if (accept(name)) out.push({ path, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* file vanished */
    }
  }
  return out;
}

function lines(path: string): string[] {
  const buf = readFileSync(path);
  return (path.endsWith(".zst") ? zstdDecompressSync(buf) : buf).toString("utf8").split("\n");
}

/** Claude Code keeps one config directory per account (`~/.claude`, `~/.claude-work`, ...). */
export function claudeConfigDirs(): string[] {
  const dirs = new Set<string>();
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (env) dirs.add(resolve(env));
  const home = homedir();
  try {
    for (const name of readdirSync(home)) {
      if (name !== ".claude" && !name.startsWith(".claude-")) continue;
      const dir = join(home, name);
      if (existsSync(join(dir, "projects"))) dirs.add(dir);
    }
  } catch {
    /* unreadable home */
  }
  return [...dirs];
}

// ---------------------------------------------------------------- Claude

const CLAUDE_SYNTHETIC = "<synthetic>";

function cacheCreation1h(usage: Record<string, unknown>): { cacheCreation1hTokens?: number } {
  const split = usage["cache_creation"];
  if (typeof split !== "object" || split === null) return {};
  const tokens = tokenCount((split as Record<string, unknown>)["ephemeral_1h_input_tokens"]);
  return tokens > 0 ? { cacheCreation1hTokens: tokens } : {};
}

export function parseClaudeLine(line: string): UsageRecord[] {
  if (!line.includes('"usage"')) return [];
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (record["type"] !== "assistant") return [];
  const message = record["message"] as Record<string, unknown> | null;
  if (typeof message !== "object" || message === null) return [];
  const usage = message["usage"] as Record<string, unknown> | null;
  if (typeof usage !== "object" || usage === null) return [];
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return [];
  const model = typeof message["model"] === "string" ? message["model"] : "";
  if (!model || model === CLAUDE_SYNTHETIC) return [];
  const messageId = typeof message["id"] === "string" ? message["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  const dedupeKey = messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;
  const cost = record["costUSD"];
  const sessionId = typeof record["sessionId"] === "string" ? record["sessionId"] : "";
  const executor: UsageRecord = {
    provider: "claude",
    timestampMs,
    model,
    sessionId,
    totals: {
      uncachedInputTokens: tokenCount(usage["input_tokens"]),
      cachedInputTokens: tokenCount(usage["cache_read_input_tokens"]),
      cacheCreationTokens: tokenCount(usage["cache_creation_input_tokens"]),
      outputTokens: tokenCount(usage["output_tokens"]),
      reasoningTokens: 0,
    },
    ...cacheCreation1h(usage),
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    speed: usage["speed"] === "fast" ? "fast" : "standard",
    dedupeKey,
  };
  const out = [executor];
  // Advisor calls run on another model at its own rates and only appear in `iterations`.
  const iterations: unknown[] = Array.isArray(usage["iterations"]) ? usage["iterations"] : [];
  iterations.forEach((it, index) => {
    if (typeof it !== "object" || it === null) return;
    const adv = it as Record<string, unknown>;
    if (adv["type"] !== "advisor_message") return;
    const advModel = typeof adv["model"] === "string" ? adv["model"] : "";
    if (!advModel || advModel === CLAUDE_SYNTHETIC) return;
    out.push({
      provider: "claude",
      timestampMs,
      model: advModel,
      sessionId,
      totals: {
        uncachedInputTokens: tokenCount(adv["input_tokens"]),
        cachedInputTokens: tokenCount(adv["cache_read_input_tokens"]),
        cacheCreationTokens: tokenCount(adv["cache_creation_input_tokens"]),
        outputTokens: tokenCount(adv["output_tokens"]),
        reasoningTokens: 0,
      },
      ...cacheCreation1h(adv),
      reportedCostUsd: null,
      speed: executor.speed,
      dedupeKey: dedupeKey === null ? null : `${dedupeKey}:advisor:${index}`,
    });
  });
  return out;
}

export const claudeReader: SourceReader = {
  provider: "claude",
  dir: () => join(claudeConfigDirs()[0] ?? join(homedir(), ".claude"), "projects"),
  files() {
    return claudeConfigDirs().flatMap((dir) => walk(join(dir, "projects"), (n) => n.endsWith(".jsonl")));
  },
  read(path, sinceMs) {
    const records: UsageRecord[] = [];
    for (const line of lines(path)) {
      for (const r of parseClaudeLine(line)) if (r.timestampMs >= sinceMs) records.push(r);
    }
    return { records, malformed: 0 };
  },
};

// ---------------------------------------------------------------- Codex

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

function readCodexUsage(value: unknown): CodexUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const input = raw["input_tokens"];
  const output = raw["output_tokens"];
  if (typeof input !== "number" || typeof output !== "number") return null;
  const n = (k: string, d = 0) => (typeof raw[k] === "number" ? (raw[k] as number) : d);
  const u: CodexUsage = {
    input_tokens: input,
    cached_input_tokens: n("cached_input_tokens"),
    cache_write_input_tokens: n("cache_write_input_tokens"),
    output_tokens: output,
    reasoning_output_tokens: n("reasoning_output_tokens"),
    total_tokens: n("total_tokens", input + output),
  };
  const ok =
    Object.values(u).every((v) => Number.isInteger(v) && v >= 0) &&
    u.cached_input_tokens + u.cache_write_input_tokens <= u.input_tokens &&
    u.reasoning_output_tokens <= u.output_tokens;
  return ok ? u : null;
}

const CODEX_KEYS: Array<keyof CodexUsage> = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

const codexSpeed = (tier: unknown): UsageSpeed =>
  tier === "priority" || tier === "fast" ? "fast" : tier === "ultrafast" ? "ultrafast" : "standard";

interface Attribution {
  timestampMs: number;
  model: string;
  speed: UsageSpeed;
}
interface Unreported extends Attribution {
  usage: CodexUsage;
}
interface CodexState {
  model: string;
  speed: UsageSpeed;
  sessionId: string;
  lastUsageSignature: string | null;
  lastCumulativeUsage: CodexUsage | null;
  sequenceStartSignature?: string;
  latestCumulativeAtMs?: number;
  unreportedRequests?: Unreported[];
  requestLedgerActive: boolean;
  malformedRecords: number;
  sawSessionMeta: boolean;
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

const FORK_COPY_MAX_GAP_MS = 1000;
const sameUsage = (a: CodexUsage, b: CodexUsage) => CODEX_KEYS.every((k) => a[k] === b[k]);

function advance(previous: CodexUsage | null, last: CodexUsage): CodexUsage | null {
  return readCodexUsage(Object.fromEntries(CODEX_KEYS.map((k) => [k, (previous?.[k] ?? 0) + last[k]])));
}

function dateBaseline(state: CodexState, ts: number) {
  state.latestCumulativeAtMs = Math.max(state.latestCumulativeAtMs ?? ts, ts);
}

function rebase(state: CodexState, cumulative: CodexUsage, ts: number) {
  state.lastCumulativeUsage = cumulative;
  dateBaseline(state, ts);
  delete state.unreportedRequests;
  if (cumulative.input_tokens + cumulative.output_tokens === 0) delete state.sequenceStartSignature;
}

// Bill requests an interrupted turn never reported only when the records since the previous snapshot explain the whole gap.
function bridged(previous: CodexUsage | null, cumulative: CodexUsage, last: CodexUsage, pending: Unreported[] | undefined) {
  if (previous === null || pending === undefined || CODEX_KEYS.some((k) => cumulative[k] - previous[k] !== pending.reduce((s, r) => s + r.usage[k], 0))) return null;
  const final = pending.at(-1)!;
  const remainder = readCodexUsage(Object.fromEntries(CODEX_KEYS.map((k) => [k, final.usage[k] - last[k]])));
  if (remainder === null) return null;
  return [...pending.slice(0, -1), { ...final, usage: remainder }].filter((r) => r.usage.input_tokens + r.usage.output_tokens > 0);
}

function discarded(pending: Unreported[] | undefined, last: CodexUsage) {
  const final = pending?.at(-1);
  if (pending === undefined || final === undefined) return 0;
  return pending.length - (sameUsage(final.usage, last) ? 1 : 0);
}

function isForkedMeta(p: Record<string, unknown>): boolean {
  if (typeof p["forked_from_id"] === "string") return true;
  const spawn = ((p["source"] as Record<string, unknown> | undefined)?.["subagent"] as Record<string, unknown> | undefined)?.["thread_spawn"] as Record<string, unknown> | undefined;
  return typeof spawn?.["parent_thread_id"] === "string";
}

function isForkCopy(state: CodexState, ts: number): boolean {
  if (!state.suppressingForkCopies) return false;
  if (ts - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
    state.forkCopyAnchorMs = ts;
    return true;
  }
  state.suppressingForkCopies = false;
  state.lastUsageSignature = null;
  return false;
}

const attribution = (state: CodexState, ts: number): Attribution => ({ timestampMs: ts, model: state.model, speed: state.speed });

function request(state: CodexState, usage: CodexUsage, a: Attribution, dedupeKey: string | null = null): UsageRecord {
  const totals: UsageTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    cacheCreationTokens: usage.cache_write_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.reasoning_output_tokens,
  };
  return { provider: "codex", timestampMs: a.timestampMs, model: a.model, sessionId: state.sessionId, totals, reportedCostUsd: null, speed: a.speed, dedupeKey };
}

function parseCodexRecord(rec: Record<string, unknown>, state: CodexState): UsageRecord[] {
  const payload = rec["payload"];
  if (typeof payload !== "object" || payload === null) return [];
  const p = payload as Record<string, unknown>;
  const payloadType = p["type"];

  if (rec["type"] === "session_meta") {
    if (state.sawSessionMeta) return [];
    state.sawSessionMeta = true;
    const id = p["id"] ?? p["session_id"];
    if (typeof id === "string") state.sessionId = id;
    const ts = parseTimestampMs(rec["timestamp"]);
    if (ts !== null && isForkedMeta(p)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = ts;
    }
    return [];
  }
  if (rec["type"] === "turn_context") {
    state.requestLedgerActive = false;
    if (typeof p["model"] === "string") state.model = p["model"];
    return [];
  }
  if (rec["type"] === "token_usage_record") {
    const ts = parseTimestampMs(rec["timestamp"]);
    const usage = readCodexUsage(p["usage"]);
    if (ts === null || usage === null || state.model.length === 0) return [];
    if (isForkCopy(state, ts)) return [];
    const responseId = p["response_id"];
    if (typeof responseId === "string" && responseId.length > 0) {
      const pending = state.unreportedRequests ?? [];
      state.requestLedgerActive = true;
      for (const r of pending) state.lastCumulativeUsage = advance(state.lastCumulativeUsage, r.usage);
      state.lastCumulativeUsage = advance(state.lastCumulativeUsage, usage);
      dateBaseline(state, ts);
      delete state.unreportedRequests;
      return [
        ...pending.map((r) => request(state, r.usage, r)),
        request(state, usage, attribution(state, ts), JSON.stringify(["codex", state.sessionId, responseId])),
      ];
    }
    state.requestLedgerActive = false;
    (state.unreportedRequests ??= []).push({ ...attribution(state, ts), usage });
    return [];
  }
  if (payloadType === "thread_settings_applied") {
    const settings = p["thread_settings"];
    if (typeof settings === "object" && settings !== null) state.speed = codexSpeed((settings as Record<string, unknown>)["service_tier"]);
    return [];
  }
  if (payloadType !== "token_count") return [];
  const info = p["info"];
  if (typeof info !== "object" || info === null) return [];
  const i = info as Record<string, unknown>;
  const ts = parseTimestampMs(rec["timestamp"]);
  if (ts === null || state.model.length === 0) return [];

  const last = readCodexUsage(i["last_token_usage"]);
  const rawCumulative = i["total_token_usage"];
  const hasCumulative = rawCumulative !== undefined && rawCumulative !== null;
  const cumulative = hasCumulative ? readCodexUsage(rawCumulative) : null;

  if (isForkCopy(state, ts)) {
    const signature = last === null ? null : JSON.stringify(last);
    if (cumulative !== null) rebase(state, cumulative, ts);
    else if (!hasCumulative && last !== null && signature !== state.lastUsageSignature) {
      state.lastCumulativeUsage = advance(state.lastCumulativeUsage, last);
      dateBaseline(state, ts);
    }
    state.lastUsageSignature = signature;
    return [];
  }
  if (state.requestLedgerActive) {
    if (cumulative !== null) rebase(state, cumulative, ts);
    return [];
  }
  const previous = state.lastCumulativeUsage;
  const latestAt = state.latestCumulativeAtMs;
  const pending = state.unreportedRequests;
  if (cumulative !== null) rebase(state, cumulative, ts);
  if (last === null || (hasCumulative && cumulative === null)) {
    state.malformedRecords += 1;
    return [];
  }
  if (last.input_tokens + last.output_tokens === 0) {
    state.lastUsageSignature = null;
    return [];
  }
  if (cumulative !== null && previous !== null && sameUsage(cumulative, previous)) return [];
  if (last.total_tokens !== last.input_tokens + last.output_tokens) {
    state.malformedRecords += 1;
    return [];
  }
  const signature = JSON.stringify(last);
  let unreported: Unreported[] = [];
  if (cumulative !== null) {
    const restarted = sameUsage(cumulative, last);
    const sequenceStart = JSON.stringify([ts, last]);
    if (restarted && sequenceStart === state.sequenceStartSignature) {
      state.lastCumulativeUsage = previous;
      if (latestAt === undefined) delete state.latestCumulativeAtMs;
      return [];
    }
    const lowered = previous !== null && CODEX_KEYS.some((k) => cumulative[k] < previous[k]);
    const rewound = lowered && latestAt !== undefined && ts > latestAt;
    const reconciled =
      previous === null || rewound
        ? readCodexUsage(Object.fromEntries(CODEX_KEYS.map((k) => [k, cumulative[k] - last[k]]))) !== null
        : CODEX_KEYS.every((k) => cumulative[k] - previous[k] === last[k]);
    if (!restarted && !reconciled) {
      const b = bridged(previous, cumulative, last, pending);
      if (b === null) {
        const replayed = latestAt !== undefined && (ts < latestAt || (ts === latestAt && lowered && cumulative.input_tokens + cumulative.output_tokens > 0));
        if (replayed) {
          state.lastCumulativeUsage = previous;
          if (pending !== undefined) state.unreportedRequests = pending;
        }
        state.malformedRecords += 1;
        return [];
      }
      unreported = b;
    } else if (!restarted && rewound) {
      state.malformedRecords += discarded(pending, last);
    }
    if (restarted) state.sequenceStartSignature = sequenceStart;
  } else {
    if (signature === state.lastUsageSignature) return [];
    const advanced = advance(previous, last);
    if (advanced === null) {
      state.malformedRecords += 1;
      return [];
    }
    state.lastCumulativeUsage = advanced;
    dateBaseline(state, ts);
  }
  state.lastUsageSignature = signature;
  return [...unreported.map((r) => request(state, r.usage, r)), request(state, last, attribution(state, ts))];
}

/**
 * Codex `token_count` events carry neither model nor tier: both are carried forward from the most
 * recent `turn_context` and `thread_settings_applied`. Forked sessions copy their parent's history
 * right after the session meta; that copy is already billed in the parent. (Port of T3 Code's reader.)
 */
export function parseCodexFile(content: string[]): ReadResult {
  const state: CodexState = {
    model: "",
    speed: "standard",
    sessionId: "",
    lastUsageSignature: null,
    lastCumulativeUsage: null,
    requestLedgerActive: false,
    malformedRecords: 0,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  for (const line of content) {
    if (!(line.includes('"token_count"') || line.includes('"token_usage_record"') || line.includes('"turn_context"') || line.includes('"thread_settings_applied"') || line.includes('"session_meta"'))) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec !== "object" || rec === null) continue;
    for (const r of parseCodexRecord(rec as Record<string, unknown>, state)) {
      if (r.dedupeKey !== null) {
        if (seen.has(r.dedupeKey)) continue;
        seen.add(r.dedupeKey);
      }
      records.push(r);
    }
  }
  return { records, malformed: state.malformedRecords };
}

export const codexReader: SourceReader = {
  provider: "codex",
  dir: () => join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions"),
  sharedSessionsAcrossFiles: true,
  files() {
    const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    const accept = (n: string) => n.endsWith(".jsonl") || n.endsWith(".jsonl.zst");
    return [...walk(join(home, "sessions"), accept), ...walk(join(home, "archived_sessions"), accept)];
  },
  read(path, sinceMs) {
    const result = parseCodexFile(lines(path));
    return { records: result.records.filter((r) => r.timestampMs >= sinceMs), malformed: result.malformed };
  },
};

// ---------------------------------------------------------------- OpenCode

const OPENCODE_GATEWAYS = new Set(["opencode", "opencode-go"]);
const LITELLM_PREFIXES = new Map([["opencode-go", "opencode_go"]]);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseOpenCodeMessage(
  source: string,
  fallback: { id?: string; sessionId?: string; timestampMs?: number } = {},
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const message = obj(parsed);
  if (message["role"] !== undefined && message["role"] !== "assistant") return null;
  const usage = obj(message["tokens"]);
  const cache = obj(usage["cache"]);
  const modelRef = obj(message["model"]);
  const model = str(modelRef["id"]) || str(modelRef["modelID"]) || str(message["modelID"]);
  const providerId = str(modelRef["providerID"]) || str(message["providerID"]);
  const timestampMs = obj(message["time"])["created"] ?? fallback.timestampMs;
  if (!model || typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return null;
  const reasoning = tokenCount(usage["reasoning"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: tokenCount(usage["input"]),
    cachedInputTokens: tokenCount(cache["read"]),
    cacheCreationTokens: tokenCount(cache["write"]),
    outputTokens: tokenCount(usage["output"]) + reasoning,
    reasoningTokens: reasoning,
  };
  if (totalTokens(totals) === 0) return null;
  const id = fallback.id || str(message["id"]);
  const cost = message["cost"];
  const prefix = LITELLM_PREFIXES.get(providerId);
  const free = OPENCODE_GATEWAYS.has(providerId) && model.endsWith("-free");
  return {
    provider: "opencode",
    timestampMs,
    model,
    ...(prefix !== undefined && !model.includes("/") ? { rateModel: `${prefix}/${model}` } : {}),
    sessionId: fallback.sessionId || str(message["sessionID"]),
    totals,
    // OpenCode records zero for unknown rates and paid subscriptions alike.
    reportedCostUsd:
      typeof cost === "number" && Number.isFinite(cost) && (cost > 0 || (free && cost === 0)) ? cost : null,
    speed: "standard",
    dedupeKey: id ? `opencode:${id}` : null,
  };
}

const opencodeRoot = () => resolve(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");

export const opencodeReader: SourceReader = {
  provider: "opencode",
  dir: opencodeRoot,
  files() {
    const root = opencodeRoot();
    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      return out;
    }
    for (const name of names.filter((n) => /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(n))) {
      const path = join(root, name);
      // The WAL moves on every commit while the main file can stay put.
      let size = 0;
      let mtimeMs = 0;
      for (const f of [path, `${path}-wal`]) {
        try {
          const st = statSync(f);
          size += st.size;
          mtimeMs = Math.max(mtimeMs, st.mtimeMs);
        } catch {
          /* no wal */
        }
      }
      if (existsSync(path)) out.push({ path, size, mtimeMs });
    }
    return out;
  },
  read(path, sinceMs) {
    const records: UsageRecord[] = [];
    let malformed = 0;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 1000");
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
      for (const table of ["message", "session_message"] as const) {
        if (!tables.has(table)) continue;
        const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
        const hasTime = cols.has("time_created");
        const where: string[] = [];
        if (table === "session_message") where.push("type IN ('assistant', 'compaction')");
        if (hasTime) where.push("time_created >= ?");
        where.push("typeof(data) = 'text' AND json_valid(data)");
        // Project only the fields we need in SQLite: message bodies can be very large.
        const sql = `SELECT id, session_id, ${hasTime ? "time_created" : "NULL"} AS created,
            json_object('tokens', data -> '$.tokens', 'cost', data -> '$.cost', 'model', data -> '$.model',
              'modelID', data -> '$.modelID', 'providerID', data -> '$.providerID', 'time', data -> '$.time',
              'id', data -> '$.id', 'sessionID', data -> '$.sessionID') AS data
          FROM ${table} WHERE ${where.join(" AND ")}`;
        const rows = (hasTime ? db.prepare(sql).all(sinceMs) : db.prepare(sql).all()) as Array<{
          id: unknown;
          session_id: unknown;
          created: unknown;
          data: unknown;
        }>;
        for (const row of rows) {
          const record = parseOpenCodeMessage(str(row.data), {
            id: str(row.id),
            sessionId: str(row.session_id),
            ...(typeof row.created === "number" ? { timestampMs: row.created } : {}),
          });
          if (record && record.timestampMs >= sinceMs) records.push(record);
          else if (!record && str(row.data) === "") malformed++;
        }
      }
    } finally {
      db.close();
    }
    return { records, malformed };
  },
};

export const READERS: readonly SourceReader[] = [claudeReader, codexReader, opencodeReader];
