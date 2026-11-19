import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ServerSettingsPatch, UsageModelPriceOverride } from "../src/contracts.ts";

export interface AppSettings {
  usagePriceOverrides: Record<string, UsageModelPriceOverride>;
  usageModelAliases: Record<string, string>;
}

const price = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e6;

function validPrice(p: unknown): p is UsageModelPriceOverride {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    price(o["inputCostPerMillionTokens"]) &&
    price(o["outputCostPerMillionTokens"]) &&
    (o["cacheReadCostPerMillionTokens"] === undefined || price(o["cacheReadCostPerMillionTokens"])) &&
    (o["cacheWriteCostPerMillionTokens"] === undefined || price(o["cacheWriteCostPerMillionTokens"]))
  );
}

const validName = (s: string) => s.trim().length > 0 && s.length <= 200;

export function createSettingsStore(dataDir: string) {
  const file = join(dataDir, "settings.json");
  let current: AppSettings = { usagePriceOverrides: {}, usageModelAliases: {} };
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AppSettings>;
      current = {
        usagePriceOverrides: raw.usagePriceOverrides ?? {},
        usageModelAliases: raw.usageModelAliases ?? {},
      };
    } catch {
      /* keep defaults */
    }
  }
  return {
    get: (): AppSettings => current,
    /** `null` removes an entry. Invalid entries are rejected as a whole. */
    patch(patch: ServerSettingsPatch): AppSettings | null {
      const next: AppSettings = {
        usagePriceOverrides: { ...current.usagePriceOverrides },
        usageModelAliases: { ...current.usageModelAliases },
      };
      for (const [model, value] of Object.entries(patch.usagePriceOverrides ?? {})) {
        if (!validName(model)) return null;
        if (value === null) delete next.usagePriceOverrides[model];
        else if (validPrice(value)) next.usagePriceOverrides[model] = value;
        else return null;
      }
      for (const [model, value] of Object.entries(patch.usageModelAliases ?? {})) {
        if (!validName(model)) return null;
        if (value === null) delete next.usageModelAliases[model];
        else if (typeof value === "string" && validName(value)) next.usageModelAliases[model] = value;
        else return null;
      }
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, JSON.stringify(next, null, 2));
      current = next;
      return next;
    },
  };
}
