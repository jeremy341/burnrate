/**
 * EventSource lifecycle for `/api/stream` alert events.
 *
 * The stream exists only while alerts are enabled AND the page is visible; it is closed as soon as
 * either becomes false. Reconnection uses bounded exponential backoff and every timer is cleared
 * on `dispose()`, so there is no hidden polling or unbounded retry loop.
 */
import { parseAlertEvent } from "./parse";
import type { AlertEvent } from "./types";

export interface StreamEventLike {
  readonly data?: string;
}
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: StreamEventLike) => void): void;
  removeEventListener(type: string, listener: (event: StreamEventLike) => void): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

export interface AlertStreamOptions {
  readonly url?: string;
  readonly getState: () => { readonly enabled: boolean; readonly hidden: boolean };
  readonly onEvent: (event: AlertEvent) => void;
  /** Injectable for tests with a fake EventSource. */
  readonly createEventSource?: EventSourceFactory;
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
}

export interface AlertStreamController {
  /** Call whenever enabled/hidden may have changed. */
  update(): void;
  /** Permanently close the stream and cancel pending retries. */
  dispose(): void;
  readonly connected: boolean;
}

const defaultFactory: EventSourceFactory = (url) => new EventSource(url) as unknown as EventSourceLike;

export function createAlertStream(options: AlertStreamOptions): AlertStreamController {
  const url = options.url ?? "/api/stream";
  const makeSource = options.createEventSource ?? defaultFactory;
  const baseRetry = Math.max(100, options.retryMs ?? 1000);
  const maxRetry = Math.max(baseRetry, options.maxRetryMs ?? 30_000);

  let source: EventSourceLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let disposed = false;

  const desired = (): boolean => {
    const state = options.getState();
    return state.enabled && !state.hidden;
  };

  const onMessage = (event: StreamEventLike): void => {
    const parsed = parseAlertEvent(typeof event?.data === "string" ? event.data : "");
    if (parsed) options.onEvent(parsed);
  };
  const onOpen = (): void => {
    retries = 0;
  };
  const onError = (): void => {
    if (disposed) return;
    disconnect();
    if (!desired()) return;
    const delay = Math.min(maxRetry, baseRetry * 2 ** retries);
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!disposed && desired()) connect();
    }, delay);
  };

  function connect(): void {
    if (source || disposed || !desired()) return;
    try {
      source = makeSource(url);
    } catch {
      onError();
      return;
    }
    source.addEventListener("alert", onMessage);
    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
  }

  function disconnect(): void {
    if (!source) return;
    source.removeEventListener("alert", onMessage);
    source.removeEventListener("open", onOpen);
    source.removeEventListener("error", onError);
    try {
      source.close();
    } catch {
      /* already closed */
    }
    source = null;
  }

  function clearRetry(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  return {
    update(): void {
      if (disposed) return;
      if (desired()) {
        clearRetry();
        connect();
      } else {
        clearRetry();
        retries = 0;
        disconnect();
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearRetry();
      disconnect();
    },
    get connected(): boolean {
      return source !== null;
    },
  };
}
