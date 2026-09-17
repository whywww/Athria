//! Replays the TypeScript Phase 5 application contract against Rust.

use std::sync::Arc;

use athria_application::{AthriaApplication, AthriaError};
use athria_core::FixedClock;
use athria_store::SqliteStore;
use serde_json::{Value, json};

fn normalize(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(normalize).collect()),
        Value::Object(items) => Value::Object(items.into_iter().filter(|(key, _)| key != "occurrenceId").map(|(key, value)| (key, normalize(value))).collect()),
        other => other,
    }
}

fn execute(app: &AthriaApplication<SqliteStore>, operation: &str, input: &Value) -> Result<Value, AthriaError> {
    match operation {
        "get_profile" => app.get_profile(),
        "update_profile" => app.update_profile(input),
        "get_personal_information" => app.get_personal_information(),
        "save_personal_information" => app.save_personal_information(input),
        "update_wellness" => app.update_wellness(input["day"].as_str().unwrap(), &input["value"]),
        "record_training_session" => app.record_training_session(input),
        "get_training_summary" => app.get_training_summary(input["days"].as_i64().unwrap(), input["from"].as_str(), input["to"].as_str()),
        "create_template" => app.create_template(input),
        "update_template" => app.update_template(input),
        "save_current_plan" => app.save_current_plan(input),
        "get_calendar" => app.get_calendar(input["from"].as_str(), input["to"].as_str()).map(Value::Array),
        "update_planned_session" => app.update_planned_session(input["id"].as_str().unwrap(), &input["value"]),
        "get_next_training_day" => app.get_next_training_day(input["onOrAfterDate"].as_str()),
        "preview_hevy" => app.preview_hevy(input["content"].as_str().unwrap().as_bytes(), input["fileName"].as_str().unwrap()),
        "commit_hevy" => app.commit_hevy(input["previewToken"].as_str().unwrap()),
        "commit_intervals" => app.commit_intervals(&input["payload"], &input["context"]),
        "commit_xunji" => app.commit_xunji(&input["result"], input["attemptedAt"].as_str().unwrap()),
        other => panic!("unknown fixture operation: {other}"),
    }
}

#[test]
fn typescript_and_rust_application_contracts_match() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/application.json")).expect("fixture parses");
    let clock = Arc::new(FixedClock::new(fixture["now"].as_str().unwrap()));
    let store = SqliteStore::open_in_memory_with_clock(clock.clone()).expect("in-memory store opens");
    let app = AthriaApplication::with_clock(store, "local-user", clock);

    for (index, step) in fixture["steps"].as_array().unwrap().iter().enumerate() {
        let operation = step["operation"].as_str().unwrap();
        let result = execute(&app, operation, step.get("input").unwrap_or(&Value::Null));
        if let Some(expected_error) = step.get("error") {
            let error = result.unwrap_err();
            assert_eq!(
                json!({ "code": error.code().as_str(), "message": error.message(), "status": error.status() }),
                *expected_error,
                "step {index} ({operation}) error differs"
            );
        } else {
            assert_eq!(normalize(result.unwrap()), step["expected"], "step {index} ({operation}) result differs");
        }
    }

    // The replay must exercise writes through the store port, not a mock-only path.
    assert_eq!(app.get_profile().unwrap()["preferredName"], json!("Compat Athlete"));
}
