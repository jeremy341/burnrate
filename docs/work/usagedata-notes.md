# Usage data and graphs: measurements (real home, release build)

Corpus: ~2,765 in-horizon transcript files (10 GB on disk), 22 MB scan cache, ~80k records.

| | before | after |
|---|---|---|
| First `/api/usage`, cold cache | 55 s (blocks, UI on skeletons) | 2-30 ms, first records after ~1.6 s, full scan ~49 s in the background |
| First `/api/usage`, warm cache, after restart | ~3 s (waited for the startup scan) | 100 ms, full data at once |
| Steady `/api/usage` (7/30/90 d) | 300-470 ms (rescan + clone on every call) | 2-4 ms memoised, 35-135 ms recompute after a change |
| Files re-parsed on every restart | ~10% (fractional mtime did not survive the JSON round trip) | 0 (whole-millisecond mtime) |
| Startup | eager scan holding the lock + limits probe by the scheduler | background scan, no limits probe for 45 s |
| RSS | steady 41-57 MB | steady 59-75 MB, peak ~150 MB during a cold scan (batches of 32 files) |

API additions: `scan: {state, filesDone, filesTotal, completedOnce, providers[]}` on `/api/usage`, `stale: true` when the persisted
summary is served, `GET /api/usage/progress`. Persisted: `usage-scan-cache.bin` (every 10 s during a scan) and `usage-summary-cache.json`.
