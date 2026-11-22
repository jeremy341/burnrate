import { describe, expect, it } from "vitest";

import { formatResetDuration, formatStatusLine } from "./statusLine";

const NOW = Date.parse("2026-11-20T12:00:00Z");

describe("formatResetDuration", () => {
  it("formats days, hours and minutes", () => {
    expect(formatResetDuration("2026-11-20T14:30:00Z", NOW)).toBe("2h 30m");
    expect(formatResetDuration("2026-11-20T12:45:00Z", NOW)).toBe("45m");
    expect(formatResetDuration("2026-11-24T02:00:00Z", NOW)).toBe("3d 14h");
  });

  it("clamps past timestamps to zero and handles invalid dates", () => {
    expect(formatResetDuration("2026-11-20T11:00:00Z", NOW)).toBe("0m");
    expect(formatResetDuration("not-a-date", NOW)).toBe("?");
  });
});

describe("formatStatusLine", () => {
  it("reports each account's tightest window with its reset time", () => {
    const line = formatStatusLine(
      {
        accounts: [
          {
            label: "Jerry",
            windows: [
              { label: "Session", usedPercent: 47.2, remainingPercent: 52.8, resetsAt: "2026-11-20T12:28:00Z" },
              { label: "Weekly", usedPercent: 94, remainingPercent: 6, resetsAt: "2026-11-24T02:00:00Z" },
            ],
          },
          { label: "Kernel", windows: [{ kind: "session", usedPercent: 10 }] },
        ],
      },
      NOW,
    );
    expect(line).toBe("Jerry 6% left (Weekly, resets in 3d 14h) · Kernel 90% left (session)");
  });

  it("uses the supplied account naming", () => {
    const line = formatStatusLine(
      { accounts: [{ provider: "claudeAgent", windows: [{ usedPercent: 50 }] }] },
      NOW,
      () => "Claude Code",
    );
    expect(line).toBe("Claude Code 50% left");
  });

  it("falls back when there are no windows", () => {
    expect(formatStatusLine({}, NOW)).toBe("No limits available");
    expect(formatStatusLine({ accounts: [{ label: "A", windows: [] }] }, NOW)).toBe("No limits available");
  });
});
