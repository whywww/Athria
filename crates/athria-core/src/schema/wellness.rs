//! `wellnessRecordSchema` normalization.
//!
//! Wellness schema parsing and normalization. `fields` is a
//! strict partial object over the 17 wellness fields, so a parsed record keeps
//! exactly the present fields in schema declaration order — the order both the
//! TypeScript store and the Rust store write into `wellness.data`.

use serde_json::{Map, Value};

use super::common::*;
use crate::Result;

/// The `wellnessFields` shape order.
pub const WELLNESS_FIELD_ORDER: [&str; 17] = [
    "restingHeartRateBpm",
    "hrvRmssdMs",
    "hrvSdnnMs",
    "sleepSeconds",
    "sleepScore",
    "avgSleepingHeartRateBpm",
    "weightKg",
    "bodyFatPercent",
    "vo2maxMlKgMin",
    "spo2Percent",
    "stepsCount",
    "respirationRpm",
    "subjectiveFatigue",
    "readiness",
    "atl",
    "ctl",
    "form",
];

/// ICU `sleepQuality` grades mapped onto the 0–100 scale, aligned with the
/// readiness sleep bands so folded imports keep their meaning.
pub const ICU_SLEEP_QUALITY_SCORES: [(f64, f64); 4] =
    [(1.0, 90.0), (2.0, 75.0), (3.0, 60.0), (4.0, 45.0)];

/// Map an intervals.icu `sleepQuality` grade (integer 1–4) to its score.
pub fn icu_sleep_quality_score(grade: f64) -> Option<f64> {
    ICU_SLEEP_QUALITY_SCORES
        .into_iter()
        .find(|(candidate, _)| *candidate == grade)
        .map(|(_, score)| score)
}

/// ICU `fatigue` grades (None 0 – Extreme 4) mapped onto the 0–100 scale,
/// where 0 is well rested and 100 is exhausted.
pub const ICU_FATIGUE_SCORES: [(f64, f64); 5] =
    [(0.0, 0.0), (1.0, 25.0), (2.0, 50.0), (3.0, 75.0), (4.0, 100.0)];

/// Map an intervals.icu `fatigue` grade (integer 0–4) to its score.
pub fn icu_fatigue_score(grade: f64) -> Option<f64> {
    ICU_FATIGUE_SCORES
        .into_iter()
        .find(|(candidate, _)| *candidate == grade)
        .map(|(_, score)| score)
}

/// `wellnessSourceSchema`.
const SOURCES: [&str; 4] = ["intervals_icu", "user", "llm", "athria"];

/// The `wellnessFieldSchema(...)` validator behind each field.
#[derive(Clone, Copy)]
enum FieldValue {
    NonNegative,
    Finite,
    NonNegativeInteger,
    ZeroToOneHundred,
    Positive,
    SleepDuration,
}

