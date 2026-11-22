#!/usr/bin/env node
// Builds server-rs/defs/catalog.json from the models.dev provider registry.
//
// Usage:
//   node scripts/build-catalog.mjs                 # fetch models.dev and rewrite the catalog
//   node scripts/build-catalog.mjs --dry-run       # print the JSON instead of writing it
//   node scripts/build-catalog.mjs --check         # exit 1 when the committed file is stale
//   node scripts/build-catalog.mjs --validate      # offline structure/consistency check
//   node scripts/build-catalog.mjs --validate --strict   # also fail on definitions missing from this tree
//   node scripts/build-catalog.mjs --self-test     # exercise the generator, no network
//   node scripts/build-catalog.mjs --source ./api.json --defs-dir ./some/dir
//
// Node >= 20, no dependencies (global fetch, fs/promises, node:path).
//
// Re-run without arguments after merging a branch that adds provider definitions:
// hasDefinition, the aliases and the synthesized definition-only entries are all
// derived from the TOML files in --defs-dir (default server-rs/defs).
//
// The catalog is an ARRAY of provider entries:
//   { id, label, baseUrl?, docs?, envVars?, hasDefinition, status?, category?, note? }
// `status` (stable | experimental | disabled) and `category` (agent | apiKey | admin | localLogs)
// are copied from the definition file and only present when hasDefinition is true, so the picker
// can hide disabled providers and group admin keys under "Advanced".
// It powers the "Add provider" picker (GET /api/defs/catalog). `hasDefinition` is
// derived from the TOML files in --defs-dir (default server-rs/defs), never from
// models.dev, so the UI can only offer provider definitions that really ship.
//
// Determinism: the output has no timestamps and a fixed order (CORE first, then
// definition-only entries, then the rest by coding relevance and label), so a
// re-run on the same models.dev snapshot produces an identical file.

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = "https://models.dev/api.json";
const DEFAULT_OUT = path.join(REPO_ROOT, "server-rs", "defs", "catalog.json");
const DEFAULT_DEFS_DIR = path.join(REPO_ROOT, "server-rs", "defs");

// Hard cap from docs/work/PACKAGES.md ("cap ~120 entries").
const MAX_ENTRIES = 120;

// Providers that matter for coding agents, in the order the picker shows them:
// first-party labs, subscription/coding plans, agent/IDE vendors, local runtimes,
// then gateways and hosting companies. Anything not listed here is ranked by
// codingScore() and appended until MAX_ENTRIES is reached.
// Ids are catalog ids (i.e. after DEFINITION_ALIASES).
const CORE = [
  // First-party model APIs
  "anthropic",
  "openai",
  "google",
  "google-vertex",
  "amazon-bedrock",
  "azure",
  "xai",
  "deepseek",
  "mistral",
  "zai",
  "zhipuai",
  "moonshot",
  "moonshotai-cn",
  "minimax",
  "minimax-cn",
  "alibaba",
  "alibaba-cn",
  "meta",
  "cerebras",
  "groq",
  "perplexity",
  "together",
  "poolside",
  "inception",
  "thinkingmachines",
  "stepfun",
  // Coding plans / subscriptions (often the only place a quota is visible)
  "kimi-code",
  "kimi-code-plan-cn",
  "zai-coding-plan",
  "zhipuai-coding-plan",
  "minimax-coding-plan",
  "alibaba-coding-plan",
  "alibaba-coding-plan-cn",
  "alibaba-token-plan",
  "alibaba-token-plan-cn",
  "volcengine-coding-plan",
  "tencent-coding-plan",
  "umans-ai-coding-plan",
  "xiaomi-token-plan-cn",
  "kuae-cloud-coding-plan",
  "scnet-token-plan",
  "stepfun-step-plan",
  // Agents, IDEs and coding-specific gateways
  "copilot",
  "gitlab",
  "kilo",
  "cline-pass",
  "opencode",
  "opencode-go",
  // Gateways, routers and hosted inference
  "openrouter",
  "requesty",
  "llmgateway",
  "llmgateway-providers",
  "vercel",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "poe",
  "helicone",
  "huggingface",
  "fireworks-ai",
  "deepinfra",
  "novita-ai",
  "nebius",
  "baseten",
  "nvidia",
  "scaleway",
  "ovhcloud",
  "synthetic",
  "chutes",
  "morph",
  "wandb",
  // Local runtimes
  "ollama",
  "lmstudio",
];

