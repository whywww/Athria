//! Application use cases over the real SQLite store.
//!
//! `AthriaApplication` is generic over the `AthriaStore` port; these tests run
//! it against `SqliteStore` in memory with a fixed clock, which is the exact
//! wiring the desktop shell uses. The committed fixture replay covers the
//! stable application contract.

use std::sync::Arc;

use athria_application::{AthriaApplication, RecordImportBatchInput};
use athria_core::{
    AdjustmentScopePolicy, AdjustmentTrigger, AthriaErrorCode, EvidenceSeverity, FixedClock,
    ReasonCode, RecommendedScope, ReviewStatus, ScopeViolationCode,
};
use athria_store::SqliteStore;
use athria_vault::{create_envelope, encrypt_secret, new_master_key};
use serde_json::{Value, json};

const NOW: &str = "2026-09-17T04:00:00.000Z";

fn test_app() -> AthriaApplication<SqliteStore> {
    let clock = Arc::new(FixedClock::new(NOW));
    let store =
        SqliteStore::open_in_memory_with_clock(clock.clone()).expect("in-memory store opens");
    AthriaApplication::with_clock(store, "local-user", clock)
}

#[test]
fn athria_readiness_is_persisted_and_recomputed_for_dependent_days() {
    let app = test_app();
    let day = "2026-10-05";
    let mut records: Vec<Value> = (0..=7).map(|offset| json!({
        "id": athria_core::date::format_iso_date(athria_core::date::epoch_day(day) - offset),
        "hrv": 50, "restingHR": 50, "readiness": 1
    })).collect();
    records.push(json!({ "id": "2026-10-06", "sleepScore": 85, "readiness": 100 }));
    app.store().upsert_wellness("local-user", &records).unwrap();
    let fetched = app.get_wellness_day(day).unwrap();
    assert_eq!(fetched["record"]["fields"]["readiness"]["value"], 85);
    assert_eq!(fetched["record"]["fields"]["readiness"]["source"], "athria");
    assert!(app.get_wellness_day("2026-10-06").unwrap()["record"]["fields"].get("readiness").is_none());
    let mut list = app.list_wellness_in_window(30, Some("2026-09-28"), Some("2026-10-06")).unwrap();
    assert_eq!(list.iter_mut().find(|record| record["day"] == day).unwrap()["fields"]["readiness"]["value"], 85);
    let sleep = app.get_wellness_day(day).unwrap();
    app.update_wellness(day, &json!({ "confirmed": true, "source": "user",
        "expectedSnapshotHash": sleep["snapshotHash"], "fields": { "sleepScore": 0 }
    })).unwrap();
    assert_eq!(app.get_wellness_day(day).unwrap()["record"]["fields"]["readiness"]["value"], 45);
    let current = app.get_wellness_day(day).unwrap();
    assert!(app.update_wellness(day, &json!({ "confirmed": true, "source": "user",
        "expectedSnapshotHash": current["snapshotHash"], "fields": { "readiness": 100 }
    })).is_err());
    // Removing one cardiac baseline falls back to the remaining heart-rate signal.
    let baseline = app.get_wellness_day("2026-09-28").unwrap();
    app.update_wellness("2026-09-28", &json!({ "confirmed": true, "source": "user",
        "expectedSnapshotHash": baseline["snapshotHash"], "fields": { "hrvRmssdMs": null }
    })).unwrap();
    assert_eq!(app.get_wellness_day(day).unwrap()["record"]["fields"]["readiness"]["value"], 45);
    app.store().upsert_wellness("local-user", &[json!({ "id": "2026-09-28", "hrv": 50 })]).unwrap();
    assert_eq!(app.get_wellness_day(day).unwrap()["record"]["fields"]["readiness"]["value"], 45);
    let current = app.get_wellness_day(day).unwrap();
    let saved = app.update_wellness(day, &json!({ "confirmed": true, "source": "user",
        "expectedSnapshotHash": current["snapshotHash"], "fields": { "restingHeartRateBpm": null, "hrvRmssdMs": null }
    })).unwrap();
    assert!(saved["fields"].get("readiness").is_none());
}

#[test]
fn wellness_load_import_and_updates_keep_form_derived() {
    let app = test_app();
    let day = "2026-10-14";
    for (atl, ctl, form) in [(60.5, 40.25, -20.25), (10.25, 40.5, 30.25), (0.0, 0.0, 0.0)] {
        app.store().upsert_wellness("local-user", &[json!({
            "id": day, "atl": atl, "ctl": ctl, "form": 999, "sleepScore": 3,
        })]).unwrap();
        let record = app.store().get_wellness("local-user", day).unwrap().unwrap();
        assert_eq!(record["fields"]["atl"]["value"].as_f64(), Some(atl));
        assert_eq!(record["fields"]["ctl"]["value"].as_f64(), Some(ctl));
        assert_eq!(record["fields"]["form"]["value"], json!(form));
        assert_eq!(record["fields"]["form"]["source"], "intervals_icu");
        assert_eq!(app.store().get_wellness("local-user", "2026-10-13").unwrap().unwrap()["fields"]["sleepScore"]["value"], 3);
    }
    app.store().upsert_wellness("local-user", &[json!({ "id": day, "atl": null, "ctl": -10 })]).unwrap();
    let record = app.store().get_wellness("local-user", day).unwrap().unwrap();
    assert_eq!(record["fields"]["form"]["value"], 0.0);
    let current = app.get_wellness_day(day).unwrap();
    assert_eq!(current["record"]["fields"]["form"]["value"], 0.0);
    let saved = app.update_wellness(day, &json!({ "confirmed": true, "source": "user",
        "expectedSnapshotHash": current["snapshotHash"], "fields": { "ctl": 7.5, "form": 100 }
    })).unwrap();
    assert_eq!(saved["fields"]["form"]["value"], 7.5);
    let current = app.get_wellness_day(day).unwrap();
    let saved = app.update_wellness(day, &json!({ "confirmed": true, "source": "user",
        "expectedSnapshotHash": current["snapshotHash"], "fields": { "atl": null }
    })).unwrap();
    assert!(saved["fields"].get("form").is_none());
    assert!(app.store().get_wellness("local-user", day).unwrap().unwrap()["fields"].get("form").is_none());
    app.store().save_wellness(&json!({ "ownerId": "local-user", "day": day, "updatedAt": NOW,
        "fields": { "form": { "value": 99, "source": "user", "updatedAt": NOW } }
    })).unwrap();
    assert!(app.store().get_wellness("local-user", day).unwrap().unwrap()["fields"].get("form").is_none());
    app.store().upsert_wellness("local-user", &[json!({ "id": "2026-10-13", "ctl": "12.5" })]).unwrap();
    assert!(app.store().get_wellness("local-user", "2026-10-13").unwrap().unwrap()["fields"].get("form").is_none());
}

#[test]
fn manual_sleep_entries_survive_sync_until_cleared_and_use_snapshot_conflict_checks() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sleep.sqlite3");
    let clock = Arc::new(FixedClock::new(NOW));
    let store = SqliteStore::open_with_clock(&path, clock.clone()).unwrap();
    let app = AthriaApplication::with_clock(store, "local-user", clock.clone());
    let day = "2026-09-17";
    let initial = app.get_wellness_day(day).unwrap();
    let saved = app.update_wellness(day, &json!({ "confirmed": true, "source": "user", "expectedSnapshotHash": initial["snapshotHash"], "fields": { "sleepScore": 60, "sleepSeconds": 25200, "subjectiveFatigue": 70 } })).unwrap();
    assert_eq!(saved["fields"]["sleepScore"]["source"], "user");
    assert_eq!(saved["fields"]["sleepSeconds"]["source"], "user");
    assert_eq!(saved["fields"]["subjectiveFatigue"], json!({ "value": 70, "source": "user", "updatedAt": NOW }));
    // Manual entries win over sync; every other source field still imports.
    app.store().upsert_wellness("local-user", &[json!({ "id": "2026-09-18", "sleepScore": 90, "sleepSecs": 28800, "restingHR": 50 })]).unwrap();
    app.store().upsert_wellness("local-user", &[json!({ "id": "2026-09-17", "fatigue": 1 })]).unwrap();
    let stale = app.update_wellness(day, &json!({ "confirmed": true, "source": "user", "expectedSnapshotHash": initial["snapshotHash"], "fields": { "sleepScore": 80 } })).unwrap_err();
    assert_eq!(stale.code(), AthriaErrorCode::InputSnapshotChanged);
    let after_sync = app.get_wellness_day(day).unwrap();
    assert_eq!(after_sync["record"]["fields"]["sleepScore"], json!({ "value": 60, "source": "user", "updatedAt": NOW }));
    assert_eq!(after_sync["record"]["fields"]["sleepSeconds"], json!({ "value": 25200, "source": "user", "updatedAt": NOW }));
    assert_eq!(after_sync["record"]["fields"]["subjectiveFatigue"], json!({ "value": 70, "source": "user", "updatedAt": NOW }));
    assert_eq!(app.get_wellness_day("2026-09-18").unwrap()["record"]["fields"]["restingHeartRateBpm"]["value"], 50);
    drop(app);
    let store = SqliteStore::open_with_clock(&path, clock.clone()).unwrap();
    let app = AthriaApplication::with_clock(store, "local-user", clock);
    assert_eq!(app.get_wellness_day(day).unwrap(), after_sync);
    // Clearing the manual fields hands the day back to the source, which refills on a later sync.
    let cleared = app.update_wellness(day, &json!({ "confirmed": true, "source": "user", "expectedSnapshotHash": after_sync["snapshotHash"], "fields": { "sleepScore": null, "sleepSeconds": null, "subjectiveFatigue": null } })).unwrap();
    assert!(cleared["fields"].get("sleepScore").is_none());
    assert!(cleared["fields"].get("sleepSeconds").is_none());
    assert!(cleared["fields"].get("subjectiveFatigue").is_none());
    app.store().upsert_wellness("local-user", &[json!({ "id": "2026-09-18", "sleepScore": 90, "sleepSecs": 28800 })]).unwrap();
    app.store().upsert_wellness("local-user", &[json!({ "id": "2026-09-17", "fatigue": 1 })]).unwrap();
    let refilled = app.get_wellness_day(day).unwrap();
    assert_eq!(refilled["record"]["fields"]["sleepScore"], json!({ "value": 90, "source": "intervals_icu", "updatedAt": NOW }));
    assert_eq!(refilled["record"]["fields"]["sleepSeconds"], json!({ "value": 28800, "source": "intervals_icu", "updatedAt": NOW }));
    assert_eq!(refilled["record"]["fields"]["subjectiveFatigue"], json!({ "value": 25, "source": "intervals_icu", "updatedAt": NOW }));
}

#[test]
fn profile_writes_reject_old_session_minutes_without_changing_profile() {
    let app=test_app();
    let before=app.profile_hash().unwrap();
    assert!(app.save_profile(&json!({"maxSessionMinutes":90})).is_err());
    for patch in [json!({"maxSessionMinutes":75}),json!({"usualSessionMinutes":75,"maxSessionMinutes":120})] {
        assert!(app.update_profile(&json!({"patch":patch,"expectedProfileHash":before})).is_err());
        assert_eq!(app.profile_hash().unwrap(),before);
    }
}

#[test]
fn training_memory_is_bounded_and_invalidates_plan_inputs_only_when_changed() {
    let app = test_app();
    let initial = app.snapshot_hash().unwrap();
    assert_eq!(app.get_training_memory().unwrap()["revision"], 0);
    let first = app.update_training_memory(&json!({
        "contentMarkdown": "自述：有半年规律训练经验。", "expectedRevision": 0
    })).unwrap();
    assert_eq!(first["revision"], 1);
    let after = app.snapshot_hash().unwrap();
    assert_ne!(after, initial);
    assert_eq!(app.get_training_state().unwrap()["inputSnapshotHash"], after);
    assert_eq!(app.update_training_memory(&json!({
        "contentMarkdown": "自述：有半年规律训练经验。", "expectedRevision": 1
    })).unwrap()["revision"], 1);
    assert_eq!(app.snapshot_hash().unwrap(), after);
    assert_eq!(app.update_training_memory(&json!({
        "contentMarkdown": "旧内容", "expectedRevision": 0
    })).unwrap_err().code(), AthriaErrorCode::RevisionConflict);
    assert_eq!(app.update_training_memory(&json!({
        "contentMarkdown": "长".repeat(2001), "expectedRevision": 1
    })).unwrap_err().code(), AthriaErrorCode::InvalidData);
}

#[test]
fn data_source_status_reports_connection_and_local_day_freshness_without_secrets() {
    let app = test_app();
    let initial = app.get_data_source_status().unwrap();
    assert_eq!(initial["sources"][0]["connected"], false);
    assert_eq!(initial["sources"][0]["lastSuccessAt"], Value::Null);
    assert_eq!(initial["sources"][2]["lastImportAt"], Value::Null);

    let database_uuid = app.store().database_uuid().unwrap();
    let master = new_master_key();
    let envelope = create_envelope(&database_uuid, "password", &master).unwrap();
    let intervals_secret = encrypt_secret(
        &database_uuid,
        "intervals",
        json!({ "athleteId": "42" }),
        "private-api-key",
        &master,
    )
    .unwrap();
    app.store()
        .initialize_vault(&envelope, &[intervals_secret])
        .unwrap();
    let connected_without_sync = app.get_data_source_status().unwrap();
    assert_eq!(connected_without_sync["sources"][0]["connected"], true);
    assert_eq!(connected_without_sync["sources"][0]["syncedToday"], false);
    app.store()
        .save_connection_sync_state(&json!({
            "ownerId": "local-user",
            "source": "intervals",
            "lastAttemptAt": NOW,
            "lastSuccessAt": "2026-09-16T16:30:00.000Z",
            "rangeStart": "2026-09-10",
            "rangeEnd": "2026-09-17",
            "status": "success",
            "data": {},
        }))
        .unwrap();
    app.store()
        .save_connection_sync_state(&json!({
            "ownerId": "local-user",
            "source": "xunji",
            "lastAttemptAt": "2026-09-16T04:00:00.000Z",
            "lastSuccessAt": "2026-09-16T04:00:00.000Z",
            "rangeStart": "2026-09-01",
            "rangeEnd": "2026-09-16",
            "status": "success",
            "data": {},
        }))
        .unwrap();
    let import_data = json!({ "counts": { "sessions": 1 } });
    app.store()
        .record_import_batch(&RecordImportBatchInput {
            owner_id: "local-user",
            source: "hevy",
            content_hash: "hash",
            file_name: "hevy.csv",
            parser_version: "test",
            status: "committed",
            data: &import_data,
        })
        .unwrap();

    let status = app.get_data_source_status().unwrap();
    assert_eq!(status["localDate"], "2026-09-17");
    assert_eq!(status["sources"][0]["source"], "intervals");
    assert_eq!(status["sources"][0]["connected"], true);
    assert_eq!(status["sources"][0]["syncedToday"], true);
    assert_eq!(status["sources"][1]["source"], "xunji");
    assert_eq!(status["sources"][1]["connected"], false);
    assert_eq!(status["sources"][1]["syncedToday"], false);
    assert_eq!(status["sources"][2]["source"], "hevy");
    assert_eq!(status["sources"][2]["importedToday"], true);
    let serialized = serde_json::to_string(&status).unwrap();
    assert!(!serialized.contains("private-api-key"));
    assert!(!serialized.contains("ciphertext"));

    app.store().delete_connection_secret("intervals").unwrap();
    let disconnected = app.get_data_source_status().unwrap();
    assert_eq!(disconnected["sources"][0]["connected"], false);
    assert_eq!(disconnected["sources"][0]["syncedToday"], true);
    assert_eq!(disconnected["sources"][0]["rangeEnd"], "2026-09-17");
}

fn endurance_template(id: &str, name: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "intent": "Build or maintain low-intensity aerobic capacity at a conversational effort.",
        "domain": "endurance",
        "nodes": [{ "role": "steady", "variables": ["duration"] }],
    })
}

fn profile_keys(profile: &Value) -> Vec<&str> {
    profile
        .as_object()
        .expect("profile is an object")
        .keys()
        .map(String::as_str)
        .collect()
}

#[test]
fn fresh_database_returns_the_default_profile() {
    let app = test_app();
    let profile = app.get_profile().unwrap();
    assert_eq!(profile["preferredName"], json!(""));
    assert_eq!(profile["timezone"], json!("Asia/Hong_Kong"));
    assert_eq!(
        app.profile_hash().unwrap(),
        athria_core::stable_hash(&profile)
    );
    assert_eq!(
        profile_keys(&profile),
        [
            "ownerId",
            "preferredName",
            "gender",
            "heightCm",
            "birthDate",
            "timezone",
            "goals",
            "preference",
            "usualSessionMinutes",
            "trainingRhythm",
            "equipment",
            "injuries",
            "constraintNotes",
            "explicitRecoveryDays",
            "unitSystem",
            "mesocycleDurationWeeks",
            "raceDays"
        ]
    );
}

#[test]
fn update_profile_requires_the_current_hash() {
    let app = test_app();
    let stale = app
        .update_profile(&json!({ "patch": { "preferredName": "Wei" }, "expectedProfileHash": "fnv1a-00000000", "confirmed": true }))
        .unwrap_err();
    assert_eq!(stale.code(), AthriaErrorCode::InputSnapshotChanged);
    assert_eq!(stale.status(), 409);

    let updated = app
        .update_profile(&json!({
            "patch": { "preferredName": "  Wei  ", "unitSystem": "imperial", "raceDays": [{ "date": "2026-11-01", "sport": "Marathon" }] },
            "expectedProfileHash": app.profile_hash().unwrap(),
            "confirmed": true,
        }))
        .unwrap();
    assert_eq!(updated["preferredName"], json!("Wei"));
    assert_eq!(updated["unitSystem"], json!("imperial"));
    assert_eq!(
        updated["raceDays"],
        json!([{ "date": "2026-11-01", "sport": "Marathon" }])
    );
    assert_eq!(
        profile_keys(&updated),
        profile_keys(&app.get_profile().unwrap())
    );
}

#[test]
fn complete_profile_save_is_atomic_and_checks_both_snapshots() {
    let app = test_app();
    let original_profile = app.get_profile().unwrap();
    let original_personal = app.get_personal_information().unwrap();
    let mut changed_profile = original_profile.clone();
    changed_profile["preferredName"] = json!("Wei");
    changed_profile["goals"] = json!(["build_strength"]);
    let personal = json!({
        "preferredName": "Wei", "gender": null, "heightCm": null,
        "birthDate": null, "unitSystem": "metric", "weightKg": 72.5,
        "expectedSnapshotHash": original_personal["snapshotHash"]
    });
    let input = json!({
        "profile": changed_profile,
        "personalInformation": personal,
        "expectedProfileHash": app.profile_hash().unwrap()
    });
    let stale_personal = json!({
        "profile": changed_profile,
        "personalInformation": { "preferredName": "Wei", "gender": null, "heightCm": null,
            "birthDate": null, "unitSystem": "metric", "weightKg": 72.5,
            "expectedSnapshotHash": "stale" },
        "expectedProfileHash": app.profile_hash().unwrap()
    });
    assert_eq!(app.save_profile_and_personal_information(&stale_personal).unwrap_err().code(), AthriaErrorCode::InputSnapshotChanged);
    assert_eq!(app.get_profile().unwrap(), original_profile);
    assert_eq!(app.get_personal_information().unwrap()["weightKg"], json!(null));

    let invalid_weight = json!({
        "profile": changed_profile,
        "personalInformation": { "preferredName": "Wei", "gender": null, "heightCm": null,
            "birthDate": null, "unitSystem": "metric", "weightKg": "invalid",
            "expectedSnapshotHash": original_personal["snapshotHash"] },
        "expectedProfileHash": app.profile_hash().unwrap()
    });
    assert!(app.save_profile_and_personal_information(&invalid_weight).is_err());
    assert_eq!(app.get_profile().unwrap(), original_profile);

    let saved = app.save_profile_and_personal_information(&input).unwrap();
    assert_eq!(saved["preferredName"], json!("Wei"));
    assert_eq!(saved["goals"], json!(["build_strength"]));
    assert_eq!(app.get_personal_information().unwrap()["weightKg"], json!(72.5));
    assert_eq!(app.save_profile_and_personal_information(&input).unwrap_err().code(), AthriaErrorCode::InputSnapshotChanged);
}

