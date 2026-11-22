import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  customThemes: {} as Record<string, unknown>,
  patches: [] as unknown[],
}));

vi.mock("~/settings/store", () => ({
  getSettings: () => ({ appearance: { customThemes: state.customThemes } }),
  updateSettings: vi.fn((patch: unknown) => {
    state.patches.push(patch);
    return Promise.resolve();
  }),
  useSettings: vi.fn(),
}));

import { writeCustomThemes } from "./store";

describe("writeCustomThemes", () => {
  beforeEach(() => {
    state.patches = [];
    state.customThemes = { alpha: { id: "alpha" }, beta: { id: "beta" } };
  });

  it("sends null for a theme that left the record so the server deletes it", () => {
    writeCustomThemes({ beta: { id: "beta" } } as never);
    expect(state.patches).toEqual([
      { appearance: { customThemes: { beta: { id: "beta" }, alpha: null } } },
    ]);
  });

  it("sends only the record when nothing was removed", () => {
    writeCustomThemes({ alpha: { id: "alpha" }, beta: { id: "beta" }, gamma: { id: "gamma" } } as never);
    expect(state.patches).toEqual([
      { appearance: { customThemes: { alpha: { id: "alpha" }, beta: { id: "beta" }, gamma: { id: "gamma" } } } },
    ]);
  });
});