// models.dev id -> Burnrate definition id. Aliases are only needed when
// models.dev and server-rs/defs call the same service differently. Entries whose
// definition id has no models.dev counterpart are synthesized from the TOML file.
const DEFINITION_ALIASES = {
  togetherai: "together",
  "ollama-cloud": "ollama",
  "github-copilot": "copilot",
  moonshotai: "moonshot",
  "kimi-code-plan-global": "kimi-code",
};

// Short, human-readable catalog notes. Keep them factual; they are shown in the
// provider picker next to the entry. Disabled definitions must have one.
const NOTES = {
  groq: "no per-key usage API; budget-based tracking",
  perplexity: "no per-key usage API; budget-based tracking",
  together: "no per-key usage API; budget-based tracking",
  "openai-admin": "organization admin key (sk-admin-...); experimental endpoint",
  "anthropic-admin": "organization admin key required",
  "opencode-go": "unofficial usage endpoint, the same one OpenCode's own login reads",
};

// Models that suggest "this provider is used by a coding agent".
const CODING_MODEL_RE = /code|coder|coding|devstral|swe|agent|sonnet|opus|gpt-5|gpt5|gemini|kimi|qwen|deepseek|glm|grok|llama|mistral/i;

const STATUSES = ["stable", "experimental", "disabled"];
const CATEGORIES = ["agent", "apiKey", "admin", "localLogs"];

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

/* ------------------------------------------------------------------ args --- */

function parseArgs(argv) {
  const args = {
    source: DEFAULT_SOURCE,
    out: DEFAULT_OUT,
    defsDir: DEFAULT_DEFS_DIR,
    check: false,
    validate: false,
    strict: false,
    selfTest: false,
    dryRun: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v) die(`missing value for ${a}`);
      return v;
    };
    if (a === "--source") args.source = value();
    else if (a === "--out") args.out = path.resolve(value());
    else if (a === "--defs-dir") args.defsDir = path.resolve(value());
    else if (a === "--check") args.check = true;
    else if (a === "--validate") args.validate = true;
    else if (a === "--strict") args.strict = true;
    else if (a === "--self-test") args.selfTest = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: node scripts/build-catalog.mjs [--source URL|FILE] [--out FILE] [--defs-dir DIR]\n" +
          "                                      [--check] [--validate] [--strict] [--self-test] [--dry-run] [--quiet]",
      );
      process.exit(0);
    } else die(`unknown argument "${a}" (try --help)`);
  }
  return args;
}

function die(message) {
  console.error(`build-catalog: ${message}`);
  process.exit(2);
}

/* ---------------------------------------------------------------- source --- */

async function loadSource(source) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, {
      headers: { accept: "application/json", "user-agent": "burnrate-build-catalog" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`GET ${source} -> ${res.status} ${res.statusText}`);
    return { data: await res.json(), origin: source };
  }
  const file = path.resolve(source);
  return { data: JSON.parse(await readFile(file, "utf8")), origin: file };
}

/* ----------------------------------------------------------- definitions --- */

// Reads only the handful of top-level scalar fields we need, so this script does
// not depend on a TOML parser. (The Rust engine is the authority on validity.)
function topLevelString(toml, key) {
  const head = toml.split(/^[ \t]*\[\[/m)[0]; // stop at the first table
  const match = head.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*"([^"]*)"`, "m"));
  return match ? match[1] : undefined;
}

function firstRequestOrigin(toml) {
  const match = toml.match(/^[ \t]*url[ \t]*=[ \t]*"https?:\/\/([^/"\s]+)/m);
  return match ? `https://${match[1]}` : undefined;
}

async function readDefinitions(dir) {
  const defs = new Map();
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return defs; // no defs dir: catalog is models.dev only
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".toml") || name.startsWith("_")) continue;
    const raw = await readFile(path.join(dir, name), "utf8");
    const id = topLevelString(raw, "id") ?? name.slice(0, -5);
    defs.set(id, {
      id,
      label: topLevelString(raw, "label") ?? id,
      docs: topLevelString(raw, "docs"),
      status: topLevelString(raw, "status") ?? "stable",
      category: topLevelString(raw, "category") ?? "apiKey",
      baseUrl: firstRequestOrigin(raw),
    });
  }
  return defs;
}