#[test]
fn personal_information_tracks_the_latest_weight_and_todays_wellness() {
    let app = test_app();
    let initial = app.get_personal_information().unwrap();
    assert_eq!(initial["weightKg"], json!(null));
    assert_eq!(initial["weightDate"], json!(null));
    assert_eq!(
        initial
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "preferredName",
            "gender",
            "heightCm",
            "birthDate",
            "unitSystem",
            "weightKg",
            "weightDate",
            "snapshotHash"
        ]
    );

    let saved = app
        .save_personal_information(&json!({
            "preferredName": "Wei",
            "gender": "male",
            "heightCm": 180,
            "birthDate": "1994-02-01",
            "weightKg": 72.5,
            "expectedSnapshotHash": initial["snapshotHash"],
        }))
        .unwrap();
    assert_eq!(saved["preferredName"], json!("Wei"));
    assert_eq!(saved["weightKg"], json!(72.5));
    assert_eq!(saved["weightDate"], json!("2026-09-17"));
    let record = app
        .store()
        .get_wellness("local-user", "2026-09-17")
        .unwrap()
        .expect("today's wellness row was written");
    assert_eq!(
        record["fields"]["weightKg"],
        json!({ "value": 72.5, "source": "user", "updatedAt": NOW })
    );
    assert_eq!(record["updatedAt"], json!(NOW));

    let cleared = app
        .save_personal_information(&json!({
            "preferredName": "Wei",
            "gender": "male",
            "heightCm": 180,
            "birthDate": "1994-02-01",
            "weightKg": null,
            "expectedSnapshotHash": saved["snapshotHash"],
        }))
        .unwrap();
    assert_eq!(cleared["weightKg"], json!(null));
    assert_eq!(cleared["weightDate"], json!(null));
    assert_eq!(
        app.store()
            .get_wellness("local-user", "2026-09-17")
            .unwrap()
            .unwrap()["fields"],
        json!({})
    );

    let stale = app
        .save_personal_information(&json!({ "preferredName": "Wei", "gender": null, "heightCm": null, "birthDate": null, "expectedSnapshotHash": "fnv1a-00000000" }))
        .unwrap_err();
    assert_eq!(stale.code(), AthriaErrorCode::InputSnapshotChanged);
    assert_eq!(stale.status(), 409);
}

#[test]
fn personal_information_can_save_and_read_an_empty_preferred_name() {
    let app = test_app();
    let initial = app.get_personal_information().unwrap();
    let saved = app.save_personal_information(&json!({
        "preferredName": "",
        "gender": null,
        "heightCm": null,
        "birthDate": null,
        "expectedSnapshotHash": initial["snapshotHash"],
    })).unwrap();
    assert_eq!(saved["preferredName"], json!(""));
    assert_eq!(app.get_profile().unwrap()["preferredName"], json!(""));
}

#[test]
fn personal_information_keeps_an_existing_weight_field_of_another_source() {
    let app = test_app();
    let record = athria_core::schema::parse_wellness_record(&json!({
        "ownerId": "local-user",
        "day": "2026-09-17",
        "fields": { "restingHeartRateBpm": { "value": 48, "source": "intervals_icu", "updatedAt": NOW } },
        "updatedAt": NOW,
    }))
    .unwrap();
    app.store().save_wellness(&record).unwrap();

    let current = app.get_personal_information().unwrap();
    let saved = app
        .save_personal_information(&json!({
            "preferredName": "Athlete",
            "gender": null,
            "heightCm": null,
            "birthDate": null,
            "weightKg": 80,
            "expectedSnapshotHash": current["snapshotHash"],
        }))
        .unwrap();
    assert_eq!(saved["weightKg"], json!(80));
    // The parsed fields keep the schema field order when the new weight joins them.
    assert_eq!(
        app.store()
            .get_wellness("local-user", "2026-09-17")
            .unwrap()
            .unwrap()["fields"],
        json!({
            "restingHeartRateBpm": { "value": 48, "source": "intervals_icu", "updatedAt": NOW },
            "weightKg": { "value": 80, "source": "user", "updatedAt": NOW },
        })
    );
}

#[test]
fn template_library_merges_builtins_with_user_rows() {
    let app = test_app();
    let builtins = app.list_templates().unwrap();
    assert_eq!(builtins.len(), 8);
    assert_eq!(builtins[0]["id"], json!("builtin.easy-run"));
    assert_eq!(builtins[0]["origin"], json!("builtin"));
    assert_eq!(builtins[0]["catalogVersion"], json!("2.0"));

    // A create payload with a built-in ID is the derived replacement for it.
    app.create_template(&json!({
        "id": "builtin.easy-run",
        "name": "My Easy Run",
        "intent": "Build or maintain low-intensity aerobic capacity at a conversational effort.",
        "domain": "endurance",
        "nodes": [{ "role": "steady", "variables": ["duration"] }],
        "clientRequestId": "request-1",
    }))
    .unwrap();
    let merged = app.list_templates().unwrap();
    assert_eq!(merged.len(), 8);
    assert_eq!(merged[0]["name"], json!("My Easy Run"));
    assert_eq!(merged[0]["origin"], json!("user"));
    assert_eq!(merged[0]["revision"], json!(1));

    // Deleting the derived replacement keeps the built-in hidden.
    assert_eq!(
        app.delete_template("builtin.easy-run", Some(1)).unwrap(),
        json!({ "deleted": true, "id": "builtin.easy-run" })
    );
    let after_delete = app.list_templates().unwrap();
    assert_eq!(after_delete.len(), 7);
    assert!(
        after_delete
            .iter()
            .all(|template| template["id"] != json!("builtin.easy-run"))
    );

    // A user template that does not shadow a built-in is appended.
    app.create_template(&endurance_template("user.tempo", "Tempo Run"))
        .unwrap();
    let with_user = app.list_templates().unwrap();
    assert_eq!(with_user.len(), 8);
    assert_eq!(with_user[7]["id"], json!("user.tempo"));
}

#[test]
fn deleting_a_builtin_without_a_derived_row_only_dismisses_it() {
    let app = test_app();
    assert_eq!(
        app.delete_template("builtin.mobility-reset", None).unwrap(),
        json!({ "deleted": true, "id": "builtin.mobility-reset" })
    );
    assert_eq!(app.store().list_templates("local-user").unwrap().len(), 0);
    assert_eq!(
        app.store()
            .list_dismissed_template_ids("local-user")
            .unwrap(),
        ["builtin.mobility-reset"]
    );
    // The code-defined original still resolves by id.
    assert_eq!(
        app.get_template("builtin.mobility-reset").unwrap()["origin"],
        json!("builtin")
    );
}

#[test]
fn stored_templates_follow_the_revision_rules() {
    let app = test_app();
    let created = app
        .store()
        .create_template(&endurance_template("user.tempo", "Tempo Run"), "local-user")
        .unwrap();
    assert_eq!(created["revision"], json!(1));
    // The same create through the application maps the duplicate to a 409.
    let duplicate = app
        .create_template(&endurance_template("user.tempo", "Tempo Run"))
        .unwrap_err();
    assert_eq!(duplicate.code(), AthriaErrorCode::TemplateAlreadyExists);
    assert_eq!(duplicate.status(), 409);

    let conflict = app
        .update_template(&json!({ "template": endurance_template("user.tempo", "Renamed"), "expectedRevision": 5 }))
        .unwrap_err();
    assert_eq!(conflict.code(), AthriaErrorCode::RevisionConflict);
    assert_eq!(conflict.status(), 409);

    let updated = app.update_template(&json!({ "template": endurance_template("user.tempo", "Renamed"), "expectedRevision": 1 })).unwrap();
    assert_eq!(updated["template"]["name"], json!("Renamed"));
    assert_eq!(updated["template"]["revision"], json!(2));
    assert_eq!(
        updated["impact"],
        json!({ "affectedCount": 0, "updatedCount": 0 })
    );

    let missing = app.update_template(&json!({ "template": endurance_template("user.absent", "Absent"), "expectedRevision": 1 })).unwrap_err();
    assert_eq!(missing.code(), AthriaErrorCode::TemplateNotFound);
    assert_eq!(missing.status(), 404);

    assert_eq!(
        app.delete_template("user.tempo", Some(2)).unwrap(),
        json!({ "deleted": true, "id": "user.tempo" })
    );
    let removed = app.delete_template("user.tempo", Some(2)).unwrap_err();
    assert_eq!(removed.code(), AthriaErrorCode::TemplateNotFound);
    assert_eq!(removed.status(), 404);
}

#[test]
fn get_template_falls_back_to_the_builtin_catalog() {
    let app = test_app();
    let template = app.get_template("builtin.lower-strength-a").unwrap();
    assert_eq!(template["origin"], json!("builtin"));
    assert_eq!(template["nodes"][0]["movementPatternIds"], json!(["squat"]));

    let missing = app.get_template("builtin.absent").unwrap_err();
    assert_eq!(missing.code(), AthriaErrorCode::TemplateNotFound);
    assert_eq!(missing.message(), "The session template was not found.");
    assert_eq!(missing.status(), 404);
}

/// The single-session mesocycle behind the plan-match tests, owned by the test
/// user so `save_current_plan` stores it under the application's owner.
fn plan_with_run() -> Value {
    json!({
        "ownerId": "local-user", "revision": 1, "updatedAt": "2026-09-01T04:00:00.000Z",
        "mesocycle": {
            "durationWeeks": 1,
            "schedule": { "kind": "fixed_week", "days": [3, 6] },
            "domainProgressions": [{
                "domain": "endurance",
                "phases": [{ "id": "phase-1", "phaseType": "foundation", "name": "Base", "startWeek": 1, "endWeek": 1, "focus": "Aerobic base", "progression": [] }],
            }],
            "weeks": [{
                "weekNumber": 1, "focus": null,
                "sessions": [{
                    "id": "s1", "scheduledDate": "2026-09-10", "order": 0, "status": "planned", "templateRef": null,
                    "type": "Run", "subtype": null, "domain": "endurance", "name": "Easy Run", "intent": "Aerobic base", "durationMinutes": 60, "recoveryDemand": "low", "keySession": false,
                    "prescription": {"blocks":[]},
                    "progressionNote": null, "schedulingRationale": null, }],
            }],
        },
    })
}

/// The stored shape of an imported (non-manual) observation.
fn imported_session(
    source: &str,
    external_id: &str,
    id: &str,
    start_at: &str,
    end_at: &str,
    minutes: i64,
    name: &str,
) -> Value {
    json!({
        "id": id, "ownerId": "local-user", "source": source, "externalId": external_id, "type": "Run",
        "domains": ["endurance"], "type": "Run", "name": name, "startAt": start_at, "endAt": end_at,
        "durationMinutes": minutes, "status": "completed", "timezone": "Asia/Hong_Kong", "plannedSessionId": null,
        "timePrecision": "exact", "sources": [], "planMatch": null, "isPlanMatchExcluded": false,
        "strengthSets": [], "endurance": null, "missingFields": [],
    })
}

/// Records a manual session and returns its generated canonical id.
fn record(app: &AthriaApplication<SqliteStore>, body: Value) -> String {
    let recorded = app
        .record_training_session(&body)
        .expect("the manual session is recorded");
    recorded["id"]
        .as_str()
        .expect("recorded sessions carry an id")
        .to_string()
}

fn listed<'a>(sessions: &'a [Value], id: &str) -> &'a Value {
    sessions
        .iter()
        .find(|session| session["id"].as_str() == Some(id))
        .expect("session is listed")
}

#[test]
fn recorded_sessions_are_stored_as_completed_manual_observations() {
    let app = test_app();
    let recorded = app
        .record_training_session(&json!({
            "type": "StrengthTraining",
            "name": "Lower Strength",
            "startAt": "2026-09-16T09:00:00.000Z",
            "endAt": "2026-09-16T10:00:00.000Z",
            "durationMinutes": 60,
            "rpe": 3,
            "strengthSets": [{ "exerciseRaw": "Back Squat", "setIndex": 0, "weight": 100, "weightUnit": "kg", "reps": 5 }],
        }))
        .unwrap();
    assert_eq!(recorded["rpe"], json!(3));
    assert_eq!(recorded["sessionRpe"], json!(180));
    let rejected = app.record_training_session(&json!({
        "type": "Run", "name": "Rejected load", "startAt": "2026-09-16T09:00:00Z",
        "endAt": "2026-09-16T10:00:00Z", "durationMinutes": 60, "rpe": 3, "sessionRpe": 999
    })).unwrap_err();
    assert_eq!(rejected.code(), AthriaErrorCode::InvalidData);
    for field in athria_core::schema::session::API_SESSION_METRICS {
        let mut input = json!({"type":"Run","name":"API-only metric","startAt":"2026-09-16T09:00:00Z","durationMinutes":60});
        input[field] = json!(10);
        assert_eq!(app.record_training_session(&input).unwrap_err().code(), AthriaErrorCode::InvalidData);
    }
    let id = recorded["id"].as_str().expect("a generated id");
    assert_eq!(recorded["ownerId"], json!("local-user"));
    assert_eq!(recorded["sources"][0]["source"], json!("manual"));
    assert!(recorded.get("source").is_none());
    assert_eq!(recorded["status"], json!("completed"));
    assert_eq!(recorded["sources"][0]["externalId"], json!(id));
    assert!(recorded.get("externalId").is_none());
    assert_eq!(recorded["domains"], json!(["strength"]));
    assert_eq!(recorded["strengthSets"][0]["setType"], json!("normal"));
    // The response is the parsed schema document in declaration order.
    assert_eq!(
        recorded
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "id",
            "ownerId",
            "type",
            "subtype",
            "domains",
            "name",
            "startAt",

            "durationMinutes",
            "rpe",
            "sessionRpe",
                "trainingLoad",
                "powerLoad",
                "hrLoad",
                "paceLoad",
                "intensity",
            "status",
            "timezone",
            "plannedSessionId",
            "timePrecision",
            "sources",
            "planMatch",
            "isPlanMatchExcluded",
            "strengthSets",
            "endurance"
        ]
    );

    // `listSessions` derives the domain from the strength sets.
    let sessions = app.list_sessions(90).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["id"], json!(id));
    assert_eq!(sessions[0]["domains"], json!(["strength"]));
    assert!(sessions[0].get("missingFields").is_none());

    // Explicit ids survive the manual write path.
    let explicit = app
        .record_training_session(&json!({
            "id": "manual-1", "externalId": "manual-external-1",
            "type": "StrengthTraining", "name": "Upper Strength",
            "startAt": "2026-09-15T09:00:00.000Z", "endAt": "2026-09-15T10:00:00.000Z", "durationMinutes": 60,
            "strengthSets": [{ "exerciseRaw": "Bench Press", "setIndex": 0, "weight": 60, "weightUnit": "kg", "reps": 8 }],
        }))
        .unwrap();
    assert_eq!(explicit["id"], json!("manual-1"));
    assert_eq!(explicit["sources"][0]["externalId"], json!("manual-external-1"));
}

#[test]
fn stale_session_edit_is_rejected_after_another_connection_updates_the_workout() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("shared.sqlite3");
    let first = AthriaApplication::new(SqliteStore::open(&path).unwrap());
    let second = AthriaApplication::new(SqliteStore::open(&path).unwrap());
    second.record_training_session(&json!({
        "id": "manual-shared", "name": "Easy Run", "type": "Run", "domains": ["endurance"],
        "type": "Run", "startAt": "2026-09-16T09:00:00.000Z", "endAt": "2026-09-16T10:00:00.000Z",
        "durationMinutes": 60, "timezone": "Asia/Hong_Kong", "timePrecision": "exact",
    })).unwrap();
    let snapshot = first.list_sessions_with_snapshots(365).unwrap().remove(0);
    second.update_manual_training_session("manual-shared", &json!({
        "confirmed": true, "durationMinutes": 45, "expectedSnapshotHash": snapshot["snapshotHash"],
    })).unwrap();

    let error = first.update_manual_training_session("manual-shared", &json!({
        "confirmed": true, "durationMinutes": 30, "expectedSnapshotHash": snapshot["snapshotHash"],
    })).unwrap_err();
    assert_eq!(error.code(), AthriaErrorCode::InputSnapshotChanged);
    assert_eq!(first.list_sessions(365).unwrap()[0]["durationMinutes"], 45);
}

#[test]
fn list_sessions_uses_type_domains_without_metric_inference() {
    let app = test_app();
    // A known type classifies even when no metric details are present.
    let bare_id = record(
        &app,
        json!({
            "type": "Run", "name": "Bare Run",
            "startAt": "2026-09-14T10:00:00.000Z", "endAt": "2026-09-14T10:30:00.000Z", "durationMinutes": 30,
        }),
    );
    // Metrics do not alter the classification.
    let detailed_id = record(
        &app,
        json!({
            "type": "Run", "name": "Easy Run",
            "startAt": "2026-09-16T10:00:00.000Z", "endAt": "2026-09-16T10:30:00.000Z", "durationMinutes": 30,
            "endurance": { "distanceMeters": 5000 },
        }),
    );

    let sessions = app.list_sessions(90).unwrap();
    let bare = listed(&sessions, &bare_id);
    assert_eq!(bare["domains"], json!(["endurance"]));
    assert!(bare.get("missingFields").is_none());
    let detailed = listed(&sessions, &detailed_id);
    assert_eq!(detailed["domains"], json!(["endurance"]));
    assert!(detailed.get("missingFields").is_none());

    // The classification is also stored, not synthesized while reading.
    let stored = app.store().list_sessions("local-user", None).unwrap();
    assert_eq!(listed(&stored, &detailed_id)["domains"], json!(["endurance"]));
}

