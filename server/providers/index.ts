import type { ProviderModule } from "../types.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { mistral } from "./mistral.ts";
import { opencode } from "./opencode.ts";

/** Add a provider by importing its module and listing it here. */
export const PROVIDERS: readonly ProviderModule[] = [claude, opencode, codex, mistral];