function addDefinitionFacts(entry, def) {
  entry.status = def.status;
  entry.category = def.category;
}

function statusNote(def) {
  if (!def) return undefined;
  if (def.status === "experimental") return "experimental definition; unofficial endpoint";
  if (def.status === "disabled") return "disabled; no per-key usage API; budget-based tracking";
  return undefined;
}

// Notes are keyed by definition id first, then by the models.dev id it aliases
// from, so e.g. groq/perplexity/together keep their explanation before their
// definition files are merged.
function noteFor(id, aliasTarget, defs) {
  return (
    NOTES[id] ??
    (aliasTarget ? NOTES[aliasTarget] : undefined) ??
    statusNote(defs.get(id) ?? (aliasTarget ? defs.get(aliasTarget) : undefined))
  );
}

/* ---------------------------------------------------------------- build --- */

function modelCount(provider) {
  return provider && provider.models && typeof provider.models === "object"
    ? Object.keys(provider.models).length
    : 0;
}

function codingScore(provider) {
  const models = provider.models && typeof provider.models === "object" ? Object.values(provider.models) : [];
  let score = 0;
  if (models.some((m) => m && m.tool_call === true)) score += 2;
  if (
    models.some((m) =>
      m ? CODING_MODEL_RE.test(`${m.id ?? ""} ${m.name ?? ""} ${m.family ?? ""}`) : false,
    )
  ) {
    score += 3;
  }
  if (isNonEmptyString(provider.api)) score += 1;
  if (Array.isArray(provider.env) && provider.env.some(isNonEmptyString)) score += 1;
  score += Math.min(3, Math.floor(models.length / 40));
  return score;
}

function eligible(provider, { keep }) {
  const models = provider.models && typeof provider.models === "object" ? Object.values(provider.models) : [];
  if (models.length === 0) return false;
  if (!isNonEmptyString(provider.api) && !(Array.isArray(provider.env) && provider.env.some(isNonEmptyString))) {
    return false;
  }
  if (keep) return true; // curated core or an existing definition
  return (
    models.some((m) => m && m.tool_call === true) ||
    models.some((m) =>
      m ? CODING_MODEL_RE.test(`${m.id ?? ""} ${m.name ?? ""} ${m.family ?? ""}`) : false,
    )
  );
}

function coreIndexOf(catalogId, sourceId) {
  const index = Math.min(
    CORE.indexOf(catalogId) === -1 ? Infinity : CORE.indexOf(catalogId),
    CORE.indexOf(sourceId) === -1 ? Infinity : CORE.indexOf(sourceId),
  );
  return Number.isFinite(index) ? index : -1;
}

function envVarsOf(provider) {
  if (!Array.isArray(provider.env)) return undefined;
  const vars = [...new Set(provider.env.filter(isNonEmptyString))].slice(0, 4);
  return vars.length ? vars : undefined;
}