#[test]
fn training_state_reports_the_snapshot_hash_and_the_current_metrics() {
    let app = test_app();
    let state = app.get_training_state().unwrap();
    assert_eq!(
        state
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "asOf",
            "inputSnapshotHash",
            "personalInformation",
            "metrics",
            "wellness",
            "dataGaps"
        ]
    );
    assert_eq!(state["asOf"], json!(NOW));
    assert_eq!(state["dataGaps"], json!([]));
    assert_eq!(
        state["inputSnapshotHash"],
        json!(app.snapshot_hash().unwrap())
    );
    assert_eq!(
        state["personalInformation"],
        json!(app.get_personal_information().unwrap())
    );
    assert_eq!(
        state["metrics"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["strength", "endurance"]
    );

    let before = app.snapshot_hash().unwrap();
    assert_eq!(before, app.snapshot_hash().unwrap());
    record(
        &app,
        json!({
            "type": "StrengthTraining", "name": "Lower Strength",
            "startAt": "2026-09-16T09:00:00.000Z", "endAt": "2026-09-16T10:00:00.000Z", "durationMinutes": 60,
            "strengthSets": [{ "exerciseRaw": "Back Squat", "setIndex": 0, "weight": 100, "weightUnit": "kg", "reps": 5 }],
        }),
    );
    assert_ne!(before, app.snapshot_hash().unwrap());
}

#[test]
fn compact_training_state_keeps_wellness_and_memory_in_its_freshness_hash() {
    let app = test_app();
    let compact = app.get_training_state_with_view(true).unwrap();
    assert!(compact.get("wellness").is_none());
    assert!(compact.get("personalInformation").is_none());
    assert_eq!(compact["inputSnapshotHash"], app.get_training_state().unwrap()["inputSnapshotHash"]);

    app.store().upsert_wellness("local-user", &[json!({"id":"2026-09-16", "restingHR":52})]).unwrap();
    let after_wellness = app.get_training_state_with_view(true).unwrap();
    assert_ne!(compact["inputSnapshotHash"], after_wellness["inputSnapshotHash"]);
    assert_eq!(after_wellness["inputSnapshotHash"], app.get_training_state().unwrap()["inputSnapshotHash"]);

    app.update_training_memory(&json!({"expectedRevision":0,"contentMarkdown":"Comfortable with regular short runs."})).unwrap();
    let after_memory = app.get_training_state_with_view(true).unwrap();
    assert_ne!(after_wellness["inputSnapshotHash"], after_memory["inputSnapshotHash"]);
    assert_eq!(after_memory["inputSnapshotHash"], app.snapshot_hash().unwrap());
}

#[test]
fn training_summary_groups_domains_and_sports() {
    let app = test_app();
    record(
        &app,
        json!({
            "type": "StrengthTraining", "domains": ["strength"], "name": "Lower Strength",
            "startAt": "2026-09-16T09:00:00.000Z", "endAt": "2026-09-16T10:00:00.000Z", "durationMinutes": 60,
            "strengthSets": [{ "exerciseRaw": "Back Squat", "setIndex": 0, "weight": 100, "weightUnit": "kg", "reps": 5 }],
        }),
    );
    record(
        &app,
        json!({
            "domains": ["endurance"], "type": "Run", "name": "Easy Run",
            "startAt": "2026-09-15T10:00:00.000Z", "endAt": "2026-09-15T10:30:00.000Z", "durationMinutes": 30,
        }),
    );
    record(
        &app,
        json!({
             "domains": ["sport_skill"], "type": "Basketball", "name": "Basketball",
            "startAt": "2026-09-15T12:00:00.000Z", "endAt": "2026-09-15T13:30:00.000Z", "durationMinutes": 90,
        }),
    );
    record(
        &app,
        json!({
             "domains": ["sport_skill"], "type": " Basketball ", "name": "Basketball",
            "startAt": "2026-09-16T12:00:00.000Z", "endAt": "2026-09-16T12:30:00.000Z", "durationMinutes": 30,
        }),
    );
    record(
        &app,
        json!({
             "domains": ["sport_skill"], "type": "Tennis", "name": "Tennis",
            "startAt": "2026-09-14T12:00:00.000Z", "endAt": "2026-09-14T12:45:00.000Z", "durationMinutes": 45,
        }),
    );

    let summary = app.get_training_summary(7, None, None).unwrap();
    assert_eq!(
        summary
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "periodDays",
            "sessionCount",
            "totalDurationMinutes",
            "byDomain",
            "durationMinutesByDomain",
            "sports",
            "metrics"
        ]
    );
    assert_eq!(summary["periodDays"], json!(7));
    assert_eq!(summary["sessionCount"], json!(5));
    assert_eq!(summary["totalDurationMinutes"], json!(255));
    assert_eq!(
        summary["byDomain"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "strength",
            "endurance",
            "sport_skill",
            "mind_body",
            "mobility",
            "functional"
        ]
    );
    assert_eq!(
        summary["byDomain"],
        json!({ "strength": 1, "endurance": 1, "sport_skill": 3, "mind_body": 0, "mobility": 0, "functional": 0 })
    );
    assert_eq!(
        summary["durationMinutesByDomain"],
        json!({ "strength": 60, "endurance": 30, "sport_skill": 165, "mind_body": 0, "mobility": 0, "functional": 0 })
    );
    assert_eq!(
        summary["sports"],
        json!([
            { "name": "Basketball", "sessionCount": 2, "durationMinutes": 120 },
            { "name": "Tennis", "sessionCount": 1, "durationMinutes": 45 },
        ])
    );

    // A single-day window keeps only that day's sessions.
    let window = app
        .get_training_summary(7, Some("2026-09-15"), Some("2026-09-15"))
        .unwrap();
    assert_eq!(window["sessionCount"], json!(2));
    assert_eq!(window["totalDurationMinutes"], json!(120));
    assert_eq!(
        window["byDomain"],
        json!({ "strength": 0, "endurance": 1, "sport_skill": 1, "mind_body": 0, "mobility": 0, "functional": 0 })
    );

    // Inverted and malformed windows fail before any store read.
    let inverted = app
        .get_training_summary(7, Some("2026-09-16"), Some("2026-09-15"))
        .unwrap_err();
    assert_eq!(inverted.code(), AthriaErrorCode::InvalidSummaryWindow);
    assert_eq!(
        inverted.message(),
        "The summary start date must not be after the end date."
    );
    assert_eq!(inverted.status(), 400);
    let malformed = app
        .get_training_summary(7, Some("09/15/2026"), None)
        .unwrap_err();
    assert_eq!(malformed.code(), AthriaErrorCode::InvalidData);
}

#[test]
fn plan_matches_can_be_linked_excluded_and_restored() {
    let app = test_app();
    app.store().save_current_plan(&plan_with_run(), 0).unwrap();
    let id = record(
        &app,
        json!({
            "domains": ["endurance"], "type": "Run", "name": "Easy Run",
            "startAt": "2026-09-10T10:00:00.000Z", "endAt": "2026-09-10T11:00:00.000Z", "durationMinutes": 60,
        }),
    );

    // Automatic matching links the recorded run to the planned session.
    let sessions = app.list_sessions(90).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["plannedSessionId"], json!("s1"));
    assert_eq!(
        sessions[0]["planMatch"],
        json!({ "plannedSessionId": "s1", "method": "auto" })
    );

    // An explicit link switches the match to manual.
    let linked = app
        .set_training_session_plan_match(
            &id,
            &json!({ "plannedSessionId": "s1", "expectedRevision": 1, "confirmed": true }),
        )
        .unwrap();
    assert_eq!(
        linked["planMatch"],
        json!({ "plannedSessionId": "s1", "method": "manual" })
    );

    // Excluding the workout keeps it out of automatic matching.
    let excluded = app
        .set_training_session_plan_match(
            &id,
            &json!({ "plannedSessionId": null, "expectedRevision": 1, "confirmed": true }),
        )
        .unwrap();
    assert_eq!(excluded["isPlanMatchExcluded"], json!(true));
    assert_eq!(excluded["plannedSessionId"], Value::Null);
    assert_eq!(excluded["planMatch"], Value::Null);
    assert_eq!(
        app.list_sessions(90).unwrap()[0]["isPlanMatchExcluded"],
        json!(true)
    );

    // Clearing the exclusion lets deterministic matching run again.
    let restored = app
        .clear_training_session_plan_exclusion(&id, &json!({ "confirmed": true }))
        .unwrap();
    assert_eq!(restored["isPlanMatchExcluded"], json!(false));
    assert_eq!(
        restored["planMatch"],
        json!({ "plannedSessionId": "s1", "method": "auto" })
    );
}

#[test]
fn plan_match_failures_keep_the_typescript_error_map() {
    let app = test_app();
    let id = record(
        &app,
        json!({
            "domains": ["endurance"], "type": "Run", "name": "Easy Run",
            "startAt": "2026-09-10T10:00:00.000Z", "endAt": "2026-09-10T11:00:00.000Z", "durationMinutes": 60,
        }),
    );

    // Without a stored plan the revision starts at 0 and any link has nowhere to go.
    let no_plan = app
        .set_training_session_plan_match(
            &id,
            &json!({ "plannedSessionId": "s1", "expectedRevision": 0, "confirmed": true }),
        )
        .unwrap_err();
    assert_eq!(no_plan.code(), AthriaErrorCode::NoCurrentPlan);
    assert_eq!(no_plan.message(), "There is no current plan.");
    assert_eq!(no_plan.status(), 409);

    app.store().save_current_plan(&plan_with_run(), 0).unwrap();
    let missing_workout = app
        .set_training_session_plan_match(
            "absent",
            &json!({ "plannedSessionId": "s1", "expectedRevision": 1, "confirmed": true }),
        )
        .unwrap_err();
    assert_eq!(
        missing_workout.code(),
        AthriaErrorCode::TrainingSessionNotFound
    );
    assert_eq!(missing_workout.message(), "The workout was not found.");
    assert_eq!(missing_workout.status(), 404);

    let stale_plan = app
        .set_training_session_plan_match(
            &id,
            &json!({ "plannedSessionId": "s1", "expectedRevision": 5, "confirmed": true }),
        )
        .unwrap_err();
    assert_eq!(
        stale_plan.code(),
        AthriaErrorCode::PlannedSessionRevisionConflict
    );
    assert_eq!(
        stale_plan.message(),
        "The plan changed. Refresh and try again."
    );
    assert_eq!(stale_plan.status(), 409);

    let missing_planned = app
        .set_training_session_plan_match(
            &id,
            &json!({ "plannedSessionId": "absent", "expectedRevision": 1, "confirmed": true }),
        )
        .unwrap_err();
    assert_eq!(
        missing_planned.code(),
        AthriaErrorCode::PlannedSessionNotFound
    );
    assert_eq!(
        missing_planned.message(),
        "The planned session was not found."
    );
    assert_eq!(missing_planned.status(), 404);

    // A run recorded the next day cannot link to the planned session.
    let late = record(
        &app,
        json!({
            "domains": ["endurance"], "type": "Run", "name": "Easy Run",
            "startAt": "2026-09-11T10:00:00.000Z", "endAt": "2026-09-11T11:00:00.000Z", "durationMinutes": 60,
        }),
    );
    let mismatch = app
        .set_training_session_plan_match(
            &late,
            &json!({ "plannedSessionId": "s1", "expectedRevision": 1, "confirmed": true }),
        )
        .unwrap_err();
    assert_eq!(mismatch.code(), AthriaErrorCode::PlanWorkoutDateMismatch);
    assert_eq!(
        mismatch.message(),
        "The workout and planned session must be on the same local date."
    );
    assert_eq!(mismatch.status(), 409);

    // Skipped planned sessions stay out of reach.
    let mut skipped = plan_with_run();
    skipped["revision"] = json!(2);
    skipped["mesocycle"]["weeks"][0]["sessions"][0]["status"] = json!("skipped");
    app.store().save_current_plan(&skipped, 1).unwrap();
    let skipped_link = app
        .set_training_session_plan_match(
            &id,
            &json!({ "plannedSessionId": "s1", "expectedRevision": 2, "confirmed": true }),
        )
        .unwrap_err();
    assert_eq!(skipped_link.code(), AthriaErrorCode::PlannedSessionSkipped);
    assert_eq!(
        skipped_link.message(),
        "Restore the skipped session before linking it."
    );
    assert_eq!(skipped_link.status(), 409);

    // The action schema itself rejects unconfirmed or malformed links.
    let unconfirmed = app
        .set_training_session_plan_match(
            &id,
            &json!({ "plannedSessionId": "s1", "expectedRevision": 2 }),
        )
        .unwrap_err();
    assert_eq!(unconfirmed.code(), AthriaErrorCode::InvalidData);
    let null_revision = app
        .set_training_session_plan_match(
            &id,
            &json!({ "plannedSessionId": "s1", "expectedRevision": -1, "confirmed": true }),
        )
        .unwrap_err();
    assert_eq!(null_revision.code(), AthriaErrorCode::InvalidData);
}

#[test]
fn manual_sessions_can_be_retimed() {
    let app = test_app();
    let id = record(
        &app,
        json!({
            "name": "Tempo Run", "type": "Run",
            "startAt": "2026-09-16T02:00:00.000Z", "endAt": "2026-09-16T03:00:00.000Z", "durationMinutes": 60,
            "timePrecision": "date_only", "missingFields": ["actual start time"],
        }),
    );

    // A retime keeps the duration and records the exact start.
    let retimed = app
        .update_manual_training_session(
            &id,
            &json!({ "startAt": "2026-09-16T02:30:00.000Z", "confirmed": true }),
        )
        .unwrap();
    assert_eq!(retimed["startAt"], json!("2026-09-16T02:30:00.000Z"));
    assert!(retimed.get("endAt").is_none());
    assert_eq!(retimed["timePrecision"], json!("exact"));
    assert!(retimed.get("missingFields").is_none());

    // A duration update moves the end instead.
    let stretched = app
        .update_manual_training_session(&id, &json!({ "durationMinutes": 45, "confirmed": true }))
        .unwrap();
    assert_eq!(stretched["durationMinutes"], json!(45));
    assert!(stretched.get("endAt").is_none());

    // Changing the local day is refused until the plan match moves.
    let moved = app
        .update_manual_training_session(
            &id,
            &json!({ "startAt": "2026-09-17T02:00:00.000Z", "confirmed": true }),
        )
        .unwrap_err();
    assert_eq!(
        moved.code(),
        AthriaErrorCode::ManualDateChangeRequiresPlanMove
    );
    assert_eq!(
        moved.message(),
        "Move or unlink the planned session before changing the workout date."
    );
    assert_eq!(moved.status(), 409);

    // Action-schema violations fail before the store is touched.
    let empty = app
        .update_manual_training_session(&id, &json!({ "confirmed": true }))
        .unwrap_err();
    assert_eq!(empty.code(), AthriaErrorCode::InvalidData);
    assert_eq!(empty.message(), "session: provide a start time or duration");
    let zero = app
        .update_manual_training_session(&id, &json!({ "durationMinutes": 0, "confirmed": true }))
        .unwrap_err();
    assert_eq!(zero.code(), AthriaErrorCode::InvalidData);

    // Imported observations have no manual source to retime.
    app.store()
        .upsert_sessions(&[imported_session(
            "hevy",
            "hevy-run-1",
            "hevy-session",
            "2026-09-14T10:00:00.000Z",
            "2026-09-14T11:00:00.000Z",
            60,
            "Easy Run",
        )])
        .unwrap();
    let missing_source = app
        .update_manual_training_session(
            "hevy-session",
            &json!({ "durationMinutes": 30, "confirmed": true }),
        )
        .unwrap_err();
    assert_eq!(missing_source.code(), AthriaErrorCode::ManualSourceNotFound);
    assert_eq!(
        missing_source.message(),
        "The manual workout details could not be updated."
    );
    assert_eq!(missing_source.status(), 404);

}

#[test]
fn session_deletions_follow_the_manual_and_canonical_rules() {
    let app = test_app();
    let id = record(
        &app,
        json!({
            "type": "Run", "name": "Easy Run",
            "startAt": "2026-09-16T02:00:00.000Z", "endAt": "2026-09-16T03:00:00.000Z", "durationMinutes": 60,
        }),
    );

    let unconfirmed = app.delete_training_session(&id, &json!({})).unwrap_err();
    assert_eq!(unconfirmed.code(), AthriaErrorCode::InvalidData);

    // Removing the manual source of a manual-only workout leaves nothing behind.
    let removed = app
        .delete_manual_training_session(&id, &json!({ "confirmed": true }))
        .unwrap();
    assert_eq!(removed, Value::Null);
    assert!(app.list_sessions(90).unwrap().is_empty());
    let missing = app
        .delete_manual_training_session(&id, &json!({ "confirmed": true }))
        .unwrap_err();
    assert_eq!(missing.code(), AthriaErrorCode::ManualSourceNotFound);
    assert_eq!(
        missing.message(),
        "The manual workout record could not be removed."
    );
    assert_eq!(missing.status(), 404);

    // `deleteTrainingSession` removes the canonical session and every derived row.
    let second = record(
        &app,
        json!({
            "type": "StrengthTraining", "name": "Lower Strength",
            "startAt": "2026-09-15T09:00:00.000Z", "endAt": "2026-09-15T10:00:00.000Z", "durationMinutes": 60,
            "strengthSets": [{ "exerciseRaw": "Back Squat", "setIndex": 0, "weight": 100, "weightUnit": "kg", "reps": 5 }],
        }),
    );
    assert_eq!(
        app.delete_training_session(&second, &json!({ "confirmed": true }))
            .unwrap(),
        json!({ "deleted": true })
    );
    let gone = app
        .delete_training_session(&second, &json!({ "confirmed": true }))
        .unwrap_err();
    assert_eq!(gone.code(), AthriaErrorCode::TrainingSessionNotFound);
    assert_eq!(gone.message(), "The workout was not found.");
    assert_eq!(gone.status(), 404);
}

#[test]
fn wellness_updates_merge_fields_under_the_snapshot_hash_check() {
    let app = test_app();
    let fresh = app.get_wellness_day("2026-09-16").unwrap();
    assert_eq!(fresh, json!({ "snapshotHash": "new" }));

    let updated = app
        .update_wellness(
            "2026-09-16",
            &json!({
                "confirmed": true, "source": "user", "expectedSnapshotHash": "new",
                "fields": { "restingHeartRateBpm": 48, "weightKg": 72.5 },
            }),
        )
        .unwrap();
    assert_eq!(
        updated
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["ownerId", "day", "fields", "updatedAt", "readinessAssessment"]
    );
    assert_eq!(updated["ownerId"], json!("local-user"));
    assert_eq!(updated["day"], json!("2026-09-16"));
    assert_eq!(updated["updatedAt"], json!(NOW));
    assert_eq!(
        updated["fields"]["restingHeartRateBpm"],
        json!({ "value": 48, "source": "user", "updatedAt": NOW })
    );
    assert_eq!(
        updated["fields"]["weightKg"],
        json!({ "value": 72.5, "source": "user", "updatedAt": NOW })
    );

    // The day reads back with the hash of the stored record.
    let day = app.get_wellness_day("2026-09-16").unwrap();
    assert_eq!(
        day.as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["record", "snapshotHash"]
    );
    let record = day["record"].clone();
    assert_eq!(
        day["snapshotHash"],
        json!(athria_core::stable_hash(&record))
    );

    // A stale hash is rejected.
    let stale = app
        .update_wellness("2026-09-16", &json!({ "confirmed": true, "source": "user", "expectedSnapshotHash": "new", "fields": { "weightKg": 70 } }))
        .unwrap_err();
    assert_eq!(stale.code(), AthriaErrorCode::InputSnapshotChanged);
    assert_eq!(
        stale.message(),
        "Wellness changed. Refresh before applying the confirmed update."
    );
    assert_eq!(stale.status(), 409);

    // A null clears one field and keeps the rest.
    let cleared = app
        .update_wellness("2026-09-16", &json!({ "confirmed": true, "source": "user", "expectedSnapshotHash": day["snapshotHash"], "fields": { "weightKg": null } }))
        .unwrap();
    assert_eq!(
        cleared["fields"],
        json!({ "restingHeartRateBpm": { "value": 48, "source": "user", "updatedAt": NOW } })
    );

    // The action schema rejects a malformed day and an unconfirmed patch.
    let bad_day = app.update_wellness("16-09-2026", &json!({ "confirmed": true, "source": "user", "expectedSnapshotHash": "new", "fields": {} })).unwrap_err();
    assert_eq!(bad_day.code(), AthriaErrorCode::InvalidData);
    let unconfirmed = app
        .update_wellness(
            "2026-09-16",
            &json!({ "source": "user", "expectedSnapshotHash": "new", "fields": {} }),
        )
        .unwrap_err();
    assert_eq!(unconfirmed.code(), AthriaErrorCode::InvalidData);
}

