import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { normalizeCatalog, normalizeDefinitions } from "~/api/catalog";
import { buildWizardOptions, filterWizardOptions, isActionableOption } from "~/components/providers/providerWizard";
import type { ProviderInfo } from "~/contracts";

import { catalogRedirect, providerHint, providerSearchTerms } from "./aliases";
import { providerFallbackColor } from "./presentation";
import { providerColor, providerLabel } from "./registry";

/**
 * Parity between the shipped definitions/catalog (server-rs/defs) and what the Add-provider wizard
 * and provider cards can show. These read the real files so a new definition cannot ship without
 * a catalog entry, and OpenCode Go / ChatGPT cannot silently fall out of the picker again.
 */

const defsUrl = new URL("../../server-rs/defs/", import.meta.url);

interface RawEntry {
  id: string;
  label: string;
  hasDefinition?: boolean;
  note?: string;
}

async function loadCatalog(): Promise<RawEntry[]> {
  return JSON.parse(await readFile(new URL("catalog.json", defsUrl), "utf8")) as RawEntry[];
}

async function definitionIds(): Promise<string[]> {
  return (await readdir(defsUrl))
    .filter((name) => name.endsWith(".toml") && !name.startsWith("_"))
    .map((name) => name.replace(/\.toml$/, ""))
    .sort();
}

async function readDefinition(id: string): Promise<string> {
  return readFile(new URL(`${id}.toml`, defsUrl), "utf8");
}

function provider(overrides: Partial<ProviderInfo> & Pick<ProviderInfo, "id" | "label">): ProviderInfo {
  return { color: "#000000", auth: "apiKey", connected: false, accounts: [], ...overrides };
}

describe("catalog.json vs definition files", () => {
  it("has unique ids, labels and a valid hasDefinition flag for every entry", async () => {
    const catalog = await loadCatalog();
    const ids = catalog.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of catalog) {
      expect(entry.label.trim(), entry.id).not.toBe("");
      expect(typeof entry.hasDefinition, entry.id).toBe("boolean");
    }
    // The wizard's own normaliser must keep every entry (it drops rows without an id).
    expect(normalizeCatalog(catalog)).toHaveLength(catalog.length);
  });

  it("flags hasDefinition exactly for the shipped definition files", async () => {
    const catalog = await loadCatalog();
    const flagged = catalog
      .filter((entry) => entry.hasDefinition === true)
      .map((entry) => entry.id)
      .sort();
    expect(flagged).toEqual(await definitionIds());
  });

  it("notes every experimental or disabled definition so the picker can explain it", async () => {
    const catalog = new Map((await loadCatalog()).map((entry) => [entry.id, entry] as const));
    for (const id of await definitionIds()) {
      const status = /^status\s*=\s*"(\w+)"/m.exec(await readDefinition(id))?.[1];
      if (status === "stable") continue;
      expect(catalog.get(id)?.note, `${id} (${status}) needs a catalog note`).toBeTruthy();
    }
  });

  it("gives every definition a brand fallback colour or a TOML colour", async () => {
    for (const id of await definitionIds()) {
      const toml = await readDefinition(id);
      const tomlColor = /^color\s*=\s*"(#[0-9a-fA-F]{6})"/m.exec(toml)?.[1];
      expect(tomlColor ?? providerFallbackColor(id), `${id} needs a colour`).toBeTruthy();
    }
  });
});

