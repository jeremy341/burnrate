import { describe, expect, it } from "vitest";

import { fallbackCopy, parseAlertEvent } from "./parse";

const valid = {
  id: "evt-1",
  ts: 1_700_000_000_000,
  kind: "threshold",
  accountId: "claude-main",
  provider: "claude",
  windowId: "five_hour",
  title: "80% used",
  body: "Your 5 hour window is at 80%.",
  severity: "warn",
  usedPercent: 80,
};

describe("parseAlertEvent", () => {
  it("parses a complete event", () => {
    expect(parseAlertEvent(JSON.stringify(valid))).toEqual(valid);
  });

  it("coerces a numeric-string timestamp and usedPercent", () => {
    const parsed = parseAlertEvent(JSON.stringify({ ...valid, ts: "1700000000000", usedPercent: "92.5" }));
    expect(parsed?.ts).toBe(1_700_000_000_000);
    expect(parsed?.usedPercent).toBe(92.5);
  });

  it("fills in localised fallback copy when title/body are missing", () => {
    const parsed = parseAlertEvent(JSON.stringify({ ...valid, title: undefined, body: undefined }));
    expect(parsed?.title).toBe(fallbackCopy("threshold").title);
    expect(parsed?.body).toBe(fallbackCopy("threshold").body);
  });

  it("rejects malformed payloads", () => {
    expect(parseAlertEvent("not json")).toBeNull();
    expect(parseAlertEvent("[]")).toBeNull();
    expect(parseAlertEvent(JSON.stringify({ ...valid, id: "" }))).toBeNull();
    expect(parseAlertEvent(JSON.stringify({ ...valid, kind: "unknown" }))).toBeNull();
    expect(parseAlertEvent(JSON.stringify({ ...valid, severity: "fatal" }))).toBeNull();
    expect(parseAlertEvent(JSON.stringify({ kind: "reset" }))).toBeNull();
  });

  it("returns a timestamp for events without one", () => {
    const before = Date.now();
    const parsed = parseAlertEvent(JSON.stringify({ ...valid, ts: undefined }));
    expect(parsed?.ts).toBeGreaterThanOrEqual(before);
  });
});
