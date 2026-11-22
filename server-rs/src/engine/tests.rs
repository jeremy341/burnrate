use super::*;
use crate::readers::FileInfo;
use crate::store::{C_CACHED, C_CACHE_WRITE, C_OUTPUT, C_SPEED, C_TS, C_UNCACHED};
use super::scan::FIRST_BATCH;
use crate::types::Record;
use chrono::{TimeZone, Utc};
use std::fs;
use std::path::Path;
use std::sync::atomic::AtomicUsize;

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("burnrate-engine-{}-{}", std::process::id(), NEXT_DIR.fetch_add(1, Ordering::Relaxed)));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::create_dir_all(dir.join("data")).unwrap();
    dir
}

/// A Source over a temp directory of JSONL files: `{"session":"s","model":"m","ts":123,"tokens":10}` per line.
struct TestSource {
    dir: PathBuf,
    reads: Arc<Mutex<Vec<String>>>,
}

impl Source for TestSource {
    fn provider(&self) -> &'static str {
        "test"
    }
    fn dir(&self) -> PathBuf {
        self.dir.clone()
    }
    fn files(&self) -> Vec<FileInfo> {
        let mut out = Vec::new();
        for entry in fs::read_dir(&self.dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                if let Ok(meta) = entry.metadata() {
                    out.push(FileInfo { path, size: meta.len() as f64, mtime_ms: readers::mtime_ms(&meta) });
                }
            }
        }
        out
    }
    fn read(&self, path: &Path, _since_ms: f64) -> Result<crate::types::ReadResult, String> {
        self.reads.lock().unwrap().push(path.file_name().unwrap().to_string_lossy().into_owned());
        let mut records = Vec::new();
        for line in readers::lines(path)? {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let session = v.get("session").and_then(Value::as_str).unwrap_or("");
            let model = v.get("model").and_then(Value::as_str).unwrap_or("test-model");
            let ts = v.get("ts").and_then(Value::as_f64).unwrap_or_else(now_ms);
            let mut r = Record::new(self.provider(), ts, model, session);
            r.uncached = v.get("tokens").and_then(Value::as_f64).unwrap_or(0.0);
            records.push(r);
        }
        Ok(crate::types::ReadResult { records, malformed: 0 })
    }
}

fn engine(dir: &Path) -> (Engine, Arc<Mutex<Vec<String>>>) {
    let reads = Arc::new(Mutex::new(Vec::new()));
    let source = TestSource { dir: dir.join("src"), reads: reads.clone() };
    (Engine::with_readers(dir.join("data"), vec![Box::new(source)]), reads)
}

fn write_file(dir: &Path, name: &str, lines: &[String]) {
    fs::write(dir.join("src").join(name), lines.join("\n") + "\n").unwrap();
}

fn line(session: &str, model: &str, ts: f64, tokens: f64) -> String {
    format!("{{\"session\":\"{session}\",\"model\":\"{model}\",\"ts\":{ts},\"tokens\":{tokens}}}")
}

/// Run one scan on this thread. Marks the engine as scanning first so summaries asked from `after_batch`
/// do not start a second one.
fn run_sync(e: &Engine, after_batch: &mut dyn FnMut()) {
    e.shared.scanning.store(true, Ordering::Release);
    e.shared.run_scan(after_batch);
}

