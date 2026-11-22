import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BRAND_ICONS } from "./brandIcons";
import { ProviderIcon } from "./ProviderIcon";

/** Provider ids that must show a real brand mark, not two-letter initials. */
const EXPECTED = [
  "opencode",
  "opencode-go",
  "gemini",
  "qwen",
  "copilot",
  "cline",
  "roo",
  "kilo",
  "goose",
  "grok",
  "pi",
  "muse",
  "windsurf",
  "deepseek",
  "moonshot",
  "kimi-code",
  "zai",
  "groq",
  "perplexity",
  "together",
];

describe("brand icons", () => {
  it("has a mark for every expected provider id", () => {
    for (const id of EXPECTED) expect(BRAND_ICONS[id], id).toBeDefined();
  });

  it("draws a currentColor svg (follows light, dark and forced colours)", () => {
    for (const id of EXPECTED) {
      const html = renderToStaticMarkup(<ProviderIcon driver={id} label={id} />);
      expect(html, id).toContain("<svg");
      expect(html, id).toContain('fill="currentColor"');
      expect(html, id).toContain("<path");
    }
  });

  it("still falls back to initials for an unknown provider", () => {
    const html = renderToStaticMarkup(<ProviderIcon driver="crush" label="Crush" />);
    expect(html).not.toContain("<svg");
    expect(html).toContain("CR");
  });
});
