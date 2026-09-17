use std::sync::Arc;

use athria_application::AthriaApplication;
use athria_core::FixedClock;
use athria_store::SqliteStore;
use serde_json::json;

const NOW: &str = "2026-09-17T04:00:00.000Z";
fn app() -> AthriaApplication<SqliteStore> {
    let clock = Arc::new(FixedClock::new(NOW));
    AthriaApplication::with_clock(SqliteStore::open_in_memory_with_clock(clock.clone()).unwrap(), "local-user", clock)
}

#[test]
fn hevy_requires_preview_and_records_partial_imports() {
    let app = app();
    let csv = b"title,start_time,end_time,exercise_title,set_index,weight_kg,reps\nGood,2026-09-01T10:00:00Z,2026-09-01T11:00:00Z,Squat,1,100,5\nBad,not-a-date,,Squat,1,20,10\n";
    let preview = app.preview_hevy(csv, "hevy.csv").unwrap();
    assert_eq!(preview["counts"], json!({ "rows": 2, "sessions": 1, "sets": 1, "validRows": 1, "invalidRows": 1 }));
    assert_eq!(app.commit_hevy(preview["previewToken"].as_str().unwrap()).unwrap(), json!({ "added": 1, "updated": 0 }));
    assert_eq!(app.get_hevy_import_status().unwrap().unwrap()["status"], json!("partial"));
    let replay = app.commit_hevy(preview["previewToken"].as_str().unwrap()).unwrap_err();
    assert_eq!(replay.code().as_str(), "IMPORT_PREVIEW_NOT_FOUND");
}

#[test]
fn intervals_only_advances_last_success_after_full_success() {
    let app = app();
    let success = app.commit_intervals(&json!({ "activities": [{ "id": "run", "type": "Run", "start_date": "2026-09-10T10:00:00Z", "moving_time": 1800 }], "wellness": [{ "id": "2026-09-10", "restingHR": 50 }], "events": [] }),
        &json!({ "attemptedAt": "2026-09-11T08:00:00.000Z", "rangeStart": "2026-09-04", "rangeEnd": "2026-09-11" })).unwrap();
    assert_eq!(success["sync"]["status"], json!("success"));
    let partial = app.commit_intervals(&json!({ "activities": "HTTP 500", "wellness": [{ "id": "2026-09-11", "restingHR": 49 }], "events": [] }),
        &json!({ "attemptedAt": "2026-09-12T08:00:00.000Z", "rangeStart": "2026-09-10", "rangeEnd": "2026-09-12" })).unwrap();
    assert_eq!(partial["sync"]["status"], json!("partial"));
    assert_eq!(partial["sync"]["lastSuccessAt"], json!("2026-09-11T08:00:00.000Z"));
    assert_eq!(app.list_sessions(90).unwrap().len(), 1);
}

#[test]
fn xunji_replaces_only_successful_dates() {
    let app = app();
    let record = |id: &str, day: &str| json!({ "localid": id, "datestr": day, "title": id, "start": format!("{day}T03:00:00Z"), "end": format!("{day}T04:00:00Z"), "movements": [] });
    app.commit_xunji(&json!({ "rangeStart": "2026-09-06", "rangeEnd": "2026-09-07", "successfulDates": ["2026-09-06", "2026-09-07"], "errors": [], "records": [record("six", "2026-09-06"), record("seven", "2026-09-07")] }), NOW).unwrap();
    let partial = app.commit_xunji(&json!({ "rangeStart": "2026-09-06", "rangeEnd": "2026-09-07", "successfulDates": ["2026-09-07"], "errors": [{ "datestr": "2026-09-06", "code": "request_failed", "message": "fixture" }], "records": [] }), NOW).unwrap();
    assert_eq!(partial["sync"]["status"], json!("partial"));
    let sessions = app.list_xunji_sessions(30).unwrap();
    assert_eq!(sessions["sessions"].as_array().unwrap().iter().map(|session| session["externalId"].as_str().unwrap()).collect::<Vec<_>>(), ["six"]);
}
