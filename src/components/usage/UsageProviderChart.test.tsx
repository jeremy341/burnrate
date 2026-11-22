import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { HourlyTotals } from "~/shared/usageMerge";
import { nextChartIndex, peakColumnIndex, UsageProviderChart } from "./UsageProviderChart";

const berlinHours = ["2026-11-20T15:40:00.000Z", "2026-11-20T16:40:00.000Z"];
const referenceTime = "2026-11-20T17:40:00.000Z";

function renderChart(
  hourly: readonly HourlyTotals[],
  hours = berlinHours,
  until = referenceTime,
  loading = false,
) {
  return renderToStaticMarkup(
    <UsageProviderChart
      providers={["claude"]}
      loadingProviders={new Set(loading ? ["claude"] : [])}
      days={[]}
      daily={[]}
      hours={hours}
      hourly={hourly}
      metric="tokens"
      referenceTime={until}
      resolution="hour"
      timeZone="Europe/Berlin"
      hour12={false}
    />,
  );
}

function hourlyBucket(hourStart: string): HourlyTotals {
  const totals = { totalTokens: 432, costUsd: 1 };
  return { ...totals, hourStart, day: hourStart.slice(0, 10), byProvider: new Map([["claude", totals]]) };
}

describe("UsageProviderChart", () => {
  it("plots the Rust server's wall-clock bucket for the current partial hour", () => {
    const markup = renderChart([hourlyBucket("2026-11-20T18:00")]);
    expect(markup).toContain("<td>432</td>");
    expect(markup).toMatch(/d="M[^"]+ C[^"]+"/);
  });

  it("plots a single instant-keyed bucket as a point", () => {
    const markup = renderChart([hourlyBucket(berlinHours[0]!)], [berlinHours[0]!]);
    expect(markup).toContain("<td>432</td>");
    expect(markup).toContain('data-point="claude"');
    // An HTML dot never squashes into an ellipse when the stretched plot resizes.
    expect(markup).not.toContain("<circle");
  });

  it("counts a repeated wall-clock hour once across the fall transition", () => {
    const markup = renderChart(
      [hourlyBucket("2026-10-25T02:00")],
      ["2026-10-25T00:40:00.000Z", "2026-10-25T01:40:00.000Z"],
      "2026-10-25T02:40:00.000Z",
    );
    expect(markup.match(/<td>432<\/td>/g)).toHaveLength(1);
  });

  it("renders T3's empty chart scaffold instead of an inline status tile", () => {
    const markup = renderChart([]);
    expect(markup).toContain('role="group"');
    expect(markup).not.toContain("No usage to chart for this period.");
    expect(markup).not.toContain("border-dashed");
    expect(markup).not.toContain("Loading chart data…");
  });

  it("keeps the grid recessive like T3's history chart", () => {
    const markup = renderChart([hourlyBucket(berlinHours[0]!)], [berlinHours[0]!]);
    expect(markup).toContain("text-border");
    expect(markup).not.toContain("stroke-opacity");
    expect(markup).toContain("text-3xs");
  });

  it("uses T3's fixed h-56 plot and axis height", () => {
    const markup = renderChart([hourlyBucket(berlinHours[0]!)], [berlinHours[0]!]);
    expect(markup).toContain("h-56");
    expect(markup).not.toContain("h-48");
    expect(markup).not.toContain("sm:h-56");
  });

  it("names the chart, describes it in text and makes the plot keyboard-reachable", () => {
    const markup = renderChart([hourlyBucket(berlinHours[0]!), hourlyBucket(berlinHours[1]!)]);
    expect(markup).toContain('role="group"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-label="Hourly processed tokens by provider"');
    expect(markup).toMatch(/aria-describedby="[^"]+-summary [^"]+-hint"/);
    expect(markup).toContain("Hourly processed tokens by provider: 864 in total.");
    expect(markup).toContain("Use arrow keys to move between periods");
  });

  it("draws marks with a contrast-safe colour per theme, not the raw brand colour", () => {
    const markup = renderChart([hourlyBucket(berlinHours[0]!), hourlyBucket(berlinHours[1]!)]);
    expect(markup).toContain("--usage-mark-light");
    expect(markup).toContain("--usage-mark-dark");
    expect(markup).toContain("stroke:var(--usage-mark)");
  });

  it("adds a text legend only when more than one provider is plotted", () => {
    expect(renderChart([hourlyBucket(berlinHours[0]!)])).not.toContain('aria-label="Providers"');
    const totals = { totalTokens: 10, costUsd: 1 };
    const day = (key: string) =>
      ({ ...totals, day: key, byProvider: new Map([["claude", totals], ["codex", totals]]) }) as never;
    const two = renderToStaticMarkup(
      <UsageProviderChart
        providers={["claude", "codex"]}
        days={["2026-11-19", "2026-11-20"]}
        daily={[day("2026-11-19"), day("2026-11-20")]}
        hours={[]}
        hourly={[]}
        metric="cost"
        referenceTime={undefined}
        resolution="day"
        timeZone="UTC"
        hour12={false}
      />,
    );
    expect(two).toContain('aria-label="Providers"');
    expect(two).toContain("Claude");
    expect(two).toContain("Codex");
    // Every provider line stays solid; providers differ by colour and legend label.
    expect(two).not.toContain("stroke-dasharray");
  });
});

describe("chart keyboard model", () => {
  it("starts at the newest period and clamps at both ends", () => {
    expect(nextChartIndex("ArrowLeft", null, 5)).toBe(4);
    expect(nextChartIndex("ArrowRight", null, 5)).toBe(4);
    expect(nextChartIndex("ArrowLeft", 0, 5)).toBe(0);
    expect(nextChartIndex("ArrowRight", 4, 5)).toBe(4);
    expect(nextChartIndex("ArrowLeft", 3, 5)).toBe(2);
    expect(nextChartIndex("ArrowRight", 1, 5)).toBe(2);
  });

  it("jumps with Home and End and clears with Escape only when there is something to clear", () => {
    expect(nextChartIndex("Home", 3, 5)).toBe(0);
    expect(nextChartIndex("End", 1, 5)).toBe(4);
    expect(nextChartIndex("Escape", 2, 5)).toBeNull();
    expect(nextChartIndex("Escape", null, 5)).toBeUndefined();
  });

  it("ignores other keys and empty charts", () => {
    expect(nextChartIndex("a", 1, 5)).toBeUndefined();
    expect(nextChartIndex("ArrowLeft", null, 0)).toBeUndefined();
  });

  it("finds the highest total, or -1 when every period is empty", () => {
    expect(peakColumnIndex([{ total: 1 }, { total: 9 }, { total: 4 }])).toBe(1);
    expect(peakColumnIndex([{ total: 0 }, { total: 0 }])).toBe(-1);
  });
});
