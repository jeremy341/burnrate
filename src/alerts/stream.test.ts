import { afterEach, describe, expect, it, vi } from "vitest";

import { createAlertStream, type EventSourceLike, type StreamEventLike } from "./stream";
import type { AlertEvent } from "./types";

class FakeEventSource implements EventSourceLike {
  static all: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Set<(event: StreamEventLike) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.all.push(this);
  }

  addEventListener(type: string, listener: (event: StreamEventLike) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: StreamEventLike) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }

  close(): void {
    this.closed = true;
  }
}

function makeEvent(id: string): AlertEvent {
  return {
    id,
    ts: 1,
    kind: "threshold",
    accountId: "acct",
    provider: "claude",
    title: "t",
    body: "b",
    severity: "warn",
  };
}

describe("createAlertStream", () => {
  afterEach(() => {
    vi.useRealTimers();
    FakeEventSource.all = [];
  });

  it("does not connect while alerts are disabled", () => {
    const stream = createAlertStream({
      getState: () => ({ enabled: false, hidden: false }),
      onEvent: () => {},
      createEventSource: (url) => new FakeEventSource(url),
    });
    stream.update();
    expect(FakeEventSource.all).toHaveLength(0);
    stream.dispose();
  });

  it("connects once, forwards parsed alerts and ignores malformed data", () => {
    const received: string[] = [];
    const stream = createAlertStream({
      getState: () => ({ enabled: true, hidden: false }),
      onEvent: (event) => received.push(event.id),
      createEventSource: (url) => new FakeEventSource(url),
    });
    stream.update();
    stream.update(); // idempotent
    expect(FakeEventSource.all).toHaveLength(1);
    expect(stream.connected).toBe(true);

    const source = FakeEventSource.all[0]!;
    source.emit("alert", JSON.stringify(makeEvent("e1")));
    source.emit("alert", "not json");
    source.emit("snapshot", JSON.stringify(makeEvent("e2")));
    expect(received).toEqual(["e1"]);

    stream.dispose();
    expect(source.closed).toBe(true);
    expect(stream.connected).toBe(false);
  });

  it("closes the stream when disabled or hidden, and reopens when both allow it", () => {
    let enabled = true;
    let hidden = false;
    const stream = createAlertStream({
      getState: () => ({ enabled, hidden }),
      onEvent: () => {},
      createEventSource: (url) => new FakeEventSource(url),
    });
    stream.update();
    const first = FakeEventSource.all[0]!;

    hidden = true;
    stream.update();
    expect(first.closed).toBe(true);
    expect(FakeEventSource.all).toHaveLength(1);

    hidden = false;
    stream.update();
    expect(FakeEventSource.all).toHaveLength(2);

    enabled = false;
    stream.update();
    expect(FakeEventSource.all[1]!.closed).toBe(true);
    stream.dispose();
  });

  it("reconnects with backoff after an error and cancels retries on dispose", () => {
    vi.useFakeTimers();
    const stream = createAlertStream({
      getState: () => ({ enabled: true, hidden: false }),
      onEvent: () => {},
      createEventSource: (url) => new FakeEventSource(url),
      retryMs: 1000,
      maxRetryMs: 5000,
    });
    stream.update();
    FakeEventSource.all[0]!.emit("error");

    expect(FakeEventSource.all).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all).toHaveLength(2);

    FakeEventSource.all[1]!.emit("error");
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all).toHaveLength(3);

    FakeEventSource.all[2]!.emit("error");
    stream.dispose(); // cancels the timer before it fires
    vi.advanceTimersByTime(5000);
    expect(FakeEventSource.all).toHaveLength(3);
  });
});
