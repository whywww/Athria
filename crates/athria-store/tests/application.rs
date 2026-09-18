//! Application use cases over the real SQLite store.
//!
//! `AthriaApplication` is generic over the `AthriaStore` port; these tests run
//! it against `SqliteStore` in memory with a fixed clock, which is the exact
//! wiring the desktop shell uses. The committed fixture replay covers the
//! stable application contract.

use std::sync::Arc;

use athria_application::AthriaApplication;
use athria_core::{
    AdjustmentScopePolicy, AdjustmentTrigger, AthriaErrorCode, FixedClock, ReasonCode,
    RecommendedScope, ReviewStatus, ScopeViolationCode,
};
use athria_store::SqliteStore;
use serde_json::{Value, json};

const NOW: &str = "2026-09-17T04:00:00.000Z";

fn test_app() -> AthriaApplication<SqliteStore> {
    let clock = Arc::new(FixedClock::new(NOW));
    let store =
        SqliteStore::open_in_memory_with_clock(clock.clone()).expect("in-memory store opens");
    AthriaApplication::with_clock(store, "local-user", clock)
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
    assert_eq!(profile["preferredName"], json!("Athlete"));
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
            "maxSessionMinutes",
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
                    "name": "Easy Run", "intent": "Aerobic base", "durationMinutes": 60, "recoveryDemand": "low", "keySession": false,
                    "components": [{
                        "id": "c1", "name": "Run",
                        "domain": { "value": "endurance", "source": "user_confirmed", "confidence": 1, "evidence": "", "taxonomyVersion": "strength-2.0" },
                        "prescription": { "kind": "duration_only", "notes": "" },
                    }],
                    "progressionNote": null, "schedulingRationale": null, "legacySnapshot": false,
                }],
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
        "id": id, "ownerId": "local-user", "source": source, "externalId": external_id, "modality": "endurance",
        "domains": ["endurance"], "sport": "Run", "name": name, "startAt": start_at, "endAt": end_at,
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
            "modality": "strength",
            "name": "Lower Strength",
            "startAt": "2026-09-16T09:00:00.000Z",
            "endAt": "2026-09-16T10:00:00.000Z",
            "durationMinutes": 60,
            "strengthSets": [{ "exerciseRaw": "Back Squat", "setIndex": 0, "weight": 100, "weightUnit": "kg", "reps": 5 }],
        }))
        .unwrap();
    let id = recorded["id"].as_str().expect("a generated id");
    assert_eq!(recorded["ownerId"], json!("local-user"));
    assert_eq!(recorded["source"], json!("manual"));
    assert_eq!(recorded["status"], json!("completed"));
    assert_eq!(recorded["externalId"], json!(id));
    assert_eq!(recorded["domains"], json!([]));
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
            "source",
            "externalId",
            "modality",
            "domains",
            "sport",
            "name",
            "startAt",
            "endAt",
            "durationMinutes",
            "status",
            "timezone",
            "plannedSessionId",
            "timePrecision",
            "sources",
            "planMatch",
            "isPlanMatchExcluded",
            "strengthSets",
            "endurance",
            "missingFields"
        ]
    );

    // `listSessions` derives the domain from the strength sets.
    let sessions = app.list_sessions(90).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["id"], json!(id));
    assert_eq!(sessions[0]["domains"], json!(["strength"]));
    assert_eq!(sessions[0]["missingFields"], json!([]));

    // Explicit ids survive the manual write path.
    let explicit = app
        .record_training_session(&json!({
            "id": "manual-1", "externalId": "manual-external-1",
            "modality": "strength", "name": "Upper Strength",
            "startAt": "2026-09-15T09:00:00.000Z", "endAt": "2026-09-15T10:00:00.000Z", "durationMinutes": 60,
            "strengthSets": [{ "exerciseRaw": "Bench Press", "setIndex": 0, "weight": 60, "weightUnit": "kg", "reps": 8 }],
        }))
        .unwrap();
    assert_eq!(explicit["id"], json!("manual-1"));
    assert_eq!(explicit["externalId"], json!("manual-external-1"));
}

