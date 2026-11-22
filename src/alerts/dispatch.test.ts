import { describe, expect, it, vi } from "vitest";

import { createAlertDispatcher, type AlertDispatchState } from "./dispatch";
import type { AlertEvent } from "./types";

const event = (overrides: Partial<AlertEvent> = {}): AlertEvent => ({
  id: "e1",
  ts: 1,
  kind: "threshold",
  accountId: "acct",
  provider: "claude",
  title: "80% used",
  body: "window at 80%",
  severity: "warn",
  ...overrides,
});

type MutableState = { -readonly [K in keyof AlertDispatchState]: AlertDispatchState[K] };

function setup(initial: Partial<AlertDispatchState> = {}) {
  const state: MutableState = { snoozeUntil: null, desktop: false, ...initial };
  const showToast = vi.fn();
  const showDesktop = vi.fn();
  const dispatcher = createAlertDispatcher({
    state: () => state,
    canShowDesktop: (enabled) => enabled,
    showToast,
    showDesktop,
  });
  return { dispatcher, state, showToast, showDesktop };
}

describe("createAlertDispatcher", () => {
  it("delivers a toast with the right level and text", () => {
    const { dispatcher, showToast } = setup();
    dispatcher.handle(event());
    expect(showToast).toHaveBeenCalledWith(event(), "warning", "80% used: window at 80%");
  });

  it("maps critical severity to the error level", () => {
    const { dispatcher, showToast } = setup();
    dispatcher.handle(event({ severity: "critical" }));
    expect(showToast.mock.calls[0]?.[1]).toBe("error");
  });

  it("dedupes by event id", () => {
    const { dispatcher, showToast } = setup();
    dispatcher.handle(event());
    dispatcher.handle(event());
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("suppresses events while snoozed", () => {
    const { dispatcher, state, showToast, showDesktop } = setup({
      snoozeUntil: "2099-01-01T00:00:00Z",
      desktop: true,
    });
    dispatcher.handle(event());
    expect(showToast).not.toHaveBeenCalled();
    expect(showDesktop).not.toHaveBeenCalled();

    state.snoozeUntil = null;
    dispatcher.handle(event());
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("only shows a desktop notification when desktop is enabled", () => {
    const { dispatcher, state, showDesktop } = setup({ desktop: false });
    dispatcher.handle(event({ id: "a" }));
    expect(showDesktop).not.toHaveBeenCalled();

    state.desktop = true;
    dispatcher.handle(event({ id: "b" }));
    expect(showDesktop).toHaveBeenCalledTimes(1);
  });
});
