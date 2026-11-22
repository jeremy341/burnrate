import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LimitsSkeleton } from "./LimitsSkeleton";
import { ProvidersSkeleton } from "./ProvidersSkeleton";
import { SettingsSkeleton } from "./SettingsSkeleton";
import { UsageSkeleton } from "./UsageSkeleton";

const SKELETONS = [
  ["SettingsSkeleton", SettingsSkeleton, "Loading settings"],
  ["ProvidersSkeleton", ProvidersSkeleton, "Loading providers…"],
  ["UsageSkeleton", UsageSkeleton, "Loading usage…"],
  ["LimitsSkeleton", LimitsSkeleton, "Checking your limits…"],
] as const;

describe.each(SKELETONS)("%s", (_name, Component, loadingText) => {
  const markup = renderToStaticMarkup(<Component />);

  it("announces itself as a busy status with a screen-reader label", () => {
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain(loadingText);
  });

  it("pulses only with motion allowed", () => {
    // The single skeleton keyframe is gated by `motion-safe:`; reduced motion
    // (prefers-reduced-motion or html[data-reduce-motion]) keeps the bars still.
    expect(markup).toContain("motion-safe:animate-skeleton");
    expect(markup).not.toContain('class="animate-skeleton');
  });
});

describe("layout fidelity", () => {
  it("Settings mirrors the sidebar and a five-row card", () => {
    const markup = renderToStaticMarkup(<SettingsSkeleton />);
    expect(markup).toContain("settings-skeleton");
    expect(markup).toContain("sm:w-60");
    expect(markup.match(/data-slot="skeleton"/g)?.length ?? 0).toBeGreaterThanOrEqual(40);
  });

  it("Usage mirrors the list/chart grid and the totals tiles", () => {
    const markup = renderToStaticMarkup(<UsageSkeleton />);
    expect(markup).toContain("lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]");
    expect(markup).toContain("h-56");
    expect(markup).toContain("md:grid-cols-5");
  });

  it("Limits mirrors two provider window cards with meter bars", () => {
    const markup = renderToStaticMarkup(<LimitsSkeleton />);
    expect(markup).toContain("limits-skeleton");
    expect(markup.match(/h-6 w-full/g)).toHaveLength(4);
  });
});