#[test]
fn wellness_history_is_windowed_and_hashed_per_record() {
    let app = test_app();
    for (day, bpm) in [("2026-09-16", 48), ("2026-08-01", 50)] {
        app.update_wellness(day, &json!({ "confirmed": true, "source": "user", "expectedSnapshotHash": "new", "fields": { "restingHeartRateBpm": bpm } })).unwrap();
    }

    let recent = app.list_wellness(42).unwrap();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0]["day"], json!("2026-09-16"));
    let record = app
        .store()
        .get_wellness("local-user", "2026-09-16")
        .unwrap()
        .unwrap();
    assert_eq!(
        recent[0]["snapshotHash"],
        json!(athria_core::stable_hash(&record))
    );

    let wide = app.list_wellness(120).unwrap();
    assert_eq!(wide.len(), 2);
    assert_eq!(wide[0]["day"], json!("2026-09-16"));
    assert_eq!(wide[1]["day"], json!("2026-08-01"));
    assert_eq!(
        wide[0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["ownerId", "day", "fields", "updatedAt", "readinessAssessment", "snapshotHash"]
    );
}

#[test]
fn training_taxonomy_exposes_the_versioned_vocabularies() {
    let taxonomy = test_app().get_training_taxonomy();
    assert_eq!(
        taxonomy
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "planSchemaVersion",
            "taxonomyVersion",
            "templateCatalogVersion",
            "domains",
            "activityTypes",
            "equipmentCategories",
            "strength",
            "templateVariables",
            "factSources",
            "aiHardConfidence"
        ]
    );
    assert_eq!(taxonomy["planSchemaVersion"], json!("8.0"));
    assert_eq!(taxonomy["taxonomyVersion"], json!("strength-2.0"));
    assert_eq!(taxonomy["templateCatalogVersion"], json!("2.0"));
    assert_eq!(
        taxonomy["domains"],
        json!([
            "strength",
            "endurance",
            "sport_skill",
            "mind_body",
            "mobility",
            "functional"
        ])
    );
    assert_eq!(
        taxonomy["strength"]["movementPatterns"]
            .as_array()
            .unwrap()
            .len(),
        33
    );
    assert_eq!(
        taxonomy["strength"]["muscleGroups"]
            .as_array()
            .unwrap()
            .len(),
        47
    );
    assert_eq!(
        taxonomy["strength"]["equipment"].as_array().unwrap().len(),
        30
    );
    assert_eq!(
        taxonomy["templateVariables"]["strength"][0],
        json!("exercise_selection")
    );
    assert_eq!(
        taxonomy["templateVariables"]["endurance"],
        json!([
            "repetitions",
            "duration",
            "distance",
            "pace",
            "heart_rate_zone",
            "power",
            "cadence",
            "rpe",
            "talk_test",
            "terrain",
            "strides",
            "recovery_mode"
        ])
    );
    assert_eq!(
        taxonomy["factSources"],
        json!([
            "structured_source",
            "exact_alias",
            "ai_inferred",
            "user_confirmed"
        ])
    );
    assert_eq!(taxonomy["aiHardConfidence"], json!(0.9));
    assert_eq!(
        taxonomy["equipmentCategories"][0]["id"],
        json!("strength_resistance")
    );
    assert_eq!(
        taxonomy["equipmentCategories"][0]["groups"][0]["items"][0],
        json!({ "id": "dumbbell", "label": "Dumbbells" })
    );
}

// ---------------------------------------------------------------------------
// Plan use cases: current plan, planned sessions, calendar, next training day
// ---------------------------------------------------------------------------

/// One confirmed component of a planned prescription.
fn plan_component(id: &str, name: &str, _domain: &str) -> Value {
    json!({
        "id": id, "name": name,
        "prescription": {"blocks":[]},
    })
}

/// A weekly prescription in the 14-key order `parse_weekly_session` rebuilds.
fn plan_session(
    id: &str,
    scheduled_date: &str,
    order: i64,
    recovery_demand: &str,
    prescription: Value,
) -> Value {
    json!({
        "id": id, "scheduledDate": scheduled_date, "order": order, "status": "planned", "templateRef": null,
        "type": "Run", "subtype": null, "domain": "endurance", "name": "Easy Run", "intent": "Aerobic base", "durationMinutes": 45, "recoveryDemand": recovery_demand, "keySession": false,
        "prescription": prescription,
        "progressionNote": null, "schedulingRationale": null, })
}

fn plan_phase(id: &str, phase_type: &str, name: &str, start_week: i64, end_week: i64) -> Value {
    json!({
        "id": id, "phaseType": phase_type, "name": name, "startWeek": start_week, "endWeek": end_week,
        "focus": "Aerobic base", "progression": [],
    })
}

/// One endurance progression with a contiguous phase per plan week.
fn endurance_progressions(duration_weeks: i64) -> Value {
    let mut phases = vec![plan_phase("phase-1", "foundation", "Base", 1, 1)];
    for week in 2..=duration_weeks {
        phases.push(plan_phase(
            &format!("phase-{week}"),
            "progression",
            &format!("Build {week}"),
            week,
            week,
        ));
    }
    json!([{ "domain": "endurance", "phases": phases }])
}

fn plan_week(week_number: i64, sessions: Vec<Value>) -> Value {
    json!({ "weekNumber": week_number, "focus": null, "sessions": sessions })
}

/// The `currentPlanWriteSchema` payload: head, metadata, mesocycle and the
/// expected revision.
fn plan_write(
    schedule: Value,
    duration_weeks: i64,
    effective_start: &str,
    progressions: Value,
    weeks: Vec<Value>,
    expected_revision: i64,
) -> Value {
    json!({
        "planSchemaVersion": "8.0", "ownerId": "local-user", "title": "Base Block", "summary": "", "effectiveStartDate": effective_start,
        "mesocycle": { "durationWeeks": duration_weeks, "schedule": schedule, "domainProgressions": progressions, "weeks": weeks },
        "sourceAgent": "test", "model": null, "skillVersion": "0.6.0", "inputSnapshotHash": null,
        "expectedRevision": expected_revision,
    })
}

/// The two-week Monday plan most planned-session tests start from: one run per
/// week, both on the plan's Monday (weekday 0).
fn monday_plan_write(expected_revision: i64) -> Value {
    plan_write(
        json!({ "kind": "fixed_week", "days": [0] }),
        2,
        "2026-09-14",
        endurance_progressions(2),
        vec![
            plan_week(
                1,
                vec![plan_session(
                    "s1",
                    "2026-09-14",
                    0,
                    "low",
                    plan_component("c1", "Run", "endurance")["prescription"].clone(),
                )],
            ),
            plan_week(
                2,
                vec![plan_session(
                    "s2",
                    "2026-09-21",
                    0,
                    "low",
                    plan_component("c2", "Run", "endurance")["prescription"].clone(),
                )],
            ),
        ],
        expected_revision,
    )
}

#[test]
fn plan_drafts_persist_weeks_validate_and_commit_atomically() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );
    let complete = monday_plan_write(0);
    let weeks = complete["mesocycle"]["weeks"].as_array().unwrap().clone();
    let mut metadata = complete.clone();
    metadata["mesocycle"]["weeks"] = json!([]);
    let created = app
        .create_plan_draft(&json!({ "mode": "new", "plan": metadata }))
        .unwrap();
    let id = created["draftId"].as_str().unwrap();
    let other = app.create_plan_draft(&json!({ "mode": "new", "plan": metadata })).unwrap();
    assert!(created.get("status").is_none());
    assert_eq!(created["missingWeekNumbers"], json!([1, 2]));

    let first = app.upsert_plan_draft_week(id, 0, &weeks[0]).unwrap();
    assert_eq!(first["draftRevision"], 1);
    let stale = app.upsert_plan_draft_week(id, 0, &weeks[1]).unwrap_err();
    assert_eq!(stale.code(), AthriaErrorCode::DraftRevisionConflict);
    let incomplete = app.validate_plan_draft(id).unwrap_err();
    assert_eq!(incomplete.code(), AthriaErrorCode::DraftIncomplete);
    assert_eq!(app.commit_plan_draft(id, 1, 0, &app.snapshot_hash().unwrap(), true).unwrap_err().code(), AthriaErrorCode::DraftIncomplete);
    assert!(app.get_current_plan().unwrap().is_none());
    assert_eq!(app.store().list_plan_draft_weeks(id).unwrap().len(), 1);

    let ready = app.upsert_plan_draft_week(id, 1, &weeks[1]).unwrap();
    assert_eq!(ready["missingWeekNumbers"], json!([]));
    assert!(app.validate_plan_draft(id).unwrap().valid);
    let snapshot = app.snapshot_hash().unwrap();
    let committed = app.commit_plan_draft(id, 2, 0, &snapshot, true).unwrap();
    assert_eq!(committed["revision"], 1);
    assert_eq!(committed["sourceDraftId"], id);
    assert!(committed.get("idempotentReplay").is_none());
    assert_eq!(app.get_current_plan().unwrap().unwrap()["sourceDraftId"], id);
    assert!(app.store().get_plan_draft(id, "local-user").unwrap().is_none());
    assert!(app.store().list_plan_draft_weeks(id).unwrap().is_empty());
    assert_eq!(app.list_plan_drafts().unwrap(), vec![other]);
    assert_eq!(app.get_plan_draft(id, None).unwrap_err().code(), AthriaErrorCode::DraftNotFound);
    assert_eq!(
        app.get_current_plan().unwrap().unwrap()["mesocycle"]["weeks"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        app.commit_plan_draft(id, 2, 0, &snapshot, true).unwrap_err().code(),
        AthriaErrorCode::DraftNotFound
    );
    assert_eq!(
        app.upsert_plan_draft_week(id, 2, &weeks[0])
            .unwrap_err()
            .code(),
        AthriaErrorCode::DraftNotFound
    );
}

#[test]
fn draft_sessions_write_one_at_a_time_with_revision_checks() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );
    let complete = monday_plan_write(0);
    let weeks = complete["mesocycle"]["weeks"].as_array().unwrap().clone();
    let mut metadata = complete.clone();
    metadata["mesocycle"]["weeks"] = json!([]);
    let created = app
        .create_plan_draft(&json!({ "mode": "new", "plan": metadata }))
        .unwrap();
    let id = created["draftId"].as_str().unwrap();
    let session = weeks[0]["sessions"][0].clone();

    let first = app
        .upsert_plan_draft_session(id, 0, 1, Some(json!("Base")), &session)
        .unwrap();
    assert_eq!(first["draftRevision"], 1);
    assert_eq!(first["existingWeekNumbers"], json!([1]));
    let week = app.store().list_plan_draft_weeks(id).unwrap();
    assert_eq!(week[0]["focus"], "Base");
    assert_eq!(week[0]["sessions"].as_array().unwrap().len(), 1);

    assert_eq!(
        app.upsert_plan_draft_session(id, 0, 1, None, &session)
            .unwrap_err()
            .code(),
        AthriaErrorCode::DraftRevisionConflict
    );
    assert_eq!(
        app.upsert_plan_draft_session(id, 1, 2, None, &session)
            .unwrap_err()
            .code(),
        AthriaErrorCode::InvalidData
    );

    let second = app
        .upsert_plan_draft_session(id, 1, 2, Some(json!("Build")), &weeks[1]["sessions"][0])
        .unwrap();
    assert_eq!(second["draftRevision"], 2);
    assert_eq!(second["missingWeekNumbers"], json!([]));

    let mut replacement = session.clone();
    replacement["name"] = json!("Replaced Run");
    let replaced = app
        .upsert_plan_draft_session(id, 2, 1, None, &replacement)
        .unwrap();
    assert_eq!(replaced["draftRevision"], 3);
    let week = app
        .store()
        .list_plan_draft_weeks(id)
        .unwrap()
        .into_iter()
        .find(|week| week["weekNumber"] == 1)
        .unwrap();
    assert_eq!(week["focus"], "Base");
    assert_eq!(week["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(week["sessions"][0]["name"], "Replaced Run");

    assert_eq!(
        app.remove_plan_draft_session(id, 3, 1, "missing")
            .unwrap_err()
            .code(),
        AthriaErrorCode::PlannedSessionNotFound
    );
    let removed = app.remove_plan_draft_session(id, 3, 1, "s1").unwrap();
    assert_eq!(removed["draftRevision"], 4);
    assert_eq!(removed["existingWeekNumbers"], json!([1, 2]));
    let week = app
        .store()
        .list_plan_draft_weeks(id)
        .unwrap()
        .into_iter()
        .find(|week| week["weekNumber"] == 1)
        .unwrap();
    assert!(week["sessions"].as_array().unwrap().is_empty());
    assert!(app.store().get_plan_draft(id, "local-user").unwrap().is_some());
}

#[test]
fn draft_discard_checks_owner_and_revision_then_cascades() {
    let app = test_app();
    patch_profile(&app, json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }));
    app.save_current_plan(&monday_plan_write(0)).unwrap();
    let draft = app.create_plan_draft(&json!({"mode":"current_plan"})).unwrap();
    let id = draft["draftId"].as_str().unwrap();
    let plan = app.get_current_plan().unwrap();
    assert_eq!(app.store().delete_plan_draft(id, "another-owner", 2).unwrap_err().code(), AthriaErrorCode::DraftNotFound);
    assert_eq!(app.discard_plan_draft(id, 1).unwrap_err().code(), AthriaErrorCode::DraftRevisionConflict);
    assert_eq!(app.get_plan_draft(id, None).unwrap(), draft);
    assert_eq!(app.store().list_plan_draft_weeks(id).unwrap().len(), 2);
    app.discard_plan_draft(id, 2).unwrap();
    assert!(app.store().list_plan_draft_weeks(id).unwrap().is_empty());
    assert!(app.list_plan_drafts().unwrap().is_empty());
    assert_eq!(app.discard_plan_draft(id, 2).unwrap_err().code(), AthriaErrorCode::DraftNotFound);
    assert_eq!(app.get_current_plan().unwrap(), plan);
}

#[test]
fn failed_draft_commits_preserve_plan_context_and_weeks() {
    let app = test_app();
    commit_monday_plan(&app);
    let draft = app.create_plan_draft(&json!({"mode":"current_plan"})).unwrap();
    let id = draft["draftId"].as_str().unwrap();
    let weeks = app.store().list_plan_draft_weeks(id).unwrap();
    let plan = app.get_current_plan().unwrap();
    let context = app.store().get_plan_review_context("local-user").unwrap();
    let snapshot = app.snapshot_hash().unwrap();
    for (draft_revision, plan_revision, hash, code) in [
        (1, 1, snapshot.as_str(), AthriaErrorCode::DraftRevisionConflict),
        (2, 0, snapshot.as_str(), AthriaErrorCode::PlanRevisionConflict),
        (2, 1, "stale", AthriaErrorCode::InputSnapshotChanged),
    ] {
        assert_eq!(app.commit_plan_draft(id, draft_revision, plan_revision, hash, true).unwrap_err().code(), code);
        assert_eq!(app.get_current_plan().unwrap(), plan);
        assert_eq!(app.store().get_plan_review_context("local-user").unwrap(), context);
        assert_eq!(app.get_plan_draft(id, None).unwrap(), draft);
        assert_eq!(app.store().list_plan_draft_weeks(id).unwrap(), weeks);
    }
    // A real intervening plan write must also prevent the old draft's commit.
    app.save_current_plan(&monday_plan_write(1)).unwrap();
    let updated = app.get_current_plan().unwrap();
    assert_eq!(app.commit_plan_draft(id, 2, 1, &app.snapshot_hash().unwrap(), true).unwrap_err().code(), AthriaErrorCode::PlanRevisionConflict);
    assert_eq!(app.get_current_plan().unwrap(), updated);
    assert_eq!(app.store().list_plan_draft_weeks(id).unwrap(), weeks);

    let mut metadata = monday_plan_write(2);
    metadata["mesocycle"]["weeks"] = json!([]);
    metadata["mesocycle"]["schedule"]["days"] = json!([1]);
    let invalid = app.create_plan_draft(&json!({"mode":"new","plan":metadata})).unwrap();
    let invalid_id = invalid["draftId"].as_str().unwrap();
    for (index, week) in weeks.iter().enumerate() {
        app.upsert_plan_draft_week(invalid_id, index as i64, week).unwrap();
    }
    assert_eq!(app.commit_plan_draft(invalid_id, 2, 2, &app.snapshot_hash().unwrap(), true).unwrap_err().code(), AthriaErrorCode::PlanHasBlockers);
    assert_eq!(app.get_current_plan().unwrap(), updated);
    assert_eq!(app.store().get_plan_review_context("local-user").unwrap(), context);
    assert_eq!(app.store().list_plan_draft_weeks(invalid_id).unwrap(), weeks);
}

#[test]
fn source_draft_id_is_runtime_owned_and_survives_daily_operations() {
    let app = test_app();
    patch_profile(&app, json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }));
    let mut write = monday_plan_write(0);
    write["sourceDraftId"] = json!("forged");
    assert!(app.save_current_plan(&write).unwrap()["plan"]["sourceDraftId"].is_null());
    let draft = app.create_plan_draft(&json!({"mode":"current_plan"})).unwrap();
    let id = draft["draftId"].as_str().unwrap();
    app.commit_plan_draft(id, 2, 1, &app.snapshot_hash().unwrap(), true).unwrap();
    assert_eq!(app.get_current_plan().unwrap().unwrap()["sourceDraftId"], id);
    app.update_planned_session("s2", &json!({"action":"move_occurrence","expectedRevision":2,"scheduledDate":"2026-09-22"})).unwrap();
    assert_eq!(app.get_current_plan().unwrap().unwrap()["sourceDraftId"], id);
    let mut write = monday_plan_write(3);
    write["sourceDraftId"] = json!("another-forged-id");
    assert_eq!(app.save_current_plan(&write).unwrap()["plan"]["sourceDraftId"], id);
    let next = app.create_plan_draft(&json!({"mode":"current_plan"})).unwrap();
    let next_id = next["draftId"].as_str().unwrap();
    assert!(app.store().get_plan_draft(next_id, "local-user").unwrap().unwrap()["data"].get("sourceDraftId").is_none());
    app.commit_plan_draft(next_id, 2, 4, &app.snapshot_hash().unwrap(), true).unwrap();
    assert_eq!(app.get_current_plan().unwrap().unwrap()["sourceDraftId"], next_id);
}

