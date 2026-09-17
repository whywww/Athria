//! Cross-language database compatibility fixtures.
//!
//! These tests are driven by `bun run scripts/store-compat.ts`, which seeds a
//! database with the TypeScript `AthriaRepository` and writes an `expected.json`
//! describing everything the Rust store must read and write. The JavaScript
//! side owns the fixture data; this file only consumes it.
//!
//! The tests are skipped silently when the environment variables are absent so
//! that a plain `cargo test` stays green without Bun.

use std::env;
use std::fs;

use athria_store::SqliteStore;
use serde_json::{Value, json};

fn env_path(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.is_empty())
}

fn load_expected(path: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(path).expect("expected.json is readable"))
        .expect("expected.json parses")
}

fn assert_equal(label: &str, actual: &Value, expected: &Value) {
    assert_eq!(
        actual, expected,
        "FAILED: {label}\n  expected: {expected}\n  actual:   {actual}"
    );
}

fn assert_code<T: std::fmt::Debug>(label: &str, result: athria_store::Result<T>, code: &str) {
    match result {
        Ok(value) => panic!("FAILED: {label} — expected error {code}, got Ok({value:?})"),
        Err(error) => assert_eq!(
            error.code().as_str(),
            code,
            "FAILED: {label} — wrong error code"
        ),
    }
}

/// The template view minus the fields that live in columns: what the `data`
/// column stores in the TypeScript schema.
fn template_payload(template: &Value) -> Value {
    let mut object = template.as_object().expect("template is an object").clone();
    for key in ["id", "origin", "revision"] {
        object.remove(key);
    }
    Value::Object(object)
}

