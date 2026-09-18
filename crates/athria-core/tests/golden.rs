//! Golden regression suite: replays the committed fixtures under
//! `tests/fixtures` through the Rust core and verifies the stable outputs.
//!
//! Comparison rules: strings, booleans, null and object key sets must match
//! exactly; numbers compare with a 1e-9 relative tolerance so equivalent
//! float pipelines are not rejected over representation noise. Error fixtures
//! compare the `AthriaError` message byte for byte.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use athria_core::{
    DoubleProgressionInput, RpeAutoregulationInput, calculate_heart_rate_zones,
    calculate_training_metrics, estimate_one_rep_max, evaluate_double_progression,
    evaluate_rpe_autoregulation, expand_schedule, stable_hash, validate_plan,
};
use serde_json::Value;

const KINDS: [&str; 8] = [
    "double_progression",
    "heart_rate_zones",
    "one_rep_max",
    "rpe_autoregulation",
    "schedule",
    "stable_hash",
    "training_metrics",
    "validate_plan",
];

fn run(kind: &str, input: &Value) -> Result<Value, String> {
    match kind {
        "schedule" => {
            let effective_start_date = input["effectiveStartDate"]
                .as_str()
                .expect("effectiveStartDate must be a string");
            let duration_weeks = input["durationWeeks"]
                .as_i64()
                .expect("durationWeeks must be an integer");
            serde_json::to_value(expand_schedule(
                effective_start_date,
                duration_weeks,
                &input["schedule"],
            ))
            .map_err(|error| error.to_string())
        }
        "one_rep_max" => {
            let load = input["load"].as_f64().expect("load must be a number");
            let reps = input["reps"].as_f64().expect("reps must be a number");
            let unit = input["unit"].as_str().expect("unit must be a string");
            estimate_one_rep_max(load, reps, unit)
                .map_err(|error| error.message().to_string())
                .and_then(serialize)
        }
        "heart_rate_zones" => {
            let max_heart_rate = input["maxHeartRate"]
                .as_f64()
                .expect("maxHeartRate must be a number");
            calculate_heart_rate_zones(max_heart_rate)
                .map_err(|error| error.message().to_string())
                .and_then(serialize)
        }
        "training_metrics" => {
            let sessions = input["sessions"]
                .as_array()
                .cloned()
                .expect("sessions must be an array");
            serialize(calculate_training_metrics(&sessions))
        }
        "double_progression" => {
            let parsed: DoubleProgressionInput =
                serde_json::from_value(input.clone()).map_err(|error| {
                    format!("double_progression input did not deserialize: {error}")
                })?;
            evaluate_double_progression(&parsed)
                .map_err(|error| error.message().to_string())
                .and_then(serialize)
        }
        "rpe_autoregulation" => {
            let parsed: RpeAutoregulationInput =
                serde_json::from_value(input.clone()).map_err(|error| {
                    format!("rpe_autoregulation input did not deserialize: {error}")
                })?;
            evaluate_rpe_autoregulation(&parsed)
                .map_err(|error| error.message().to_string())
                .and_then(serialize)
        }
        "stable_hash" => Ok(Value::String(stable_hash(&input["value"]))),
        "validate_plan" => {
            let now = input["now"].as_str().expect("now must be a string");
            serialize(validate_plan(&input["profile"], &input["draft"], now))
        }
        other => Err(format!("unknown fixture kind `{other}`")),
    }
}

fn serialize(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| format!("output did not serialize: {error}"))
}

fn compare(expected: &Value, actual: &Value, path: &str) -> Option<String> {
    match (expected, actual) {
        (Value::Number(left), Value::Number(right)) => {
            let left = left.as_f64().unwrap_or(f64::NAN);
            let right = right.as_f64().unwrap_or(f64::NAN);
            let tolerance = 1e-9 * left.abs().max(right.abs()).max(1.0);
            if (left - right).abs() <= tolerance {
                None
            } else {
                Some(format!("{path}: {left} vs {right}"))
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            if left.len() != right.len() {
                return Some(format!(
                    "{path}: array length {} vs {}",
                    left.len(),
                    right.len()
                ));
            }
            left.iter()
                .zip(right)
                .enumerate()
                .find_map(|(index, (left, right))| {
                    compare(left, right, &format!("{path}[{index}]"))
                })
        }
        (Value::Object(left), Value::Object(right)) => {
            for (key, expected) in left {
                match right.get(key) {
                    Some(actual) => {
                        if let Some(detail) = compare(expected, actual, &format!("{path}.{key}")) {
                            return Some(detail);
                        }
                    }
                    None => return Some(format!("{path}.{key}: missing on the Rust side")),
                }
            }
            right
                .keys()
                .find(|key| !left.contains_key(*key))
                .map(|key| format!("{path}.{key}: extra on the Rust side"))
        }
        (left, right) if left == right => None,
        (left, right) => Some(format!("{path}: expected {left}, got {right}")),
    }
}

#[test]
fn golden_fixtures_match_the_domain_baseline() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures");
    let entries = fs::read_dir(&directory).unwrap_or_else(|error| {
        panic!(
            "cannot read committed fixture {}: {error}",
            directory.display()
        )
    });
    let mut paths: Vec<PathBuf> = entries
        .map(|entry| entry.expect("fixture directory entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    paths.sort();
    assert!(
        !paths.is_empty(),
        "no committed fixtures in {}",
        directory.display()
    );

    let mut failures: Vec<String> = Vec::new();
    let mut kinds_seen: BTreeSet<String> = BTreeSet::new();
    for path in &paths {
        let fixture: Value =
            serde_json::from_str(&fs::read_to_string(path).expect("fixture readable"))
                .expect("fixture is JSON");
        let kind = fixture["kind"].as_str().expect("fixture kind").to_string();
        let name = fixture["name"].as_str().expect("fixture name");
        kinds_seen.insert(kind.clone());
        match run(&kind, &fixture["input"]) {
            Ok(actual) => match fixture.get("expected") {
                Some(expected) => {
                    if let Some(detail) = compare(expected, &actual, "$") {
                        failures.push(format!("{kind} {name}: {detail}"));
                    }
                }
                None => failures.push(format!("{kind} {name}: fixture expects an error but the Rust core succeeded")),
            },
            Err(message) => match fixture.get("error") {
                Some(expected) if expected.as_str() == Some(message.as_str()) => {}
                Some(expected) => failures.push(format!("{kind} {name}: error mismatch: expected {expected}, got {message:?}")),
                None => failures.push(format!("{kind} {name}: Rust core failed with {message:?} but the fixture expects a value")),
            },
        }
    }

    let missing: Vec<&str> = KINDS
        .iter()
        .copied()
        .filter(|kind| !kinds_seen.contains(*kind))
        .collect();
    assert!(
        missing.is_empty(),
        "fixture kinds without coverage: {missing:?}"
    );

    assert!(
        failures.is_empty(),
        "{} of {} golden fixtures mismatched:\n{}",
        failures.len(),
        paths.len(),
        failures
            .iter()
            .map(|failure| format!("  - {failure}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}