#[test]
fn current_plan_drafts_clone_weeks_and_discard_without_changing_plan() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );
    app.save_current_plan(&monday_plan_write(0)).unwrap();
    let created = app
        .create_plan_draft(&json!({ "mode": "current_plan" }))
        .unwrap();
    assert_eq!(created["existingWeekNumbers"], json!([1, 2]));
    assert_eq!(created["draftRevision"], 2);
    let id = created["draftId"].as_str().unwrap();
    assert_eq!(app.list_plan_drafts().unwrap().len(), 1);
    assert_eq!(
        app.get_plan_draft(id, Some(1)).unwrap()["week"]["weekNumber"],
        1
    );
    app.discard_plan_draft(id, 2).unwrap();
    assert_eq!(app.get_current_plan().unwrap().unwrap()["revision"], 1);
    assert_eq!(
        app.upsert_plan_draft_week(id, 2, &plan_week(1, vec![]))
            .unwrap_err()
            .code(),
        AthriaErrorCode::DraftNotFound
    );
}

fn adjustment_scope_policy(
    app: &AthriaApplication<SqliteStore>,
    recommended_scope: RecommendedScope,
) -> AdjustmentScopePolicy {
    AdjustmentScopePolicy {
        recommended_scope,
        review_date: "2026-09-17".to_owned(),
        target_session_ids: Vec::new(),
        target_week_numbers: Vec::new(),
        expected_plan_revision: app.get_current_plan().unwrap().unwrap()["revision"]
            .as_i64()
            .unwrap(),
        input_snapshot_hash: app.snapshot_hash().unwrap(),
        profile_hash: app.profile_hash().unwrap(),
    }
}

#[test]
fn adjustment_review_requires_a_current_plan() {
    let error = test_app()
        .review_current_plan_for_adjustment(AdjustmentTrigger::WeeklyReview)
        .unwrap_err();
    assert_eq!(error.code(), AthriaErrorCode::NoCurrentPlan);
}

#[test]
fn first_opening_reviews_previous_week_and_later_requests_check_profile_conflicts() {
    for now in ["2026-09-20T16:30:00.000Z", "2026-09-23T04:00:00.000Z"] {
        let clock = Arc::new(FixedClock::new(now));
        let store = SqliteStore::open_in_memory_with_clock(clock.clone()).unwrap();
        let app = AthriaApplication::with_clock(store, "local-user", clock);
        patch_profile(&app, json!({ "timezone": "Asia/Hong_Kong", "trainingRhythm": { "kind": "fixed_week", "days": [0] } }));
        let mut plan = monday_plan_write(0);
        plan["mesocycle"]["weeks"][0]["sessions"][0]["keySession"] = json!(true);
        plan["mesocycle"]["weeks"][1]["sessions"][0]["keySession"] = json!(true);
        app.save_current_plan(&plan).unwrap();
        let first = app.review_scheduled_plan_reminder(None, None).unwrap();
        assert_eq!(first.assessment.trigger, AdjustmentTrigger::WeeklyReview);
        let missed = first.assessment.reasons.iter().find(|reason| reason.reason_code == ReasonCode::KeySessionMissed).unwrap();
        assert_eq!(missed.evidence_refs, vec!["s1"]);
        assert!(!missed.evidence_refs.contains(&"s2".to_owned()));
        let later = app.review_scheduled_plan_reminder(Some("2026-09-21"), None).unwrap();
        assert_eq!(later.assessment.trigger, AdjustmentTrigger::ProfileChange);
        assert!(!later.show_reminder);
        patch_profile(&app, json!({ "trainingRhythm": { "kind": "fixed_week", "days": [1] } }));
        let conflict = app.review_scheduled_plan_reminder(Some("2026-09-21"), None).unwrap();
        assert!(conflict.show_reminder);
        assert_eq!(conflict.assessment.review_status, ReviewStatus::ReviewRequired);
        let next_week = app.review_scheduled_plan_reminder(Some("2026-09-14"), None).unwrap();
        assert_eq!(next_week.assessment.trigger, AdjustmentTrigger::WeeklyReview);
    }
}

#[test]
fn previous_week_review_includes_unresolved_sunday_but_not_this_weeks_sessions() {
    let clock = Arc::new(FixedClock::new("2026-09-21T04:00:00.000Z"));
    let store = SqliteStore::open_in_memory_with_clock(clock.clone()).unwrap();
    let app = AthriaApplication::with_clock(store, "local-user", clock);
    patch_profile(&app, json!({ "timezone": "Asia/Hong_Kong", "trainingRhythm": { "kind": "fixed_week", "days": [6] } }));
    let mut plan = monday_plan_write(0);
    plan["mesocycle"]["schedule"]["days"] = json!([6]);
    plan["mesocycle"]["weeks"][0]["sessions"][0]["scheduledDate"] = json!("2026-09-20");
    plan["mesocycle"]["weeks"][0]["sessions"][0]["keySession"] = json!(true);
    plan["mesocycle"]["weeks"][1]["sessions"][0]["scheduledDate"] = json!("2026-09-27");
    app.save_current_plan(&plan).unwrap();
    let review = app.review_scheduled_plan_reminder(None, None).unwrap();
    let missed = review.assessment.reasons.iter().find(|reason| reason.reason_code == ReasonCode::KeySessionMissed).unwrap();
    assert_eq!(missed.evidence_refs, vec!["s1"]);
}

#[test]
fn profile_change_review_reuses_validation_and_refreshes_freshness() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );
    app.save_current_plan(&monday_plan_write(0)).unwrap();

    let before = app
        .review_current_plan_for_adjustment(AdjustmentTrigger::ProfileChange)
        .unwrap();
    assert_eq!(before.review_status, ReviewStatus::Keep);

    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [1] } }),
    );
    let after = app
        .review_current_plan_for_adjustment(AdjustmentTrigger::ProfileChange)
        .unwrap();
    assert_eq!(after.review_status, ReviewStatus::ReviewRequired);
    assert_eq!(after.recommended_scope, RecommendedScope::Plan);
    assert_eq!(
        after.reasons[0].reason_code,
        ReasonCode::ProfileTrainingRhythmConflict
    );
    assert_ne!(before.profile_hash, after.profile_hash);
    assert_ne!(before.input_snapshot_hash, after.input_snapshot_hash);
}

#[test]
fn compatible_flexible_profile_change_is_a_watch_not_a_required_review() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );
    app.save_current_plan(&monday_plan_write(0)).unwrap();

    patch_profile(
        &app,
        json!({
            "trainingRhythm": {
                "kind": "flexible_week",
                "targetDaysPerWeek": 1,
                "minDaysPerWeek": 1,
                "maxDaysPerWeek": 2
            }
        }),
    );
    let review = app
        .review_current_plan_for_adjustment(AdjustmentTrigger::ProfileChange)
        .unwrap();

    assert_eq!(review.review_status, ReviewStatus::Watch);
    assert_eq!(review.recommended_scope, RecommendedScope::None);
    assert!(review.hard_overrides.is_empty());
    assert_eq!(review.reasons[0].severity, EvidenceSeverity::Soft);
    assert_eq!(
        review.reasons[0].reason_code,
        ReasonCode::ProfileTrainingRhythmConflict
    );
}

#[test]
fn weekly_review_uses_reconciled_calendar_and_reports_missing_wellness() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );
    app.save_current_plan(&monday_plan_write(0)).unwrap();

    let review = app
        .review_current_plan_for_adjustment(AdjustmentTrigger::WeeklyReview)
        .unwrap();
    assert_eq!(review.current_plan_revision, 1);
    assert_eq!(review.review_status, ReviewStatus::Watch);
    assert_eq!(review.recommended_scope, RecommendedScope::None);
    assert_eq!(review.data_gaps[0].code, "WELLNESS_EVIDENCE_MISSING");
    assert_eq!(review.suggested_read_window, 3);
}

#[test]
fn adjustment_acknowledgement_suppresses_only_the_same_soft_review() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );
    app.save_current_plan(&monday_plan_write(0)).unwrap();

    let first = app
        .review_current_plan_reminder(AdjustmentTrigger::WeeklyReview, None)
        .unwrap();
    assert!(first.show_reminder);
    let acknowledged = app
        .review_current_plan_reminder(
            AdjustmentTrigger::WeeklyReview,
            Some(&first.idempotency_context),
        )
        .unwrap();
    assert!(!acknowledged.show_reminder);

    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [1] } }),
    );
    let changed = app
        .review_current_plan_reminder(
            AdjustmentTrigger::ProfileChange,
            Some(&first.idempotency_context),
        )
        .unwrap();
    assert!(changed.show_reminder);
    assert_ne!(changed.idempotency_context, first.idempotency_context);
}

#[test]
fn adjustment_validation_combines_existing_validator_with_scope_policy() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );
    app.save_current_plan(&monday_plan_write(0)).unwrap();

    let mut policy = adjustment_scope_policy(&app, RecommendedScope::Week);
    policy.target_week_numbers = vec![2];
    let mut proposed = app.get_current_plan().unwrap().unwrap();
    proposed["expectedRevision"] = json!(1);
    proposed["mesocycle"]["weeks"][1]["sessions"][0]["name"] = json!("Adjusted Run");

    let accepted = app
        .validate_current_plan_adjustment(&proposed, &policy)
        .unwrap();
    assert!(accepted.plan_validation.valid);
    assert!(accepted.scope_validation.valid);
    assert!(accepted.valid);

    policy.target_week_numbers = vec![1];
    let rejected = app
        .validate_current_plan_adjustment(&proposed, &policy)
        .unwrap();
    assert!(rejected.plan_validation.valid);
    assert!(!rejected.scope_validation.valid);
    assert_eq!(
        rejected.scope_validation.violations[0].code,
        ScopeViolationCode::ChangeOutsideRecommendedScope
    );
    assert!(!rejected.valid);
}

#[test]
fn adjustment_validation_never_allows_historical_session_changes() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );
    app.save_current_plan(&monday_plan_write(0)).unwrap();

    let policy = adjustment_scope_policy(&app, RecommendedScope::Plan);
    let mut proposed = app.get_current_plan().unwrap().unwrap();
    proposed["expectedRevision"] = json!(1);
    proposed["mesocycle"]["weeks"][0]["sessions"][0]["name"] = json!("Rewritten Run");

    let result = app
        .validate_current_plan_adjustment(&proposed, &policy)
        .unwrap();
    assert_eq!(
        result.scope_validation.violations[0].code,
        ScopeViolationCode::HistoricalSessionChanged
    );
    assert!(!result.valid);
}

#[test]
fn adjustment_validation_rejects_stale_plan_and_input_freshness() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );
    app.save_current_plan(&monday_plan_write(0)).unwrap();
    let proposed = app.get_current_plan().unwrap().unwrap();

    let mut stale_revision = adjustment_scope_policy(&app, RecommendedScope::None);
    stale_revision.expected_plan_revision = 0;
    let revision_error = app
        .validate_current_plan_adjustment(&proposed, &stale_revision)
        .unwrap_err();
    assert_eq!(revision_error.code(), AthriaErrorCode::RevisionConflict);

    let mut stale_snapshot = adjustment_scope_policy(&app, RecommendedScope::None);
    stale_snapshot.input_snapshot_hash = "stale".to_owned();
    let snapshot_error = app
        .validate_current_plan_adjustment(&proposed, &stale_snapshot)
        .unwrap_err();
    assert_eq!(snapshot_error.code(), AthriaErrorCode::InputSnapshotChanged);
}

/// Applies a profile patch under the current hash.
fn patch_profile(app: &AthriaApplication<SqliteStore>, patch: Value) -> Value {
    app.update_profile(&json!({ "patch": patch, "expectedProfileHash": app.profile_hash().unwrap(), "confirmed": true }))
        .expect("the profile patch succeeds")
}

/// A planned-session write payload for the next-training-day use cases.
fn next_day_session(id: &str) -> Value {
    json!({ "type": "Run", "subtype": null,
        "id": id, "status": "planned", "templateRef": null, "name": "Tempo Run", "intent": "Threshold",
        "durationMinutes": 50, "recoveryDemand": "normal", "keySession": false,
        "prescription": plan_component(&format!("{id}-c1"), "Run", "endurance")["prescription"].clone(),
        "progressionNote": null, "schedulingRationale": null, })
}

fn next_day_write(scheduled_date: &str, expected_revision: i64, sessions: Vec<Value>) -> Value {
    json!({ "clientRequestId": "req-1", "scheduledDate": scheduled_date, "expectedRevision": expected_revision, "mode": "replace", "sessions": sessions })
}

#[test]
fn saved_plans_materialize_weekly_occurrences_with_impact_and_revision() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );

    // A Monday plan against a [0, 2] rhythm fails the core rhythm rule as a
    // blocker, so the save is rejected before anything is written.
    let broken = plan_write(
        json!({ "kind": "fixed_week", "days": [0, 2] }),
        2,
        "2026-09-14",
        endurance_progressions(2),
        vec![
            plan_week(
                1,
                vec![plan_session(
                    "s1",
                    "2026-09-14",
                    0,
                    "low",
                    plan_component("c1", "Run", "endurance")["prescription"].clone(),
                )],
            ),
            plan_week(
                2,
                vec![plan_session(
                    "s2",
                    "2026-09-21",
                    0,
                    "low",
                    plan_component("c2", "Run", "endurance")["prescription"].clone(),
                )],
            ),
        ],
        0,
    );
    let validation = app.validate_current_plan(&broken).unwrap();
    assert!(!validation.valid);
    let rhythm = validation
        .results
        .iter()
        .find(|result| result["reasonCode"] == json!("PROFILE_TRAINING_RHYTHM"))
        .expect("the rhythm rule ran");
    assert_eq!(rhythm["status"], json!("fail"));
    assert_eq!(rhythm["enforcement"], json!("blocker"));
    let rejected = app.save_current_plan(&broken).unwrap_err();
    assert_eq!(rejected.code(), AthriaErrorCode::PlanHasBlockers);
    assert_eq!(
        rejected.message(),
        "Plan has 1 blocking issue(s) (PROFILE_TRAINING_RHYTHM:fail). Validate the complete plan draft for the full report."
    );
    assert_eq!(rejected.status(), 409);
    assert!(
        app.store()
            .get_current_plan("local-user")
            .unwrap()
            .is_none()
    );

    // The matching Monday draft validates and saves at revision 1.
    let draft = monday_plan_write(0);
    let validated = app.validate_current_plan(&draft).unwrap();
    assert!(validated.valid);
    assert_eq!(validated.validated_at, NOW);
    assert!(!validated.input_hash.is_empty());
    assert!(validated.data_gaps.is_empty());

    let saved = app.save_current_plan(&draft).unwrap();
    assert_eq!(saved["plan"]["revision"], json!(1));
    assert_eq!(saved["plan"]["updatedAt"], json!(NOW));
    assert_eq!(saved["validation"]["valid"], json!(true));
    assert_eq!(
        saved["impact"],
        json!({ "affectedCount": 0, "updatedCount": 2, "deletedCount": 0 })
    );
    assert_eq!(
        saved["plan"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "planSchemaVersion",
            "ownerId",
            "title",
            "summary",
            "effectiveStartDate",
            "mesocycle",
            "revision",
            "sourceAgent",
            "model",
            "skillVersion",
            "inputSnapshotHash",
            "updatedAt",
            "sourceDraftId"
        ]
    );
    assert_eq!(
        saved["plan"]["mesocycle"]["schedule"],
        json!({ "kind": "fixed_week", "days": [0] })
    );
    assert_eq!(
        saved["plan"]["mesocycle"]["weeks"][0]["sessions"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "type",
            "domain",
            "subtype",
            "id",
            "scheduledDate",
            "order",
            "status",
            "templateRef",
            "name",
            "intent",
            "durationMinutes",
            "recoveryDemand",
            "keySession",
            "prescription",
            "progressionNote",
            "schedulingRationale",
        ]
    );

    // The calendar projects both occurrences with their display states.
    let calendar = app
        .get_calendar(Some("2026-09-14"), Some("2026-09-27"))
        .unwrap();
    assert_eq!(calendar.len(), 2);
    assert_eq!(
        calendar[0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "id",
            "type",
            "subtype",
            "domain",
            "domains",
            "occurrenceId",
            "revision",
            "scheduledDate",
            "order",
            "weekNumber",
            "phaseRefs",
            "templateRef",
            "name",
            "intent",
            "durationMinutes",
            "recoveryDemand",
            "keySession",
            "progressionNote",
            "schedulingRationale",
            "status",
            "displayState",
            "prescription",
            "overrideReason",
            "completedTrainingSessionId",
            "completedAt",
            "completionSource",
            "match"
        ]
    );
    assert_eq!(calendar[0]["occurrenceId"], json!("plan:2026-09-14"));
    assert_eq!(calendar[1]["occurrenceId"], json!("plan:2026-09-21"));
    assert_eq!(calendar[0]["displayState"], json!("unrecorded"));
    assert_eq!(calendar[1]["displayState"], json!("scheduled"));
    assert_eq!(calendar[0]["revision"], json!(1));

    let inverted = app
        .get_calendar(Some("2026-09-21"), Some("2026-09-14"))
        .unwrap_err();
    assert_eq!(inverted.code(), AthriaErrorCode::InvalidCalendarWindow);
    assert_eq!(
        inverted.message(),
        "The calendar start date must not be after the end date."
    );
    assert_eq!(inverted.status(), 400);
}

