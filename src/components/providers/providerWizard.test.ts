import { describe, expect, it } from "vitest";

import type { CatalogEntry, DefinitionInfo } from "~/api/catalog";
import { normalizeCatalog, normalizeDefinitions } from "~/api/catalog";
import type { ProviderInfo } from "~/contracts";

import {
  buildWizardOptions,
  claudeUsedNames,
  filterWizardOptions,
  isActionableOption,
  suggestWizardName,
  validateWizardName,
  isAdvancedOption,
  wizardAuthKind,
  wizardGroups,
  wizardNeedsName,
} from "./providerWizard";

function provider(overrides: Partial<ProviderInfo> & Pick<ProviderInfo, "id" | "label">): ProviderInfo {
  return {
    color: "#000000",
    auth: "apiKey",
    connected: false,
    accounts: [],
    ...overrides,
  };
}

const claude = provider({
  id: "claudeAgent",
  label: "Claude Code",
  auth: "localLogin",
  connected: true,
  accounts: [{ id: "claude-work", label: "work" }],
});
const openrouter = provider({
  id: "openrouter",
  label: "OpenRouter",
  accounts: [{ id: "openrouter-1", label: "openrouter-1" }],
});

const definitions: DefinitionInfo[] = [
  { id: "openrouter", label: "OpenRouter", status: "stable", source: "builtin" },
  { id: "zai", label: "Z.ai", status: "experimental", source: "builtin" },
  { id: "legacy", label: "Legacy", status: "disabled", source: "user" },
];

const catalog: CatalogEntry[] = [
  { id: "deepseek", label: "DeepSeek", hasDefinition: true },
  { id: "somewhere", label: "Somewhere AI", hasDefinition: false, baseUrl: "https://example.com" },
];

describe("buildWizardOptions", () => {
  const options = buildWizardOptions({
    providers: [openrouter, claude],
    definitions,
    catalog,
  });

  it("keeps one entry per id, preferring the live provider", () => {
    const ids = options.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
    const openrouterOption = options.find((option) => option.id === "openrouter");
    expect(openrouterOption?.source).toBe("provider");
    expect(openrouterOption?.provider).toBe(openrouter);
  });

  it("marks definitions that are not providers as unavailable with a reason", () => {
    const zai = options.find((option) => option.id === "zai");
    expect(zai?.source).toBe("definition");
    expect(zai?.note).toContain("Experimental");
    expect(zai?.unavailableReason).toContain("Enable it in Settings");
    expect(isActionableOption(zai)).toBe(false);

    const legacy = options.find((option) => option.id === "legacy");
    expect(legacy?.unavailableReason).toContain("disabled");
  });

  it("keeps catalog entries that have no definition, and explains why", () => {
    const somewhere = options.find((option) => option.id === "somewhere");
    expect(somewhere?.source).toBe("catalog");
    expect(somewhere?.unavailableReason).toContain("No usage definition yet");
    const deepseek = options.find((option) => option.id === "deepseek");
    expect(deepseek?.unavailableReason).toContain("Enable it in Settings");
  });

  it("always ends with the custom provider escape hatch", () => {
    expect(options[options.length - 1]?.source).toBe("custom");
    expect(isActionableOption(options[options.length - 1])).toBe(false);
  });
});

describe("filterWizardOptions", () => {
  const options = buildWizardOptions({
    providers: [openrouter, claude],
    definitions,
    catalog,
  });

  it("returns everything for an empty query", () => {
    expect(filterWizardOptions(options, "")).toHaveLength(options.length);
  });

  it("matches labels, ids and details", () => {
    expect(filterWizardOptions(options, "openrouter").map((option) => option.id)).toEqual([
      "openrouter",
    ]);
    expect(filterWizardOptions(options, "experimental").map((option) => option.id)).toEqual(["zai"]);
    expect(filterWizardOptions(options, "example.com").map((option) => option.id)).toEqual([
      "somewhere",
    ]);
    expect(filterWizardOptions(options, "custom").map((option) => option.source)).toContain(
      "custom",
    );
  });

  it("needs every token to match", () => {
    expect(filterWizardOptions(options, "claude code")).toHaveLength(1);
    expect(filterWizardOptions(options, "claude openrouter")).toHaveLength(0);
  });
});

describe("definition and catalog responses", () => {
  it("normalises a catalog array and ignores unusable rows", () => {
    expect(
      normalizeCatalog([
        {
          id: "deepseek",
          name: "DeepSeek",
          base_url: "https://api.deepseek.com",
          env: ["DEEPSEEK_API_KEY"],
          has_definition: true,
        },
        { id: "" },
        "nope",
      ]),
    ).toEqual([
      {
        id: "deepseek",
        label: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        hasDefinition: true,
      },
    ]);
  });

  it("accepts a wrapped definitions response", () => {
    expect(
      normalizeDefinitions({
        defs: [
          { id: "zai", label: "Z.ai", status: "experimental", source: "user" },
          { id: "bad", label: "Bad", status: "weird", source: "elsewhere" },
        ],
      }),
    ).toEqual([
      {
        id: "zai",
        label: "Z.ai",
        status: "experimental",
        source: "user",
        hasDefinition: true,
      },
      {
        id: "bad",
        label: "Bad",
        status: "stable",
        source: "builtin",
        hasDefinition: true,
      },
    ]);
  });

  it("returns an empty list for a non-list payload", () => {
    expect(normalizeCatalog(null)).toEqual([]);
    expect(normalizeDefinitions("nope")).toEqual([]);
  });
});

