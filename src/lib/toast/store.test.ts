import { describe, expect, it } from "vitest";

import { createToastStore, DEFAULT_MAX_TOASTS } from "./store";
import type { TimerHandle, ToastTimers } from "./types";

/** Deterministic timer seam: no real timers, no global fake-timer state. */
class ManualTimers implements ToastTimers {
  private next = 0;
  private timers = new Map<number, { fn: () => void; at: number }>();
  now = 0;

  set(fn: () => void, ms: number): TimerHandle {
    const id = ++this.next;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  }

  clear(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  tick(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.now) {
        this.timers.delete(id);
        timer.fn();
      }
    }
  }

  get pending(): number {
    return this.timers.size;
  }
}

function setup(max?: number, duration?: number) {
  const timers = new ManualTimers();
  const store = createToastStore({
    timers,
    ...(max !== undefined ? { max } : {}),
    ...(duration !== undefined ? { duration } : {}),
  });
  return { store, timers };
}

describe("toast queue", () => {
  it("adds toasts with resolved fields and unique, increasing ids", () => {
    const { store, timers } = setup();
    const action = { label: "Undo", onClick: () => {} };

    const first = store.add("success", "Saved", { title: "Settings", action });
    const second = store.add("error", "Failed", { duration: 100 });

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(store.getSnapshot()).toEqual([
      { id: 1, type: "success", message: "Saved", title: "Settings", action, duration: 5_000 },
      { id: 2, type: "error", message: "Failed", duration: 100 },
    ]);
    expect(timers.pending).toBe(2);
  });

  it("uses DEFAULT_MAX_TOASTS when no max is given", () => {
    const { store } = setup();
    for (let i = 0; i < DEFAULT_MAX_TOASTS; i++) store.add("info", `#${i}`, { duration: 0 });
    store.add("info", "overflow", { duration: 0 });

    expect(store.getSnapshot()).toHaveLength(DEFAULT_MAX_TOASTS);
    expect(store.getSnapshot()[0]!.message).toBe("#1");
    expect(store.getSnapshot().at(-1)!.message).toBe("overflow");
  });

  it("keeps the snapshot reference stable until a mutation", () => {
    const { store } = setup();
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);

    const id = store.add("info", "hello", { duration: 0 });
    const added = store.getSnapshot();
    expect(added).not.toBe(before);
    expect(store.getSnapshot()).toBe(added);

    store.dismiss(id);
    expect(store.getSnapshot()).not.toBe(added);
  });

  it("notifies subscribers on add, dismiss and clear, and stops after unsubscribe", () => {
    const { store } = setup();
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);

    const id = store.add("info", "one", { duration: 0 });
    expect(calls).toBe(1);
    store.dismiss(id);
    expect(calls).toBe(2);
    store.clear();
    expect(calls).toBe(3);

    unsubscribe();
    store.add("info", "two", { duration: 0 });
    expect(calls).toBe(3);
  });

  it("drops the oldest toast (and its timer) when the queue overflows", () => {
    const { store, timers } = setup(2, 1_000);
    store.add("info", "oldest");
    store.add("info", "middle");
    store.add("info", "newest");

    expect(store.getSnapshot().map((item) => item.message)).toEqual(["middle", "newest"]);
    expect(timers.pending).toBe(2);

    timers.tick(1_000);
    expect(store.getSnapshot()).toEqual([]);
    expect(timers.pending).toBe(0);
  });

  it("auto-dismisses after the duration and clears the timer", () => {
    const { store, timers } = setup();
    let notifications = 0;
    store.subscribe(() => notifications++);
    store.add("warning", "careful", { duration: 100 });

    timers.tick(99);
    expect(store.getSnapshot()).toHaveLength(1);
    expect(notifications).toBe(1);

    timers.tick(1);
    expect(store.getSnapshot()).toEqual([]);
    expect(notifications).toBe(2);
    expect(timers.pending).toBe(0);
  });

  it("dismisses only the requested toast and ignores unknown ids", () => {
    const { store, timers } = setup();
    const first = store.add("info", "first", { duration: 1_000 });
    store.add("info", "second", { duration: 1_000 });
    let notifications = 0;
    store.subscribe(() => notifications++);

    store.dismiss(first);
    expect(store.getSnapshot().map((item) => item.message)).toEqual(["second"]);
    expect(timers.pending).toBe(1);

    store.dismiss(999);
    expect(store.getSnapshot()).toHaveLength(1);
    expect(timers.pending).toBe(1);
    expect(notifications).toBe(1);
  });

  it("clear removes every toast and every pending timer", () => {
    const { store, timers } = setup();
    store.add("info", "a");
    store.add("info", "b");
    store.add("info", "c");

    store.clear();

    expect(store.getSnapshot()).toEqual([]);
    expect(timers.pending).toBe(0);
    timers.tick(10_000);
    expect(store.getSnapshot()).toEqual([]);
  });

  it("keeps sticky toasts (duration 0 or Infinity) until dismissed", () => {
    const { store, timers } = setup();
    const zero = store.add("error", "sticky zero", { duration: 0 });
    const infinite = store.add("error", "sticky infinite", { duration: Number.POSITIVE_INFINITY });

    expect(timers.pending).toBe(0);
    timers.tick(1_000_000);
    expect(store.getSnapshot()).toHaveLength(2);

    store.dismiss(zero);
    store.dismiss(infinite);
    expect(store.getSnapshot()).toEqual([]);
  });

  it("preserves the action and title references for the overlay", () => {
    const { store } = setup();
    const action = { label: "Retry", onClick: () => {} };
    store.add("error", "Boom", { title: "Sync failed", action, duration: 0 });

    const item = store.getSnapshot()[0]!;
    expect(item.title).toBe("Sync failed");
    expect(item.action).toBe(action);
  });
});
