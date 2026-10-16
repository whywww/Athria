use super::*;

fn raw_record(owner: &str, day: &str, score: i64, source: &str) -> Value {
    json!({ "ownerId": owner, "day": day, "updatedAt": "2026-10-16T00:00:00Z", "fields": {
        "sleepScore": { "value": score, "source": source, "updatedAt": "2026-10-15T01:00:00Z" },
        "sleepSeconds": { "value": score * 300, "source": source, "updatedAt": "2026-10-15T02:00:00Z" },
        "avgSleepingHeartRateBpm": { "value": 45, "source": "intervals_icu", "updatedAt": "2026-10-15T03:00:00Z" },
        "hrvRmssdMs": { "value": score, "source": "intervals_icu", "updatedAt": "2026-10-15T04:00:00Z" }
    } })
}

#[test]
fn legacy_sleep_moves_once_across_boundaries_without_moving_other_metrics_or_owners() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("legacy-sleep.sqlite3");
    let store = SqliteStore::open(&path).unwrap();
    // Simulate a current-schema database created before the evening-date correction.
    store.connection.execute_batch("DROP TABLE athria_data_migrations").unwrap();
    let mut originals = Vec::new();
    for (owner, source) in [("a", "user"), ("b", "intervals_icu"), ("c", "llm")] {
        for (day, evening, score) in [("2026-01-01", "2025-12-31", 70), ("2026-01-02", "2026-01-01", 80), ("2024-03-01", "2024-02-29", 60)] {
            let record = raw_record(owner, day, score, source);
            store.write_wellness_record(&record).unwrap();
            originals.push((record, evening));
        }
    }
    let before = store.data_version().unwrap();
    drop(store);
    let inspect = SqliteStore::open_read_only(&path).unwrap();
    assert!(!inspect.table_exists("athria_data_migrations").unwrap());
    assert_eq!(inspect.data_version().unwrap(), before);
    assert_eq!(inspect.get_wellness("a", "2026-01-01").unwrap().unwrap()["fields"]["sleepScore"]["value"], 70);
    drop(inspect);

    let store = SqliteStore::open(&path).unwrap();
    for (original, evening) in &originals {
        let owner = original["ownerId"].as_str().unwrap();
        let shifted = store.get_wellness(owner, evening).unwrap().unwrap();
        for key in ["sleepScore", "sleepSeconds", "avgSleepingHeartRateBpm"] {
            assert_eq!(shifted["fields"][key], original["fields"][key]);
        }
        let original_day = store.get_wellness(owner, original["day"].as_str().unwrap()).unwrap().unwrap();
        assert_eq!(original_day["fields"]["hrvRmssdMs"], original["fields"]["hrvRmssdMs"]);
    }
    assert!(store.get_wellness("a", "2026-01-02").unwrap().unwrap()["fields"].get("sleepScore").is_none());
    assert!(store.get_wellness("a", "2025-12-31").unwrap().unwrap()["fields"].get("hrvRmssdMs").is_none());
    // New entries already use the evening date and must survive all future opens unchanged.
    store.save_wellness(&raw_record("a", "2026-10-15", 90, "user")).unwrap();
    let after = store.list_wellness("a", None).unwrap();
    let version = store.data_version().unwrap();
    drop(store);
    let reopened = SqliteStore::open(&path).unwrap();
    assert_eq!(reopened.list_wellness("a", None).unwrap(), after);
    assert_eq!(reopened.data_version().unwrap(), version);
}

#[test]
fn migration_and_marker_roll_back_together_on_write_failure() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rollback.sqlite3");
    let store = SqliteStore::open(&path).unwrap();
    let original = raw_record("a", "2026-10-16", 80, "user");
    store.write_wellness_record(&original).unwrap();
    store.connection.execute_batch("DELETE FROM athria_data_migrations;
        CREATE TRIGGER fail_sleep_move BEFORE INSERT ON wellness BEGIN SELECT RAISE(ABORT, 'sleep move failed'); END;").unwrap();
    let version = store.data_version().unwrap();
    drop(store);
    assert!(SqliteStore::open(&path).is_err());
    let inspect = SqliteStore::open_read_only(&path).unwrap();
    assert_eq!(inspect.get_wellness("a", "2026-10-16").unwrap().unwrap(), original);
    assert!(inspect.get_wellness("a", "2026-10-15").unwrap().is_none());
    assert_eq!(inspect.data_version().unwrap(), version);
    let markers: i64 = inspect.connection.query_row("SELECT COUNT(*) FROM athria_data_migrations", [], |r| r.get(0)).unwrap();
    assert_eq!(markers, 0);
    drop(inspect);
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("DROP TRIGGER fail_sleep_move").unwrap();
    drop(connection);
    let reopened = SqliteStore::open(&path).unwrap();
    assert_eq!(reopened.get_wellness("a", "2026-10-15").unwrap().unwrap()["fields"]["sleepScore"], original["fields"]["sleepScore"]);
}

#[test]
fn migration_recomputes_readiness_using_the_moved_evening_sleep() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("readiness.sqlite3");
    let store = SqliteStore::open(&path).unwrap();
    for offset in 0..=7 {
        let day = athria_core::date::format_iso_date(athria_core::date::epoch_day("2026-10-05") - offset);
        store.write_wellness_record(&json!({ "ownerId": "a", "day": day, "updatedAt": "original", "fields": {
            "hrvRmssdMs": { "value": 50, "source": "intervals_icu", "updatedAt": "original" },
            "restingHeartRateBpm": { "value": 50, "source": "intervals_icu", "updatedAt": "original" }
        } })).unwrap();
    }
    let mut sleep = raw_record("a", "2026-10-06", 85, "user");
    sleep["fields"].as_object_mut().unwrap().shift_remove("hrvRmssdMs");
    store.write_wellness_record(&sleep).unwrap();
    store.connection.execute_batch("DELETE FROM athria_data_migrations").unwrap();
    drop(store);
    let reopened = SqliteStore::open(&path).unwrap();
    assert_eq!(reopened.get_wellness("a", "2026-10-05").unwrap().unwrap()["fields"]["readiness"]["value"], 84);
}

#[test]
fn icu_sleep_import_uses_the_evening_date_and_keeps_adjacent_nights_distinct() {
    let store = SqliteStore::open_in_memory().unwrap();
    // Reverse chronological order matches a normal ICU sync batch.
    let payloads = [json!({ "id": "2026-01-02", "sleepScore": 80, "sleepSecs": 28800, "avgSleepingHR": 45, "hrv": 60 }),
        json!({ "id": "2026-01-01", "sleepScore": 70, "sleepSecs": 25200, "avgSleepingHR": 50, "hrv": 55 })];
    for _ in 0..2 {
        assert_eq!(store.upsert_wellness("a", &payloads).unwrap(), 2);
        let december = store.get_wellness("a", "2025-12-31").unwrap().unwrap();
        assert_eq!(december["fields"]["sleepScore"]["value"], 70);
        assert_eq!(december["fields"]["sleepSeconds"]["value"], 25200);
        assert_eq!(december["fields"]["avgSleepingHeartRateBpm"]["value"], 50);
        assert!(december["fields"].get("hrvRmssdMs").is_none());
        let january = store.get_wellness("a", "2026-01-01").unwrap().unwrap();
        assert_eq!(january["fields"]["sleepScore"]["value"], 80);
        assert_eq!(january["fields"]["hrvRmssdMs"]["value"], 55);
        assert!(store.get_wellness("a", "2026-01-02").unwrap().unwrap()["fields"].get("sleepScore").is_none());
    }
}
