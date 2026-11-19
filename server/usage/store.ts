import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { UsageRecord, UsageSpeed } from "./types.ts";

/**
 * Parsed usage is kept as one Float64Array per transcript file instead of one object per record:
 * a record costs 112 bytes here against several hundred as an object, and the cache on disk is the
 * same bytes, so it loads without parsing. Strings (provider, model, session) are interned.
 */
export const STRIDE = 14;
export const COL = {
  ts: 0,
  provider: 1,
  model: 2,
  rateModel: 3,
  session: 4,
  speed: 5,
  uncached: 6,
  cached: 7,
  cacheWrite: 8,
  output: 9,
  reasoning: 10,
  cache1h: 11,
  reportedCost: 12,
  keyHash: 13,
} as const;

const SPEEDS: readonly UsageSpeed[] = ["standard", "fast", "ultrafast"];

export class Interner {
  readonly strings: string[] = [];
  readonly #ids = new Map<string, number>();

  constructor(initial: readonly string[] = []) {
    for (const s of initial) this.id(s);
  }

  id(value: string): number {
    let id = this.#ids.get(value);
    if (id === undefined) {
      id = this.strings.length;
      this.strings.push(value);
      this.#ids.set(value, id);
    }
    return id;
  }

  get(id: number): string {
    return this.strings[id] ?? "";
  }
}

/** 53-bit hash of a dedupe key (two FNV-1a passes): small enough to keep in a Float64Array. */
export function hashKey(key: string): number {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b) ^ (b >>> 13);
  }
  return (a >>> 0) * 0x200000 + ((b >>> 0) >>> 11);
}

export function packRecords(records: readonly UsageRecord[], strings: Interner): Float64Array {
  const rows = new Float64Array(records.length * STRIDE);
  records.forEach((r, i) => {
    const o = i * STRIDE;
    rows[o + COL.ts] = r.timestampMs;
    rows[o + COL.provider] = strings.id(r.provider);
    rows[o + COL.model] = strings.id(r.model);
    rows[o + COL.rateModel] = r.rateModel === undefined ? -1 : strings.id(r.rateModel);
    rows[o + COL.session] = strings.id(r.sessionId);
    rows[o + COL.speed] = SPEEDS.indexOf(r.speed);
    rows[o + COL.uncached] = r.totals.uncachedInputTokens;
    rows[o + COL.cached] = r.totals.cachedInputTokens;
    rows[o + COL.cacheWrite] = r.totals.cacheCreationTokens;
    rows[o + COL.output] = r.totals.outputTokens;
    rows[o + COL.reasoning] = r.totals.reasoningTokens;
    rows[o + COL.cache1h] = r.cacheCreation1hTokens ?? 0;
    rows[o + COL.reportedCost] = r.reportedCostUsd ?? Number.NaN;
    rows[o + COL.keyHash] = r.dedupeKey === null ? Number.NaN : hashKey(`${r.provider}\0${r.dedupeKey}`);
  });
  return rows;
}

/** One row as a record, for pricing. The caller applies aliases to `model`. */
export function unpackRow(rows: Float64Array, index: number, strings: Interner): UsageRecord {
  const o = index * STRIDE;
  const rateModel = rows[o + COL.rateModel]!;
  const cache1h = rows[o + COL.cache1h]!;
  const cost = rows[o + COL.reportedCost]!;
  return {
    provider: strings.get(rows[o + COL.provider]!),
    timestampMs: rows[o + COL.ts]!,
    model: strings.get(rows[o + COL.model]!),
    ...(rateModel < 0 ? {} : { rateModel: strings.get(rateModel) }),
    sessionId: strings.get(rows[o + COL.session]!),
    totals: {
      uncachedInputTokens: rows[o + COL.uncached]!,
      cachedInputTokens: rows[o + COL.cached]!,
      cacheCreationTokens: rows[o + COL.cacheWrite]!,
      outputTokens: rows[o + COL.output]!,
      reasoningTokens: rows[o + COL.reasoning]!,
    },
    ...(cache1h > 0 ? { cacheCreation1hTokens: cache1h } : {}),
    reportedCostUsd: Number.isNaN(cost) ? null : cost,
    speed: SPEEDS[rows[o + COL.speed]!] ?? "standard",
    dedupeKey: null,
  };
}

export interface FileEntry {
  size: number;
  mtimeMs: number;
  malformed: number;
  rows: Float64Array;
}

interface Header {
  version: number;
  strings: string[];
  files: Array<{ key: string; size: number; mtimeMs: number; malformed: number; rowCount: number }>;
}

export function saveStore(path: string, version: number, strings: Interner, files: ReadonlyMap<string, FileEntry>): void {
  const header: Header = {
    version,
    strings: strings.strings,
    files: [...files].map(([key, e]) => ({ key, size: e.size, mtimeMs: e.mtimeMs, malformed: e.malformed, rowCount: e.rows.length / STRIDE })),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  // Row data starts on an 8-byte boundary so it can be read back as Float64.
  const padding = (8 - ((4 + headerBytes.length) % 8)) % 8;
  const prefix = Buffer.alloc(4 + headerBytes.length + padding);
  prefix.writeUInt32LE(headerBytes.length, 0);
  headerBytes.copy(prefix, 4);
  const parts: Buffer[] = [prefix];
  for (const e of files.values()) parts.push(Buffer.from(e.rows.buffer, e.rows.byteOffset, e.rows.byteLength));
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, Buffer.concat(parts));
  renameSync(tmp, path);
}

export function loadStore(path: string, version: number): { strings: Interner; files: Map<string, FileEntry> } | null {
  if (!existsSync(path)) return null;
  try {
    const buf = readFileSync(path);
    const headerLength = buf.readUInt32LE(0);
    const header = JSON.parse(buf.subarray(4, 4 + headerLength).toString("utf8")) as Header;
    if (header.version !== version) return null;
    const padding = (8 - ((4 + headerLength) % 8)) % 8;
    let offset = 4 + headerLength + padding;
    const files = new Map<string, FileEntry>();
    for (const f of header.files) {
      const bytes = f.rowCount * STRIDE * 8;
      // Copy out of the file buffer so it can be released once loaded.
      const rows = new Float64Array(buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + bytes));
      files.set(f.key, { size: f.size, mtimeMs: f.mtimeMs, malformed: f.malformed, rows });
      offset += bytes;
    }
    return { strings: new Interner(header.strings), files };
  } catch {
    return null;
  }
}
