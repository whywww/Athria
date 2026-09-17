//! The Phase 5 application use cases over the real SQLite store.
//!
//! `AthriaApplication` is generic over the `AthriaStore` port; these tests run
//! it against `SqliteStore` in memory with a fixed clock, which is the exact
//! wiring the desktop shell will use. TypeScript parity for the same use cases
//! is covered by the fixture replay (`scripts/application-compat.ts`).

use std::rc::Rc;

use athria_application::AthriaApplication;
use athria_core::{AthriaErrorCode, FixedClock};
use athria_store::SqliteStore;
use serde_json::{Value, json};

const NOW: &str = "2026-09-17T04:00:00.000Z";

fn test_app() -> AthriaApplication<SqliteStore> {
    let clock = Rc::new(FixedClock::new(NOW));
    let store = SqliteStore::open_in_memory_with_clock(clock.clone()).expect("in-memory store opens");
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
    profile.as_object().expect("profile is an object").keys().map(String::as_str).collect()
}

#[test]
fn fresh_database_returns_the_default_profile() {
    let app = test_app();
    let profile = app.get_profile().unwrap();
    assert_eq!(profile["preferredName"], json!("Athlete"));
    assert_eq!(profile["timezone"], json!("Asia/Hong_Kong"));
    assert_eq!(app.profile_hash().unwrap(), athria_core::stable_hash(&profile));
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
    assert_eq!(updated["raceDays"], json!([{ "date": "2026-11-01", "sport": "Marathon" }]));
    assert_eq!(profile_keys(&updated), profile_keys(&app.get_profile().unwrap()));
}

#[test]
fn personal_information_tracks_the_latest_weight_and_todays_wellness() {
    let app = test_app();
    let initial = app.get_personal_information().unwrap();
    assert_eq!(initial["weightKg"], json!(null));
    assert_eq!(initial["weightDate"], json!(null));
    assert_eq!(
        initial.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
        ["preferredName", "gender", "heightCm", "birthDate", "unitSystem", "weightKg", "weightDate", "snapshotHash"]
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
    let record = app.store().get_wellness("local-user", "2026-09-17").unwrap().expect("today's wellness row was written");
    assert_eq!(record["fields"]["weightKg"], json!({ "value": 72.5, "source": "user", "updatedAt": NOW }));
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
    assert_eq!(app.store().get_wellness("local-user", "2026-09-17").unwrap().unwrap()["fields"], json!({}));

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
        app.store().get_wellness("local-user", "2026-09-17").unwrap().unwrap()["fields"],
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
    assert_eq!(app.delete_template("builtin.easy-run", Some(1)).unwrap(), json!({ "deleted": true, "id": "builtin.easy-run" }));
    let after_delete = app.list_templates().unwrap();
    assert_eq!(after_delete.len(), 7);
    assert!(after_delete.iter().all(|template| template["id"] != json!("builtin.easy-run")));

    // A user template that does not shadow a built-in is appended.
    app.create_template(&endurance_template("user.tempo", "Tempo Run")).unwrap();
    let with_user = app.list_templates().unwrap();
    assert_eq!(with_user.len(), 8);
    assert_eq!(with_user[7]["id"], json!("user.tempo"));
}

#[test]
fn deleting_a_builtin_without_a_derived_row_only_dismisses_it() {
    let app = test_app();
    assert_eq!(app.delete_template("builtin.mobility-reset", None).unwrap(), json!({ "deleted": true, "id": "builtin.mobility-reset" }));
    assert_eq!(app.store().list_templates("local-user").unwrap().len(), 0);
    assert_eq!(app.store().list_dismissed_template_ids("local-user").unwrap(), ["builtin.mobility-reset"]);
    // The code-defined original still resolves by id.
    assert_eq!(app.get_template("builtin.mobility-reset").unwrap()["origin"], json!("builtin"));
}

#[test]
fn stored_templates_follow_the_revision_rules() {
    let app = test_app();
    let created = app.store().create_template(&endurance_template("user.tempo", "Tempo Run"), "local-user").unwrap();
    assert_eq!(created["revision"], json!(1));
    // The same create through the application maps the duplicate to a 409.
    let duplicate = app.create_template(&endurance_template("user.tempo", "Tempo Run")).unwrap_err();
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
    assert_eq!(updated["impact"], json!({ "affectedCount": 0, "updatedCount": 0 }));

    let missing = app.update_template(&json!({ "template": endurance_template("user.absent", "Absent"), "expectedRevision": 1 })).unwrap_err();
    assert_eq!(missing.code(), AthriaErrorCode::TemplateNotFound);
    assert_eq!(missing.status(), 404);

    assert_eq!(app.delete_template("user.tempo", Some(2)).unwrap(), json!({ "deleted": true, "id": "user.tempo" }));
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

#[test]
fn training_taxonomy_exposes_the_versioned_vocabularies() {
    let taxonomy = test_app().get_training_taxonomy();
    assert_eq!(
        taxonomy.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
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
    assert_eq!(taxonomy["domains"], json!(["strength", "endurance", "sport_skill", "mind_body", "recovery"]));
    assert_eq!(taxonomy["strength"]["movementPatterns"].as_array().unwrap().len(), 33);
    assert_eq!(taxonomy["strength"]["muscleGroups"].as_array().unwrap().len(), 47);
    assert_eq!(taxonomy["strength"]["equipment"].as_array().unwrap().len(), 30);
    assert_eq!(taxonomy["templateVariables"]["strength"][0], json!("exercise_selection"));
    assert_eq!(taxonomy["templateVariables"]["endurance"], json!(["repetitions", "duration", "distance", "pace", "heart_rate_zone", "power", "cadence", "rpe", "talk_test", "terrain", "strides", "recovery_mode"]));
    assert_eq!(taxonomy["factSources"], json!(["structured_source", "exact_alias", "ai_inferred", "user_confirmed"]));
    assert_eq!(taxonomy["aiHardConfidence"], json!(0.9));
    assert_eq!(taxonomy["equipmentCategories"][0]["id"], json!("strength_resistance"));
    assert_eq!(taxonomy["equipmentCategories"][0]["groups"][0]["items"][0], json!({ "id": "dumbbell", "label": "Dumbbells" }));
}
