use athria_store::SqliteStore;
use serde_json::json;
use std::sync::{Arc, Barrier};

const ZONE: &str = "Asia/Hong_Kong";
const NOW: &str = "2026-10-07T08:00:00Z";

#[test]
fn attempts_survive_restart_even_without_a_completed_sync() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("daily.sqlite3");
    let store = SqliteStore::open(&path).unwrap();
    assert!(store.begin_daily_sync_attempt("intervals", "local-user", ZONE, NOW, true).unwrap());
    assert!(store.get_connection_sync_state("intervals", "local-user").unwrap().is_none());
    drop(store);
    let reopened = SqliteStore::open(&path).unwrap();
    assert!(!reopened.begin_daily_sync_attempt("intervals", "local-user", ZONE, NOW, true).unwrap());
    assert!(reopened.begin_daily_sync_attempt("xunji", "local-user", ZONE, NOW, true).unwrap());
    assert!(reopened.begin_daily_sync_attempt("intervals", "other-owner", ZONE, NOW, true).unwrap());
    assert!(reopened.begin_daily_sync_attempt("intervals", "local-user", ZONE, "2026-10-08T08:00:00Z", true).unwrap());
    // Manual retries remain available, even after an automatic attempt.
    assert!(reopened.begin_daily_sync_attempt("intervals", "local-user", ZONE, NOW, false).unwrap());
}

#[test]
fn manual_attempts_and_all_historical_outcomes_suppress_daily_sync() {
    let store = SqliteStore::open_in_memory().unwrap();
    assert!(store.begin_daily_sync_attempt("xunji", "manual", ZONE, NOW, false).unwrap());
    assert!(!store.begin_daily_sync_attempt("xunji", "manual", ZONE, NOW, true).unwrap());
    for status in ["success", "partial", "failed"] {
        store.save_connection_sync_state(&json!({
            "ownerId": status, "source": "intervals", "lastAttemptAt": NOW,
            "lastSuccessAt": null, "rangeStart": "2026-10-01", "rangeEnd": "2026-10-07", "status": status, "data": {},
        })).unwrap();
        assert!(!store.begin_daily_sync_attempt("intervals", status, ZONE, NOW, true).unwrap());
        assert!(store.begin_daily_sync_attempt("intervals", status, ZONE, "2026-10-07T16:00:00Z", true).unwrap());
    }
}

#[test]
fn days_follow_profile_timezone_across_local_midnight() {
    let store = SqliteStore::open_in_memory().unwrap();
    for (owner, zone, expected) in [("hk", ZONE, true), ("ny", "America/New_York", false)] {
        assert!(store.begin_daily_sync_attempt("xunji", owner, zone, "2026-10-07T15:59:59Z", true).unwrap());
        assert_eq!(store.begin_daily_sync_attempt("xunji", owner, zone, "2026-10-07T16:00:00Z", true).unwrap(), expected);
    }
}

#[test]
fn separate_connections_claim_the_same_day_only_once() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("concurrent.sqlite3");
    drop(SqliteStore::open(&path).unwrap());
    let barrier = Arc::new(Barrier::new(2));
    let workers: Vec<_> = (0..2).map(|_| {
        let path = path.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            let store = SqliteStore::open(path).unwrap();
            barrier.wait();
            store.begin_daily_sync_attempt("intervals", "local-user", ZONE, NOW, true).unwrap()
        })
    }).collect();
    assert_eq!(workers.into_iter().map(|worker| worker.join().unwrap() as usize).sum::<usize>(), 1);
}

#[test]
fn daily_attempts_belong_to_the_selected_database() {
    let a = SqliteStore::open_in_memory().unwrap();
    let b = SqliteStore::open_in_memory().unwrap();
    assert!(a.begin_daily_sync_attempt("xunji", "local-user", ZONE, NOW, true).unwrap());
    assert!(b.begin_daily_sync_attempt("xunji", "local-user", ZONE, NOW, true).unwrap());
}
