import { describe, expect, it, vi } from "vitest";

import {
  ONBOARDED_KEY,
  readOnboardedFlag,
  readOnboardedServerFlag,
  writeOnboardedFlag,
} from "./flags";

function fakeStorage(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    values,
    getItem: vi.fn((key: string) => values[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values[key] = value;
    }),
  };
}

describe("readOnboardedFlag", () => {
  it("is true only for the explicit string 'true'", () => {
    expect(ONBOARDED_KEY).toBe("burnrate.onboarded");
    expect(readOnboardedFlag(fakeStorage({ [ONBOARDED_KEY]: "true" }))).toBe(true);
    expect(readOnboardedFlag(fakeStorage({ [ONBOARDED_KEY]: "false" }))).toBe(false);
    expect(readOnboardedFlag(fakeStorage())).toBe(false);
  });

  it("survives storage that throws or is unavailable", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readOnboardedFlag(throwing)).toBe(false);
    expect(readOnboardedFlag(null)).toBe(false);
  });
});

describe("readOnboardedServerFlag", () => {
  it("reads the new top-level flag", () => {
    expect(readOnboardedServerFlag({ onboarded: true })).toBe(true);
    expect(readOnboardedServerFlag({ onboarded: false })).toBe(false);
  });

  it("still reads the legacy advanced.experimental flag", () => {
    expect(readOnboardedServerFlag({ advanced: { experimental: { onboarded: true } } })).toBe(true);
    expect(readOnboardedServerFlag({ advanced: { experimental: { onboarded: false } } })).toBe(false);
  });

  it("prefers either shape and tolerates missing or malformed settings", () => {
    expect(
      readOnboardedServerFlag({ onboarded: false, advanced: { experimental: { onboarded: true } } }),
    ).toBe(true);
    expect(readOnboardedServerFlag({ advanced: {} })).toBe(false);
    expect(readOnboardedServerFlag({ advanced: { experimental: "no" } })).toBe(false);
    expect(readOnboardedServerFlag(null)).toBe(false);
    expect(readOnboardedServerFlag(undefined)).toBe(false);
    expect(readOnboardedServerFlag("nope")).toBe(false);
  });
});

describe("writeOnboardedFlag", () => {
  it("persists the completion flag", () => {
    const storage = fakeStorage();
    writeOnboardedFlag(storage);
    expect(storage.setItem).toHaveBeenCalledWith(ONBOARDED_KEY, "true");
    expect(readOnboardedFlag(storage)).toBe(true);
  });

  it("does not throw when storage is full or missing", () => {
    const throwing = {
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(() => writeOnboardedFlag(throwing)).not.toThrow();
    expect(() => writeOnboardedFlag(null)).not.toThrow();
  });
});
