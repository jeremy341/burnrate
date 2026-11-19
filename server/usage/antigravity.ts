// Antigravity conversation reader. Format knowledge and model table derived from T3 Code's
// Antigravity usage reader (MIT, see NOTICE), simplified to one pass per database.
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { UsageTokenTotals } from "../../src/contracts.ts";
import type { ReadResult, SourceReader } from "./readers.ts";
import type { UsageRecord } from "./types.ts";

type FieldValue = number | bigint | Uint8Array;
type Fields = Map<number, FieldValue[]>;

/** Minimal protobuf reader: field number to its raw values. */
function fields(bytes: Uint8Array): Fields {
  let offset = 0;
  const result: Fields = new Map();
  const varint = (): number | bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) throw new Error("Invalid varint");
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
    }
    throw new Error("Invalid varint");
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (typeof tag !== "number") throw new Error("Invalid protobuf field");
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0) throw new Error("Invalid protobuf field");
    let value: FieldValue;
    if (wire === 0) value = varint();
    else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (typeof length !== "number") throw new Error("Invalid length");
      if (length > bytes.length - offset) throw new Error("Truncated field");
      value = bytes.subarray(offset, offset + length);
      offset += length;
      if (wire !== 2) continue;
    } else throw new Error("Unsupported wire type");
    const entries = result.get(number) ?? [];
    entries.push(value);
    result.set(number, entries);
  }
  return result;
}

const numberAt = (v: Fields, key: number) => {
  const e = v.get(key)?.[0];
  return typeof e === "number" ? e : 0;
};
const bytesAt = (v: Fields, key: number) => {
  const e = v.get(key)?.[0];
  return e instanceof Uint8Array ? e : undefined;
};
const nested = (v: Fields, key: number): Fields => {
  const b = bytesAt(v, key);
  return b === undefined ? new Map() : fields(b);
};
const textAt = (v: Fields, key: number) => {
  const b = bytesAt(v, key);
  return b === undefined ? "" : new TextDecoder("utf-8", { fatal: true }).decode(b).trim();
};
const timestamp = (v: Fields): number | null => {
  const seconds = numberAt(v, 1);
  return seconds > 0 ? seconds * 1000 + Math.floor(numberAt(v, 2) / 1_000_000) : null;
};

// Offline fallback for records without names. New names are learned from the scanned metadata.
const MODEL_IDS: Record<number, string> = {
  246: "gemini-2.5-pro", 312: "gemini-2.5-flash", 313: "gemini-2.5-flash-thinking", 329: "gemini-2.5-flash-thinking",
  330: "gemini-2.5-flash-lite", 281: "claude-sonnet-4", 282: "claude-sonnet-4", 290: "claude-opus-4", 291: "claude-opus-4",
  333: "claude-sonnet-4-5", 334: "claude-sonnet-4-5", 340: "claude-haiku-4-5", 341: "claude-haiku-4-5",
  342: "gpt-oss-120b-medium", 1026: "claude-opus-4-6", 1035: "claude-sonnet-4-6", 1016: "gemini-3.1-pro",
  1036: "gemini-3.1-pro", 1037: "gemini-3.1-pro", 1018: "gemini-3-flash-preview", 1084: "gemini-3-flash-preview",
  1047: "gemini-3-flash-preview", 1020: "gemini-3.5-flash-medium", 1021: "gemini-3.1-flash-image",
  1050: "gemini-3.1-flash-lite", 1071: "gemini-3.6-flash-high", 1072: "gemini-3.6-flash-medium",
  1073: "gemini-3.6-flash-low", 1132: "gemini-3.5-flash-high", 1133: "gemini-3.5-flash-high",
  1187: "gemini-3.5-flash-extra-low", 1196: "gemini-3.6-flash", 1266: "gemini-3.6-flash",
  1298: "gemini-3.7-flash-high", 1299: "gemini-3.7-flash-medium", 1300: "gemini-3.7-flash-low",
  1301: "gemini-3.7-flash-tiered", 1318: "gemini-3.8-flash-high", 1319: "gemini-3.8-flash-medium",
  1320: "gemini-3.8-flash-low", 1322: "gemini-3.8-flash-tiered", 1402: "claude-opus-5-5",
  1417: "gemini-4-argon", 1418: "gemini-4-argon", 1419: "gemini-4-argon",
};

