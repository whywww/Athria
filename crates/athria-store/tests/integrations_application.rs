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
fn intervals_preserves_data_and_sync_time_after_endpoint_failure() {
    let app = app();
    let success = app.commit_intervals(&json!({ "activities": [{ "id": "run", "type": "Run", "start_date": "2026-09-10T10:00:00Z", "moving_time": 1800 }], "wellness": [{ "id": "2026-09-10", "restingHR": 50 }], "events": [] }),
        &json!({ "attemptedAt": "2026-09-11T08:00:00.000Z", "rangeStart": "2026-09-04", "rangeEnd": "2026-09-11" })).unwrap();
    assert_eq!(success["sync"]["status"], json!("success"));
    let partial = app.commit_intervals(&json!({ "activities": "HTTP 500", "wellness": [{ "id": "2026-09-11", "restingHR": 49 }], "events": [] }),
        &json!({ "attemptedAt": "2026-09-12T08:00:00.000Z", "rangeStart": "2026-09-10", "rangeEnd": "2026-09-12" })).unwrap();
    assert_eq!(partial["sync"]["status"], json!("failed"));
    assert_eq!(partial["sync"]["lastSuccessAt"], json!("2026-09-11T08:00:00.000Z"));
    assert_eq!(app.list_sessions(90).unwrap().len(), 1);
    assert_eq!(partial["wellnessCount"], 0);
    assert_eq!(app.list_wellness(90).unwrap().len(), 1);
}

#[test]
fn intervals_cancels_all_dates_after_one_normalization_failure() {
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
    assert_eq!(partial["sync"]["status"], "failed");
    assert_eq!(partial["sync"]["lastSuccessAt"], "2026-09-13T08:00:00Z");
    assert_eq!(partial["failedDates"][0]["date"], "2026-09-11");
    assert_eq!(partial["failedDates"][0]["failures"][0]["activityId"], "bad-eleven");
    assert_eq!(app.get_intervals_sync_status().unwrap().unwrap()["data"]["failedDates"], partial["failedDates"]);
    let ids: Vec<String> = app.list_sessions(90).unwrap().iter().map(|session| session["sources"][0]["externalId"].as_str().unwrap().to_owned()).collect();
    assert_eq!(ids.len(), 3);
    for id in ["activities:old-ten", "activities:old-eleven", "activities:old-twelve"] { assert!(ids.contains(&id.to_string()), "missing {id}"); }
}

#[test]
fn intervals_undated_failure_cancels_good_activities() {
    let app = app();
    let context = json!({ "attemptedAt": "2026-09-15T08:00:00Z", "rangeStart": "2026-09-10", "rangeEnd": "2026-09-11" });
    app.commit_intervals(&json!({ "activities": [{ "id": "old", "start_date": "2026-09-10T10:00:00Z" }], "wellness": [] }), &context).unwrap();
    let partial = app.commit_intervals(&json!({ "activities": [
        { "id": "good", "start_date": "2026-09-11T10:00:00Z" },
        { "id": "bad", "start_date": "not-a-date" }
    ], "wellness": [] }), &context).unwrap();
    assert_eq!(partial["sync"]["status"], "failed");
    assert_eq!(partial["undatedFailures"][0]["activityId"], "bad");
    let ids: Vec<String> = app.list_sessions(90).unwrap().iter().map(|session| session["sources"][0]["externalId"].as_str().unwrap().to_owned()).collect();
    assert_eq!(ids.len(), 1);
    for id in ["activities:old"] { assert!(ids.contains(&id.to_string()), "missing {id}"); }
}

