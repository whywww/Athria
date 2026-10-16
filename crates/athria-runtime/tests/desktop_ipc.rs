//! Test the desktop request boundary without building the Tauri application.
#[path = "../../../apps/desktop/src-tauri/src/application_ipc.rs"]
mod desktop_ipc;

use athria_application::AthriaApplication;
use athria_core::FixedClock;
use athria_integrations::normalize_intervals_activity;
use athria_store::SqliteStore;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::json;
use std::{path::Path, sync::Arc};

#[test]
fn imported_effort_can_be_saved_through_an_encoded_desktop_route() {
    let clock = Arc::new(FixedClock::new("2026-10-14T00:00:00Z"));
    let app = AthriaApplication::with_clock(SqliteStore::open_in_memory_with_clock(clock.clone()).unwrap(), "local-user", clock);
    let imported = normalize_intervals_activity(&json!({"id":"i123","type":"Run","name":"Run","start_date":"2026-10-13T10:00:00Z","elapsed_time":1800,"icu_rpe":3}), "activities", "UTC").unwrap().unwrap();
    app.store().upsert_sessions(&[imported]).unwrap();
    let path = Path::new("test.sqlite3");
    let listed = desktop_ipc::dispatch(&app,path,"GET","/api/sessions?days=365",None).unwrap();
    let id = listed[0]["id"].as_str().unwrap();
    assert!(id.contains(':'));
    let route = format!("/api/training-sessions/{}/effort",utf8_percent_encode(id,NON_ALPHANUMERIC));
    let payload = |rpe, hash: &serde_json::Value| Some(json!({"rpe":rpe,"confirmed":true,"expectedSnapshotHash":hash}));
    let saved = desktop_ipc::dispatch(&app,path,"PATCH",&route,payload(7,&listed[0]["snapshotHash"])).unwrap();
    assert_eq!(saved["rpe"],json!(7));
    assert_eq!(saved["sessionRpe"],json!(210));
    let refreshed = desktop_ipc::dispatch(&app,path,"GET","/api/sessions?days=365",None).unwrap();
    assert_eq!(refreshed[0]["rpe"],json!(7));
    assert!(desktop_ipc::dispatch(&app,path,"PATCH",&route,payload(8,&listed[0]["snapshotHash"])).is_err());
    desktop_ipc::dispatch(&app,path,"PATCH",&route,payload(8,&refreshed[0]["snapshotHash"])).unwrap();
}

#[test]
fn resource_ids_are_decoded_once_after_splitting_the_route() {
    for id in ["ordinary-uuid", "manual:a+b/中文%2F", "intervals:activities:i123"] {
        let clock = Arc::new(FixedClock::new("2026-10-14T00:00:00Z"));
        let app = AthriaApplication::with_clock(SqliteStore::open_in_memory_with_clock(clock.clone()).unwrap(), "local-user", clock);
        app.record_training_session(&json!({"id":id,"type":"Run","name":"Run","startAt":"2026-10-13T10:00:00Z","durationMinutes":30})).unwrap();
        let session = app.list_sessions_with_snapshots(365).unwrap().remove(0);
        let route = format!("/api/training-sessions/{}/effort",utf8_percent_encode(id,NON_ALPHANUMERIC));
        let saved = desktop_ipc::dispatch(&app,Path::new("test.sqlite3"),"PATCH",&route,Some(json!({"rpe":1,"confirmed":true,"expectedSnapshotHash":session["snapshotHash"]}))).unwrap();
        assert_eq!(saved["id"],json!(id));
    }
}

#[test]
fn malformed_utf8_in_resource_ids_returns_a_controlled_error() {
    let app = AthriaApplication::new(SqliteStore::open_in_memory().unwrap());
    assert_eq!(desktop_ipc::dispatch(&app,Path::new("test.sqlite3"),"PATCH","/api/training-sessions/%FF/effort",Some(json!({}))).unwrap_err(),"Invalid UTF-8 in Athria request path.");
}