// Effort and routing variants share the base model's price.
export const antigravityRateModel = (model: string): string => {
  const base = model.replace(/-(?:extra-low|low|medium|high|tiered|control|thinking|agent)$/, "");
  return /^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)
    ? "gemini-3.5-flash"
    : model === "gemini-3.7-flash-safety-le"
      ? "gemini-3.7-flash"
      : base === "gemini-3-flash"
        ? "gemini-3-flash-preview"
        : base;
};

function modelName(name: string): string {
  if (!name) return "";
  const normalized = name.toLowerCase().replace(/\s*\(([^)]*)\)\s*$/, "-$1").replace(/\s+/g, "-");
  if (normalized.startsWith("claude-")) {
    return normalized.replace(/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1").replaceAll(".", "-");
  }
  return normalized;
}

const isConcreteModel = (model: string): boolean =>
  /^(?:gemini-\d|claude-(?:sonnet|opus|haiku)-\d|gpt-)/.test(model) && !/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model);

interface Metadata {
  model: string;
  modelId: number;
  timestampMs: number | null;
  usages: Fields[];
}

function metadata(bytes: Uint8Array, step: boolean): Metadata {
  const root = fields(bytes);
  if (!step && bytesAt(root, 1) === undefined) throw new Error("Missing generation metadata");
  const data = step ? root : nested(root, 1);
  const model = step ? nested(data, 24) : data;
  const usage = bytesAt(data, step ? 9 : 4);
  const primary = usage === undefined ? undefined : fields(usage.slice());
  const usages = primary === undefined ? [] : [primary];
  for (const retry of data.get(step ? 28 : 17) ?? []) {
    if (!(retry instanceof Uint8Array)) throw new Error("Invalid retry metadata");
    const retryUsage = bytesAt(fields(retry), 2);
    if (retryUsage !== undefined) usages.push(fields(retryUsage.slice()));
  }
  const names = [textAt(model, step ? 12 : 19), textAt(model, step ? 8 : 21)].map(modelName);
  return {
    model: names.find(isConcreteModel) ?? names.find((n) => n && !/^model[_-]/.test(n)) ?? "",
    modelId: numberAt(model, step ? 1 : 3) || (primary === undefined ? 0 : numberAt(primary, 1)),
    timestampMs: step ? (timestamp(nested(data, 8)) ?? timestamp(nested(data, 1))) : timestamp(nested(nested(data, 9), 4)),
    usages,
  };
}

