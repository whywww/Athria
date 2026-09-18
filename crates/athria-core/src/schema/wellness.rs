//! `wellnessRecordSchema` normalization.
//!
//! Wellness schema parsing and normalization. `fields` is a
//! strict partial object over the 24 wellness fields, so a parsed record keeps
//! exactly the present fields in schema declaration order — the order both the
//! TypeScript store and the Rust store write into `wellness.data`.

use serde_json::{Map, Value};

use super::common::*;
use crate::Result;

/// The `wellnessFields` shape order.
pub const WELLNESS_FIELD_ORDER: [&str; 24] = [
    "restingHeartRateBpm",
    "hrvRmssdMs",
    "hrvSdnnMs",
    "sleepSeconds",
    "sleepScore",
    "sleepQuality",
    "avgSleepingHeartRateBpm",
    "weightKg",
    "bodyFatPercent",
    "vo2maxMlKgMin",
    "spo2Percent",
    "stepsCount",
    "respirationRpm",
    "fatigue",
    "soreness",
    "stress",
    "mood",
    "motivation",
    "readiness",
    "injuryScore",
    "notes",
    "eftpWatts",
    "wPrimeJoules",
    "pMaxWatts",
];

/// `wellnessSourceSchema`.
const SOURCES: [&str; 3] = ["intervals_icu", "user", "llm"];

/// The `wellnessFieldSchema(...)` validator behind each field.
#[derive(Clone, Copy)]
enum FieldValue {
    NonNegative,
    NonNegativeInteger,
    ZeroToOneHundred,
    Positive,
    Text(usize),
}

/// `z.number().nonnegative()` and friends; `null` is always allowed.
fn accepts(rule: FieldValue, value: &Value) -> bool {
    match rule {
        FieldValue::Text(maximum) => value
            .as_str()
            .is_some_and(|text| text.encode_utf16().count() <= maximum),
        FieldValue::NonNegative => value.as_f64().is_some_and(|number| number >= 0.0),
        FieldValue::NonNegativeInteger => value
            .as_f64()
            .is_some_and(|number| number >= 0.0 && number.fract() == 0.0),
        FieldValue::ZeroToOneHundred => value
            .as_f64()
            .is_some_and(|number| (0.0..=100.0).contains(&number)),
        FieldValue::Positive => value.as_f64().is_some_and(|number| number > 0.0),
    }
}

fn rule_for(field: &str) -> FieldValue {
    match field {
        "sleepSeconds" | "sleepQuality" | "stepsCount" | "injuryScore" => {
            FieldValue::NonNegativeInteger
        }
        "sleepScore" | "bodyFatPercent" | "spo2Percent" => FieldValue::ZeroToOneHundred,
        "weightKg" => FieldValue::Positive,
        "notes" => FieldValue::Text(2000),
        _ => FieldValue::NonNegative,
    }
}

/// `wellnessRecordSchema.parse(value)`.
pub fn parse_wellness_record(value: &Value) -> Result<Value> {
    object(value, "wellness")?;
    let day = required_text(value, "day", "wellness")?;
    if !is_iso_date(&day) {
        return Err(invalid("wellness.day", "expected a YYYY-MM-DD date"));
    }
    let updated_at = required_text(value, "updatedAt", "wellness")?;
    let fields = object(get(value, "fields"), "wellness.fields")?;
    let mut ordered = Map::new();
    for field in fields.keys() {
        if !WELLNESS_FIELD_ORDER.contains(&field.as_str()) {
            return Err(invalid("wellness.fields", "unknown wellness field"));
        }
    }
    for field in WELLNESS_FIELD_ORDER {
        if let Some(field_value) = fields.get(field) {
            ordered.insert(field.to_owned(), parse_field(field, field_value)?);
        }
    }
    let mut record = Map::new();
    record.insert(
        "ownerId".into(),
        Value::String(text_or(value, "ownerId", crate::DEFAULT_OWNER_ID)),
    );
    record.insert("day".into(), Value::String(day));
    record.insert("fields".into(), Value::Object(ordered));
    record.insert("updatedAt".into(), Value::String(updated_at));
    Ok(Value::Object(record))
}

/// Parsed `wellnessPatchSchema`: the confirmed field update for one day.
#[derive(Debug, Clone, PartialEq)]
pub struct WellnessPatch {
    pub expected_snapshot_hash: String,
    /// `user` or `llm`; intervals imports never come through this path.
    pub source: String,
    /// Raw `{ field: value }` entries; `null` clears the stored field.
    pub fields: Map<String, Value>,
}

