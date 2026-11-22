import { describe, expect, it } from "vitest";

import { UsageDay, type UsageSource, type UsageSummary } from "~/contracts";

import { mergeUsage } from "./usageMerge";

function source(over: Partial<UsageSource>): UsageSource {
  return {
    fingerprint: {
      hostId: "local",
      provider: "claude",
      resolvedHomePath: "/home/u/.claude/projects",
      volumeId: "",
    },
    status: "ok",
    scannedFiles: 1,
    skippedFiles: 0,
    malformedRecords: 0,
    distinctSessions: 2741,
    message: null,
    ...over,
  };
}

function summary(sources: UsageSource[]): UsageSummary {
  return {
    contractVersion: 6,
    readAt: "2026-11-21T21:00:00.000Z",
    timeZone: "Europe/Berlin",
    sinceDay: UsageDay.make("2026-11-20"),
    untilDay: UsageDay.make("2026-11-21"),
    buckets: [],
    sources,
    pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 0 },
    scanDurationMs: 1,
  };
}

describe("mergeUsage sessions", () => {
  it("prefers the window-scoped count over the all-time count", () => {
    const merged = mergeUsage(
      [
        {
          environmentId: "local",
          label: "This computer",
          summary: summary([source({ windowSessions: 46 })]),
        },
      ],
      6,
    );
    expect(merged.sessions).toBe(46);
  });

  it("falls back to distinctSessions when an older server omits windowSessions", () => {
    const merged = mergeUsage(
      [
        {
          environmentId: "local",
          label: "This computer",
          summary: summary([source({})]),
        },
      ],
      6,
    );
    expect(merged.sessions).toBe(2741);
  });

  it("sums window-scoped sessions across owned sources", () => {
    const merged = mergeUsage(
      [
        {
          environmentId: "local",
          label: "This computer",
          summary: summary([
            source({ windowSessions: 46 }),
            source({
              fingerprint: {
                hostId: "local",
                provider: "codex",
                resolvedHomePath: "/home/u/.codex/sessions",
                volumeId: "",
              },
              windowSessions: 10,
            }),
          ]),
        },
      ],
      6,
    );
    expect(merged.sessions).toBe(56);
  });
});