#[test]
fn plan_saves_enforce_ownership_snapshots_references_and_revisions() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );

    let mut foreign = monday_plan_write(0);
    foreign["ownerId"] = json!("someone-else");
    let owner = app.save_current_plan(&foreign).unwrap_err();
    assert_eq!(owner.code(), AthriaErrorCode::OwnerMismatch);
    assert_eq!(
        owner.message(),
        "The plan owner does not match the local athlete."
    );
    assert_eq!(owner.status(), 403);

    let mut stale_snapshot = monday_plan_write(0);
    stale_snapshot["inputSnapshotHash"] = json!("fnv1a-00000000");
    let changed = app.save_current_plan(&stale_snapshot).unwrap_err();
    assert_eq!(changed.code(), AthriaErrorCode::InputSnapshotChanged);
    assert_eq!(
        changed.message(),
        "Training state changed. Refresh and revise the plan."
    );
    assert_eq!(changed.status(), 409);

    // An absent hash skips the snapshot check, like the falsy empty string.
    let saved = app.save_current_plan(&monday_plan_write(0)).unwrap();
    assert_eq!(saved["plan"]["revision"], json!(1));

    let repeat = app.save_current_plan(&monday_plan_write(0)).unwrap_err();
    assert_eq!(repeat.code(), AthriaErrorCode::RevisionConflict);
    assert_eq!(
        repeat.message(),
        "The current plan changed. Refresh and try again."
    );
    assert_eq!(repeat.status(), 409);

    let bumped = app.save_current_plan(&monday_plan_write(1)).unwrap();
    assert_eq!(bumped["plan"]["revision"], json!(2));

    // Session template references must resolve to the requested version.
    app.create_template(&endurance_template("user.tempo", "Tempo Run"))
        .unwrap();
    let mut stale_user = monday_plan_write(2);
    stale_user["mesocycle"]["weeks"][0]["sessions"][0]["templateRef"] =
        json!({ "source": "user", "id": "user.tempo", "revision": 5 });
    let user_miss = app.save_current_plan(&stale_user).unwrap_err();
    assert_eq!(user_miss.code(), AthriaErrorCode::TemplateNotFound);
    assert_eq!(
        user_miss.message(),
        "Template reference user.tempo does not resolve to the requested version."
    );
    assert_eq!(user_miss.status(), 409);

    let mut stale_builtin = monday_plan_write(2);
    stale_builtin["mesocycle"]["weeks"][0]["sessions"][0]["templateRef"] =
        json!({ "source": "builtin", "id": "builtin.easy-run", "catalogVersion": "1.0" });
    let builtin_miss = app.save_current_plan(&stale_builtin).unwrap_err();
    assert_eq!(builtin_miss.code(), AthriaErrorCode::TemplateNotFound);
    assert_eq!(
        builtin_miss.message(),
        "Template reference builtin.easy-run does not resolve to the requested version."
    );

    let mut referenced = monday_plan_write(2);
    referenced["mesocycle"]["weeks"][0]["sessions"][0]["templateRef"] =
        json!({ "source": "builtin", "id": "builtin.easy-run", "catalogVersion": "2.0" });
    let referenced = app.save_current_plan(&referenced).unwrap();
    assert_eq!(referenced["plan"]["revision"], json!(3));
    assert_eq!(
        referenced["plan"]["mesocycle"]["weeks"][0]["sessions"][0]["templateRef"],
        json!({ "source": "builtin", "id": "builtin.easy-run", "catalogVersion": "2.0" })
    );
}

#[test]
fn planned_sessions_skip_restore_and_move_keep_the_revision_contract() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );

    let no_plan = app
        .update_planned_session("s1", &json!({ "action": "skip", "expectedRevision": 0 }))
        .unwrap_err();
    assert_eq!(no_plan.code(), AthriaErrorCode::NoCurrentPlan);
    assert_eq!(no_plan.message(), "There is no current plan.");
    assert_eq!(no_plan.status(), 409);

    app.save_current_plan(&monday_plan_write(0)).unwrap();

    let missing = app
        .update_planned_session(
            "absent",
            &json!({ "action": "skip", "expectedRevision": 1 }),
        )
        .unwrap_err();
    assert_eq!(missing.code(), AthriaErrorCode::PlannedSessionNotFound);
    assert_eq!(missing.message(), "The planned session was not found.");
    assert_eq!(missing.status(), 404);

    let stale = app
        .update_planned_session("s1", &json!({ "action": "skip", "expectedRevision": 0 }))
        .unwrap_err();
    assert_eq!(
        stale.code(),
        AthriaErrorCode::PlannedSessionRevisionConflict
    );
    assert_eq!(
        stale.message(),
        "The planned sessions changed. Refresh and try again."
    );
    assert_eq!(stale.status(), 409);

    let skipped = app
        .update_planned_session("s1", &json!({ "action": "skip", "expectedRevision": 1, "reason": { "reasonCode": "travel", "note": "work trip" } }))
        .unwrap();
    assert_eq!(skipped["revision"], json!(2));
    assert_eq!(skipped["sessions"][0]["id"], json!("s1"));
    assert_eq!(skipped["sessions"][0]["status"], json!("skipped"));
    let stored = app
        .store()
        .get_current_plan("local-user")
        .unwrap()
        .expect("the plan is stored");
    assert_eq!(stored["revision"], json!(2));
    assert_eq!(stored["updatedAt"], json!(NOW));
    let calendar = app
        .get_calendar(Some("2026-09-14"), Some("2026-09-27"))
        .unwrap();
    let skipped_entry = calendar
        .iter()
        .find(|entry| entry["id"] == json!("s1"))
        .expect("the skipped occurrence is scheduled");
    assert_eq!(skipped_entry["status"], json!("skipped"));
    assert_eq!(skipped_entry["displayState"], json!("skipped"));

    let repeat_skip = app
        .update_planned_session("s1", &json!({ "action": "skip", "expectedRevision": 2 }))
        .unwrap_err();
    assert_eq!(
        repeat_skip.code(),
        AthriaErrorCode::PlannedSessionAlreadyResolved
    );
    assert_eq!(
        repeat_skip.message(),
        "Completed or skipped sessions cannot be skipped."
    );
    assert_eq!(repeat_skip.status(), 409);

    let move_skipped = app
        .update_planned_session("s1", &json!({ "action": "move_occurrence", "expectedRevision": 2, "scheduledDate": "2026-09-16" }))
        .unwrap_err();
    assert_eq!(
        move_skipped.code(),
        AthriaErrorCode::PlannedSessionAlreadyResolved
    );
    assert_eq!(
        move_skipped.message(),
        "Completed or skipped sessions must be unresolved before they can be moved."
    );
    assert_eq!(move_skipped.status(), 409);

    let restored = app
        .update_planned_session("s1", &json!({ "action": "restore", "expectedRevision": 2 }))
        .unwrap();
    assert_eq!(restored["revision"], json!(3));
    assert_eq!(restored["sessions"][0]["status"], json!("planned"));
    assert_eq!(restored["sessions"][0]["updatedAt"], json!(NOW));
    let calendar = app
        .get_calendar(Some("2026-09-14"), Some("2026-09-27"))
        .unwrap();
    let restored_entry = calendar
        .iter()
        .find(|entry| entry["id"] == json!("s1"))
        .expect("the restored occurrence is scheduled");
    assert_eq!(restored_entry["displayState"], json!("unrecorded"));

    let repeat_restore = app
        .update_planned_session("s1", &json!({ "action": "restore", "expectedRevision": 3 }))
        .unwrap_err();
    assert_eq!(
        repeat_restore.code(),
        AthriaErrorCode::PlannedSessionNotSkipped
    );
    assert_eq!(
        repeat_restore.message(),
        "Only a skipped planned session can be restored."
    );
    assert_eq!(repeat_restore.status(), 409);
}

#[test]
fn completing_a_planned_session_records_a_dated_manual_workout() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );
    app.save_current_plan(&monday_plan_write(0)).unwrap();

    // A future occurrence cannot be marked complete yet.
    let future = app
        .update_planned_session(
            "s2",
            &json!({ "action": "complete", "expectedRevision": 1 }),
        )
        .unwrap_err();
    assert_eq!(
        future.code(),
        AthriaErrorCode::FutureSessionCannotBeCompleted
    );
    assert_eq!(
        future.message(),
        "Move this planned session to the date you completed it before adding it as a completed workout."
    );
    assert_eq!(future.status(), 409);

    let completed = app
        .update_planned_session(
            "s1",
            &json!({ "action": "complete", "expectedRevision": 1 }),
        )
        .unwrap();
    let workout = &completed["trainingSession"];
    assert_eq!(completed["revision"], json!(1));
    assert_eq!(workout["sources"][0]["source"], json!("manual"));
    assert_eq!(workout["status"], json!("completed"));
    assert_eq!(workout["type"], json!("Run"));
    assert_eq!(workout["domains"], json!(["endurance"]));
    assert!(workout.get("sport").is_none());
    assert_eq!(workout["type"], "Run");
    assert_eq!(workout["plannedSessionId"], json!("s1"));
    assert_eq!(workout["timePrecision"], json!("date_only"));
    assert_eq!(workout["startAt"], json!("2026-09-14T04:00:00.000Z"));
    assert!(workout.get("endAt").is_none());
    assert_eq!(workout["durationMinutes"], json!(45));
    assert_eq!(workout["timezone"], json!("Asia/Hong_Kong"));
    assert_eq!(workout["strengthSets"], json!([]));
    assert_eq!(workout["endurance"], json!(null));
    assert!(workout.get("missingFields").is_none());

    let resolved = &completed["sessions"][0];
    assert_eq!(resolved["id"], json!("s1"));
    assert_eq!(resolved["status"], json!("completed"));
    assert_eq!(resolved["displayState"], json!("completed"));
    assert_eq!(resolved["completionSource"], json!("manual"));
    assert_eq!(resolved["completedTrainingSessionId"], workout["id"]);
    assert_eq!(resolved["completedAt"], json!("2026-09-14T04:45:00.000Z"));
    assert_eq!(
        resolved["match"],
        json!({ "plannedSessionId": "s1", "method": "manual" })
    );

    // The next training day is the still-planned Monday with its rhythm phase.
    let next = app.get_next_training_day(None).unwrap();
    assert_eq!(next["reasonCode"], json!(null));
    assert_eq!(
        next["nextTrainingDay"]["occurrenceId"],
        json!("plan:2026-09-21")
    );
    assert_eq!(
        next["nextTrainingDay"]["scheduledDate"],
        json!("2026-09-21")
    );
    assert_eq!(next["nextTrainingDay"]["dayOfWeek"], json!(0));
    assert_eq!(next["nextTrainingDay"]["weekNumber"], json!(2));
    assert_eq!(next["nextTrainingDay"]["revision"], json!(1));
    assert_eq!(next["nextTrainingDay"]["timezone"], json!("Asia/Hong_Kong"));
    assert_eq!(
        next["nextTrainingDay"]["domainPhases"],
        json!([{ "domain": "endurance", "phaseId": "phase-2", "phaseType": "progression", "name": "Build 2" }])
    );
    assert_eq!(
        next["nextTrainingDay"]["existingSessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn moving_an_occurrence_checks_the_rhythm_and_recomputes_the_week() {
    let app = test_app();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );
    app.save_current_plan(&monday_plan_write(0)).unwrap();

    let same_date = app
        .update_planned_session("s1", &json!({ "action": "move_occurrence", "expectedRevision": 1, "scheduledDate": "2026-09-14" }))
        .unwrap_err();
    assert_eq!(same_date.code(), AthriaErrorCode::InvalidMoveDate);
    assert_eq!(
        same_date.message(),
        "Choose a different date for the planned session."
    );
    assert_eq!(same_date.status(), 400);

    let outside = app
        .update_planned_session("s1", &json!({ "action": "move_occurrence", "expectedRevision": 1, "scheduledDate": "2026-10-05" }))
        .unwrap_err();
    assert_eq!(outside.code(), AthriaErrorCode::MoveOutsidePlan);
    assert_eq!(
        outside.message(),
        "The moved training day must stay within the current plan."
    );
    assert_eq!(outside.status(), 409);

    let off_rhythm = app
        .update_planned_session("s1", &json!({ "action": "move_occurrence", "expectedRevision": 1, "scheduledDate": "2026-09-22" }))
        .unwrap();
    assert_eq!(off_rhythm["revision"], json!(2));
    let review = app.review_current_plan_for_adjustment(AdjustmentTrigger::ProfileChange).unwrap();
    assert!(review.reasons.iter().any(|reason| reason.reason_code == ReasonCode::ProfileTrainingRhythmConflict));

    let moved_to_occupied = app
        .update_planned_session("s1", &json!({ "action": "move_occurrence", "expectedRevision": 2, "scheduledDate": "2026-09-21" }))
        .unwrap();
    assert_eq!(moved_to_occupied["revision"], json!(3));
    let occupied = app.get_calendar(Some("2026-09-21"), Some("2026-09-21")).unwrap();
    assert_eq!(occupied.len(), 2);
    assert!(occupied.iter().any(|session| session["id"] == "s1"));
    assert!(occupied.iter().any(|session| session["id"] == "s2"));

    // A flexible rhythm accepts the same move and recomputes week and phases.
    let flex = test_app();
    patch_profile(
        &flex,
        json!({ "trainingRhythm": { "kind": "flexible_week", "targetDaysPerWeek": 2, "minDaysPerWeek": 1, "maxDaysPerWeek": 3 } }),
    );
    let flex_plan = plan_write(
        json!({ "kind": "flexible_week", "targetDaysPerWeek": 2, "minDaysPerWeek": 1, "maxDaysPerWeek": 3 }),
        2,
        "2026-09-14",
        endurance_progressions(2),
        vec![
            plan_week(
                1,
                vec![plan_session(
                    "s1",
                    "2026-09-14",
                    0,
                    "low",
                    plan_component("c1", "Run", "endurance")["prescription"].clone(),
                )],
            ),
            plan_week(
                2,
                vec![plan_session(
                    "s2",
                    "2026-09-21",
                    0,
                    "low",
                    plan_component("c2", "Run", "endurance")["prescription"].clone(),
                )],
            ),
        ],
        0,
    );
    flex.save_current_plan(&flex_plan).unwrap();

    let moved = flex.update_planned_session("s2", &json!({ "action": "move_occurrence", "expectedRevision": 1, "scheduledDate": "2026-09-16" })).unwrap();
    assert_eq!(moved["revision"], json!(2));
    assert_eq!(moved["sessions"][0]["id"], json!("s2"));
    assert_eq!(moved["sessions"][0]["scheduledDate"], json!("2026-09-16"));
    assert_eq!(moved["sessions"][0]["weekNumber"], json!(1));
    assert_eq!(
        moved["sessions"][0]["phaseRefs"][0]["phaseId"],
        json!("phase-1")
    );

    let calendar = flex
        .get_calendar(Some("2026-09-14"), Some("2026-09-20"))
        .unwrap();
    assert_eq!(calendar.len(), 2);
    assert_eq!(calendar[0]["occurrenceId"], json!("plan:2026-09-14"));
    assert_eq!(calendar[1]["id"], json!("s2"));
    assert_eq!(calendar[1]["occurrenceId"], json!("plan:2026-09-16"));
    assert_eq!(calendar[1]["weekNumber"], json!(1));
    assert_eq!(calendar[1]["phaseRefs"][0]["phaseId"], json!("phase-1"));
    assert_eq!(calendar[1]["revision"], json!(2));
}

#[test]
fn user_moves_override_all_training_rhythms() {
    for (rhythm, schedule) in [
        (json!({ "kind": "fixed_week", "days": [0] }), json!({ "kind": "fixed_week", "days": [0] })),
        (json!({ "kind": "flexible_week", "targetDaysPerWeek": 1, "minDaysPerWeek": 1, "maxDaysPerWeek": 1 }), json!({ "kind": "flexible_week", "targetSessionsPerWeek": 1, "minSessionsPerWeek": 1, "maxSessionsPerWeek": 1 })),
        (json!({ "kind": "interval", "intervalDays": 7 }), json!({ "kind": "interval", "intervalDays": 7 })),
    ] {
        let app = test_app();
        patch_profile(&app, json!({ "trainingRhythm": rhythm }));
        let mut plan = monday_plan_write(0);
        plan["mesocycle"]["schedule"] = schedule;
        app.save_current_plan(&plan).unwrap();
        let moved = app.update_planned_session("s1", &json!({ "action": "move_occurrence", "expectedRevision": 1, "scheduledDate": "2026-09-22" })).unwrap();
        assert_eq!(moved["revision"], json!(2));
        let moved = app.update_planned_session("s1", &json!({ "action": "move_occurrence", "expectedRevision": 2, "scheduledDate": "2026-09-21" })).unwrap();
        assert_eq!(moved["revision"], json!(3));
        assert_eq!(app.get_calendar(Some("2026-09-21"), Some("2026-09-21")).unwrap().len(), 2);
    }
}

#[test]
fn moving_high_recovery_days_keeps_the_interval_advisory() {
    let app = test_app();
    patch_profile(
        &app,
        json!({
            "trainingRhythm": { "kind": "flexible_week", "targetDaysPerWeek": 3, "minDaysPerWeek": 1, "maxDaysPerWeek": 3 },
            "explicitRecoveryDays": 3,
        }),
    );
    let plan = plan_write(
        json!({ "kind": "flexible_week", "targetDaysPerWeek": 3, "minDaysPerWeek": 1, "maxDaysPerWeek": 3 }),
        2,
        "2026-09-14",
        endurance_progressions(2),
        vec![
            plan_week(
                1,
                vec![
                    plan_session(
                        "s1",
                        "2026-09-14",
                        0,
                        "high",
                        plan_component("c1", "Run", "endurance")["prescription"].clone(),
                    ),
                    plan_session(
                        "s2",
                        "2026-09-18",
                        1,
                        "low",
                        plan_component("c2", "Run", "endurance")["prescription"].clone(),
                    ),
                ],
            ),
            plan_week(
                2,
                vec![
                    plan_session(
                        "s3",
                        "2026-09-21",
                        0,
                        "high",
                        plan_component("c3", "Run", "endurance")["prescription"].clone(),
                    ),
                    plan_session(
                        "s4",
                        "2026-09-22",
                        1,
                        "low",
                        plan_component("c4", "Run", "endurance")["prescription"].clone(),
                    ),
                ],
            ),
        ],
        0,
    );
    let saved = app.save_current_plan(&plan).unwrap();
    assert_eq!(saved["plan"]["revision"], json!(1));
    assert_eq!(saved["impact"]["updatedCount"], json!(4));

    let tight = app
        .update_planned_session("s3", &json!({ "action": "move_occurrence", "expectedRevision": 1, "scheduledDate": "2026-09-16" }))
        .unwrap();
    assert_eq!(tight["revision"], json!(2));
    let review = app.review_current_plan_for_adjustment(AdjustmentTrigger::ProfileChange).unwrap();
    let recovery = review.reasons.iter().find(|reason| reason.reason_code == ReasonCode::ProfileRecoveryConstraintConflict).unwrap();
    assert_eq!(recovery.severity, EvidenceSeverity::Soft);
    assert!(review.hard_overrides.is_empty());

    let next = app.get_next_training_day(None).unwrap();
    let mut high = next_day_session("extra-high");
    high["recoveryDemand"] = json!("high");
    let mut write = next_day_write(
        next["nextTrainingDay"]["scheduledDate"].as_str().unwrap(),
        2,
        vec![high],
    );
    write["mode"] = json!("append");
    let saved = app.save_next_training_day_sessions(&write).unwrap();
    assert_eq!(saved["revision"], json!(3));

    let moved = app.update_planned_session("s1", &json!({ "action": "move_occurrence", "expectedRevision": 3, "scheduledDate": "2026-09-24" })).unwrap();
    assert_eq!(moved["revision"], json!(4));
    assert_eq!(moved["sessions"][0]["id"], json!("s1"));
    assert_eq!(moved["sessions"][0]["weekNumber"], json!(2));
    assert_eq!(
        moved["sessions"][0]["phaseRefs"][0]["phaseId"],
        json!("phase-2")
    );
}