function buildCatalog(providers, defs) {
  const byId = new Map();

  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error("models.dev payload is not an object keyed by provider id");
  }

  for (const provider of Object.values(providers)) {
    if (!provider || !isNonEmptyString(provider.id)) continue;
    const aliasTarget = DEFINITION_ALIASES[provider.id];
    // Only rename when the definition it points at exists; otherwise keep the
    // models.dev id so the catalog never advertises a provider id that has no
    // definition behind it.
    const id = aliasTarget && defs.has(aliasTarget) ? aliasTarget : provider.id;
    const coreIndex = coreIndexOf(id, aliasTarget ?? provider.id);
    if (!eligible(provider, { keep: coreIndex !== -1 || defs.has(id) })) continue;
    if (byId.has(id)) continue; // first wins; aliases are unique

    const entry = { id, label: isNonEmptyString(provider.name) ? provider.name : id };
    if (isNonEmptyString(provider.api)) entry.baseUrl = provider.api;
    if (isNonEmptyString(provider.doc)) entry.docs = provider.doc;
    const envVars = envVarsOf(provider);
    if (envVars) entry.envVars = envVars;
    entry.hasDefinition = defs.has(id);
    if (entry.hasDefinition) addDefinitionFacts(entry, defs.get(id));
    const note = noteFor(id, aliasTarget, defs);
    if (note) entry.note = note;

    byId.set(id, {
      entry,
      score: codingScore(provider),
      models: modelCount(provider),
      coreIndex,
      definitionOnly: false,
    });
  }

  // Definitions whose id has no models.dev entry (openai-admin, kiro, ...) are
  // synthesized from their TOML file so every shipped definition is offerable.
  for (const [id, def] of [...defs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (byId.has(id)) continue;
    const entry = { id, label: def.label };
    if (def.baseUrl) entry.baseUrl = def.baseUrl;
    if (def.docs) entry.docs = def.docs;
    entry.hasDefinition = true;
    addDefinitionFacts(entry, def);
    const note = noteFor(id, undefined, defs);
    if (note) entry.note = note;
    byId.set(id, { entry, score: 0, models: 0, coreIndex: -1, definitionOnly: true });
  }

  const rank = (a, b) => {
    if (a.coreIndex !== b.coreIndex) {
      if (a.coreIndex === -1) return 1;
      if (b.coreIndex === -1) return -1;
      return a.coreIndex - b.coreIndex;
    }
    if (a.definitionOnly !== b.definitionOnly) return a.definitionOnly ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    // Same relevance: prefer the broader catalogue, then a stable label order.
    if (a.models !== b.models) return b.models - a.models;
    return a.entry.label.localeCompare(b.entry.label);
  };

  const all = [...byId.values()].sort(rank);
  const kept = [];
  const rest = [];
  for (const item of all) {
    const mustKeep = item.coreIndex !== -1 || item.definitionOnly || item.entry.hasDefinition;
    if (mustKeep) kept.push(item);
    else rest.push(item);
  }
  const limit = Math.max(0, MAX_ENTRIES - kept.length);
  return [...kept, ...rest.slice(0, limit)]
    .sort(rank)
    .map((item) => item.entry);
}

/* ------------------------------------------------------------- validate --- */

function validateCatalog(entries, defs) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(entries)) return { errors: ["catalog.json must be a JSON array"], warnings };

  const seen = new Set();
  const encoder = new TextEncoder();
  for (const [index, entry] of entries.entries()) {
    const at = `entry ${index}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${at}: not an object`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!["id", "label", "baseUrl", "docs", "envVars", "hasDefinition", "status", "category", "note"].includes(key)) {
        errors.push(`${at}: unexpected key "${key}"`);
      }
    }
    if (!isNonEmptyString(entry.id)) errors.push(`${at}: missing id`);
    else if (seen.has(entry.id)) errors.push(`${at}: duplicate id "${entry.id}"`);
    else seen.add(entry.id);
    if (!isNonEmptyString(entry.label)) errors.push(`${at}: missing label`);
    if (entry.baseUrl !== undefined && !isNonEmptyString(entry.baseUrl)) errors.push(`${at}: baseUrl must be a string`);
    if (entry.docs !== undefined && !isNonEmptyString(entry.docs)) errors.push(`${at}: docs must be a string`);
    if (entry.note !== undefined && !isNonEmptyString(entry.note)) errors.push(`${at}: note must be a string`);
    if (
      entry.envVars !== undefined &&
      (!Array.isArray(entry.envVars) || entry.envVars.some((v) => !isNonEmptyString(v)))
    ) {
      errors.push(`${at}: envVars must be an array of non-empty strings`);
    }
    if (typeof entry.hasDefinition !== "boolean") errors.push(`${at}: hasDefinition must be a boolean`);
    if (entry.status !== undefined && !STATUSES.includes(entry.status)) errors.push(`${at}: status must be one of ${STATUSES.join(", ")}`);
    if (entry.category !== undefined && !CATEGORIES.includes(entry.category)) errors.push(`${at}: category must be one of ${CATEGORIES.join(", ")}`);
    if ((entry.status !== undefined || entry.category !== undefined) && entry.hasDefinition !== true) {
      errors.push(`${at}: status/category only apply to entries with a definition`);
    }
    if (encoder.encode(JSON.stringify(entry)).length > 4096) errors.push(`${at}: entry is unreasonably large`);
  }

  for (const id of defs.keys()) {
    const entry = entries.find((e) => e && e.id === id);
    if (!entry) errors.push(`definition "${id}" has no catalog entry`);
    else if (entry.hasDefinition !== true) errors.push(`definition "${id}" entry must set hasDefinition: true`);
    else {
      const def = defs.get(id);
      if (entry.status !== def.status) errors.push(`definition "${id}" entry status must be "${def.status}"`);
      if (entry.category !== def.category) errors.push(`definition "${id}" entry category must be "${def.category}"`);
    }
  }
  for (const entry of entries) {
    if (entry && entry.hasDefinition === true && !defs.has(entry.id)) {
      // Definition packages land in separate branches. Until they are merged the
      // committed catalog can legitimately reference them (the notes and the
      // hasDefinition flag are part of the generated artifact), so this is a
      // warning; --strict turns it into an error for post-merge CI.
      warnings.push(`entry "${entry.id}" references a definition that is not in this tree yet`);
    }
  }
  return { errors, warnings };
}

