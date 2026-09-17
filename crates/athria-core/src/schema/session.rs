//! `trainingSessionSchema` and its nested shapes.
//!
//! Ported from `packages/schemas/src/index.ts` lines 85-96. A parsed session is
//! a 21-key document in schema declaration order — the order every stored
//! `training_sessions.data` row and every session response serializes in.

use serde_json::{Map, Value};

use super::common::*;
use crate::Result;
use crate::vocab::DOMAIN_IDS;

/// `modalitySchema`, kept only as source metadata on imported records.
const MODALITIES: [&str; 5] = ["strength", "endurance", "recovery", "mixed", "unknown"];
const TIME_PRECISIONS: [&str; 2] = ["exact", "date_only"];
const WEIGHT_UNITS: [&str; 2] = ["kg", "lb"];

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
    let modality = enum_or(value, "modality", &MODALITIES, "");
    if modality.is_empty() {
        return Err(invalid("session.modality", "expected a modality"));
    }
    session.insert("modality".into(), Value::String(modality));
    session.insert("domains".into(), domain_array(value, "domains"));
    session.insert("sport".into(), text_or_null(value, "sport"));
    session.insert(
        "name".into(),
        Value::String(required_text(value, "name", "session")?),
    );
    session.insert(
        "startAt".into(),
        Value::String(required_text(value, "startAt", "session")?),
    );
    session.insert(
        "endAt".into(),
        Value::String(required_text(value, "endAt", "session")?),
    );
    session.insert(
        "durationMinutes".into(),
        Value::from(required_int(value, "durationMinutes", "session")?),
    );
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
    session.insert("missingFields".into(), string_array(value, "missingFields"));
    Ok(Value::Object(session))
}

/// `z.array(domainSchema)`/`z.array(z.string())` as a reader: entries outside
/// the vocabulary are dropped, like the other array readers in this module.
fn domain_array(value: &Value, key: &str) -> Value {
    enum_array_or(value, key, &DOMAIN_IDS, &[])
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
            "modality": "strength",
            "domains": ["strength"],
            "sport": null,
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
            "modality",
            "name",
            "startAt",
            "endAt",
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
}
