//! `trainingSessionSchema` and its nested shapes.
//!
//! Source-observation parsing and normalization. Observations retain singular
//! source identities for importing. Canonical history replaces those identities
//! with priority-ordered `sources` during reconciliation.

use serde_json::{Map, Value};

use super::common::*;
use crate::Result;

const TIME_PRECISIONS: [&str; 2] = ["exact", "date_only"];
const WEIGHT_UNITS: [&str; 2] = ["kg", "lb"];
pub const API_SESSION_METRICS: [&str; 5] = ["trainingLoad", "powerLoad", "hrLoad", "paceLoad", "intensity"];

/// `trainingSessionSchema.parse(value)`.
pub fn parse_training_session(value: &Value) -> Result<Value> {
    object(value, "session")?;
    let mut session = Map::new();
    session.insert(
        "id".into(),
        Value::String(required_text(value, "id", "session")?),
    );
    session.insert(
        "ownerId".into(),
        Value::String(text_or(value, "ownerId", crate::DEFAULT_OWNER_ID)),
    );
    session.insert(
        "source".into(),
        Value::String(required_text(value, "source", "session")?),
    );
    session.insert(
        "externalId".into(),
        Value::String(required_text(value, "externalId", "session")?),
    );
    let (kind, subtype) = crate::training_type::fields(value);
    session.insert("type".into(), kind.clone());
    session.insert("subtype".into(), subtype);
    session.insert("domains".into(), crate::training_type::domains(kind.as_str()));
    session.insert(
        "name".into(),
        Value::String(required_text(value, "name", "session")?),
    );
    session.insert(
        "startAt".into(),
        Value::String(required_text(value, "startAt", "session")?),
    );
    session.insert(
        "durationMinutes".into(),
        Value::from(required_int(value, "durationMinutes", "session")?),
    );
    let rpe = session_metric(value, "rpe", Some(10.0))?;
    let supplied_load = if matches!(session["source"].as_str(), Some("intervals" | "xunji")) {
        session_metric(value, "sessionRpe", None)?
    } else { None };
    let load = supplied_load.or_else(|| rpe.map(|rpe| rpe * session["durationMinutes"].as_i64().unwrap() as f64));
    session.insert("rpe".into(), rpe.map(crate::js_number).unwrap_or(Value::Null));
    session.insert("sessionRpe".into(), load.map(crate::js_number).unwrap_or(Value::Null));
    for key in API_SESSION_METRICS {
        let metric = if matches!(session["source"].as_str(), Some("intervals" | "xunji")) {
            session_metric(value, key, None)?
        } else { None };
        session.insert(key.into(), metric.map(crate::js_number).unwrap_or(Value::Null));
    }
    session.insert(
        "status".into(),
        Value::String(enum_or(value, "status", &["completed"], "completed")),
    );
    session.insert("timezone".into(), text_or_null(value, "timezone"));
    session.insert(
        "plannedSessionId".into(),
        text_or_null(value, "plannedSessionId"),
    );
    session.insert(
        "timePrecision".into(),
        Value::String(enum_or(value, "timePrecision", &TIME_PRECISIONS, "exact")),
    );
    session.insert("sources".into(), parse_sources(value));
    session.insert(
        "planMatch".into(),
        match_summary_or_null(value, "planMatch"),
    );
    session.insert(
        "isPlanMatchExcluded".into(),
        Value::Bool(
            value
                .get("isPlanMatchExcluded")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    session.insert("strengthSets".into(), parse_strength_sets(value));
    session.insert("endurance".into(), parse_endurance(value));
    Ok(Value::Object(session))
}

fn session_metric(value: &Value, key: &str, maximum: Option<f64>) -> Result<Option<f64>> {
    let Some(value) = value.get(key).filter(|value| !value.is_null()) else { return Ok(None); };
    let number = value.as_f64().filter(|number| number.is_finite() && *number >= 0.0 && maximum.is_none_or(|max| *number <= max))
        .ok_or_else(|| invalid(&format!("session.{key}"), "expected a finite number in the allowed range"))?;
    Ok(Some(number))
}

fn string_array(value: &Value, key: &str) -> Value {
    text_array_or(value, key, &[])
}

/// `sources: z.array(trainingSessionSourceSummarySchema)`.
fn parse_sources(value: &Value) -> Value {
    Value::Array(
        value
            .get("sources")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        Some(serde_json::json!({
                            "source": item.get("source")?.as_str()?,
                            "externalId": item.get("externalId")?.as_str()?,
                        }))
                    })
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// `strengthSets: z.array(strengthSetSchema)`.
fn parse_strength_sets(value: &Value) -> Value {
    Value::Array(
        value
            .get("strengthSets")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(parse_strength_set).collect())
            .unwrap_or_default(),
    )
}

/// `strengthSetSchema.parse(value)`: the four optional fields stay present only
/// when the source observation carries them.
fn parse_strength_set(value: &Value) -> Value {
    let mut set = Map::new();
    set.insert(
        "exerciseRaw".into(),
        Value::String(text_or(value, "exerciseRaw", "")),
    );
    set.insert("exerciseKey".into(), text_or_null(value, "exerciseKey"));
    set.insert("movement".into(), text_or_null(value, "movement"));
    set.insert(
        "primaryMuscles".into(),
        string_array(value, "primaryMuscles"),
    );
    set.insert(
        "secondaryMuscles".into(),
        string_array(value, "secondaryMuscles"),
    );
    set.insert(
        "setIndex".into(),
        Value::from(value.get("setIndex").and_then(Value::as_i64).unwrap_or(0)),
    );
    set.insert(
        "setType".into(),
        Value::String(text_or(value, "setType", "normal")),
    );
    set.insert("weight".into(), number_or_null(value, "weight"));
    set.insert(
        "weightUnit".into(),
        nullable_enum(value, "weightUnit", &WEIGHT_UNITS),
    );
    set.insert("reps".into(), number_or_null(value, "reps"));
    set.insert("rpe".into(), number_or_null(value, "rpe"));
    for key in [
        "leftWeight",
        "rightWeight",
        "durationSeconds",
        "restSeconds",
        "plannedRestSeconds",
    ] {
        if let Some(entry) = value.get(key) {
            set.insert(key.into(), entry.clone());
        }
    }
    Value::Object(set)
}

/// `endurance: enduranceDetailsSchema.nullable()`.
fn parse_endurance(value: &Value) -> Value {
    let Some(details) = value.get("endurance").filter(|item| !item.is_null()) else {
        return Value::Null;
    };
    let mut parsed = Map::new();
    for key in [
        "distanceMeters",
        "averageHeartRate",
        "maxHeartRate",
        "averagePowerWatts",
        "maxPowerWatts",
    ] {
        parsed.insert(key.into(), number_or_null(details, key));
    }
    let zones = details
        .get("heartRateZoneSeconds")
        .and_then(Value::as_object)
        .map(|entries| {
            Value::Object(
                entries
                    .iter()
                    .filter(|(_, zone)| zone.as_f64().is_some())
                    .map(|(key, zone)| (key.clone(), zone.clone()))
                    .collect(),
            )
        });
    parsed.insert(
        "heartRateZoneSeconds".into(),
        zones.unwrap_or_else(|| Value::Object(Map::new())),
    );
    Value::Object(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_payload() -> Value {
        json!({
            "type": "StrengthTraining",
            "domains": ["strength"],
            "name": "Lower Strength",
            "startAt": "2026-09-17T04:00:00.000Z",
            "endAt": "2026-09-17T05:00:00.000Z",
            "durationMinutes": 60,
            "timezone": null,
            "plannedSessionId": null,
            "timePrecision": "date_only",
            "strengthSets": [{ "exerciseRaw": "Back Squat", "setIndex": 0, "weight": 100, "weightUnit": "kg", "reps": 5 }],
            "endurance": null,
            "missingFields": ["actual start time"],
            "id": "session-1",
            "externalId": "session-1",
            "source": "manual",
        })
    }

    #[test]
    fn session_rpe_validates_and_calculates_without_using_set_rpe() {
        for (rpe, supplied, expected) in [
            (serde_json::json!(3), serde_json::json!(118), serde_json::json!(118)),
            (serde_json::json!(3), Value::Null, serde_json::json!(180)),
            (serde_json::json!(0), Value::Null, serde_json::json!(0)),
            (serde_json::json!(2.5), Value::Null, serde_json::json!(150)),
            (Value::Null, Value::Null, Value::Null),
            (Value::Null, serde_json::json!(0), serde_json::json!(0)),
        ] {
            let mut input = write_payload();
            input["source"] = serde_json::json!("intervals");
            input["rpe"] = rpe.clone();
            input["sessionRpe"] = supplied;
            let parsed = parse_training_session(&input).unwrap();
            assert_eq!(parsed["rpe"], rpe);
            assert_eq!(parsed["sessionRpe"], expected);
        }
        for (field, value) in [("rpe", serde_json::json!(11)), ("rpe", serde_json::json!(-1)), ("rpe", serde_json::json!("bad")), ("sessionRpe", serde_json::json!(-1))] {
            let mut input = write_payload(); input["source"] = serde_json::json!("intervals"); input[field] = value;
            assert!(parse_training_session(&input).is_err());
        }
        let mut manual = write_payload();
        manual["rpe"] = serde_json::json!(3);
        manual["sessionRpe"] = serde_json::json!(999);
        assert_eq!(parse_training_session(&manual).unwrap()["sessionRpe"], serde_json::json!(180));
    }

    #[test]
    fn sessions_are_rebuilt_in_schema_order() {
        let session = parse_training_session(&write_payload()).unwrap();
        assert_eq!(
            session
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
        assert_eq!(session["ownerId"], json!(crate::DEFAULT_OWNER_ID));
        assert_eq!(session["status"], json!("completed"));
        assert_eq!(session["sources"], json!([]));
        assert_eq!(session["endurance"], json!(null));
        assert_eq!(session["strengthSets"][0]["setType"], json!("normal"));
        assert_eq!(session["strengthSets"][0]["exerciseKey"], json!(null));
    }

    #[test]
    fn nested_endurance_and_match_summaries_keep_their_defaults() {
        let mut payload = write_payload();
        payload["endurance"] =
            json!({ "distanceMeters": 5000, "heartRateZoneSeconds": { "1": 600 } });
        payload["planMatch"] = json!({ "plannedSessionId": "planned-1", "method": "manual" });
        let session = parse_training_session(&payload).unwrap();
        assert_eq!(
            session["endurance"],
            json!({
                "distanceMeters": 5000,
                "averageHeartRate": null,
                "maxHeartRate": null,
                "averagePowerWatts": null,
                "maxPowerWatts": null,
                "heartRateZoneSeconds": { "1": 600 },
            })
        );
        assert_eq!(
            session["planMatch"],
            json!({ "plannedSessionId": "planned-1", "method": "manual" })
        );
    }

    #[test]
    fn missing_required_fields_are_rejected() {
        for key in [
            "name",
            "startAt",

            "durationMinutes",
            "id",
        ] {
            let mut payload = write_payload();
            payload.as_object_mut().unwrap().remove(key);
            let error = parse_training_session(&payload).unwrap_err();
            assert_eq!(
                error.code(),
                crate::AthriaErrorCode::InvalidData,
                "{key} must be required"
            );
        }
    }
    #[test]
    fn classification_ignores_metrics_and_legacy_overrides_with_type_priority() {
        let mut value = write_payload();
        value["type"] = json!("WeightTraining");
        value["sport"] = json!("Swim");
        value["modality"] = json!("endurance");
        value["domains"] = json!(["endurance"]);
        value["subtype"] = json!("weighttraining");
        value["strengthSets"] = json!([]);
        value["endurance"] = json!({"averageHeartRate":130});
        let session = parse_training_session(&value).unwrap();
        assert_eq!(session["type"], "StrengthTraining");
        assert_eq!(session["subtype"], Value::Null);
        assert_eq!(session["domains"], json!(["strength"]));
        assert!(session.get("modality").is_none() && session.get("sport").is_none());
        value["type"] = Value::Null;
        assert_eq!(parse_training_session(&value).unwrap()["type"], "Swim");
        value["type"] = json!("Unknown");
        assert_eq!(parse_training_session(&value).unwrap()["domains"], json!([]));
    }

}