#[test]
fn list_sessions_derives_endurance_domains_and_reports_missing_ones() {
    let app = test_app();
    // Nothing to derive from: `domains` is recorded as a missing field.
    let bare_id = record(
        &app,
        json!({
            "modality": "endurance", "name": "Bare Run",
            "startAt": "2026-09-14T10:00:00.000Z", "endAt": "2026-09-14T10:30:00.000Z", "durationMinutes": 30,
        }),
    );
    // Endurance details present: the domain is derived from them.
    let detailed_id = record(
        &app,
        json!({
            "modality": "endurance", "name": "Easy Run",
            "startAt": "2026-09-16T10:00:00.000Z", "endAt": "2026-09-16T10:30:00.000Z", "durationMinutes": 30,
            "endurance": { "distanceMeters": 5000 },
        }),
    );

    let sessions = app.list_sessions(90).unwrap();
    let bare = listed(&sessions, &bare_id);
    assert_eq!(bare["domains"], json!([]));
    assert_eq!(bare["missingFields"], json!(["domains"]));
    let detailed = listed(&sessions, &detailed_id);
    assert_eq!(detailed["domains"], json!(["endurance"]));
    assert_eq!(detailed["missingFields"], json!([]));

    // Only the response carries the derived domains; the stored document keeps
    // the empty array the schema parsed.
    let stored = app.store().list_sessions("local-user", None).unwrap();
    assert_eq!(listed(&stored, &detailed_id)["domains"], json!([]));
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
            "modality": "strength", "name": "Lower Strength",
            "startAt": "2026-09-16T09:00:00.000Z", "endAt": "2026-09-16T10:00:00.000Z", "durationMinutes": 60,
            "strengthSets": [{ "exerciseRaw": "Back Squat", "setIndex": 0, "weight": 100, "weightUnit": "kg", "reps": 5 }],
        }),
    );
    assert_ne!(before, app.snapshot_hash().unwrap());
}