/* ------------------------------------------------------------- self test --- */

function runSelfTest() {
  const failures = [];
  let checks = 0;
  const check = (label, condition) => {
    checks++;
    if (!condition) failures.push(label);
  };
  const provider = (id, name, extra = {}) => ({
    id,
    name,
    api: "https://api.example.com/v1",
    doc: `https://docs.example.com/${id}`,
    env: [`${id.toUpperCase().replace(/-/g, "_")}_API_KEY`],
    models: { [`${id}-code`]: { id: `${id}-code`, name: "Coder", tool_call: true, family: "code" } },
    ...extra,
  });

  // Eligibility: a provider needs models, an api/env, and a coding signal.
  const providers = {
    "coding-gateway": provider("coding-gateway", "Coding Gateway"),
    "no-models": { id: "no-models", name: "No Models", api: "https://x.test", models: {} },
    "no-endpoint": { id: "no-endpoint", name: "No Endpoint", models: provider("x", "x").models },
    "chat-only": {
      id: "chat-only",
      name: "Chat Only",
      api: "https://chat.test/v1",
      models: { m: { id: "m", name: "Plain chat" } },
    },
    togetherai: provider("togetherai", "Together AI"),
    groq: provider("groq", "Groq"),
    // Core providers are kept even without a coding-signal model (e.g. Perplexity).
    perplexity: {
      id: "perplexity",
      name: "Perplexity",
      doc: "https://docs.perplexity.ai",
      env: ["PERPLEXITY_API_KEY"],
      models: { sonar: { id: "sonar", name: "Sonar" } },
    },
    ...Object.fromEntries(
      Array.from({ length: 130 }, (_, i) => [`bulk-${i}`, provider(`bulk-${i}`, `Bulk ${i}`)]),
    ),
  };

  const catalog = buildCatalog(providers, new Map());
  const ids = catalog.map((e) => e.id);
  check("skips providers without models", !ids.includes("no-models"));
  check("skips providers without api/env", !ids.includes("no-endpoint"));
  check("skips providers without a coding signal", !ids.includes("chat-only"));
  check("cap keeps at most MAX_ENTRIES", catalog.length <= MAX_ENTRIES && catalog.length === MAX_ENTRIES);
  check("keeps core providers inside the cap", ids.includes("groq") && ids.includes("togetherai"));
  check("keeps core providers without a coding signal", ids.includes("perplexity"));
  check("hasDefinition defaults to false", catalog.every((e) => e.hasDefinition === false));
  check(
    "disabled note applies before the definition exists",
    catalog.find((e) => e.id === "groq")?.note === "no per-key usage API; budget-based tracking",
  );
  check(
    "note follows the alias source before the definition exists",
    catalog.find((e) => e.id === "togetherai")?.note === "no per-key usage API; budget-based tracking",
  );
  check(
    "catalog ids are unique",
    new Set(ids).size === ids.length,
  );

  // Aliasing + notes once the definition exists, plus a definition-only entry.
  const defs = new Map([
    ["together", { id: "together", label: "Together AI", docs: "https://docs.together.ai", status: "disabled", category: "apiKey" }],
    ["groq", { id: "groq", label: "Groq", docs: "https://console.groq.com/docs/rate-limits", status: "disabled", category: "apiKey" }],
    ["kiro", { id: "kiro", label: "Kiro", docs: "https://kiro.dev/docs", status: "experimental", category: "agent", baseUrl: "https://kiro.test" }],
  ]);
  const withDefs = buildCatalog(providers, defs);
  const together = withDefs.find((e) => e.id === "together");
  check("alias renames to the definition id", Boolean(together) && !withDefs.some((e) => e.id === "togetherai"));
  check("aliased entry keeps models.dev metadata", together?.label === "Together AI" && together?.hasDefinition === true);
  check("definition-only entry is synthesized", withDefs.some((e) => e.id === "kiro" && e.hasDefinition === true));
  check(
    "experimental definitions get a note",
    withDefs.find((e) => e.id === "kiro")?.note === "experimental definition; unofficial endpoint",
  );
  check("explicit note wins over the status note", together?.note === "no per-key usage API; budget-based tracking");
  check("definition entries carry status and category", together?.status === "disabled" && together?.category === "apiKey");
  check("definition-only entries carry status", withDefs.find((e) => e.id === "kiro")?.status === "experimental");
  check("entries without a definition carry no status", catalog.every((e) => e.status === undefined && e.category === undefined));

  // validateCatalog catches the two drift cases that matter.
  check("validate accepts a consistent catalog", validateCatalog(withDefs, defs).errors.length === 0);
  check(
    "validate warns about hasDefinition without a file",
    validateCatalog([{ id: "ghost", label: "Ghost", hasDefinition: true }], defs).warnings.length > 0,
  );
  check(
    "validate rejects duplicate ids",
    validateCatalog(
      [
        { id: "a", label: "A", hasDefinition: false },
        { id: "a", label: "A", hasDefinition: false },
      ],
      new Map(),
    ).errors.length > 0,
  );

  if (failures.length) {
    console.error(`self-test FAILED (${failures.length}/${checks}):\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`ok: build-catalog self-test (${checks} checks)`);
}

/* ----------------------------------------------------------------- main --- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }
  const defs = await readDefinitions(args.defsDir);

  if (args.validate) {
    let entries;
    try {
      entries = JSON.parse(await readFile(args.out, "utf8"));
    } catch (error) {
      die(`${args.out}: ${error.message}`);
    }
    const { errors, warnings } = validateCatalog(entries, defs);
    if (warnings.length && !args.quiet) {
      console.warn(
        `note: ${warnings.length} catalog entr${warnings.length === 1 ? "y references" : "ies reference"} definitions not in this tree yet` +
          " (regenerate after the definition packages merge)",
      );
      if (args.strict) {
        console.error(`  ${warnings.join("\n  ")}`);
        process.exit(1);
      }
    }
    if (errors.length) {
      console.error(`catalog ${path.relative(REPO_ROOT, args.out)} is invalid:\n  ${errors.join("\n  ")}`);
      process.exit(1);
    }
    if (!args.quiet) {
      console.log(
        `ok: ${entries.length} catalog entries, ${entries.filter((e) => e.hasDefinition).length} with definitions` +
          ` (${defs.size} definition file(s) in ${path.relative(REPO_ROOT, args.defsDir)})`,
      );
    }
    return;
  }

  let loaded;
  try {
    loaded = await loadSource(args.source);
  } catch (error) {
    die(`could not load ${args.source}: ${error.message}`);
  }

  const entries = buildCatalog(loaded.data, defs);
  const json = `${JSON.stringify(entries, null, 2)}\n`;
  const { errors } = validateCatalog(entries, defs);
  if (errors.length) {
    die(`generated catalog is invalid:\n  ${errors.join("\n  ")}`);
  }

  if (args.dryRun) {
    if (!args.quiet) console.error(`build-catalog: ${entries.length} entries (dry run)`);
    process.stdout.write(json);
    return;
  }

  if (args.check) {
    let current = "";
    try {
      // Tolerate a CRLF checkout: the committed file is normalised to LF by git.
      current = (await readFile(args.out, "utf8")).replace(/\r\n/g, "\n");
    } catch {
      /* missing file counts as drift */
    }
    if (current !== json) {
      console.error(
        `catalog is stale: run "node scripts/build-catalog.mjs" (${entries.length} entries from ${loaded.origin})`,
      );
      process.exit(1);
    }
    if (!args.quiet) console.log(`ok: catalog is up to date (${entries.length} entries)`);
    return;
  }

  await writeFile(args.out, json, "utf8");
  if (!args.quiet) {
    const withDefs = entries.filter((e) => e.hasDefinition).length;
    console.log(
      `wrote ${path.relative(REPO_ROOT, args.out)}: ${entries.length} entries, ${withDefs} with definitions` +
        ` (source ${loaded.origin}, defs ${path.relative(REPO_ROOT, args.defsDir)})`,
    );
  }
}

main().catch((error) => {
  console.error(`build-catalog: ${error?.stack ?? error}`);
  process.exit(1);
});