describe("wizardGroups", () => {
  it("groups by source and omits empty groups", () => {
    const groups = wizardGroups(
      buildWizardOptions({ providers: [claude], definitions: [], catalog: [] }),
    );
    expect(groups.map((group) => group.id)).toEqual(["agents", "custom"]);
  });

  it("uses the Providers-screen groups: agents, API keys, then everything else", () => {
    const groups = wizardGroups(
      buildWizardOptions({ providers: [openrouter, claude], definitions, catalog }),
    );
    expect(groups.map((group) => group.id)).toEqual([
      "agents",
      "apiKeys",
      "definitions",
      "catalog",
      "custom",
    ]);
    expect(groups[0]!.label).toBe("Agents you use");
    expect(groups[0]!.options.map((option) => option.id)).toEqual(["claudeAgent"]);
    expect(groups[1]!.label).toBe("API keys");
  });

  it("keeps admin keys out of the picker until Advanced is shown", () => {
    const admin = provider({ id: "anthropic-admin", label: "Anthropic Admin" });
    const options = buildWizardOptions({ providers: [openrouter, admin] });
    expect(wizardGroups(options).flatMap((group) => group.options.map((o) => o.id))).not.toContain(
      "anthropic-admin",
    );
    const shown = wizardGroups(options, { showAdvanced: true });
    expect(shown.find((group) => group.id === "advanced")?.options.map((o) => o.id)).toEqual([
      "anthropic-admin",
    ]);
    expect(isAdvancedOption(options.find((o) => o.id === "anthropic-admin")!)).toBe(true);
    expect(isAdvancedOption(options.find((o) => o.id === "openrouter")!)).toBe(false);
  });

  it("honours the server's category over the id", () => {
    const go = provider({ id: "opencode-go", label: "OpenCode Go", category: "agent" });
    const groups = wizardGroups(buildWizardOptions({ providers: [go] }));
    expect(groups[0]!.id).toBe("agents");
  });
});

describe("wizardAuthKind", () => {
  it("identifies sign-ins, API keys, local files and unavailable rows", () => {
    expect(wizardAuthKind(buildWizardOptions({ providers: [claude] })[0])).toBe("login");
    const codex = provider({
      id: "codex",
      label: "Codex",
      auth: "localLogin",
      login: { kind: "cli", command: "codex", installed: true, installUrl: "https://example.test" },
    });
    expect(wizardAuthKind(buildWizardOptions({ providers: [codex] })[0])).toBe("login");
    expect(wizardNeedsName(buildWizardOptions({ providers: [codex] })[0])).toBe(false);
    expect(wizardNeedsName(buildWizardOptions({ providers: [claude] })[0])).toBe(true);
    expect(wizardNeedsName(buildWizardOptions({ providers: [openrouter] })[0])).toBe(true);
    expect(wizardAuthKind(buildWizardOptions({ providers: [openrouter] })[0])).toBe("key");
    expect(
      wizardAuthKind(
        buildWizardOptions({
          providers: [provider({ id: "cursor", label: "Cursor", auth: "localLogs" })],
        })[0],
      ),
    ).toBe("none");
    expect(wizardAuthKind(undefined)).toBe("unavailable");
  });
});

describe("account names", () => {
  it("suggests main for Claude and provider ids for keys", () => {
    expect(suggestWizardName(buildWizardOptions({ providers: [claude] })[0]!)).toBe("main");
    expect(suggestWizardName(buildWizardOptions({ providers: [openrouter] })[0]!)).toBe(
      "openrouter-2",
    );
  });

  it("strips the claude- prefix for the sign-in dialog", () => {
    expect(claudeUsedNames(claude)).toEqual(["work"]);
  });

  it("validates duplicates, characters and length", () => {
    const option = buildWizardOptions({ providers: [openrouter] })[0]!;
    expect(validateWizardName(option, "openrouter-1")).toBe(
      "An account with this name already exists.",
    );
    expect(validateWizardName(option, "bad name")).toContain("letters, digits");
    expect(validateWizardName(option, "")).toBe("Enter an account name.");
    expect(validateWizardName(option, "x".repeat(65))).toContain("64 characters");
    expect(validateWizardName(option, "work-2")).toBeUndefined();
  });

  it("does not require a name for local-only providers", () => {
    const option = buildWizardOptions({
      providers: [provider({ id: "pi", label: "Pi", auth: "localLogs" })],
    })[0]!;
    expect(validateWizardName(option, "")).toBeUndefined();
  });
});
