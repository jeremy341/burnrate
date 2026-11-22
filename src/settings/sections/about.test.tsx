import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, type AppSettings } from "~/settings/schema";

vi.mock("~/settings/store", () => ({
  useSettings: (selector: (settings: AppSettings) => unknown) => selector(DEFAULT_SETTINGS),
  updateSettings: vi.fn(),
}));

import { section, updateOutcome } from "./about";

describe("updateOutcome", () => {
  it("says an update is available only when the server found a newer release", () => {
    expect(
      updateOutcome({ current: "0.1.0", latest: "0.2.0", url: "https://github.com/x/releases/1", newer: true }),
    ).toEqual({ kind: "available", latest: "0.2.0", url: "https://github.com/x/releases/1" });
  });

  it("reports up to date when the release is known and not newer", () => {
    expect(updateOutcome({ current: "0.2.0", latest: "0.2.0", url: "https://x", newer: false })).toEqual({
      kind: "current",
    });
  });

  it("never reports up to date when the release could not be read", () => {
    // The server answers 200 with a null `latest` when checks are off, offline or rate limited.
    expect(updateOutcome({ current: "0.1.0", latest: null as never, url: null as never, newer: false })).toEqual({
      kind: "unreachable",
    });
    expect(updateOutcome({ latest: "  " })).toEqual({ kind: "unreachable" });
    expect(updateOutcome(null)).toEqual({ kind: "unreachable" });
  });

  it("drops an empty release url", () => {
    expect(updateOutcome({ latest: "1.0.0", url: "", newer: true })).toEqual({
      kind: "available",
      latest: "1.0.0",
      url: null,
    });
  });
});

describe("Settings > About", () => {
  const html = renderToStaticMarkup(<section.Component />);

  it("keeps T3's App and Legal sections without filler text", () => {
    expect(html).toContain("App");
    expect(html).toContain("Legal");
    expect(html).toContain("Check for updates");
    expect(html).not.toContain("About this installation");
  });

  it("has no dead-end pointing at a setting that no longer exists", () => {
    expect(html).not.toContain("Turn on “Check for updates” in General");
  });

  it("shows the license once, as an expandable notice", () => {
    expect(html).toContain("Burnrate license (MIT)");
    expect(html).not.toContain("Distributed under the MIT License.");
  });
});