fn wait_idle(e: &Engine) {
    for _ in 0..400 {
        let p = e.shared.progress_lock().clone();
        if !p.scanning && p.completed_once && !e.shared.scanning.load(Ordering::Acquire) {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("scan did not finish");
}

fn today_input() -> SummaryInput {
    let now = Utc::now();
    SummaryInput { since_day: (now - chrono::Duration::days(6)).format("%Y-%m-%d").to_string(), until_day: now.format("%Y-%m-%d").to_string(), time_zone: "UTC".into(), hourly: false, since_time: None, until_time: None }
}

fn total_records(summary: &Value) -> u64 {
    summary["buckets"].as_array().map_or(0, |b| b.iter().map(|x| x["records"].as_u64().unwrap_or(0)).sum())
}

fn string_count(e: &Engine) -> usize {
    e.shared.lock().strings.strings.len()
}

#[test]
fn time_zone_fallback_is_flagged() {
    let tokyo: chrono_tz::Tz = "Asia/Tokyo".parse().unwrap();
    assert_eq!(time_zone_or_utc("Asia/Tokyo"), (tokyo, false));
    let (tz, invalid) = time_zone_or_utc("Not/AZone");
    assert_eq!(tz, chrono_tz::UTC);
    assert!(invalid);
}

#[test]
fn shared_session_copy_keeps_new_rows_and_drops_duplicates() {
    fn row(session: f64, token: f64) -> Vec<f64> {
        let mut r = vec![0.0; STRIDE];
        r[C_SESSION] = session;
        r[C_UNCACHED] = token;
        r
    }
    let sid = 42.0_f64.to_bits();
    let canonical_row = row(42.0, 10.0);
    let mut canonical_rows = canonical_row.clone();
    canonical_rows.extend(row(42.0, 20.0));
    let copy_rows = [row(42.0, 10.0).as_slice(), row(42.0, 30.0).as_slice()].concat();
    let best = HashMap::from([(sid, (0usize, 2usize))]);
    let canonical = HashMap::from([(sid, HashSet::from([row_fingerprint(&canonical_row), row_fingerprint(&row(42.0, 20.0))]))]);

    let kept = shared_session_rows(&canonical_rows, 0, &best, &canonical);
    assert_eq!(kept.len(), 2 * STRIDE);
    let kept = shared_session_rows(&copy_rows, 1, &best, &canonical);
    assert_eq!(kept.len(), STRIDE);
    assert_eq!(kept[C_UNCACHED], 30.0); // the live file grew after the copy
}

#[test]
fn stale_files_release_interned_strings() {
    let dir = temp_dir();
    let (e, _) = engine(&dir);
    run_sync(&e, &mut || {});
    let baseline = string_count(&e);
    assert_eq!(baseline, 0, "a fresh interner should be empty after a scan");

    let log = dir.join("src").join("session.jsonl");
    fs::write(&log, "{\"session\":\"alpha\"}\n{\"session\":\"beta\"}\n{\"session\":\"gamma\"}\n").unwrap();
    run_sync(&e, &mut || {});
    assert!(string_count(&e) > baseline, "scanning the log should intern its unique sessions");

    fs::remove_file(&log).unwrap();
    run_sync(&e, &mut || {});
    assert_eq!(string_count(&e), baseline, "orphaned strings should be pruned once the file disappears");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn pruning_remaps_surviving_rows() {
    let dir = temp_dir();
    let (e, _) = engine(&dir);
    fs::write(dir.join("src").join("keep.jsonl"), "{\"session\":\"keep-session\"}\n").unwrap();
    fs::write(dir.join("src").join("drop.jsonl"), "{\"session\":\"drop-session\"}\n").unwrap();
    run_sync(&e, &mut || {});
    let before = string_count(&e);

    fs::remove_file(dir.join("src").join("drop.jsonl")).unwrap();
    run_sync(&e, &mut || {});
    let inner = e.shared.lock();
    assert!(inner.strings.strings.len() < before, "the dropped file's session should be pruned");
    assert!(!inner.strings.strings.iter().any(|s| s == "drop-session"), "the dropped session string must be gone");
    // The published view must index the compacted interner too, not just the cache.
    let rec = store::unpack(&inner.views[0].rows[0], 0, &inner.strings);
    assert_eq!(rec.provider, "test");
    assert_eq!(rec.model, "test-model");
    assert_eq!(rec.session, "keep-session", "surviving rows must index the compacted interner");
    drop(inner);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn partial_results_are_served_while_scanning() {
    let dir = temp_dir();
    let (e, _) = engine(&dir);
    let now = now_ms();
    for i in 0..40 {
        write_file(&dir, &format!("f{i:02}.jsonl"), &[line(&format!("s{i}"), "m", now - 60_000.0, 10.0)]);
    }
    let input = today_input();
    let mut seen: Vec<(String, u64, u64, u64)> = Vec::new();
    let settings = Settings::default();
    run_sync(&e, &mut || {
        let summary = e.summary(&input, &settings);
        seen.push((
            summary["scan"]["state"].as_str().unwrap().to_string(),
            summary["scan"]["filesDone"].as_u64().unwrap(),
            summary["scan"]["filesTotal"].as_u64().unwrap(),
            total_records(&summary),
        ));
    });
    assert!(seen.len() >= 3, "one callback per batch plus provider completion: {seen:?}");
    assert!(seen.iter().all(|s| s.0 == "scanning" && s.2 == 40), "{seen:?}");
    let partial: Vec<_> = seen.iter().filter(|s| s.3 > 0 && s.3 < 40).collect();
    assert!(!partial.is_empty(), "a request made mid-scan must see some, not all, of the data: {seen:?}");
    assert!(seen.windows(2).all(|w| w[0].1 <= w[1].1 && w[0].3 <= w[1].3), "progress and data only grow: {seen:?}");
    assert_eq!(seen.first().unwrap().1, FIRST_BATCH as u64, "the first batch is the small one");

    let done = e.summary(&input, &settings);
    assert_eq!(total_records(&done), 40);
    assert_eq!(done["scan"]["state"], "idle");
    assert_eq!(done["scan"]["completedOnce"], true);
    assert_eq!(done["scan"]["filesDone"], 40);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn newest_files_are_parsed_first() {
    let dir = temp_dir();
    let (e, reads) = engine(&dir);
    let now = SystemTime::now();
    for i in 0..40u64 {
        let name = format!("f{i:02}.jsonl");
        write_file(&dir, &name, &[line("s", "m", now_ms(), 1.0)]);
        // f39 is the newest, f00 the oldest.
        let file = fs::OpenOptions::new().write(true).open(dir.join("src").join(&name)).unwrap();
        file.set_modified(now - Duration::from_secs(3600 * (40 - i))).unwrap();
    }
    run_sync(&e, &mut || {});
    let order = reads.lock().unwrap().clone();
    assert_eq!(order.len(), 40);
    let first: HashSet<String> = order[..FIRST_BATCH].iter().cloned().collect();
    let newest: HashSet<String> = (24..40).map(|i| format!("f{i:02}.jsonl")).collect();
    assert_eq!(first, newest, "the first batch must hold the 16 most recently modified files");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn unchanged_files_are_not_read_again_and_progress_counts_them() {
    let dir = temp_dir();
    let (e, reads) = engine(&dir);
    for i in 0..5 {
        write_file(&dir, &format!("f{i}.jsonl"), &[line("s", "m", now_ms(), 1.0)]);
    }
    run_sync(&e, &mut || {});
    assert_eq!(reads.lock().unwrap().len(), 5);
    reads.lock().unwrap().clear();
    run_sync(&e, &mut || {});
    assert!(reads.lock().unwrap().is_empty(), "fresh cache entries must not be parsed again");
    let progress = e.progress();
    assert_eq!(progress["filesDone"], 5);
    assert_eq!(progress["filesTotal"], 5);
    assert_eq!(progress["providers"][0]["state"], "done");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn summary_is_memoised_until_the_rows_change() {
    let dir = temp_dir();
    let (e, _) = engine(&dir);
    write_file(&dir, "a.jsonl", &[line("s1", "m", now_ms() - 1000.0, 5.0)]);
    run_sync(&e, &mut || {});
    let input = today_input();
    let settings = Settings::default();
    let first = e.summary(&input, &settings);
    let again = e.summary(&input, &settings);
    assert_eq!(first["readAt"], again["readAt"], "the second answer must come from the memo");
    assert_eq!(total_records(&first), 1);

    write_file(&dir, "b.jsonl", &[line("s2", "m", now_ms() - 500.0, 7.0)]);
    run_sync(&e, &mut || {});
    let changed = e.summary(&input, &settings);
    assert_eq!(total_records(&changed), 2);
    assert_ne!(first["readAt"], changed["readAt"]);

    let mut other = Settings::default();
    other.aliases.insert("m".into(), "renamed".into());
    let aliased = e.summary(&input, &other);
    assert_eq!(aliased["buckets"][0]["model"], "renamed", "a different alias set must not reuse the memo");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn window_and_resolution_select_the_right_rows() {
    let dir = temp_dir();
    let (e, _) = engine(&dir);
    let now = now_ms();
    write_file(
        &dir,
        "a.jsonl",
        &[line("s1", "recent", now - 60_000.0, 100.0), line("s2", "older", now - 3.0 * DAY_MS, 50.0), line("s3", "ancient", now - 40.0 * DAY_MS, 25.0)],
    );
    run_sync(&e, &mut || {});
    let settings = Settings::default();
    let week = e.summary(&today_input(), &settings);
    let models: Vec<&str> = week["buckets"].as_array().unwrap().iter().map(|b| b["model"].as_str().unwrap()).collect();
    assert_eq!(models.len(), 2);
    assert!(models.contains(&"recent") && models.contains(&"older"));
    assert!(!models.contains(&"ancient"));

    let mut hourly = today_input();
    hourly.hourly = true;
    let hours = e.summary(&hourly, &settings);
    let recent = hours["buckets"].as_array().unwrap().iter().find(|b| b["model"] == "recent").unwrap();
    assert!(recent["hourStart"].as_str().is_some_and(|h| h.len() == 16 && h.ends_with(":00")), "{recent}");
    assert_eq!(recent["totals"]["uncachedInputTokens"], 100.0);

    let mut ninety = today_input();
    ninety.since_day = (Utc::now() - chrono::Duration::days(90)).format("%Y-%m-%d").to_string();
    assert_eq!(total_records(&e.summary(&ninety, &settings)), 3);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn exact_window_excludes_the_rest_of_the_day_and_counts_window_sessions() {
    let dir = temp_dir();
    let (e, _) = engine(&dir);
    let now = Utc::now();
    let now_ms = now.timestamp_millis() as f64;
    write_file(
        &dir,
        "a.jsonl",
        &[
            line("inside", "m", now_ms - 2.0 * 3_600_000.0, 10.0),
            line("outside-early", "m", now_ms - 30.0 * 3_600_000.0, 90.0),
            line("outside-late", "m", now_ms + 3_600_000.0, 5.0),
        ],
    );
    run_sync(&e, &mut || {});
    let settings = Settings::default();
    let days = SummaryInput {
        since_day: (now - chrono::Duration::days(2)).format("%Y-%m-%d").to_string(),
        until_day: now.format("%Y-%m-%d").to_string(),
        time_zone: "UTC".into(),
        hourly: true,
        since_time: None,
        until_time: None,
    };
    assert_eq!(total_records(&e.summary(&days, &settings)), 3);
    assert_eq!(e.summary(&days, &settings)["sources"][0]["windowSessions"], 3);

    let exact = SummaryInput { since_time: Some(now_ms - DAY_MS), until_time: Some(now_ms), ..days };
    let answer = e.summary(&exact, &settings);
    assert_eq!(total_records(&answer), 1, "only the row inside the last 24 h counts");
    assert_eq!(answer["sources"][0]["windowSessions"], 1);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn rows_sit_in_the_requested_time_zone_day() {
    let dir = temp_dir();
    let (e, _) = engine(&dir);
    // 23:30 UTC on 2025-03-10 is already 2025-03-11 in Tokyo.
    let ts = Utc.with_ymd_and_hms(2025, 3, 10, 23, 30, 0).unwrap().timestamp_millis() as f64;
    // Old transcripts fall outside the scan horizon, so seed the rows through the cache directly.
    {
        let mut inner = e.shared.lock();
        let rec = Record { uncached: 9.0, ..Record::new("test", ts, "m", "s") };
        let rows = Arc::new(store::pack(&[rec], &mut inner.strings));
        inner.cache.insert(format!("test{SEP}x"), FileEntry { size: 1.0, mtime_ms: 1.0, malformed: 0, rows });
        inner.views[0].keys = vec![format!("test{SEP}x")];
        scan::publish(&mut inner, 0, "test", false);
        e.shared.generation.store(inner.generation, Ordering::Release);
    }
    e.shared.progress_lock().completed_once = true;
    e.shared.progress_lock().last_finished_ms = now_ms();
    let settings = Settings::default();
    let utc = SummaryInput { since_day: "2025-03-10".into(), until_day: "2025-03-11".into(), time_zone: "UTC".into(), hourly: false, since_time: None, until_time: None };
    let tokyo = SummaryInput { time_zone: "Asia/Tokyo".into(), ..utc.clone() };
    assert_eq!(e.summary(&utc, &settings)["buckets"][0]["day"], "2025-03-10");
    assert_eq!(e.summary(&tokyo, &settings)["buckets"][0]["day"], "2025-03-11");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn persisted_summary_is_shown_at_once_when_the_scan_cache_is_gone() {
    let dir = temp_dir();
    let (e, _) = engine(&dir);
    write_file(&dir, "a.jsonl", &[line("s1", "m", now_ms() - 1000.0, 5.0), line("s2", "m", now_ms() - 900.0, 6.0)]);
    let input = today_input();
    let settings = Settings::default();
    e.summary(&input, &settings); // remembers the window and starts a scan
    wait_idle(&e);
    assert!(dir.join("data").join(SUMMARY_FILE).is_file(), "the finished scan persists the remembered windows");
    assert_eq!(total_records(&e.summary(&input, &settings)), 2);
    drop(e);

    // A restart that lost the row cache: only the persisted summary can answer instantly.
    let _ = fs::remove_file(dir.join("data").join("usage-scan-cache.bin"));
    let (restarted, _) = engine(&dir);
    assert!(restarted.shared.cold_start);
    restarted.shared.scanning.store(true, Ordering::Release); // hold the revalidation scan back for the assertion
    let answer = restarted.summary(&input, &settings);
    assert_eq!(answer["stale"], true, "a persisted answer is marked stale");
    assert_eq!(total_records(&answer), 2);
    assert_eq!(answer["scan"]["completedOnce"], false);
    restarted.shared.scanning.store(false, Ordering::Release);

    // Once the real scan completed the live numbers replace it.
    restarted.shared.kick();
    wait_idle(&restarted);
    let live = restarted.summary(&input, &settings);
    assert!(live.get("stale").is_none());
    assert_eq!(total_records(&live), 2);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_warm_scan_cache_answers_a_restart_without_waiting() {
    let dir = temp_dir();
    let (e, _) = engine(&dir);
    write_file(&dir, "a.jsonl", &[line("s1", "m", now_ms() - 1000.0, 5.0)]);
    run_sync(&e, &mut || {});
    drop(e);

    let (restarted, reads) = engine(&dir);
    assert!(!restarted.shared.cold_start);
    restarted.shared.scanning.store(true, Ordering::Release);
    let answer = restarted.summary(&today_input(), &Settings::default());
    assert_eq!(total_records(&answer), 1, "rows come straight from the saved scan cache");
    assert!(answer.get("stale").is_none());
    assert!(reads.lock().unwrap().is_empty());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cache_rows_are_shared_not_copied() {
    let dir = temp_dir();
    let (e, _) = engine(&dir);
    write_file(&dir, "a.jsonl", &[line("s1", "m", now_ms(), 5.0)]);
    run_sync(&e, &mut || {});
    let inner = e.shared.lock();
    let cached = inner.cache.values().next().unwrap();
    assert!(Arc::ptr_eq(&cached.rows, &inner.views[0].rows[0]), "the published view must reuse the cached buffer");
    let row = &cached.rows;
    assert_eq!((row[C_UNCACHED], row[C_CACHED], row[C_CACHE_WRITE], row[C_OUTPUT], row[C_SPEED]), (5.0, 0.0, 0.0, 0.0, 0.0));
    assert!(row[C_TS] > 0.0);
    drop(inner);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn progress_json_has_the_documented_shape() {
    let dir = temp_dir();
    let (e, _) = engine(&dir);
    let idle = e.progress();
    assert_eq!(idle["state"], "idle");
    assert_eq!(idle["completedOnce"], false);
    assert_eq!(idle["filesDone"], 0);
    assert_eq!(idle["providers"][0]["id"], "test");
    let _ = fs::remove_dir_all(&dir);
}
