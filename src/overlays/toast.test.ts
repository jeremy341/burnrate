import { describe, expect, it } from "vitest";

import { diffExitedToasts } from "./toast";
import type { ToastItem, ToastType } from "~/lib/toast";

let nextId = 0;
function toastItem(type: ToastType = "info"): ToastItem {
  return { id: ++nextId, type, message: `message ${nextId}`, duration: 5000 };
}

describe("diffExitedToasts", () => {
  it("reports nothing when the snapshot is unchanged", () => {
    const items = [toastItem(), toastItem()];
    expect(diffExitedToasts(items, items)).toEqual([]);
  });

  it("keeps the stack index a dismissed front toast held", () => {
    const front = toastItem();
    const second = toastItem();
    expect(diffExitedToasts([front, second], [second])).toEqual([
      { item: front, index: 0 },
    ]);
  });

  it("keeps the stack index of a toast dismissed from the middle", () => {
    const first = toastItem();
    const middle = toastItem();
    const last = toastItem();
    expect(diffExitedToasts([first, middle, last], [first, last])).toEqual([
      { item: middle, index: 1 },
    ]);
  });

  it("reports every cleared toast with its own index", () => {
    const first = toastItem();
    const second = toastItem();
    expect(diffExitedToasts([first, second], [])).toEqual([
      { item: first, index: 0 },
      { item: second, index: 1 },
    ]);
  });

  it("ignores items that only moved within the snapshot", () => {
    const front = toastItem();
    const back = toastItem();
    expect(diffExitedToasts([front, back], [back, front])).toEqual([]);
  });
});
