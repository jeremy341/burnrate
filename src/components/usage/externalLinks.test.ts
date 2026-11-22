import { describe, expect, it } from "vitest";

import type { LimitsAccount } from "~/contracts";

import { collectExternalLinks } from "./UsageLimitsPooled";

function account(label: string, externalUsage?: { label: string; url: string }): LimitsAccount {
  return {
    label,
    limits: externalUsage ? { externalUsage, windows: [] } : { windows: [] },
  } as unknown as LimitsAccount;
}

describe("collectExternalLinks", () => {
  it("never surfaces the stale ChatGPT usage card, even when an older server still sends it", () => {
    const links = collectExternalLinks(
      [account("ChatGPT login", { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" })],
      "PC",
    );
    expect(links).toEqual([]);
  });

  it("still links providers that really cannot show limits here", () => {
    const links = collectExternalLinks(
      [
        account("ChatGPT login", { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" }),
        account("Work", { label: "Acme usage", url: "https://acme.example/usage" }),
      ],
      "PC",
    );
    expect(links.map((link) => link.url)).toEqual(["https://acme.example/usage"]);
  });
});
