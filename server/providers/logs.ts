import { existsSync } from "node:fs";

import { READERS } from "../usage/readers.ts";
import type { ProviderModule } from "../types.ts";

/**
 * Providers with no subscription-limit API: Burnrate shows their cost and tokens from the local
 * transcripts. Connected means their transcript folder exists on this computer.
 */
function logsOnly(id: string, label: string, color: string, readerProvider: string): ProviderModule {
  return {
    id,
    label,
    color,
    auth: "localLogs",
    hasLogin: () => {
      const reader = READERS.find((r) => r.provider === readerProvider);
      return reader ? existsSync(reader.dir()) : false;
    },
    read: async () => [],
  };
}

export const pi = logsOnly("pi", "Pi", "#4d9f8a", "pi");
export const muse = logsOnly("muse", "Muse Code", "#0866ff", "muse");
export const antigravity = logsOnly("antigravity", "Antigravity", "#8c7bd1", "antigravity");