#[test]
fn next_training_day_sessions_validate_and_save_with_revision_guards() {
    let app = test_app();
    assert_eq!(
        app.get_next_training_day(None).unwrap(),
        json!({ "nextTrainingDay": null, "reasonCode": "NO_CURRENT_PLAN" })
    );

    let no_plan = app
        .validate_next_training_day_sessions(&next_day_write(
            "2026-09-21",
            0,
            vec![next_day_session("n1")],
        ))
        .unwrap_err();
    assert_eq!(no_plan.code(), AthriaErrorCode::NoCurrentPlan);
    assert_eq!(
        no_plan.message(),
        "There is no available next training day."
    );
    assert_eq!(no_plan.status(), 409);

    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );
    app.save_current_plan(&monday_plan_write(0)).unwrap();
    app.update_planned_session(
        "s1",
        &json!({ "action": "complete", "expectedRevision": 1 }),
    )
    .unwrap();

    let wrong_date = app
        .validate_next_training_day_sessions(&next_day_write(
            "2026-09-22",
            1,
            vec![next_day_session("n1")],
        ))
        .unwrap_err();
    assert_eq!(wrong_date.code(), AthriaErrorCode::NextTrainingDayChanged);
    assert_eq!(
        wrong_date.message(),
        "Refresh the next training day before saving sessions."
    );
    assert_eq!(wrong_date.status(), 409);

    let stale = app
        .validate_next_training_day_sessions(&next_day_write(
            "2026-09-21",
            0,
            vec![next_day_session("n1")],
        ))
        .unwrap_err();
    assert_eq!(
        stale.code(),
        AthriaErrorCode::PlannedSessionRevisionConflict
    );
    assert_eq!(
        stale.message(),
        "The planned sessions changed. Refresh and confirm the update again."
    );
    assert_eq!(stale.status(), 409);

    let duplicated = app
        .validate_next_training_day_sessions(&next_day_write(
            "2026-09-21",
            1,
            vec![next_day_session("n1"), next_day_session("n1")],
        ))
        .unwrap_err();
    assert_eq!(
        duplicated.code(),
        AthriaErrorCode::DuplicatePlannedSessionId
    );
    assert_eq!(duplicated.message(), "Session IDs must be unique.");
    assert_eq!(duplicated.status(), 400);

    let validated = app
        .validate_next_training_day_sessions(&next_day_write(
            "2026-09-21",
            1,
            vec![next_day_session("n1")],
        ))
        .unwrap();
    assert_eq!(validated["valid"], json!(true));
    assert_eq!(validated["scheduledDate"], json!("2026-09-21"));
    assert_eq!(validated["revision"], json!(1));
    let session = &validated["sessions"][0];
    assert_eq!(session["id"], json!("n1"));
    assert_eq!(session["occurrenceId"], json!("plan:2026-09-21"));
    assert_eq!(session["planRevision"], json!(1));
    assert_eq!(session["scheduledDate"], json!("2026-09-21"));
    assert_eq!(session["order"], json!(0));
    assert_eq!(session["weekNumber"], json!(2));
    assert_eq!(session["status"], json!("planned"));
    assert_eq!(session["displayState"], json!("scheduled"));
    assert_eq!(session["createdAt"], json!(NOW));
    assert_eq!(session["match"], json!(null));
    assert_eq!(
        session["phaseRefs"],
        json!([{ "domain": "endurance", "phaseId": "phase-2" }])
    );

    let saved = app
        .save_next_training_day_sessions(&next_day_write(
            "2026-09-21",
            1,
            vec![next_day_session("n1")],
        ))
        .unwrap();
    assert_eq!(saved["revision"], json!(2));
    assert_eq!(saved["idempotentReplay"], json!(false));
    assert_eq!(saved["sessions"][0]["id"], json!("n1"));
    assert_eq!(
        saved["sessions"][0]["occurrenceId"],
        json!("plan:2026-09-21")
    );

    let replay = app
        .save_next_training_day_sessions(&next_day_write(
            "2026-09-21",
            1,
            vec![next_day_session("n1")],
        ))
        .unwrap_err();
    assert_eq!(
        replay.code(),
        AthriaErrorCode::PlannedSessionRevisionConflict
    );
    assert_eq!(
        replay.message(),
        "The planned sessions changed. Refresh and confirm the update again."
    );
    assert_eq!(replay.status(), 409);
}

#[test]
fn intervals_swim_resync_matches_plan_and_preserves_user_choices() {
    let app = test_app();
    let mut plan = plan_with_run();
    plan["mesocycle"]["weeks"][0]["sessions"][0]["scheduledDate"] = json!("2026-10-07");
    plan["mesocycle"]["weeks"][0]["sessions"][0]["name"] = json!("Swimming class");
    plan["mesocycle"]["weeks"][0]["sessions"][0]["type"] = json!("Swim");
    app.store().save_current_plan(&plan, 0).unwrap();
    let context = json!({ "attemptedAt": "2026-10-08T02:02:22Z", "rangeStart": "2026-10-07", "rangeEnd": "2026-10-07" });
    let payload = json!({ "activities": [{ "id": "i194646139", "type": "OpenWaterSwim", "name": "Swim",
        "start_date": "2026-10-07T11:03:08Z", "moving_time": 2880, "distance": 925 }], "wellness": [] });
    let id = "intervals:activities:i194646139";
    let mut old = imported_session("intervals", "activities:i194646139", id, "2026-10-07T11:03:08Z", "2026-10-07T11:51:08Z", 48, "Swim");
    old["domains"] = json!([]);
    old["type"] = json!("OpenWaterSwim");
    app.store().upsert_sessions(&[old]).unwrap();
    app.commit_intervals(&payload, &context).unwrap();
    let read = || app.store().list_sessions("local-user", None).unwrap();
    let sessions = read();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["type"], "Swim");
    assert_eq!(sessions[0]["subtype"], "openwaterswim");
    assert_eq!(sessions[0]["domains"], json!(["endurance"]));
    assert_eq!(sessions[0]["durationMinutes"], 48);
    assert_eq!(sessions[0]["endurance"]["distanceMeters"], 925);
    assert_eq!(sessions[0]["planMatch"]["method"], "auto");
    assert_eq!(sessions[0]["plannedSessionId"], "s1");
    app.set_training_session_plan_match(id, &json!({ "plannedSessionId": "s1", "expectedRevision": 1, "confirmed": true })).unwrap();
    app.commit_intervals(&payload, &context).unwrap();
    assert_eq!(read()[0]["planMatch"]["method"], "manual");
    app.set_training_session_plan_match(id, &json!({ "plannedSessionId": null, "expectedRevision": 1, "confirmed": true })).unwrap();
    app.commit_intervals(&payload, &context).unwrap();
    let sessions = read();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["domains"], json!(["endurance"]));
    assert_eq!(sessions[0]["isPlanMatchExcluded"], true);
    assert_eq!(sessions[0]["planMatch"], Value::Null);
}

#[test]
fn six_domains_count_functional_duration_once_and_strength_from_content() {
    let app = test_app();
    for (index, kind) in ["StrengthTraining","Run","Tennis","Yoga","Mobility","Hyrox"].into_iter().enumerate() {
        record(&app, json!({"type":kind,"name":kind,"startAt":format!("2026-09-16T{:02}:00:00Z", index+1),"endAt":format!("2026-09-16T{:02}:30:00Z", index+1),"durationMinutes":30,"strengthSets":if kind == "Hyrox" {json!([{ "exerciseRaw":"Squat","setIndex":0,"reps":10,"weight":20,"weightUnit":"kg" }])} else {json!([])},"endurance":{"averageHeartRate":140}}));
    }
    let summary = app.get_training_summary(30, None, None).unwrap();
    for domain in ["strength","endurance","sport_skill","mind_body","mobility","functional"] {
        assert_eq!(summary["byDomain"][domain], 1);
        assert_eq!(summary["durationMinutesByDomain"][domain], 30);
    }
    assert_eq!(summary["totalDurationMinutes"], 180);
    assert_eq!(summary["metrics"]["strength"]["workingSets"]["value"], 1);
    assert_eq!(summary["metrics"]["endurance"]["durationMinutes"]["value"], 30);
}

#[test]
fn new_manual_records_and_plans_require_a_known_type() {
    let app = test_app();
    let mut value = json!({"name":"Unknown","startAt":"2026-09-16T01:00:00Z","endAt":"2026-09-16T01:30:00Z","durationMinutes":30});
    assert_eq!(app.record_training_session(&value).unwrap_err().code(), AthriaErrorCode::InvalidData);
    value["type"] = json!("Unknown");
    assert_eq!(app.record_training_session(&value).unwrap_err().code(), AthriaErrorCode::InvalidData);
    value["sport"] = json!("WeightTraining");
    value["type"] = Value::Null;
    assert!(app.record_training_session(&value).is_err());
    value.as_object_mut().unwrap().remove("sport");
    value["type"] = json!("WeightTraining");
    let session = app.record_training_session(&value).unwrap();
    assert_eq!(session["type"], "StrengthTraining");
    assert_eq!(session["subtype"], Value::Null);
    let mut plan = monday_plan_write(0);
    plan["mesocycle"]["weeks"][0]["sessions"][0]["type"] = Value::Null;
    assert_eq!(app.save_current_plan(&plan).unwrap_err().code(), AthriaErrorCode::InvalidData);
}


fn commit_monday_plan(app: &AthriaApplication<SqliteStore>) -> String {
    patch_profile(app, json!({"trainingRhythm":{"kind":"fixed_week","days":[0]}}));
    let mut plan = monday_plan_write(0);
    let weeks = plan["mesocycle"]["weeks"].as_array().unwrap().clone();
    plan["mesocycle"]["weeks"] = json!([]);
    let draft = app.create_plan_draft(&json!({"mode":"new", "plan":plan})).unwrap();
    let id = draft["draftId"].as_str().unwrap().to_owned();
    for (index, week) in weeks.iter().enumerate() {
        app.upsert_plan_draft_week(&id, index as i64, week).unwrap();
    }
    app.commit_plan_draft(&id, 2, 0, &app.snapshot_hash().unwrap(), true).unwrap();
    id
}

#[test]
fn review_diff_is_net_since_commit_and_profile_remains_authoritative() {
    let app = test_app();
    patch_profile(&app, json!({"goals":["endurance"], "preference":"A"}));
    let draft_id = commit_monday_plan(&app);
    let anchor = app.store().get_plan_review_context("local-user").unwrap().unwrap();
    assert_eq!(anchor["committedAt"], NOW);
    assert_eq!(anchor["committedPlanRevision"], 1);
    assert_eq!(anchor["profileChanges"], json!([]));
    // Full App saves and MCP-style patches pass through the same store path.
    let mut profile = app.get_profile().unwrap();
    profile["preference"] = "B".into();
    app.save_profile(&profile).unwrap();
    patch_profile(&app, json!({"preference":"C"}));
    let review = app.review_current_plan_for_adjustment(AdjustmentTrigger::UserRequest).unwrap();
    let context = app.get_plan_adjustment_context().unwrap();
    assert_eq!(context["from"], "2026-09-17");
    assert_eq!(context["to"], "2026-09-17");
    assert_eq!(context["profileChanges"].as_array().unwrap().len(), 1);
    assert_eq!(context["profileChanges"][0]["before"], "A");
    assert_eq!(context["profileChanges"][0]["after"], "C");
    assert_eq!(app.get_profile().unwrap()["goals"], json!(["endurance"]));
    // The diff remains an Agent hint, not an invented deterministic signal.
    assert!(!review.reasons.iter().any(|reason| format!("{:?}", reason.reason_code).contains("Preference")));
    let before = app.store().get_plan_review_context("local-user").unwrap();
    patch_profile(&app, json!({"preference":"C", "preferredName":"New name"}));
    assert_eq!(app.store().get_plan_review_context("local-user").unwrap(), before);
    assert!(app.update_profile(&json!({"expectedProfileHash":"stale", "patch":{"preference":"D"}})).is_err());
    assert_eq!(app.store().get_plan_review_context("local-user").unwrap(), before);
    // A repeated submission of a removed draft must not consume later changes.
    assert_eq!(app.commit_plan_draft(&draft_id, 2, 0, "stale", true).unwrap_err().code(), AthriaErrorCode::DraftNotFound);
    assert_eq!(app.store().get_plan_review_context("local-user").unwrap(), before);
    patch_profile(&app, json!({"preference":"A"}));
    assert_eq!(app.store().get_plan_review_context("local-user").unwrap().unwrap()["profileChanges"], json!([]));
}

#[test]
fn review_anchor_survives_workout_operations_drafts_and_failed_commits() {
    let app = test_app();
    commit_monday_plan(&app);
    patch_profile(&app, json!({"preference":"More easy running"}));
    let before = app.store().get_plan_review_context("local-user").unwrap();
    app.update_planned_session("s2", &json!({"action":"move_occurrence", "expectedRevision":1,"scheduledDate":"2026-09-22"})).unwrap();
    app.update_planned_session("s2", &json!({"action":"skip", "expectedRevision":2})).unwrap();
    let draft = app.create_plan_draft(&json!({"mode":"current_plan"})).unwrap();
    let id = draft["draftId"].as_str().unwrap();
    let revision = draft["basePlanRevision"].as_i64().unwrap();
    let draft_revision = draft["draftRevision"].as_i64().unwrap();
    assert!(app.commit_plan_draft(id, draft_revision, revision, "stale", true).is_err());
    assert_eq!(app.store().get_plan_review_context("local-user").unwrap(), before);
    app.discard_plan_draft(id, draft_revision).unwrap();
    assert_eq!(app.store().get_plan_review_context("local-user").unwrap(), before);
    app.review_current_plan_for_adjustment(AdjustmentTrigger::WeeklyReview).unwrap();
    assert_eq!(app.store().get_plan_review_context("local-user").unwrap(), before);
}

#[test]
fn review_window_uses_commit_date_in_current_profile_timezone_and_legacy_fallback() {
    let app = test_app();
    patch_profile(&app, json!({"trainingRhythm":{"kind":"fixed_week","days":[0]}}));
    app.save_current_plan(&monday_plan_write(0)).unwrap();
    let review = app.get_plan_adjustment_context().unwrap();
    assert_eq!(review["trackingComplete"], false);
    assert_eq!(review["from"], "2026-09-14");
    assert!(review["committedAt"].is_null());
    app.store().reset_plan_review_context("local-user", "2026-08-26T23:30:00Z", 1).unwrap();
    let context = app.get_plan_adjustment_context().unwrap();
    assert_eq!(context["from"], "2026-08-27");
    assert_eq!(context["to"], "2026-09-17");
    patch_profile(&app, json!({"timezone":"America/Los_Angeles"}));
    let context = app.get_plan_adjustment_context().unwrap();
    assert_eq!(context["from"], "2026-08-26");
    assert_eq!(context["to"], "2026-09-16");
    // Legacy plan with future effective start has no execution evidence.
    let future = test_app();
    patch_profile(&future, json!({"trainingRhythm":{"kind":"fixed_week","days":[0]}}));
    let mut plan = monday_plan_write(0);
    plan["effectiveStartDate"] = "2026-10-05".into();
    plan["mesocycle"]["weeks"][0]["sessions"][0]["scheduledDate"] = "2026-10-05".into();
    plan["mesocycle"]["weeks"][1]["sessions"][0]["scheduledDate"] = "2026-10-12".into();
    future.save_current_plan(&plan).unwrap();
    let context = future.get_plan_adjustment_context().unwrap();
    assert_eq!(context["hasExecutionWindow"], false);
    assert_eq!(context["from"], "2026-10-05");
}

#[test]
fn explicit_history_windows_align_summary_sessions_and_wellness_in_profile_timezone() {
    let app = test_app();
    for instant in ["2026-08-26T15:59:59Z", "2026-08-26T16:00:00Z", "2026-08-26T09:01:00-07:00", "2026-09-17T15:59:59Z", "2026-09-17T16:00:00Z"] {
        record(&app, json!({"type":"Running", "name":"Run", "timezone":"America/Los_Angeles", "startAt":instant,"endAt":athria_core::tz::iso_from_millis(athria_core::tz::millis(instant).unwrap() + 1_800_000),"durationMinutes":30}));
    }
    for day in ["2026-08-26", "2026-08-27", "2026-09-17", "2026-09-18"] {
        app.store().upsert_wellness("local-user", &[json!({"id":day,"sleepScore":80})]).unwrap();
    }
    // Explicit dates override even a one-day rolling lookback.
    let sessions = app.list_sessions_in_window(1, Some("2026-08-27"), Some("2026-09-17")).unwrap();
    let summary = app.get_training_summary(1, Some("2026-08-27"), Some("2026-09-17")).unwrap();
    let wellness = app.list_wellness_in_window(1, Some("2026-08-27"), Some("2026-09-17")).unwrap();
    assert_eq!(sessions.len(), 3);
    assert_eq!(summary["sessionCount"], 3);
    assert_eq!(wellness.len(), 2);
    assert_eq!(wellness[0]["day"], "2026-09-17");
    assert!(sessions.iter().all(|session| session["snapshotHash"].is_string()));
    assert_eq!(app.list_sessions_in_window(1, Some("2026-09-17"), Some("2026-09-17")).unwrap().len(), 1);
    for (from, to) in [(Some("2026-09-17"), None), (None, Some("2026-09-17")), (Some("2026-02-30"), Some("2026-09-17")), (Some("2026-09-18"), Some("2026-09-17"))] {
        assert!(app.list_sessions_in_window(7, from, to).is_err());
        assert!(app.list_wellness_in_window(7, from, to).is_err());
        assert!(app.get_training_summary(7, from, to).is_err());
    }
    assert_eq!(app.list_sessions_in_window(30, None, None).unwrap(), app.list_sessions_with_snapshots(30).unwrap());
    assert_eq!(app.list_wellness_in_window(42, None, None).unwrap(), app.list_wellness(42).unwrap());
}


#[test]
fn failed_anchor_reset_rolls_back_the_whole_plan_commit_and_success_consumes_diff() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("commit.sqlite3");
    let clock = Arc::new(FixedClock::new(NOW));
    let app = AthriaApplication::with_clock(SqliteStore::open_with_clock(&path, clock.clone()).unwrap(), "local-user", clock);
    commit_monday_plan(&app);
    patch_profile(&app, json!({"preference":"More easy running"}));
    let original_context = app.store().get_plan_review_context("local-user").unwrap();
    let original_plan = app.get_current_plan().unwrap();
    let draft = app.create_plan_draft(&json!({"mode":"current_plan"})).unwrap();
    let id = draft["draftId"].as_str().unwrap();
    let revision = draft["draftRevision"].as_i64().unwrap();
    let snapshot = app.snapshot_hash().unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_context_reset BEFORE UPDATE ON plan_review_context BEGIN SELECT RAISE(ABORT, 'test reset failure'); END;").unwrap();
    assert!(app.commit_plan_draft(id, revision, 1, &snapshot, true).is_err());
    assert_eq!(app.get_current_plan().unwrap(), original_plan);
    assert_eq!(app.store().get_plan_review_context("local-user").unwrap(), original_context);
    assert_eq!(app.get_plan_draft(id, None).unwrap()["draftRevision"], revision);
    connection.execute_batch("DROP TRIGGER fail_context_reset;").unwrap();
    app.commit_plan_draft(id, revision, 1, &snapshot, true).unwrap();
    let context = app.store().get_plan_review_context("local-user").unwrap().unwrap();
    assert_eq!(context["committedPlanRevision"], 2);
    assert_eq!(context["profileChanges"], json!([]));
}


