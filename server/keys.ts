import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { KeyStore } from "./types.ts";

export interface WritableKeyStore extends KeyStore {
  set(providerId: string, name: string, key: string): void;
  remove(providerId: string, name: string): void;
  names(providerId: string): string[];
}

/**
 * API keys are encrypted at rest (AES-256-GCM) with a per-install master key kept next to them.
 * This keeps keys out of plain text; it is not a substitute for an OS keychain, which is the
 * planned next step. Keys are write-only through the HTTP API.
 */
export function createKeyStore(dataDir: string): WritableKeyStore {
  mkdirSync(dataDir, { recursive: true });
  const masterPath = join(dataDir, "master.key");
  const filePath = join(dataDir, "keys.enc");
  if (!existsSync(masterPath)) {
    writeFileSync(masterPath, randomBytes(32));
    try {
      chmodSync(masterPath, 0o600);
    } catch {
      /* not supported on every filesystem */
    }
  }
  const master = readFileSync(masterPath);

  type Data = Record<string, Record<string, string>>;
  const load = (): Data => {
    if (!existsSync(filePath)) return {};
    try {
      const raw = readFileSync(filePath);
      const decipher = createDecipheriv("aes-256-gcm", master, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as Data;
    } catch {
      return {};
    }
  };
  const save = (data: Data) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", master, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    writeFileSync(filePath, Buffer.concat([iv, cipher.getAuthTag(), body]));
  };

  return {
    list: (providerId) =>
      Object.entries(load()[providerId] ?? {}).map(([name, key]) => ({ name, key })),
    names: (providerId) => Object.keys(load()[providerId] ?? {}),
    set(providerId, name, key) {
      const data = load();
      (data[providerId] ??= {})[name] = key;
      save(data);
    },
    remove(providerId, name) {
      const data = load();
      if (data[providerId]) delete data[providerId][name];
      save(data);
    },
  };
}
