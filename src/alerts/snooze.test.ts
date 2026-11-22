import { describe, expect, it } from "vitest";

import { isSnoozed } from "./snooze";

describe("isSnoozed", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");

  it("is false with no snooze", () => {
    expect(isSnoozed(null, now)).toBe(false);
    expect(isSnoozed(undefined, now)).toBe(false);
    expect(isSnoozed("", now)).toBe(false);
  });

  it("is true only while the timestamp is in the future", () => {
    expect(isSnoozed("2026-01-01T13:00:00Z", now)).toBe(true);
    expect(isSnoozed("2026-01-01T11:00:00Z", now)).toBe(false);
    expect(isSnoozed("2026-01-01T12:00:00Z", now)).toBe(false);
  });

  it("ignores invalid dates", () => {
    expect(isSnoozed("not a date", now)).toBe(false);
  });
});