#[test]
fn reads_and_writes_a_typescript_created_database() {
    let (Some(db_path), Some(expected_path)) = (
        env_path("ATHRIA_COMPAT_DB"),
        env_path("ATHRIA_COMPAT_EXPECTED"),
    ) else {
        eprintln!("skipping: ATHRIA_COMPAT_DB / ATHRIA_COMPAT_EXPECTED not set");
        return;
    };
    let expected = load_expected(&expected_path);
    let store = SqliteStore::open(&db_path).expect("Rust opens the TypeScript-created database");

    assert_eq!(store.schema_version().unwrap(), 24);

    // Profile -----------------------------------------------------------------
    let profile = store
        .get_profile("local-user")
        .unwrap()
        .expect("profile row exists");
    assert_equal(
        "profile.preferredName",
        &profile["preferredName"],
        &expected["profile"]["preferredName"],
    );
    assert_equal(
        "profile.gender",
        &profile["gender"],
        &expected["profile"]["gender"],
    );
    assert_equal(
        "profile.heightCm",
        &profile["heightCm"],
        &expected["profile"]["heightCm"],
    );
    assert_equal(
        "profile.birthDate",
        &profile["birthDate"],
        &expected["profile"]["birthDate"],
    );
    assert_equal(
        "profile.unitSystem",
        &profile["unitSystem"],
        &expected["profile"]["unitSystem"],
    );
    assert_equal(
        "profile.timezone",
        &profile["timezone"],
        &expected["profile"]["timezone"],
    );

    // Wellness ----------------------------------------------------------------
    let day = expected["wellness"]["day"].as_str().unwrap();
    let wellness = store
        .get_wellness("local-user", day)
        .unwrap()
        .expect("wellness row exists");
    assert_equal(
        "wellness.rhr",
        &wellness["fields"]["restingHeartRateBpm"]["value"],
        &expected["wellness"]["restingHeartRateBpm"],
    );
    assert_eq!(store.list_wellness("local-user", None).unwrap().len(), 1);

    // Training sessions (read-only in Phase 3) --------------------------------
    let sessions = store.list_training_sessions("local-user").unwrap();
    assert_eq!(sessions.len(), 1);
    assert_equal("session.id", &sessions[0]["id"], &expected["session"]["id"]);
    assert_equal(
        "session.source",
        &sessions[0]["source"],
        &expected["session"]["source"],
    );
    assert_equal(
        "session.externalId",
        &sessions[0]["externalId"],
        &expected["session"]["externalId"],
    );
    assert_equal(
        "session.startAt",
        &sessions[0]["startAt"],
        &expected["session"]["startAt"],
    );
    assert_equal(
        "session.modality",
        &sessions[0]["modality"],
        &expected["session"]["modality"],
    );
    assert_equal(
        "session.name",
        &sessions[0]["name"],
        &expected["session"]["name"],
    );
    let sources = store.list_training_session_sources("local-user").unwrap();
    assert_eq!(sources.len(), 1);
    assert_equal(
        "sessionSource.source",
        &sources[0]["source"],
        &expected["sessionSource"]["source"],
    );
    assert_equal(
        "sessionSource.externalId",
        &sources[0]["externalId"],
        &expected["sessionSource"]["externalId"],
    );
    assert_equal(
        "sessionSource.localDate",
        &sources[0]["localDate"],
        &expected["sessionSource"]["localDate"],
    );

    // Template ----------------------------------------------------------------
    let template_id = expected["template"]["id"].as_str().unwrap();
    let template = store
        .get_template(template_id, "local-user")
        .unwrap()
        .expect("template row exists");
    assert_equal("template.id", &template["id"], &expected["template"]["id"]);
    assert_equal(
        "template.name",
        &template["name"],
        &expected["template"]["name"],
    );
    assert_equal(
        "template.revision",
        &template["revision"],
        &expected["template"]["revision"],
    );
    assert_equal(
        "template.origin",
        &template["origin"],
        &expected["template"]["origin"],
    );
    assert_equal(
        "template data column",
        &template_payload(&template),
        &expected["templateStoredData"],
    );
    assert_eq!(store.list_templates("local-user").unwrap().len(), 1);

    // Current plan ------------------------------------------------------------
    let plan = store
        .get_current_plan("local-user")
        .unwrap()
        .expect("plan row exists");
    let session = &plan["mesocycle"]["weeks"][0]["sessions"][0];
    assert_equal(
        "plan.revision",
        &plan["revision"],
        &expected["plan"]["revision"],
    );
    assert_equal("plan.title", &plan["title"], &expected["plan"]["title"]);
    assert_equal(
        "plan.session.id",
        &session["id"],
        &expected["plan"]["sessionId"],
    );
    assert_equal(
        "plan.session.scheduledDate",
        &session["scheduledDate"],
        &expected["plan"]["scheduledDate"],
    );
    assert_equal(
        "plan.session.name",
        &session["name"],
        &expected["plan"]["sessionName"],
    );

    // Sync state --------------------------------------------------------------
    let sync = store
        .get_connection_sync_state("intervals_icu", "local-user")
        .unwrap()
        .expect("sync state row exists");
    assert_equal("sync.status", &sync["status"], &expected["sync"]["status"]);
    assert_equal(
        "sync.rangeEnd",
        &sync["rangeEnd"],
        &expected["sync"]["rangeEnd"],
    );
    assert_equal(
        "sync.data.workouts",
        &sync["data"]["workouts"],
        &expected["sync"]["workouts"],
    );

    // Vault metadata (read-only, no crypto in Phase 3) ------------------------
    let vault = store.vault_metadata().unwrap();
    assert_equal(
        "vault.databaseUuid",
        &vault["databaseUuid"],
        &expected["vaultUuid"],
    );
    assert_equal("vault.formatVersion", &vault["formatVersion"], &json!(1));
    assert_equal(
        "vault.envelopePresent",
        &vault["envelopePresent"],
        &json!(false),
    );
    assert_equal("vault.secretCount", &vault["secretCount"], &json!(0));

    // Error semantics mirror the TypeScript store -----------------------------
    assert_code("stale template update", store.update_template(&json!({ "id": template_id, "name": "x", "intent": "x", "domain": "endurance", "nodes": [] }), 99, "local-user"), "REVISION_CONFLICT");
    assert_code("duplicate template create", store.create_template(&json!({ "id": template_id, "name": "x", "intent": "x", "domain": "endurance", "nodes": [] }), "local-user"), "TEMPLATE_ALREADY_EXISTS");
    assert_code(
        "stale plan save",
        store.save_current_plan(&plan, 99),
        "REVISION_CONFLICT",
    );

    // Rust writes -------------------------------------------------------------
    let rust = &expected["rustWrites"];

    let mut updated_profile = profile.clone();
    updated_profile["preferredName"] = rust["preferredName"].clone();
    store
        .save_profile(&updated_profile)
        .expect("Rust updates the profile");

    let record = &rust["wellnessRecord"];
    store.save_wellness(record).expect("Rust saves wellness");
    let written = store
        .get_wellness("local-user", record["day"].as_str().unwrap())
        .unwrap()
        .expect("Rust-written wellness row exists");
    assert_equal(
        "wellness written by Rust",
        &written["fields"]["restingHeartRateBpm"]["value"],
        &json!(47),
    );

    let created = store
        .create_template(&rust["template"], "local-user")
        .expect("Rust creates a template");
    assert_equal(
        "Rust-created template revision",
        &created["revision"],
        &json!(1),
    );
    let updated = store
        .update_template(&rust["templateV2"], 1, "local-user")
        .expect("Rust updates its template");
    assert_equal(
        "Rust-updated template revision",
        &updated["revision"],
        &json!(2),
    );
    assert_equal(
        "Rust-updated template name",
        &updated["name"],
        &rust["templateV2"]["name"],
    );
    assert_code(
        "stale Rust template update",
        store.update_template(&rust["templateV2"], 1, "local-user"),
        "REVISION_CONFLICT",
    );

    let mut rewritten_plan = plan.clone();
    let name = session["name"].as_str().unwrap();
    rewritten_plan["mesocycle"]["weeks"][0]["sessions"][0]["name"] = json!(format!(
        "{name}{}",
        rust["planSessionNameSuffix"].as_str().unwrap()
    ));
    rewritten_plan["revision"] = json!(plan["revision"].as_i64().unwrap() + 1);
    rewritten_plan["updatedAt"] = rust["planUpdatedAt"].clone();
    let saved = store
        .save_current_plan(&rewritten_plan, plan["revision"].as_i64().unwrap())
        .expect("Rust saves the plan");
    assert_equal("Rust-saved plan revision", &saved["revision"], &json!(2));
    assert_code(
        "stale Rust plan save",
        store.save_current_plan(&rewritten_plan, plan["revision"].as_i64().unwrap()),
        "REVISION_CONFLICT",
    );

    store
        .save_connection_sync_state(&rust["syncState"])
        .expect("Rust saves sync state");

    // Rows outside the Phase 3 write scope must be untouched by the writes.
    assert_eq!(store.list_training_sessions("local-user").unwrap().len(), 1);
    assert_eq!(
        store
            .list_training_session_sources("local-user")
            .unwrap()
            .len(),
        1
    );

    store.checkpoint().unwrap();
    store.close();
}

#[test]
fn creates_a_database_typescript_can_open() {
    let Some(path) = env_path("ATHRIA_COMPAT_FRESH_RUST") else {
        eprintln!("skipping: ATHRIA_COMPAT_FRESH_RUST not set");
        return;
    };
    let store = SqliteStore::open(&path).expect("Rust creates a fresh database");
    assert_eq!(store.schema_version().unwrap(), 24);
    assert!(store.get_current_plan("local-user").unwrap().is_none());
    assert!(store.list_templates("local-user").unwrap().is_empty());
    assert!(
        store
            .list_training_sessions("local-user")
            .unwrap()
            .is_empty()
    );
    assert!(store.get_profile("local-user").unwrap().is_none());
    assert!(store.list_wellness("local-user", None).unwrap().is_empty());
    let vault = store.vault_metadata().unwrap();
    assert!(
        vault["databaseUuid"]
            .as_str()
            .is_some_and(|uuid| !uuid.is_empty())
    );
    assert_equal(
        "fresh vault.formatVersion",
        &vault["formatVersion"],
        &json!(1),
    );
    store.checkpoint().unwrap();
    store.close();
}