#[test]
fn training_summary_groups_domains_and_sports() {
    let app = test_app();
    record(
        &app,
        json!({
            "modality": "strength", "domains": ["strength"], "name": "Lower Strength",
            "startAt": "2026-09-16T09:00:00.000Z", "endAt": "2026-09-16T10:00:00.000Z", "durationMinutes": 60,
            "strengthSets": [{ "exerciseRaw": "Back Squat", "setIndex": 0, "weight": 100, "weightUnit": "kg", "reps": 5 }],
        }),
    );
    record(
        &app,
        json!({
            "modality": "endurance", "domains": ["endurance"], "sport": "Run", "name": "Easy Run",
            "startAt": "2026-09-15T10:00:00.000Z", "endAt": "2026-09-15T10:30:00.000Z", "durationMinutes": 30,
        }),
    );
    record(
        &app,
        json!({
            "modality": "unknown", "domains": ["sport_skill"], "sport": "Basketball", "name": "Basketball",
            "startAt": "2026-09-15T12:00:00.000Z", "endAt": "2026-09-15T13:30:00.000Z", "durationMinutes": 90,
        }),
    );
    record(
        &app,
        json!({
            "modality": "unknown", "domains": ["sport_skill"], "sport": " Basketball ", "name": "Basketball",
            "startAt": "2026-09-16T12:00:00.000Z", "endAt": "2026-09-16T12:30:00.000Z", "durationMinutes": 30,
        }),
    );
    record(
        &app,
        json!({
            "modality": "unknown", "domains": ["sport_skill"], "sport": "Tennis", "name": "Tennis",
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
            "recovery"
        ]
    );
    assert_eq!(
        summary["byDomain"],
        json!({ "strength": 1, "endurance": 1, "sport_skill": 3, "mind_body": 0, "recovery": 0 })
    );
    assert_eq!(
        summary["durationMinutesByDomain"],
        json!({ "strength": 60, "endurance": 30, "sport_skill": 165, "mind_body": 0, "recovery": 0 })
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
        json!({ "strength": 0, "endurance": 1, "sport_skill": 1, "mind_body": 0, "recovery": 0 })
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
            "modality": "endurance", "domains": ["endurance"], "sport": "Run", "name": "Easy Run",
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
            "modality": "endurance", "domains": ["endurance"], "sport": "Run", "name": "Easy Run",
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
            "modality": "endurance", "domains": ["endurance"], "sport": "Run", "name": "Easy Run",
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
fn manual_sessions_can_be_retyped_and_retimed() {
    let app = test_app();
    let id = record(
        &app,
        json!({
            "modality": "endurance", "name": "Tempo Run", "sport": "Run",
            "startAt": "2026-09-16T02:00:00.000Z", "endAt": "2026-09-16T03:00:00.000Z", "durationMinutes": 60,
            "timePrecision": "date_only", "missingFields": ["actual start time"],
        }),
    );

    // An unknown domain never reaches the store.
    let invalid = app
        .update_training_session_type(&id, &json!({ "domain": "yoga", "confirmed": true }))
        .unwrap_err();
    assert_eq!(invalid.code(), AthriaErrorCode::InvalidData);
    assert_eq!(invalid.message(), "type.domain: expected a training domain");

    let retyped = app
        .update_training_session_type(&id, &json!({ "domain": "recovery", "confirmed": true }))
        .unwrap();
    assert_eq!(retyped["domains"], json!(["recovery"]));
    // The forced domain wins over the derived one in `listSessions`.
    assert_eq!(
        app.list_sessions(90).unwrap()[0]["domains"],
        json!(["recovery"])
    );

    // A retime keeps the duration and records the exact start.
    let retimed = app
        .update_manual_training_session(
            &id,
            &json!({ "startAt": "2026-09-16T02:30:00.000Z", "confirmed": true }),
        )
        .unwrap();
    assert_eq!(retimed["startAt"], json!("2026-09-16T02:30:00.000Z"));
    assert_eq!(retimed["endAt"], json!("2026-09-16T03:30:00.000Z"));
    assert_eq!(retimed["timePrecision"], json!("exact"));
    assert_eq!(retimed["missingFields"], json!([]));

    // A duration update moves the end instead.
    let stretched = app
        .update_manual_training_session(&id, &json!({ "durationMinutes": 45, "confirmed": true }))
        .unwrap();
    assert_eq!(stretched["durationMinutes"], json!(45));
    assert_eq!(stretched["endAt"], json!("2026-09-16T03:15:00.000Z"));

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
    let unknown = app
        .update_training_session_type(
            "absent-session",
            &json!({ "domain": "strength", "confirmed": true }),
        )
        .unwrap_err();
    assert_eq!(unknown.code(), AthriaErrorCode::TrainingSessionNotFound);
    assert_eq!(unknown.message(), "The workout was not found.");
    assert_eq!(unknown.status(), 404);
}

#[test]
fn session_deletions_follow_the_manual_and_canonical_rules() {
    let app = test_app();
    let id = record(
        &app,
        json!({
            "modality": "endurance", "name": "Easy Run",
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
            "modality": "strength", "name": "Lower Strength",
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
        ["ownerId", "day", "fields", "updatedAt"]
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
        ["ownerId", "day", "fields", "updatedAt", "snapshotHash"]
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
            "equipmentCategories",
            "strength",
            "templateVariables",
            "factSources",
            "aiHardConfidence"
        ]
    );
    assert_eq!(taxonomy["planSchemaVersion"], json!("7.0"));
    assert_eq!(taxonomy["taxonomyVersion"], json!("strength-2.0"));
    assert_eq!(taxonomy["templateCatalogVersion"], json!("2.0"));
    assert_eq!(
        taxonomy["domains"],
        json!([
            "strength",
            "endurance",
            "sport_skill",
            "mind_body",
            "recovery"
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
fn plan_component(id: &str, name: &str, domain: &str) -> Value {
    json!({
        "id": id, "name": name,
        "domain": { "value": domain, "source": "user_confirmed", "confidence": 1, "evidence": "", "taxonomyVersion": "strength-2.0" },
        "prescription": { "kind": "duration_only", "notes": "" },
    })
}

/// A weekly prescription in the 14-key order `parse_weekly_session` rebuilds.
fn plan_session(
    id: &str,
    scheduled_date: &str,
    order: i64,
    recovery_demand: &str,
    components: Value,
) -> Value {
    json!({
        "id": id, "scheduledDate": scheduled_date, "order": order, "status": "planned", "templateRef": null,
        "name": "Easy Run", "intent": "Aerobic base", "durationMinutes": 45, "recoveryDemand": recovery_demand, "keySession": false,
        "components": components,
        "progressionNote": null, "schedulingRationale": null, "legacySnapshot": false,
    })
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
        "planSchemaVersion": "7.0", "ownerId": "local-user", "title": "Base Block", "summary": "", "effectiveStartDate": effective_start,
        "mesocycle": { "durationWeeks": duration_weeks, "schedule": schedule, "domainProgressions": progressions, "weeks": weeks, "adjustmentRules": [] },
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
                    json!([plan_component("c1", "Run", "endurance")]),
                )],
            ),
            plan_week(
                2,
                vec![plan_session(
                    "s2",
                    "2026-09-21",
                    0,
                    "low",
                    json!([plan_component("c2", "Run", "endurance")]),
                )],
            ),
        ],
        expected_revision,
    )
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
    json!({
        "id": id, "status": "planned", "templateRef": null, "name": "Tempo Run", "intent": "Threshold",
        "durationMinutes": 50, "recoveryDemand": "normal", "keySession": false,
        "components": [plan_component(&format!("{id}-c1"), "Run", "endurance")],
        "progressionNote": null, "schedulingRationale": null, "legacySnapshot": false,
    })
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
                    json!([plan_component("c1", "Run", "endurance")]),
                )],
            ),
            plan_week(
                2,
                vec![plan_session(
                    "s2",
                    "2026-09-21",
                    0,
                    "low",
                    json!([plan_component("c2", "Run", "endurance")]),
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
        "Plan has 1 blocking issue(s) (PROFILE_TRAINING_RHYTHM:fail). Call validate_current_plan for the full report."
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
        json!({ "affectedCount": 0, "updatedCount": 2, "deletedCount": 0, "legacySkippedCount": 0 })
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
            "updatedAt"
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
            "components",
            "progressionNote",
            "schedulingRationale",
            "legacySnapshot"
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
            "components",
            "legacySnapshot",
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
    assert_eq!(workout["source"], json!("manual"));
    assert_eq!(workout["status"], json!("completed"));
    assert_eq!(workout["modality"], json!("endurance"));
    assert_eq!(workout["domains"], json!(["endurance"]));
    assert_eq!(workout["sport"], json!(null));
    assert_eq!(workout["plannedSessionId"], json!("s1"));
    assert_eq!(workout["timePrecision"], json!("date_only"));
    assert_eq!(workout["startAt"], json!("2026-09-14T04:00:00.000Z"));
    assert_eq!(workout["endAt"], json!("2026-09-14T04:45:00.000Z"));
    assert_eq!(workout["durationMinutes"], json!(45));
    assert_eq!(workout["timezone"], json!("Asia/Hong_Kong"));
    assert_eq!(workout["strengthSets"], json!([]));
    assert_eq!(workout["endurance"], json!(null));
    assert_eq!(
        workout["missingFields"],
        json!(["actual start time", "exercise details"])
    );

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

    let conflict = app
        .update_planned_session("s1", &json!({ "action": "move_occurrence", "expectedRevision": 1, "scheduledDate": "2026-09-21" }))
        .unwrap_err();
    assert_eq!(conflict.code(), AthriaErrorCode::TrainingDayConflict);
    assert_eq!(
        conflict.message(),
        "Another planned training day already uses that date."
    );
    assert_eq!(conflict.status(), 409);

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
        .unwrap_err();
    assert_eq!(off_rhythm.code(), AthriaErrorCode::ProfileTrainingRhythm);
    assert_eq!(
        off_rhythm.message(),
        "The moved training day would break your Profile training rhythm."
    );
    assert_eq!(off_rhythm.status(), 409);

    // A flexible rhythm accepts the same move and recomputes week and phases.
    let flex = test_app();
    patch_profile(
        &flex,
        json!({ "trainingRhythm": { "kind": "flexible_week", "targetDaysPerWeek": 2, "minDaysPerWeek": 0, "maxDaysPerWeek": 3 } }),
    );
    let flex_plan = plan_write(
        json!({ "kind": "flexible_week", "targetDaysPerWeek": 2, "minDaysPerWeek": 0, "maxDaysPerWeek": 3 }),
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
                    json!([plan_component("c1", "Run", "endurance")]),
                )],
            ),
            plan_week(
                2,
                vec![plan_session(
                    "s2",
                    "2026-09-21",
                    0,
                    "low",
                    json!([plan_component("c2", "Run", "endurance")]),
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
fn moving_high_recovery_days_enforces_the_explicit_recovery_interval() {
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
                        json!([plan_component("c1", "Run", "endurance")]),
                    ),
                    plan_session(
                        "s2",
                        "2026-09-18",
                        1,
                        "low",
                        json!([plan_component("c2", "Run", "endurance")]),
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
                        json!([plan_component("c3", "Run", "endurance")]),
                    ),
                    plan_session(
                        "s4",
                        "2026-09-22",
                        1,
                        "low",
                        json!([plan_component("c4", "Run", "endurance")]),
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
        .unwrap_err();
    assert_eq!(tight.code(), AthriaErrorCode::ExplicitRecoveryInterval);
    assert_eq!(
        tight.message(),
        "The moved training day is too close to another high-recovery-demand session."
    );
    assert_eq!(tight.status(), 409);

    let moved = app.update_planned_session("s1", &json!({ "action": "move_occurrence", "expectedRevision": 1, "scheduledDate": "2026-09-24" })).unwrap();
    assert_eq!(moved["revision"], json!(2));
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
