//! In-process event hub: the scheduler publishes, the SSE endpoint (`/api/stream`) and the shell subscribe.
//! Owned by the scheduler-hub-status package. Contract: docs/CONTRACTS.md, "Events".

use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

/// Hard cap on simultaneous SSE subscribers (contract section 8). The 9th subscriber gets 429.
pub const MAX_STREAM_SUBSCRIBERS: usize = 8;

/// Per-subscriber queue depth. A stream whose writer is stuck (client stopped reading) fills this and is
/// evicted instead of letting events pile up without bound while it pins its connection thread.
const SUBSCRIBER_QUEUE: usize = 64;

/// One hub event. `kind` is "snapshot", "alert" or "settings".
#[derive(Clone, Debug)]
pub struct Event {
    pub kind: String,
    pub data: Value,
}

/// A sender plus a liveness flag. `std::sync::mpsc::Sender` has no `is_alive`, so the owning
/// `Subscription` clears this flag in its `Drop`. That lets `subscribe`/`subscriber_count`
/// reclaim slots immediately instead of waiting for the next `publish`.
struct Subscriber {
    tx: SyncSender<Event>,
    alive: Arc<AtomicBool>,
}

/// A received-side handle. Dropping it removes the subscriber from the hub.
pub struct Subscription {
    rx: Receiver<Event>,
    alive: Arc<AtomicBool>,
}

impl Subscription {
    /// Wait for one event, or time out (used for the SSE heartbeat).
    pub fn recv_timeout(&self, timeout: Duration) -> Result<Event, mpsc::RecvTimeoutError> {
        self.rx.recv_timeout(timeout)
    }

    /// Drain an event that is already queued (coalesce a burst into one SSE response).
    pub fn try_recv(&self) -> Result<Event, mpsc::TryRecvError> {
        self.rx.try_recv()
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        // An idle scheduler sleeps on this condition variable; a disappearing consumer is activity.
        wake();
    }
}

#[derive(Default)]
struct Hub {
    senders: Vec<Subscriber>,
}

fn hub() -> &'static Mutex<Hub> {
    static HUB: OnceLock<Mutex<Hub>> = OnceLock::new();
    HUB.get_or_init(|| Mutex::new(Hub::default()))
}

/// Shared wake-up primitive used by the scheduler's consumer-aware sleep. Publishing, subscribing,
/// unsubscribing and explicit activity notifications all wake it. A wake is not a timer: the
/// scheduler thread is parked on the condition variable and consumes no CPU while idle.
struct Wake {
    lock: Mutex<()>,
    cv: Condvar,
}

fn wake_state() -> &'static Wake {
    static WAKE: OnceLock<Wake> = OnceLock::new();
    WAKE.get_or_init(|| Wake { lock: Mutex::new(()), cv: Condvar::new() })
}

/// Wake a thread waiting in `wait_for_activity`.
pub fn wake() {
    let state = wake_state();
    let _guard = state.lock.lock().unwrap_or_else(|e| e.into_inner());
    state.cv.notify_all();
}

/// Wait at most `timeout` for any hub activity. A long timeout is a park, not polling.
pub fn wait_for_activity(timeout: Duration) {
    let state = wake_state();
    let guard = state.lock.lock().unwrap_or_else(|e| e.into_inner());
    let _ = state.cv.wait_timeout(guard, timeout);
}

/// Publish an event to every subscriber. Dead receivers are dropped as we go. Never blocks: each
/// subscriber has a bounded queue and `try_send` evicts one that is full (a stalled SSE client), which
/// also frees its stream slot straight away. The evicted stream ends once it drains its queue.
pub fn publish(kind: &str, data: Value) {
    let event = Event { kind: kind.to_string(), data };
    {
        let mut h = hub().lock().unwrap_or_else(|e| e.into_inner());
        h.senders.retain(|s| {
            s.alive.load(Ordering::Acquire)
                && match s.tx.try_send(event.clone()) {
                    Ok(()) => true,
                    Err(TrySendError::Full(_)) => {
                        s.alive.store(false, Ordering::Release);
                        false
                    }
                    Err(TrySendError::Disconnected(_)) => false,
                }
        });
    }
    wake();
}

/// Number of live subscribers. Reclaims slots whose `Subscription` has been dropped.
pub fn subscriber_count() -> usize {
    let mut h = hub().lock().unwrap_or_else(|e| e.into_inner());
    h.senders.retain(|s| s.alive.load(Ordering::Acquire));
    h.senders.len()
}

/// Subscribe to hub events, or `None` when the stream cap is reached.
pub fn subscribe() -> Option<Subscription> {
    let mut h = hub().lock().unwrap_or_else(|e| e.into_inner());
    h.senders.retain(|s| s.alive.load(Ordering::Acquire));
    if h.senders.len() >= MAX_STREAM_SUBSCRIBERS {
        return None;
    }
    let (tx, rx) = mpsc::sync_channel(SUBSCRIBER_QUEUE);
    let alive = Arc::new(AtomicBool::new(true));
    h.senders.push(Subscriber { tx, alive: alive.clone() });
    drop(h);
    wake();
    Some(Subscription { rx, alive })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The hub is a process-wide singleton; serialise tests that inspect its state.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn fan_out_reaches_every_subscriber() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let a = subscribe().expect("slot a");
        let b = subscribe().expect("slot b");
        publish("alert", json!({"id": "x", "severity": "warn"}));
        let ea = a.recv_timeout(Duration::from_secs(1)).expect("event for a");
        let eb = b.recv_timeout(Duration::from_secs(1)).expect("event for b");
        assert_eq!(ea.kind, "alert");
        assert_eq!(eb.kind, "alert");
        assert_eq!(ea.data["id"], "x");
        assert_eq!(eb.data["severity"], "warn");
    }

    #[test]
    fn dead_sender_is_cleaned_up() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let before = subscriber_count();
        {
            let sub = subscribe().expect("slot");
            assert_eq!(subscriber_count(), before + 1);
            drop(sub);
        }
        assert_eq!(subscriber_count(), before, "dropped subscription must free its slot");
        // A publish must not panic or retain the dead sender.
        publish("snapshot", json!({"ok": true}));
    }

    #[test]
    fn stalled_subscriber_is_evicted_when_its_queue_fills() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let before = subscriber_count();
        let stalled = subscribe().expect("slot");
        for i in 0..(SUBSCRIBER_QUEUE + 2) {
            publish("snapshot", json!({"n": i}));
        }
        assert_eq!(subscriber_count(), before, "a full queue must free the stream slot");
        // The stalled receiver still drains what was queued, then sees the hub hang up.
        let mut drained = 0;
        while stalled.try_recv().is_ok() {
            drained += 1;
        }
        assert_eq!(drained, SUBSCRIBER_QUEUE);
    }

    #[test]
    fn stream_cap_rejects_the_ninth_subscriber() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut subs = Vec::new();
        while subs.len() < MAX_STREAM_SUBSCRIBERS {
            subs.push(subscribe().expect("slot within cap"));
        }
        assert!(subscribe().is_none(), "subscriber beyond the cap must be rejected");
        subs.clear(); // drop all
        assert!(subscribe().is_some(), "slots must be reusable after unsubscribe");
    }
}