#[test]
fn draft_delete_failure_rolls_back_plan_review_context_and_cascade() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("draft-delete-rollback.sqlite3");
    let clock = Arc::new(FixedClock::new(NOW));
    let app = AthriaApplication::with_clock(SqliteStore::open_with_clock(&path, clock.clone()).unwrap(), "local-user", clock);
    commit_monday_plan(&app);
    patch_profile(&app, json!({"preference":"More easy running"}));
    let original_context = app.store().get_plan_review_context("local-user").unwrap();
    let original_plan = app.get_current_plan().unwrap();
    let draft = app.create_plan_draft(&json!({"mode":"current_plan"})).unwrap();
    let id = draft["draftId"].as_str().unwrap();
    let original_weeks = app.store().list_plan_draft_weeks(id).unwrap();
    let snapshot = app.snapshot_hash().unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    // Fail after the delete (and foreign-key cascade) to exercise full rollback.
    connection.execute_batch("CREATE TRIGGER fail_draft_delete AFTER DELETE ON plan_drafts BEGIN SELECT RAISE(ABORT, 'test draft delete failure'); END;").unwrap();
    assert!(app.commit_plan_draft(id, 2, 1, &snapshot, true).is_err());
    assert_eq!(app.get_current_plan().unwrap(), original_plan);
    assert_eq!(app.store().get_plan_review_context("local-user").unwrap(), original_context);
    assert_eq!(app.get_plan_draft(id, None).unwrap(), draft);
    assert_eq!(app.store().list_plan_draft_weeks(id).unwrap(), original_weeks);
    assert_eq!(app.snapshot_hash().unwrap(), snapshot);
    connection.execute_batch("DROP TRIGGER fail_draft_delete;").unwrap();
    app.commit_plan_draft(id, 2, 1, &snapshot, true).unwrap();
    assert!(app.store().get_plan_draft(id, "local-user").unwrap().is_none());
    assert!(app.store().list_plan_draft_weeks(id).unwrap().is_empty());
    assert_eq!(app.get_current_plan().unwrap().unwrap()["sourceDraftId"], id);
    assert_eq!(app.store().get_plan_review_context("local-user").unwrap().unwrap()["profileChanges"], json!([]));
}

#[test]
fn effort_edits_require_confirmation_valid_integers_and_a_fresh_snapshot() {
    let app = test_app();
    app.record_training_session(&json!({"type":"Run","name":"Run","startAt":"2026-09-16T09:00:00Z","durationMinutes":30})).unwrap();
    let session = app.list_sessions_with_snapshots(30).unwrap().remove(0);
    let id = session["id"].as_str().unwrap();
    let hash = &session["snapshotHash"];
    assert!(app.set_training_session_effort(id, &json!({"rpe":7,"expectedSnapshotHash":hash})).is_err());
    assert!(app.set_training_session_effort(id, &json!({"rpe":7,"confirmed":true})).is_err());
    for rpe in [json!(0), json!(11), json!(2.5), json!("7"), json!(false)] {
        assert!(app.set_training_session_effort(id,&json!({"rpe":rpe,"confirmed":true,"expectedSnapshotHash":hash})).is_err());
    }
    let changed = app.set_training_session_effort(id,&json!({"rpe":7,"confirmed":true,"expectedSnapshotHash":hash})).unwrap();
    assert_eq!(changed["rpe"],json!(7));
    assert_eq!(changed["sessionRpe"],json!(210));
    let stale = app.set_training_session_effort(id,&json!({"rpe":8,"confirmed":true,"expectedSnapshotHash":hash})).unwrap_err();
    assert_eq!(stale.code(),AthriaErrorCode::InputSnapshotChanged);
    let fresh = app.list_sessions_with_snapshots(30).unwrap().remove(0);
    assert!(app.set_training_session_effort(id,&json!({"rpe":null,"confirmed":true,"expectedSnapshotHash":fresh["snapshotHash"]})).unwrap()["rpe"].is_null());
}

// ---------------------------------------------------------------------------
// Draft history protection and scoped validation
// ---------------------------------------------------------------------------

#[test]
fn draft_commits_cannot_rewrite_or_delete_historical_sessions() {
    let app = test_app();
    commit_monday_plan(&app);
    app.update_planned_session(
        "s1",
        &json!({ "action": "complete", "expectedRevision": 1 }),
    )
    .unwrap();
    let plan_before = app.get_current_plan().unwrap().unwrap();
    let plan_revision = plan_before["revision"].as_i64().unwrap();
    let projection_before = app
        .store()
        .list_current_planned_sessions("local-user", None)
        .unwrap();
    let workouts_before = app.list_sessions(28).unwrap();

    let draft = app
        .create_plan_draft(&json!({ "mode": "current_plan" }))
        .unwrap();
    let id = draft["draftId"].as_str().unwrap().to_owned();
    let mut week = app
        .store()
        .list_plan_draft_weeks(&id)
        .unwrap()
        .into_iter()
        .find(|week| week["weekNumber"] == 1)
        .unwrap();
    week["sessions"][0]["name"] = json!("Rewritten Run");
    app.upsert_plan_draft_week(&id, 2, &week).unwrap();
    let error = app.validate_plan_draft(&id).unwrap_err();
    assert_eq!(error.code(), AthriaErrorCode::HistoricalSessionProtected);
    assert_eq!(error.status(), 409);
    assert!(error.message().contains("s1"));
    let commit_error = app
        .commit_plan_draft(&id, 3, plan_revision, &app.snapshot_hash().unwrap(), true)
        .unwrap_err();
    assert_eq!(
        commit_error.code(),
        AthriaErrorCode::HistoricalSessionProtected
    );
    assert_eq!(app.get_current_plan().unwrap().unwrap(), plan_before);
    assert!(app.store().get_plan_draft(&id, "local-user").unwrap().is_some());
    assert_eq!(
        app.store()
            .list_current_planned_sessions("local-user", None)
            .unwrap(),
        projection_before
    );
    assert_eq!(app.list_sessions(28).unwrap(), workouts_before);
    app.discard_plan_draft(&id, 3).unwrap();

    let draft = app
        .create_plan_draft(&json!({ "mode": "current_plan" }))
        .unwrap();
    let id = draft["draftId"].as_str().unwrap().to_owned();
    app.remove_plan_draft_session(&id, 2, 1, "s1").unwrap();
    let error = app.validate_plan_draft(&id).unwrap_err();
    assert_eq!(error.code(), AthriaErrorCode::HistoricalSessionProtected);
    assert!(error.message().contains("s1"));
    assert_eq!(app.get_current_plan().unwrap().unwrap(), plan_before);
}

#[test]
fn profile_rhythm_change_does_not_block_future_adjustment_but_keeps_app_review_conflict() {
    let app = test_app();
    commit_monday_plan(&app);
    app.update_planned_session(
        "s1",
        &json!({ "action": "complete", "expectedRevision": 1 }),
    )
    .unwrap();
    patch_profile(
        &app,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [1] } }),
    );

    let full = app.validate_current_plan(&monday_plan_write(1)).unwrap();
    assert!(!full.valid);
    assert!(full.results.iter().any(|rule| {
        rule["reasonCode"] == "PROFILE_TRAINING_RHYTHM" && rule["status"] == "fail"
    }));

    let review = app
        .review_current_plan_for_adjustment(AdjustmentTrigger::ProfileChange)
        .unwrap();
    assert_eq!(review.review_status, ReviewStatus::ReviewRequired);
    assert!(
        review
            .reasons
            .iter()
            .any(|reason| reason.reason_code == ReasonCode::ProfileTrainingRhythmConflict)
    );

    let complete = monday_plan_write(0);
    let weeks = complete["mesocycle"]["weeks"].as_array().unwrap().clone();
    let mut metadata = complete;
    metadata["mesocycle"]["weeks"] = json!([]);
    metadata["mesocycle"]["schedule"]["days"] = json!([1]);
    let draft = app
        .create_plan_draft(&json!({ "mode": "new", "plan": metadata }))
        .unwrap();
    let id = draft["draftId"].as_str().unwrap().to_owned();
    app.upsert_plan_draft_week(&id, 0, &weeks[0]).unwrap();
    let mut week2 = weeks[1].clone();
    week2["sessions"][0]["scheduledDate"] = json!("2026-09-22");
    app.upsert_plan_draft_week(&id, 1, &week2).unwrap();

    let validation = app.validate_plan_draft(&id).unwrap();
    assert!(validation.valid);
    let committed = app
        .commit_plan_draft(&id, 2, 1, &app.snapshot_hash().unwrap(), true)
        .unwrap();
    assert_eq!(committed["revision"], 2);

    let plan = app.get_current_plan().unwrap().unwrap();
    assert_eq!(plan["effectiveStartDate"], "2026-09-14");
    assert_eq!(plan["mesocycle"]["schedule"]["days"], json!([1]));
    assert_eq!(plan["mesocycle"]["weeks"][0]["sessions"][0]["id"], "s1");
    assert_eq!(
        plan["mesocycle"]["weeks"][0]["sessions"][0]["scheduledDate"],
        "2026-09-14"
    );
    assert_eq!(
        plan["mesocycle"]["weeks"][0]["sessions"][0]["name"],
        "Easy Run"
    );
    assert_eq!(
        plan["mesocycle"]["weeks"][1]["sessions"][0]["scheduledDate"],
        "2026-09-22"
    );
    let projection = app
        .store()
        .list_current_planned_sessions("local-user", None)
        .unwrap();
    let s1 = projection
        .iter()
        .find(|session| session["id"] == "s1")
        .unwrap();
    assert_eq!(s1["status"], "completed");
    assert_eq!(s1["match"]["method"], "manual");
    assert_eq!(app.list_sessions(28).unwrap().len(), 1);
}

#[test]
fn today_and_future_planned_sessions_remain_editable_after_a_completed_day() {
    let app = test_app();
    let flexible = json!({
        "kind": "flexible_week",
        "targetDaysPerWeek": 3,
        "minDaysPerWeek": 1,
        "maxDaysPerWeek": 3,
    });
    patch_profile(&app, json!({ "trainingRhythm": flexible.clone() }));
    let plan = plan_write(
        flexible,
        2,
        "2026-09-14",
        endurance_progressions(2),
        vec![
            plan_week(
                1,
                vec![
                    plan_session(
                        "s1",
                        "2026-09-16",
                        0,
                        "low",
                        plan_component("c1", "Run", "endurance")["prescription"].clone(),
                    ),
                    plan_session(
                        "s2",
                        "2026-09-17",
                        0,
                        "low",
                        plan_component("c2", "Run", "endurance")["prescription"].clone(),
                    ),
                ],
            ),
            plan_week(
                2,
                vec![plan_session(
                    "s3",
                    "2026-09-21",
                    0,
                    "low",
                    plan_component("c3", "Run", "endurance")["prescription"].clone(),
                )],
            ),
        ],
        0,
    );
    app.save_current_plan(&plan).unwrap();
    app.update_planned_session(
        "s1",
        &json!({ "action": "complete", "expectedRevision": 1 }),
    )
    .unwrap();

    let draft = app
        .create_plan_draft(&json!({ "mode": "current_plan" }))
        .unwrap();
    let id = draft["draftId"].as_str().unwrap().to_owned();
    let mut week1 = app
        .store()
        .list_plan_draft_weeks(&id)
        .unwrap()
        .into_iter()
        .find(|week| week["weekNumber"] == 1)
        .unwrap();
    week1["sessions"][1]["name"] = json!("Adjusted Today Run");
    app.upsert_plan_draft_week(&id, 2, &week1).unwrap();
    let mut week2 = app
        .store()
        .list_plan_draft_weeks(&id)
        .unwrap()
        .into_iter()
        .find(|week| week["weekNumber"] == 2)
        .unwrap();
    week2["sessions"][0]["scheduledDate"] = json!("2026-09-22");
    app.upsert_plan_draft_week(&id, 3, &week2).unwrap();

    assert!(app.validate_plan_draft(&id).unwrap().valid);
    app.commit_plan_draft(&id, 4, 1, &app.snapshot_hash().unwrap(), true)
        .unwrap();

    let plan = app.get_current_plan().unwrap().unwrap();
    assert_eq!(
        plan["mesocycle"]["weeks"][0]["sessions"][0]["name"],
        "Easy Run"
    );
    assert_eq!(
        plan["mesocycle"]["weeks"][0]["sessions"][1]["name"],
        "Adjusted Today Run"
    );
    assert_eq!(
        plan["mesocycle"]["weeks"][1]["sessions"][0]["scheduledDate"],
        "2026-09-22"
    );
    let projection = app
        .store()
        .list_current_planned_sessions("local-user", None)
        .unwrap();
    let s1 = projection
        .iter()
        .find(|session| session["id"] == "s1")
        .unwrap();
    assert_eq!(s1["status"], "completed");
    assert_eq!(s1["match"]["method"], "manual");
    assert_eq!(app.list_sessions(28).unwrap().len(), 1);
}

#[test]
fn a_successor_cycle_can_replace_the_plan_but_cannot_overlap_or_start_before_today() {
    let app = test_app();
    commit_monday_plan(&app);
    app.update_planned_session(
        "s1",
        &json!({ "action": "complete", "expectedRevision": 1 }),
    )
    .unwrap();
    assert_eq!(app.list_sessions(28).unwrap().len(), 1);

    let successor = plan_write(
        json!({ "kind": "fixed_week", "days": [0] }),
        2,
        "2026-09-28",
        endurance_progressions(2),
        vec![],
        0,
    );
    let draft = app
        .create_plan_draft(&json!({ "mode": "new", "plan": successor }))
        .unwrap();
    let id = draft["draftId"].as_str().unwrap().to_owned();
    let week1 = plan_week(
        1,
        vec![plan_session(
            "n1",
            "2026-09-28",
            0,
            "low",
            plan_component("n1-c1", "Run", "endurance")["prescription"].clone(),
        )],
    );
    let week2 = plan_week(
        2,
        vec![plan_session(
            "n2",
            "2026-10-05",
            0,
            "low",
            plan_component("n2-c1", "Run", "endurance")["prescription"].clone(),
        )],
    );
    app.upsert_plan_draft_week(&id, 0, &week1).unwrap();
    app.upsert_plan_draft_week(&id, 1, &week2).unwrap();
    assert!(app.validate_plan_draft(&id).unwrap().valid);
    let committed = app
        .commit_plan_draft(&id, 2, 1, &app.snapshot_hash().unwrap(), true)
        .unwrap();
    assert_eq!(committed["revision"], 2);
    let plan = app.get_current_plan().unwrap().unwrap();
    assert_eq!(plan["effectiveStartDate"], "2026-09-28");
    assert_eq!(app.list_sessions(28).unwrap().len(), 1);

    let overlapping = test_app();
    commit_monday_plan(&overlapping);
    let metadata = plan_write(
        json!({ "kind": "fixed_week", "days": [0] }),
        2,
        "2026-09-21",
        endurance_progressions(2),
        vec![],
        0,
    );
    let draft = overlapping
        .create_plan_draft(&json!({ "mode": "new", "plan": metadata }))
        .unwrap();
    let id = draft["draftId"].as_str().unwrap().to_owned();
    let week1 = plan_week(
        1,
        vec![plan_session(
            "n1",
            "2026-09-21",
            0,
            "low",
            plan_component("n1-c1", "Run", "endurance")["prescription"].clone(),
        )],
    );
    let week2 = plan_week(
        2,
        vec![plan_session(
            "n2",
            "2026-09-28",
            0,
            "low",
            plan_component("n2-c1", "Run", "endurance")["prescription"].clone(),
        )],
    );
    overlapping
        .upsert_plan_draft_week(&id, 0, &week1)
        .unwrap();
    overlapping
        .upsert_plan_draft_week(&id, 1, &week2)
        .unwrap();
    let error = overlapping.validate_plan_draft(&id).unwrap_err();
    assert_eq!(error.code(), AthriaErrorCode::HistoricalSessionProtected);
    assert!(error.message().contains("s1"));

    let ended = test_app();
    patch_profile(
        &ended,
        json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }),
    );
    let old = plan_write(
        json!({ "kind": "fixed_week", "days": [0] }),
        2,
        "2026-08-31",
        endurance_progressions(2),
        vec![
            plan_week(
                1,
                vec![plan_session(
                    "s1",
                    "2026-08-31",
                    0,
                    "low",
                    plan_component("c1", "Run", "endurance")["prescription"].clone(),
                )],
            ),
            plan_week(
                2,
                vec![plan_session(
                    "s2",
                    "2026-09-07",
                    0,
                    "low",
                    plan_component("c2", "Run", "endurance")["prescription"].clone(),
                )],
            ),
        ],
        0,
    );
    ended.save_current_plan(&old).unwrap();
    let metadata = plan_write(
        json!({ "kind": "fixed_week", "days": [0] }),
        2,
        "2026-09-14",
        endurance_progressions(2),
        vec![],
        0,
    );
    let draft = ended
        .create_plan_draft(&json!({ "mode": "new", "plan": metadata }))
        .unwrap();
    let id = draft["draftId"].as_str().unwrap().to_owned();
    let week1 = plan_week(
        1,
        vec![plan_session(
            "n1",
            "2026-09-14",
            0,
            "low",
            plan_component("n1-c1", "Run", "endurance")["prescription"].clone(),
        )],
    );
    let week2 = plan_week(
        2,
        vec![plan_session(
            "n2",
            "2026-09-21",
            0,
            "low",
            plan_component("n2-c1", "Run", "endurance")["prescription"].clone(),
        )],
    );
    ended.upsert_plan_draft_week(&id, 0, &week1).unwrap();
    ended.upsert_plan_draft_week(&id, 1, &week2).unwrap();
    let error = ended.validate_plan_draft(&id).unwrap_err();
    assert_eq!(error.code(), AthriaErrorCode::HistoricalSessionProtected);
}

#[test]
fn drafts_preserve_unclassified_history_but_reject_new_unclassified_sessions() {
    let app = test_app();
    patch_profile(&app, json!({ "trainingRhythm": { "kind": "fixed_week", "days": [0] } }));
    app.save_current_plan(&monday_plan_write(0)).unwrap();
    let mut legacy = app.get_current_plan().unwrap().unwrap();
    legacy["mesocycle"]["weeks"][0]["sessions"][0]["type"] = Value::Null;
    app.store().save_current_plan(&legacy, 1).unwrap();
    let draft = app.create_plan_draft(&json!({ "mode": "current_plan" })).unwrap();
    let id = draft["draftId"].as_str().unwrap();
    let historical = legacy["mesocycle"]["weeks"][0]["sessions"][0].clone();
    app.upsert_plan_draft_session(id, 2, 1, None, &historical).unwrap();
    let mut week = legacy["mesocycle"]["weeks"][0].clone();
    app.upsert_plan_draft_week(id, 3, &week).unwrap();
    let mut invalid = legacy["mesocycle"]["weeks"][1]["sessions"][0].clone();
    invalid["type"] = Value::Null;
    assert_eq!(app.upsert_plan_draft_session(id, 4, 2, None, &invalid).unwrap_err().code(), AthriaErrorCode::InvalidData);
    week["sessions"][0]["name"] = json!("Changed history");
    assert_eq!(app.upsert_plan_draft_week(id, 4, &week).unwrap_err().code(), AthriaErrorCode::InvalidData);
    assert!(app.validate_plan_draft(id).unwrap().valid);
    app.commit_plan_draft(id, 4, 1, &app.snapshot_hash().unwrap(), true).unwrap();
    assert_eq!(app.get_current_plan().unwrap().unwrap()["mesocycle"]["weeks"][0]["sessions"][0], historical);
}