function readDatabase(path: string, sessionId: string, fallbackTimestamp: number, sinceMs: number): ReadResult {
  const db = new DatabaseSync(path, { readOnly: true });
  const records: UsageRecord[] = [];
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
    if (!tables.has("gen_metadata") && !tables.has("steps")) return { records, malformed: 1 };
    const load = (sql: string, step: boolean) => {
      const out: Array<{ idx: number; entry: Metadata }> = [];
      // One row at a time: generation rows can hold megabytes of context.
      for (const row of db.prepare(sql).iterate() as Iterable<{ idx: unknown; data: unknown }>) {
        if (row.data === null || typeof row.idx !== "number" || !(row.data instanceof Uint8Array)) continue;
        out.push({ idx: row.idx, entry: metadata(row.data, step) });
      }
      return out.sort((a, b) => a.idx - b.idx);
    };
    const generations = tables.has("gen_metadata") ? load("SELECT idx, data FROM gen_metadata ORDER BY rowid", false) : [];
    const steps = tables.has("steps") ? load("SELECT idx, metadata AS data FROM steps ORDER BY rowid", true) : [];
    let trajectoryTimestamp: number | null = null;
    if (tables.has("trajectory_metadata_blob")) {
      for (const row of db.prepare("SELECT data FROM trajectory_metadata_blob").all() as Array<{ data: unknown }>) {
        if (row.data instanceof Uint8Array) trajectoryTimestamp ??= timestamp(nested(fields(row.data), 2));
      }
    }
    const learned = new Map<number, string | null>();
    for (const { entry } of [...generations, ...steps]) {
      if (entry.modelId > 0 && isConcreteModel(entry.model)) {
        const prev = learned.get(entry.modelId);
        learned.set(entry.modelId, prev === undefined || prev === entry.model ? entry.model : null);
      }
    }
    const generationByIdx = new Map(generations.map(({ idx, entry }) => [idx, entry]));
    for (const [source, entries] of [["step", steps], ["generation", generations]] as const) {
      for (const [index, { idx, entry }] of entries.entries()) {
        for (const [usageIndex, usage] of entry.usages.entries()) {
          const modelId = numberAt(usage, 1) || entry.modelId;
          const generation = source === "step" ? generationByIdx.get(idx) : undefined;
          const matches = (m: Metadata) => modelId === 0 || m.modelId === modelId;
          let model = matches(entry) && entry.model ? entry.model : generation && matches(generation) ? generation.model : "";
          if (!isConcreteModel(model)) {
            const known = learned.get(modelId);
            model = model || known || MODEL_IDS[modelId] || (modelId > 0 ? `antigravity-model-${modelId}` : "antigravity-unknown");
            if (isConcreteModel(known ?? "")) model = known!;
          }
          const output = Math.max(numberAt(usage, 3), numberAt(usage, 9) + numberAt(usage, 10));
          const totals: UsageTokenTotals = {
            uncachedInputTokens: numberAt(usage, 2),
            cachedInputTokens: numberAt(usage, 5),
            cacheCreationTokens: numberAt(usage, 4),
            outputTokens: output,
            reasoningTokens: Math.min(output, numberAt(usage, 9)),
          };
          if (totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens + output === 0) continue;
          const keys = ([11, 12, 7] as const).flatMap((k) => {
            const id = textAt(usage, k);
            return id ? [`antigravity:${k}:${id}`] : [];
          });
          const ts = entry.timestampMs ?? trajectoryTimestamp ?? fallbackTimestamp;
          if (ts < sinceMs) continue;
          const rateModel = antigravityRateModel(model);
          records.push({
            provider: "antigravity",
            timestampMs: ts,
            model,
            ...(rateModel === model ? {} : { rateModel }),
            sessionId,
            totals,
            reportedCostUsd: null,
            speed: "standard",
            dedupeKey: keys[0] ?? `antigravity:${sessionId}:${source}:${index}:${usageIndex}`,
          });
        }
      }
    }
  } finally {
    db.close();
  }
  return { records, malformed: 0 };
}

function dataRoots(): string[] {
  const configured = process.env.ANTIGRAVITY_DATA_DIR?.split(",").map((v) => v.trim()).filter(Boolean);
  const home = homedir();
  const defaults = [
    ...["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].map((n) => join(home, ".gemini", n)),
    join(home, ".config", "antigravity"),
  ];
  return [...new Set((configured?.length ? configured : defaults).map((r) => resolve(r)))];
}

function walkDbs(root: string, out: Array<{ path: string; size: number; mtimeMs: number }>) {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(root, name);
    try {
      const st = statSync(path);
      if (st.isDirectory()) walkDbs(path, out);
      else if (name.endsWith(".db") && path.includes("conversations")) {
        // The WAL holds new rows, so it counts toward the change fingerprint.
        let size = st.size;
        let mtimeMs = st.mtimeMs;
        try {
          const wal = statSync(`${path}-wal`);
          size += wal.size;
          mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
        } catch {
          /* no wal */
        }
        out.push({ path, size, mtimeMs });
      }
    } catch {
      /* vanished */
    }
  }
}

export const antigravityReader: SourceReader = {
  provider: "antigravity",
  dir: () => dataRoots()[0] ?? join(homedir(), ".gemini", "antigravity"),
  files() {
    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
    const seen = new Set<string>();
    for (const root of dataRoots()) walkDbs(root, out);
    return out.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
  },
  read(path, sinceMs) {
    const id = path.replace(/\\/g, "/").split("/").pop()!.replace(/\.db$/, "");
    return readDatabase(path, id, statSync(path).mtimeMs, sinceMs);
  },
};
