import { describe, expect, it } from "vitest";

import { createDedupe } from "./dedupe";

describe("createDedupe", () => {
  it("accepts an id once", () => {
    const d = createDedupe();
    expect(d.isNew("a")).toBe(true);
    expect(d.isNew("a")).toBe(false);
    expect(d.size).toBe(1);
  });

  it("ignores empty ids", () => {
    const d = createDedupe();
    expect(d.isNew("")).toBe(false);
    expect(d.size).toBe(0);
  });

  it("evicts the oldest id when full", () => {
    const d = createDedupe(2);
    expect(d.isNew("a")).toBe(true);
    expect(d.isNew("b")).toBe(true);
    expect(d.isNew("c")).toBe(true);
    expect(d.size).toBe(2);
    expect(d.isNew("a")).toBe(true); // evicted, so new again
  });

  it("can be cleared", () => {
    const d = createDedupe();
    d.isNew("a");
    d.clear();
    expect(d.size).toBe(0);
    expect(d.isNew("a")).toBe(true);
  });
});
