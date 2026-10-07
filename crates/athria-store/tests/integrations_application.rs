use std::sync::Arc;

use athria_application::AthriaApplication;
use athria_core::FixedClock;
use athria_store::SqliteStore;
use serde_json::json;

const NOW: &str = "2026-09-17T04:00:00.000Z";
fn app() -> AthriaApplication<SqliteStore> {
    let clock = Arc::new(FixedClock::new(NOW));
    AthriaApplication::with_clock(
        SqliteStore::open_in_memory_with_clock(clock.clone()).unwrap(),
        "local-user",
        clock,
    )
}

#[test]
fn hevy_requires_preview_and_records_partial_imports() {
    let app = app();
    let csv = b"title,start_time,end_time,exercise_title,set_index,weight_kg,reps\nGood,2026-09-01T10:00:00Z,2026-09-01T11:00:00Z,Squat,1,100,5\nBad,not-a-date,,Squat,1,20,10\n";
    let preview = app.preview_hevy(csv, "hevy.csv").unwrap();
    assert_eq!(
        preview["counts"],
        json!({ "rows": 2, "sessions": 1, "sets": 1, "validRows": 1, "invalidRows": 1 })
    );
    assert_eq!(
        app.commit_hevy(preview["previewToken"].as_str().unwrap())
            .unwrap(),
        json!({ "added": 1, "updated": 0 })
    );
    assert_eq!(
        app.get_hevy_import_status().unwrap().unwrap()["status"],
        json!("partial")
    );
    let replay = app
        .commit_hevy(preview["previewToken"].as_str().unwrap())
        .unwrap_err();
    assert_eq!(replay.code().as_str(), "IMPORT_PREVIEW_NOT_FOUND");
}

#[test]
fn intervals_advances_sync_time_after_partial_success() {
    let app = app();
    let success = app.commit_intervals(&json!({ "activities": [{ "id": "run", "type": "Run", "start_date": "2026-09-10T10:00:00Z", "moving_time": 1800 }], "wellness": [{ "id": "2026-09-10", "restingHR": 50 }], "events": [] }),
        &json!({ "attemptedAt": "2026-09-11T08:00:00.000Z", "rangeStart": "2026-09-04", "rangeEnd": "2026-09-11" })).unwrap();
    assert_eq!(success["sync"]["status"], json!("success"));
    let partial = app.commit_intervals(&json!({ "activities": "HTTP 500", "wellness": [{ "id": "2026-09-11", "restingHR": 49 }], "events": [] }),
        &json!({ "attemptedAt": "2026-09-12T08:00:00.000Z", "rangeStart": "2026-09-10", "rangeEnd": "2026-09-12" })).unwrap();
    assert_eq!(partial["sync"]["status"], json!("partial"));
    assert_eq!(partial["sync"]["lastSuccessAt"], json!("2026-09-12T08:00:00.000Z"));
    assert_eq!(app.list_sessions(90).unwrap().len(), 1);
}

#[test]
fn intervals_skips_a_failed_date_and_advances_partial_sync_time() {
    let app = app();
    let context = |time| json!({ "attemptedAt": time, "rangeStart": "2026-09-10", "rangeEnd": "2026-09-12" });
    app.commit_intervals(&json!({ "activities": [
        { "id": "old-ten", "start_date": "2026-09-10T10:00:00Z" },
        { "id": "old-eleven", "start_date": "2026-09-11T10:00:00Z" },
        { "id": "old-twelve", "start_date": "2026-09-12T10:00:00Z" }
    ], "wellness": [] }), &context("2026-09-13T08:00:00Z")).unwrap();
    let partial = app.commit_intervals(&json!({ "activities": [
        { "id": "new-ten", "start_date": "2026-09-10T11:00:00Z" },
        { "id": "new-eleven", "start_date": "2026-09-11T11:00:00Z" },
        { "id": "bad-eleven", "start_date_local": "2026-09-11Tbad" },
        { "id": "new-twelve", "start_date": "2026-09-12T11:00:00Z" }
    ], "wellness": [] }), &context("2026-09-14T08:00:00Z")).unwrap();
    assert_eq!(partial["sync"]["status"], "partial");
    assert_eq!(partial["sync"]["lastSuccessAt"], "2026-09-14T08:00:00Z");
    assert_eq!(partial["failedDates"][0]["date"], "2026-09-11");
    assert_eq!(partial["failedDates"][0]["failures"][0]["activityId"], "bad-eleven");
    assert_eq!(app.get_intervals_sync_status().unwrap().unwrap()["data"]["failedDates"], partial["failedDates"]);
    let ids: Vec<String> = app.list_sessions(90).unwrap().iter().map(|session| session["externalId"].as_str().unwrap().to_owned()).collect();
    assert_eq!(ids.len(), 3);
    for id in ["activities:new-ten", "activities:old-eleven", "activities:new-twelve"] { assert!(ids.contains(&id.to_string()), "missing {id}"); }
}

#[test]
fn intervals_undated_failure_upserts_good_activities_without_deleting_old_ones() {
    let app = app();
    let context = json!({ "attemptedAt": "2026-09-15T08:00:00Z", "rangeStart": "2026-09-10", "rangeEnd": "2026-09-11" });
    app.commit_intervals(&json!({ "activities": [{ "id": "old", "start_date": "2026-09-10T10:00:00Z" }], "wellness": [] }), &context).unwrap();
    let partial = app.commit_intervals(&json!({ "activities": [
        { "id": "good", "start_date": "2026-09-11T10:00:00Z" },
        { "id": "bad", "start_date": "not-a-date" }
    ], "wellness": [] }), &context).unwrap();
    assert_eq!(partial["sync"]["status"], "partial");
    assert_eq!(partial["undatedFailures"][0]["activityId"], "bad");
    let ids: Vec<String> = app.list_sessions(90).unwrap().iter().map(|session| session["externalId"].as_str().unwrap().to_owned()).collect();
    assert_eq!(ids.len(), 2);
    for id in ["activities:old", "activities:good"] { assert!(ids.contains(&id.to_string()), "missing {id}"); }
}

#[test]
fn xunji_replaces_only_successful_dates() {
    let app = app();
    let record = |id: &str, day: &str| json!({ "localid": id, "datestr": day, "title": id, "start": format!("{day}T03:00:00Z"), "end": format!("{day}T04:00:00Z"), "movements": [] });
    app.commit_xunji(&json!({ "rangeStart": "2026-09-06", "rangeEnd": "2026-09-07", "successfulDates": ["2026-09-06", "2026-09-07"], "errors": [], "records": [record("six", "2026-09-06"), record("seven", "2026-09-07")] }), NOW).unwrap();
    let partial = app.commit_xunji(&json!({ "rangeStart": "2026-09-06", "rangeEnd": "2026-09-07", "successfulDates": ["2026-09-07"], "errors": [{ "datestr": "2026-09-06", "code": "request_failed", "message": "fixture" }], "records": [] }), NOW).unwrap();
    assert_eq!(partial["sync"]["status"], json!("partial"));
    let sessions = app.list_xunji_sessions(30).unwrap();
    assert_eq!(
        sessions["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|session| session["externalId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["six"]
    );
}