describe("OpenCode Go", () => {
  it("ships as an API-key definition for the Go usage endpoint, honestly marked unofficial", async () => {
    const toml = await readDefinition("opencode-go");
    expect(toml).toMatch(/^id = "opencode-go"/m);
    expect(toml).toMatch(/^label = "OpenCode Go"/m);
    expect(toml).toMatch(/^auth = "apiKey"/m);
    expect(toml).toMatch(/^key_hosts = \["opencode\.ai"\]/m);
    expect(toml).toMatch(/^url = "https:\/\/opencode\.ai\/zen\/go\/v1\/usage"/m);
    expect(toml).toMatch(/^status = "stable"/m);
    expect(toml).toContain("UNVERIFIED");
    // Every window is labelled unofficial: nothing here is documented by the provider.
    expect(toml.match(/provenance = "(\w+)"/g)?.every((line) => line.includes("unofficial"))).toBe(true);
    const catalog = (await loadCatalog()).find((entry) => entry.id === "opencode-go");
    expect(catalog?.hasDefinition).toBe(true);
    expect(catalog?.note).toContain("unofficial");
  });

  it("has presentation for the cards before the server answers", () => {
    expect(providerLabel("opencode-go")).toBe("OpenCode Go");
    expect(providerColor("opencode-go")).toBe("#5b9bbd");
  });

  it("is found by 'opencode go' on the native OpenCode login row", () => {
    const opencode = provider({ id: "opencode", label: "OpenCode", auth: "localLogin", connected: true });
    const options = buildWizardOptions({ providers: [opencode] });
    expect(filterWizardOptions(options, "opencode go").map((option) => option.id)).toEqual(["opencode"]);
    expect(filterWizardOptions(options, "zen").map((option) => option.id)).toEqual(["opencode"]);
    expect(options.find((option) => option.id === "opencode")?.hint).toContain("OpenCode Go");
  });

  it("is a selectable API-key row once the definition is enabled, and an honest dead row before", async () => {
    const catalog = normalizeCatalog(await loadCatalog());
    const definitions = normalizeDefinitions([
      { id: "opencode-go", label: "OpenCode Go", status: "experimental", source: "builtin", enabled: false },
    ]);

    const before = buildWizardOptions({ providers: [], definitions, catalog });
    const dead = before.find((option) => option.id === "opencode-go");
    expect(dead?.source).toBe("definition");
    expect(dead?.label).toBe("OpenCode Go");
    expect(dead?.note).toContain("Experimental");
    expect(dead?.baseUrl).toBe("https://opencode.ai/inference/go/openai/v1");
    expect(dead?.envVars).toEqual(["OPENCODE_API_KEY"]);
    expect(isActionableOption(dead)).toBe(false);
    expect(before.filter((option) => option.id === "opencode-go")).toHaveLength(1);

    const live = provider({ id: "opencode-go", label: "OpenCode Go", color: "#5b9bbd" });
    const after = buildWizardOptions({ providers: [live], definitions, catalog });
    const row = after.find((option) => option.id === "opencode-go");
    expect(row?.source).toBe("provider");
    expect(isActionableOption(row)).toBe(true);
    expect(after.filter((option) => option.id === "opencode-go")).toHaveLength(1);
  });
});

describe("ChatGPT and OpenAI", () => {
  it("finds the Codex login row by 'chatgpt' and explains it", () => {
    const codex = provider({ id: "codex", label: "Codex", auth: "localLogin", connected: true });
    const options = buildWizardOptions({ providers: [codex] });
    expect(filterWizardOptions(options, "chatgpt").map((option) => option.id)).toEqual(["codex"]);
    expect(filterWizardOptions(options, "chatgpt plus").map((option) => option.id)).toEqual(["codex"]);
    expect(providerHint("codex")).toContain("ChatGPT");
    expect(providerSearchTerms("codex")).toContain("openai");
  });

  it("points the OpenAI catalog row at Codex and OpenAI Admin instead of a dead end", async () => {
    const catalog = normalizeCatalog(await loadCatalog());
    const options = buildWizardOptions({ providers: [], catalog });
    const openai = options.find((option) => option.id === "openai");
    expect(openai?.source).toBe("catalog");
    expect(openai?.unavailableReason).toBe(catalogRedirect("openai"));
    expect(openai?.unavailableReason).toContain("Codex");
    expect(openai?.unavailableReason).toContain("OpenAI Admin");
    expect(isActionableOption(openai)).toBe(false);
  });

  it("keeps OpenAI Admin reachable from 'openai' and 'chatgpt' searches", () => {
    const definitions = normalizeDefinitions([
      { id: "openai-admin", label: "OpenAI Admin", status: "experimental", source: "builtin" },
    ]);
    const options = buildWizardOptions({ providers: [], definitions });
    expect(filterWizardOptions(options, "openai").map((option) => option.id)).toContain("openai-admin");
    expect(filterWizardOptions(options, "chatgpt").map((option) => option.id)).toContain("openai-admin");
  });
});

describe("disabled definitions", () => {
  it("say there is no usage API and point at budgets, not at a toggle that cannot work", () => {
    const definitions = normalizeDefinitions([
      { id: "groq", label: "Groq", status: "disabled", source: "builtin" },
    ]);
    const groq = buildWizardOptions({ providers: [], definitions }).find((option) => option.id === "groq");
    expect(groq?.unavailableReason).toContain("no per-key usage API");
    expect(groq?.unavailableReason).toContain("budget");
    expect(groq?.unavailableReason).not.toContain("Enable it");
  });
});
