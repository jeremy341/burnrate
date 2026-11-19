import type { ProviderModule } from "../types.ts";
import { codex } from "./codex.ts";
import { mistral } from "./mistral.ts";

/** Add a provider by importing its module and listing it here. */
export const PROVIDERS: readonly ProviderModule[] = [codex, mistral];