/// `wellnessPatchSchema.parse(value)`.
pub fn parse_wellness_patch(value: &Value) -> Result<WellnessPatch> {
    object(value, "wellnessPatch")?;
    if value.get("confirmed") != Some(&Value::Bool(true)) {
        return Err(invalid("wellnessPatch.confirmed", "expected true"));
    }
    let source = value
        .get("source")
        .and_then(Value::as_str)
        .filter(|candidate| ["user", "llm"].contains(candidate));
    let Some(source) = source else {
        return Err(invalid(
            "wellnessPatch.source",
            "expected a wellness source",
        ));
    };
    Ok(WellnessPatch {
        expected_snapshot_hash: required_text(value, "expectedSnapshotHash", "wellnessPatch")?,
        source: source.to_owned(),
        fields: object(get(value, "fields"), "wellnessPatch.fields")?.clone(),
    })
}

/// `wellnessFieldSchema(...)`: `{ value, source, updatedAt }`, strict.
fn parse_field(field: &str, value: &Value) -> Result<Value> {
    let path = format!("wellness.fields.{field}");
    let entries = object(value, &path)?;
    for key in entries.keys() {
        if !["value", "source", "updatedAt"].contains(&key.as_str()) {
            return Err(invalid(&path, "unknown field key"));
        }
    }
    let field_value = get(value, "value");
    if !field_value.is_null() && !accepts(rule_for(field), field_value) {
        return Err(invalid(&path, "value is outside the field range"));
    }
    let source = entries
        .get("source")
        .and_then(Value::as_str)
        .filter(|candidate| SOURCES.contains(candidate));
    let Some(source) = source else {
        return Err(invalid(
            &format!("{path}.source"),
            "expected a wellness source",
        ));
    };
    let updated_at = required_text(value, "updatedAt", &path)?;
    let mut parsed = Map::new();
    parsed.insert("value".into(), field_value.clone());
    parsed.insert("source".into(), Value::String(source.to_owned()));
    parsed.insert("updatedAt".into(), Value::String(updated_at));
    Ok(Value::Object(parsed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fields_are_rebuilt_in_schema_order() {
        let record = parse_wellness_record(&json!({
            "ownerId": "local-user",
            "day": "2026-09-17",
            "fields": {
                "weightKg": { "value": 72.5, "source": "user", "updatedAt": "2026-09-17T04:00:00.000Z" },
                "restingHeartRateBpm": { "value": 48, "source": "intervals_icu", "updatedAt": "2026-09-17T04:00:00.000Z" },
            },
            "updatedAt": "2026-09-17T04:00:00.000Z",
        }))
        .unwrap();
        let keys: Vec<&String> = record.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["ownerId", "day", "fields", "updatedAt"]);
        let fields: Vec<&String> = record["fields"].as_object().unwrap().keys().collect();
        assert_eq!(fields, ["restingHeartRateBpm", "weightKg"]);
    }

    #[test]
    fn null_values_stay_present_and_unknown_fields_are_rejected() {
        let record = parse_wellness_record(&json!({
            "day": "2026-09-17",
            "fields": { "notes": { "value": null, "source": "llm", "updatedAt": "2026-09-17T04:00:00.000Z" } },
            "updatedAt": "2026-09-17T04:00:00.000Z",
        }))
        .unwrap();
        assert_eq!(record["ownerId"], json!(crate::DEFAULT_OWNER_ID));
        assert_eq!(record["fields"]["notes"]["value"], json!(null));

        let error = parse_wellness_record(&json!({
            "day": "2026-09-17",
            "fields": { "weightLbs": { "value": 160, "source": "user", "updatedAt": "2026-09-17T04:00:00.000Z" } },
            "updatedAt": "2026-09-17T04:00:00.000Z",
        }))
        .unwrap_err();
        assert_eq!(error.code(), crate::AthriaErrorCode::InvalidData);
    }

    #[test]
    fn field_values_are_range_checked() {
        for fields in [
            json!({ "weightKg": { "value": 0, "source": "user", "updatedAt": "2026-09-17T04:00:00.000Z" } }),
            json!({ "sleepScore": { "value": 101, "source": "user", "updatedAt": "2026-09-17T04:00:00.000Z" } }),
            json!({ "stepsCount": { "value": 8123.5, "source": "intervals_icu", "updatedAt": "2026-09-17T04:00:00.000Z" } }),
            json!({ "restingHeartRateBpm": { "value": "48", "source": "user", "updatedAt": "2026-09-17T04:00:00.000Z" } }),
            json!({ "weightKg": { "value": 72, "source": "hevy", "updatedAt": "2026-09-17T04:00:00.000Z" } }),
        ] {
            assert!(parse_wellness_record(&json!({ "day": "2026-09-17", "fields": fields, "updatedAt": "2026-09-17T04:00:00.000Z" })).is_err());
        }
    }

    #[test]
    fn invalid_days_are_rejected() {
        assert!(parse_wellness_record(&json!({ "day": "2026-9-17", "fields": {}, "updatedAt": "2026-09-17T04:00:00.000Z" })).is_err());
        assert!(parse_wellness_record(&json!({ "day": "2026-09-17T00:00:00Z", "fields": {}, "updatedAt": "2026-09-17T04:00:00.000Z" })).is_err());
    }
}