/// `z.number().nonnegative()` and friends; `null` is always allowed.
fn accepts(rule: FieldValue, value: &Value) -> bool {
    match rule {
        FieldValue::SleepDuration => value.as_f64().is_some_and(|number| (0.0..=86400.0).contains(&number) && number.fract() == 0.0),
        FieldValue::Finite => value.as_f64().is_some_and(f64::is_finite),
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
        "sleepSeconds" => FieldValue::SleepDuration,
        "stepsCount" => FieldValue::NonNegativeInteger,
        "sleepScore" | "readiness" | "bodyFatPercent" | "spo2Percent" | "subjectiveFatigue" => FieldValue::ZeroToOneHundred,
        "weightKg" => FieldValue::Positive,
        "form" => FieldValue::Finite,
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
    let fields = object(get(value, "fields"), "wellness.fields")?.clone();
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
    let mut record = Value::Object(record);
    derive_wellness_form(&mut record);
    Ok(record)
}

/// Form is derived from same-day load values, never supplied independently.
pub fn derive_wellness_form(record: &mut Value) {
    let updated_at = record.get("updatedAt").cloned().unwrap_or(Value::Null);
    let Some(fields) = record.get_mut("fields").and_then(Value::as_object_mut) else { return };
    let load = |key: &str| fields.get(key)?.get("value")?.as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0);
    let form = load("ctl").zip(load("atl")).map(|(ctl, atl)| ctl - atl);
    fields.shift_remove("form");
    if let Some(value) = form.filter(|value| value.is_finite()) {
        fields.insert("form".into(), serde_json::json!({ "value": value, "source": "intervals_icu", "updatedAt": updated_at }));
    }
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
    let fields = object(get(value, "fields"), "wellnessPatch.fields")?;
    if let Some(field) = fields.keys().find(|field| !WELLNESS_FIELD_ORDER.contains(&field.as_str())) {
        return Err(invalid(&format!("wellnessPatch.fields.{field}"), "unknown wellness field"));
    }
    if fields.contains_key("readiness") {
        return Err(invalid("wellnessPatch.fields.readiness", "readiness is calculated by Athria"));
    }
    Ok(WellnessPatch {
        expected_snapshot_hash: required_text(value, "expectedSnapshotHash", "wellnessPatch")?,
        source: source.to_owned(),
        fields: fields.clone(),
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
    fn records_reject_old_fields_and_preserve_current_low_scores() {
        for field in ["fatigue", "subjectiveSleepScore", "sleepQuality", "manualSleepSeconds", "unknown"] {
            assert!(parse_wellness_record(&json!({"day":"2026-10-30","updatedAt":"now","fields":{field:{"value":3,"source":"user","updatedAt":"now"}}})).is_err());
        }
        for score in [0,1,4,100] {
            let value=parse_wellness_record(&json!({"day":"2026-10-30","updatedAt":"now","fields":{"subjectiveFatigue":{"value":score,"source":"user","updatedAt":"now"}}})).unwrap();
            assert_eq!(value["fields"]["subjectiveFatigue"]["value"],score);
        }
        for (grade, score) in ICU_SLEEP_QUALITY_SCORES { assert_eq!(icu_sleep_quality_score(grade),Some(score)); }
    }

    #[test]
    fn load_ranges_and_derived_form_are_validated() {
        let stamp = "2026-10-14T00:00:00Z";
        for (atl, ctl, expected) in [(60.5, 40.25, -20.25), (0.0, 4.5, 4.5), (0.0, 0.0, 0.0)] {
            let record = parse_wellness_record(&json!({ "day": "2026-10-14", "updatedAt": stamp,
                "fields": {
                    "atl": { "value": atl, "source": "intervals_icu", "updatedAt": stamp },
                    "ctl": { "value": ctl, "source": "intervals_icu", "updatedAt": stamp },
                    "form": { "value": -999, "source": "user", "updatedAt": stamp }
                }
            })).unwrap();
            assert_eq!(record["fields"]["form"]["value"], json!(expected));
        }
        for key in ["atl", "ctl"] {
            assert!(parse_wellness_record(&json!({ "day": "2026-10-14", "updatedAt": stamp,
                "fields": { key: { "value": -1, "source": "intervals_icu", "updatedAt": stamp } }
            })).is_err());
        }
        let record = parse_wellness_record(&json!({ "day": "2026-10-14", "updatedAt": stamp,
            "fields": { "ctl": { "value": null, "source": "intervals_icu", "updatedAt": stamp },
                "form": { "value": 1, "source": "user", "updatedAt": stamp } }
        })).unwrap();
        assert!(record["fields"].get("form").is_none());
    }

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
    fn wellness_patches_reject_retired_fields() {
        for field in ["fatigue", "subjectiveSleepScore", "sleepQuality", "manualSleepSeconds", "notes"] {
            for value in [json!("New note"), json!(3), json!(null)] {
                let mut fields = Map::new();
                fields.insert(field.to_owned(), value);
                assert!(parse_wellness_patch(&json!({
                    "confirmed": true, "source": "user", "expectedSnapshotHash": "new",
                    "fields": Value::Object(fields),
                })).is_err());
            }
        }
        assert!(parse_wellness_patch(&json!({
            "confirmed": true, "source": "user", "expectedSnapshotHash": "new",
            "fields": { "readiness": 80 },
        })).is_err());
    }

    #[test]
    fn field_order_holds_only_live_fields() {
        assert_eq!(WELLNESS_FIELD_ORDER.len(), 17);
        for field in ["fatigue", "subjectiveSleepScore", "sleepQuality", "manualSleepSeconds", "notes"] {
            assert!(!WELLNESS_FIELD_ORDER.contains(&field));
        }
    }

    #[test]
    fn null_values_stay_present_and_unknown_fields_are_rejected() {
        let record = parse_wellness_record(&json!({
            "day": "2026-09-17",
            "fields": { "sleepScore": { "value": null, "source": "llm", "updatedAt": "2026-09-17T04:00:00.000Z" } },
            "updatedAt": "2026-09-17T04:00:00.000Z",
        }))
        .unwrap();
        assert_eq!(record["ownerId"], json!(crate::DEFAULT_OWNER_ID));
        assert_eq!(record["fields"]["sleepScore"]["value"], json!(null));

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
            json!({ "subjectiveFatigue": { "value": -1, "source": "user", "updatedAt": "2026-09-17T04:00:00.000Z" } }),
            json!({ "subjectiveFatigue": { "value": 101, "source": "user", "updatedAt": "2026-09-17T04:00:00.000Z" } }),
            json!({ "stepsCount": { "value": 8123.5, "source": "intervals_icu", "updatedAt": "2026-09-17T04:00:00.000Z" } }),
            json!({ "restingHeartRateBpm": { "value": "48", "source": "user", "updatedAt": "2026-09-17T04:00:00.000Z" } }),
            json!({ "weightKg": { "value": 72, "source": "hevy", "updatedAt": "2026-09-17T04:00:00.000Z" } }),
        ] {
            assert!(parse_wellness_record(&json!({ "day": "2026-09-17", "fields": fields, "updatedAt": "2026-09-17T04:00:00.000Z" })).is_err());
        }
        for value in [json!(0), json!(100)] {
            let record = parse_wellness_record(&json!({ "day": "2026-09-17", "updatedAt": "2026-09-17T04:00:00.000Z",
                "fields": { "subjectiveFatigue": { "value": value, "source": "user", "updatedAt": "2026-09-17T04:00:00.000Z" } } }));
            assert_eq!(record.unwrap()["fields"]["subjectiveFatigue"]["value"], value);
        }
    }

    #[test]
    fn invalid_days_are_rejected() {
        assert!(parse_wellness_record(&json!({ "day": "2026-9-17", "fields": {}, "updatedAt": "2026-09-17T04:00:00.000Z" })).is_err());
        assert!(parse_wellness_record(&json!({ "day": "2026-09-17T00:00:00Z", "fields": {}, "updatedAt": "2026-09-17T04:00:00.000Z" })).is_err());
    }

    #[test]
    fn sleep_duration_ranges_and_missing_values_are_validated() {
        for value in [json!(0), json!(86400), json!(null)] {
            let fields = json!({ "sleepSeconds": { "value": value, "source": "user", "updatedAt": "2026-09-17T04:00:00.000Z" } });
            assert!(parse_wellness_record(&json!({ "day": "2026-09-17", "fields": fields, "updatedAt": "2026-09-17T04:00:00.000Z" })).is_ok());
        }
        for value in [json!(-1), json!(86401), json!(1.5)] {
            let fields = json!({ "sleepSeconds": { "value": value, "source": "user", "updatedAt": "2026-09-17T04:00:00.000Z" } });
            assert!(parse_wellness_record(&json!({ "day": "2026-09-17", "fields": fields, "updatedAt": "2026-09-17T04:00:00.000Z" })).is_err());
        }
    }





    #[test]
    fn icu_fatigue_grades_map_onto_the_hundred_scale() {
        for (grade, mapped) in [(0, 0), (1, 25), (2, 50), (3, 75), (4, 100)] {
            assert_eq!(icu_fatigue_score(grade as f64), Some(mapped as f64));
        }
        for grade in [-1.0, 2.5, 5.0] {
            assert_eq!(icu_fatigue_score(grade), None);
        }
    }




}