#[test]
fn xunji_cancels_all_dates_after_request_failure() {
    let app = app();
    let record = |id: &str, day: &str| json!({ "localid": id, "datestr": day, "title": id, "start": format!("{day}T03:00:00Z"), "end": format!("{day}T04:00:00Z"), "movements": [] });
    app.commit_xunji(&json!({ "rangeStart": "2026-09-06", "rangeEnd": "2026-09-07", "successfulDates": ["2026-09-06", "2026-09-07"], "errors": [], "records": [record("six", "2026-09-06"), record("seven", "2026-09-07")] }), NOW).unwrap();
    let partial = app.commit_xunji(&json!({ "rangeStart": "2026-09-06", "rangeEnd": "2026-09-07", "successfulDates": ["2026-09-07"], "errors": [{ "datestr": "2026-09-06", "code": "request_failed", "message": "fixture" }], "records": [] }), "2026-09-18T04:00:00.000Z").unwrap();
    assert_eq!(partial["sync"]["status"], json!("failed"));
    assert_eq!(partial["sync"]["lastSuccessAt"], NOW);
    assert_eq!(partial["added"], 0);
    assert_eq!(partial["sync"]["data"]["successfulDays"], 0);
    let sessions = app.list_xunji_sessions(30).unwrap();
    assert_eq!(
        sessions["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|session| session["sources"][0]["externalId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["seven", "six"]
    );
}

#[test]
fn intervals_first_failure_and_retry_are_atomic() {
    let app = app();
    let context = json!({ "attemptedAt": NOW, "rangeStart": "2026-09-10", "rangeEnd": "2026-09-12" });
    for failure in [json!("HTTP 500"), json!({ "invalid": true })] {
        let result = app.commit_intervals(&json!({ "activities": [{ "id": "run", "start_date": "2026-09-10T10:00:00Z" }],
            "wellness": [], "events": failure }), &context).unwrap();
        assert_eq!(result["sync"]["status"], "failed");
        assert!(result["sync"]["lastSuccessAt"].is_null());
        assert!(app.list_sessions(90).unwrap().is_empty());
    }
    let malformed = app.commit_intervals(&json!({ "activities": [{ "id": "run", "start_date": "2026-09-10T10:00:00Z" }], "wellness": [null], "events": [] }), &context).unwrap();
    assert_eq!(malformed["sync"]["status"], "failed");
    assert!(app.list_sessions(90).unwrap().is_empty());
    let result = app.commit_intervals(&json!({ "activities": [{ "id": "run", "start_date": "2026-09-10T10:00:00Z" }], "wellness": [], "events": [] }), &context).unwrap();
    assert_eq!(result["sync"]["status"], "success");
    assert_eq!(result["sync"]["lastSuccessAt"], NOW);
    assert_eq!(app.list_sessions(90).unwrap().len(), 1);
}

#[test]
fn xunji_normalization_failures_keep_dates_and_cancel_the_batch() {
    let app = app();
    let bad = |day: &str| json!({ "datestr": day, "localid": day, "movements": "invalid" });
    let result = app.commit_xunji(&json!({ "rangeStart": "2026-09-10", "rangeEnd": "2026-09-12",
        "successfulDates": ["2026-09-10", "2026-09-11", "2026-09-12"], "errors": [],
        "records": [bad("2026-09-10"), bad("2026-09-10"), bad("2026-09-11"), { "datestr": "2026-09-12", "localid": "good" }] }), NOW).unwrap();
    assert_eq!(result["sync"]["status"], "failed");
    assert!(result["sync"]["lastSuccessAt"].is_null());
    assert_eq!(result["sync"]["data"]["failedDays"], 2);
    assert_eq!(result["sync"]["data"]["errors"][0]["datestr"], "2026-09-10");
    assert!(app.list_sessions(90).unwrap().is_empty());
    let unknown = app.commit_xunji(&json!({ "rangeStart": "2026-09-10", "rangeEnd": "2026-09-12", "successfulDates": ["2026-09-10"], "errors": [], "records": [{ "localid": "unknown" }] }), NOW).unwrap();
    assert_eq!(unknown["sync"]["status"], "failed");
    assert!(unknown["sync"]["data"]["errors"][0]["datestr"].is_null());
    let retry = app.commit_xunji(&json!({ "rangeStart": "2026-09-10", "rangeEnd": "2026-09-12", "successfulDates": ["2026-09-10", "2026-09-11", "2026-09-12"], "errors": [], "records": [] }), NOW).unwrap();
    assert_eq!(retry["sync"]["status"], "success");
    assert_eq!(retry["sync"]["lastSuccessAt"], NOW);
}

#[test]
fn xunji_explicit_window_uses_profile_local_days_and_overrides_rolling_days() {
    let app = app();
    let records = [
        ("before", "2026-09-10T15:59:59Z"),
        ("start", "2026-09-10T16:00:00Z"),
        ("end", "2026-09-11T15:59:59Z"),
        ("after", "2026-09-11T16:00:00Z"),
    ].map(|(id, start)| json!({"localid":id,"datestr":"2026-09-11","title":id,"start":start,"movements":[]}));
    let committed = app.commit_xunji(&json!({"rangeStart":"2026-09-11","rangeEnd":"2026-09-11","successfulDates":["2026-09-11"],"errors":[],"records":records}), NOW).unwrap();
    assert_eq!(committed["added"], 4, "{committed}");
    let result = app.list_xunji_sessions_in_window(1, Some("2026-09-11"), Some("2026-09-11")).unwrap();
    let names: Vec<&str> = result["sessions"].as_array().unwrap().iter().map(|session| session["name"].as_str().unwrap()).collect();
    assert_eq!(names.len(), 2, "{result}");
    assert!(names.contains(&"start"));
    assert!(names.contains(&"end"));
    assert_eq!(result["sync"]["lastSuccessAt"], NOW);
    assert_eq!(app.list_xunji_sessions(1).unwrap()["sessions"].as_array().unwrap().len(), 0);
}
