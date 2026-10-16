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

const RETIRED_WELLNESS_FIELDS: [&str; 13] = [
    "fatigue",
    "eftpWatts",
    "wPrimeJoules",
    "pMaxWatts",
    "notes",
    "soreness",
    "stress",
    "mood",
    "motivation",
    "injuryScore",
    "subjectiveSleepScore",
    "sleepQuality",
    "manualSleepSeconds",
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

/// Fold `subjectiveSleepScore`, `sleepQuality` and `manualSleepSeconds` into
/// the single sleep fields, then drop obsolete fields; idempotent.
pub fn fold_wellness_fields(record: &mut Value) {
    if let Some(fields) = record.get_mut("fields").and_then(Value::as_object_mut) {
        fold_sleep_fields_in(fields);
        fold_sleep_duration_in(fields);
        fold_fatigue_grade_in(fields);
        for key in RETIRED_WELLNESS_FIELDS {
            fields.shift_remove(key);
        }
    }
}

/// The usable 0–100 value of a sleep-score entry; `null` and out-of-range
/// values count as absent.
fn sleep_score_value(entry: Option<&Value>) -> Option<f64> {
    entry?
        .get("value")?
        .as_f64()
        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
}

/// `true` when `later` carries a strictly later `updatedAt` instant than
/// `earlier`; unparseable stamps never count as later.
fn strictly_later(later: &Value, earlier: &Value) -> bool {
    let stamp = |entry: &Value| {
        entry
            .get("updatedAt")
            .and_then(Value::as_str)
            .and_then(|iso| crate::tz::millis(iso).ok())
    };
    matches!((stamp(later), stamp(earlier)), (Some(later), Some(earlier)) if later > earlier)
}

/// The entry that replaces `sleepScore`, or `None` to keep the stored entry.
/// The latest usable value wins; ties and unparseable timestamps favor
/// `sleepScore`, and a mapped grade is the last resort.
fn fold_sleep_winner(fields: &Map<String, Value>) -> Option<Value> {
    let score = fields.get("sleepScore");
    let subjective = fields.get("subjectiveSleepScore");
    match (sleep_score_value(score), sleep_score_value(subjective)) {
        (Some(_), Some(_)) => match (score, subjective) {
            (Some(score), Some(subjective)) if strictly_later(subjective, score) => {
                Some(subjective.clone())
            }
            _ => None,
        },
        (Some(_), None) => None,
        (None, Some(_)) => subjective.cloned(),
        (None, None) => mapped_quality_entry(fields),
    }
}

/// A `sleepQuality` entry converted to a score entry, preserving its source
/// and `updatedAt`; `None` when the grade is missing or outside 1–4.
fn mapped_quality_entry(fields: &Map<String, Value>) -> Option<Value> {
    let entry = fields.get("sleepQuality")?.as_object()?;
    let mapped = icu_sleep_quality_score(entry.get("value")?.as_f64()?)?;
    let mut entry = entry.clone();
    entry.insert("value".into(), crate::js_number(mapped));
    Some(Value::Object(entry))
}

/// Fold sleep fields in place, keeping the `sleepScore` key position when it
/// already exists.
fn fold_sleep_fields_in(fields: &mut Map<String, Value>) {
    if let Some(winner) = fold_sleep_winner(fields) {
        fields.insert("sleepScore".into(), winner);
    }
    fields.shift_remove("subjectiveSleepScore");
    fields.shift_remove("sleepQuality");
}

/// The usable value of a sleep-duration entry: a whole number of seconds
/// between 0 and 86,400; `null` and out-of-range values count as absent.
fn sleep_duration_value(entry: Option<&Value>) -> Option<f64> {
    entry?
        .get("value")?
        .as_f64()
        .filter(|value| {
            value.is_finite() && (0.0..=86400.0).contains(value) && value.fract() == 0.0
        })
}

/// The entry that replaces `sleepSeconds`, or `None` to keep the stored entry.
/// The latest usable value wins; ties and unparseable timestamps favor
/// `sleepSeconds`.
fn fold_duration_winner(fields: &Map<String, Value>) -> Option<Value> {
    let stored = fields.get("sleepSeconds");
    let manual = fields.get("manualSleepSeconds");
    match (sleep_duration_value(stored), sleep_duration_value(manual)) {
        (Some(_), Some(_)) => match (stored, manual) {
            (Some(stored), Some(manual)) if strictly_later(manual, stored) => Some(manual.clone()),
            _ => None,
        },
        (None, Some(_)) => manual.cloned(),
        _ => None,
    }
}

/// Fold `manualSleepSeconds` in place, keeping the `sleepSeconds` key position
/// when it already exists.
fn fold_sleep_duration_in(fields: &mut Map<String, Value>) {
    if let Some(winner) = fold_duration_winner(fields) {
        fields.insert("sleepSeconds".into(), winner);
    }
    fields.shift_remove("manualSleepSeconds");
}

/// Old stores kept raw ICU `fatigue` grades for imported user ratings; remap those
/// onto the 0–100 scale in place, keeping source and timestamp; idempotent.
fn fold_fatigue_grade_in(fields: &mut Map<String, Value>) {
    let Some(mut entry) = fields.shift_remove("fatigue") else { return };
    if fields.contains_key("subjectiveFatigue") { return; }
    if entry.get("source").and_then(Value::as_str) == Some("intervals_icu") {
        if let Some(mapped) = entry.get("value").and_then(Value::as_f64)
            .filter(|grade| (1.0..=4.0).contains(grade)).and_then(icu_fatigue_score) {
            entry["value"] = crate::js_number(mapped);
        }
    }
    fields.insert("subjectiveFatigue".into(), entry);
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
    let mut fields = object(get(value, "fields"), "wellness.fields")?.clone();
    fold_sleep_fields_in(&mut fields);
    fold_sleep_duration_in(&mut fields);
    fold_fatigue_grade_in(&mut fields);
    let mut ordered = Map::new();
    for field in fields.keys() {
        if !WELLNESS_FIELD_ORDER.contains(&field.as_str()) && !RETIRED_WELLNESS_FIELDS.contains(&field.as_str()) {
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
    fold_wellness_fields(record);
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
    if let Some(field) = fields.keys().find(|field| RETIRED_WELLNESS_FIELDS.contains(&field.as_str())) {
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
        for field in RETIRED_WELLNESS_FIELDS {
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
        for field in RETIRED_WELLNESS_FIELDS {
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
    fn legacy_sleep_fields_fold_into_sleep_score() {
        let early = "2026-09-16T04:00:00.000Z";
        let late_ = "2026-09-17T04:00:00.000Z";
        let fold = |fields: Value| {
            parse_wellness_record(&json!({ "day": "2026-09-17", "fields": fields, "updatedAt": late_ })).unwrap()
        };
        // The newer subjective entry wins, keeping its source and timestamp.
        let record = fold(json!({
            "sleepScore": { "value": 80, "source": "intervals_icu", "updatedAt": early },
            "subjectiveSleepScore": { "value": 54, "source": "user", "updatedAt": late_ },
        }));
        assert_eq!(record["fields"]["sleepScore"], json!({ "value": 54, "source": "user", "updatedAt": late_ }));
        assert!(record["fields"].get("subjectiveSleepScore").is_none());
        // Ties, unparseable stamps and newer device scores keep sleepScore.
        for subjective in [
            json!({ "value": 54, "source": "user", "updatedAt": early }),
            json!({ "value": 54, "source": "user", "updatedAt": late_ }),
            json!({ "value": 54, "source": "user", "updatedAt": "yesterday" }),
        ] {
            let record = fold(json!({
                "sleepScore": { "value": 80, "source": "intervals_icu", "updatedAt": late_ },
                "subjectiveSleepScore": subjective,
            }));
            assert_eq!(record["fields"]["sleepScore"], json!({ "value": 80, "source": "intervals_icu", "updatedAt": late_ }));
        }
        // A null device value lets the subjective entry fill in.
        let record = fold(json!({
            "sleepScore": { "value": null, "source": "intervals_icu", "updatedAt": late_ },
            "subjectiveSleepScore": { "value": 54, "source": "user", "updatedAt": early },
        }));
        assert_eq!(record["fields"]["sleepScore"], json!({ "value": 54, "source": "user", "updatedAt": early }));
        // A lone subjective score becomes the sleep score under its own source.
        let record = fold(json!({ "subjectiveSleepScore": { "value": 0, "source": "llm", "updatedAt": early } }));
        assert_eq!(record["fields"]["sleepScore"], json!({ "value": 0, "source": "llm", "updatedAt": early }));
        // ICU grades map onto the 0–100 scale, keeping source and timestamp.
        for (grade, mapped) in [(1, 90), (2, 75), (3, 60), (4, 45)] {
            let record = fold(json!({ "sleepQuality": { "value": grade, "source": "intervals_icu", "updatedAt": early } }));
            assert_eq!(record["fields"]["sleepScore"], json!({ "value": mapped, "source": "intervals_icu", "updatedAt": early }));
            assert!(record["fields"].get("sleepQuality").is_none());
        }
        // A usable score outranks the grade fallback.
        let record = fold(json!({
            "sleepScore": { "value": 80, "source": "intervals_icu", "updatedAt": early },
            "sleepQuality": { "value": 2, "source": "intervals_icu", "updatedAt": late_ },
        }));
        assert_eq!(record["fields"]["sleepScore"]["value"], json!(80));
        // Unusable grades produce no score, and other retired fields are dropped.
        for grade in [json!(0), json!(5), json!(2.5), json!(null)] {
            let record = fold(json!({ "sleepQuality": { "value": grade, "source": "intervals_icu", "updatedAt": early } }));
            assert!(record["fields"].as_object().unwrap().is_empty());
        }
        let record = fold(json!({ "soreness": { "value": 3, "source": "user", "updatedAt": early } }));
        assert!(record["fields"].as_object().unwrap().is_empty());
        // Folding is idempotent.
        let mut record = fold(json!({
            "sleepScore": { "value": 80, "source": "intervals_icu", "updatedAt": early },
            "subjectiveSleepScore": { "value": 54, "source": "user", "updatedAt": late_ },
            "sleepQuality": { "value": 2, "source": "intervals_icu", "updatedAt": early },
        }));
        let once = record.clone();
        fold_wellness_fields(&mut record);
        assert_eq!(record, once);
    }

    #[test]
    fn legacy_manual_duration_folds_into_sleep_seconds() {
        let early = "2026-09-16T04:00:00.000Z";
        let late_ = "2026-09-17T04:00:00.000Z";
        let fold = |fields: Value| {
            parse_wellness_record(&json!({ "day": "2026-09-17", "fields": fields, "updatedAt": late_ })).unwrap()
        };
        // The newer manual entry wins, keeping its source and timestamp.
        let record = fold(json!({
            "sleepSeconds": { "value": 28800, "source": "intervals_icu", "updatedAt": early },
            "manualSleepSeconds": { "value": 25200, "source": "user", "updatedAt": late_ },
        }));
        assert_eq!(record["fields"]["sleepSeconds"], json!({ "value": 25200, "source": "user", "updatedAt": late_ }));
        assert!(record["fields"].get("manualSleepSeconds").is_none());
        // Ties, unparseable stamps and newer device values keep sleepSeconds.
        for manual in [
            json!({ "value": 25200, "source": "user", "updatedAt": early }),
            json!({ "value": 25200, "source": "user", "updatedAt": "yesterday" }),
        ] {
            let record = fold(json!({
                "sleepSeconds": { "value": 28800, "source": "intervals_icu", "updatedAt": late_ },
                "manualSleepSeconds": manual,
            }));
            assert_eq!(record["fields"]["sleepSeconds"], json!({ "value": 28800, "source": "intervals_icu", "updatedAt": late_ }));
        }
        // A null or unusable device value lets the manual entry fill in, including zero.
        for stored in [json!(null), json!(86401), json!(1.5)] {
            let record = fold(json!({
                "sleepSeconds": { "value": stored, "source": "intervals_icu", "updatedAt": late_ },
                "manualSleepSeconds": { "value": 0, "source": "user", "updatedAt": early },
            }));
            assert_eq!(record["fields"]["sleepSeconds"], json!({ "value": 0, "source": "user", "updatedAt": early }));
        }
        // A lone manual duration becomes the sleep duration under its own source.
        let record = fold(json!({ "manualSleepSeconds": { "value": 27000, "source": "llm", "updatedAt": early } }));
        assert_eq!(record["fields"]["sleepSeconds"], json!({ "value": 27000, "source": "llm", "updatedAt": early }));
        // Unusable manual values never produce a value.
        for manual in [json!(null), json!(-1), json!(86401), json!(1.5)] {
            let record = fold(json!({ "manualSleepSeconds": { "value": manual, "source": "user", "updatedAt": early } }));
            assert!(record["fields"].get("sleepSeconds").is_none());
        }
        // Folding is idempotent.
        let mut record = fold(json!({
            "sleepSeconds": { "value": 28800, "source": "intervals_icu", "updatedAt": early },
            "manualSleepSeconds": { "value": 25200, "source": "user", "updatedAt": late_ },
        }));
        let once = record.clone();
        fold_wellness_fields(&mut record);
        assert_eq!(record, once);
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

    #[test]
    fn subjective_fatigue_preserves_low_scores_and_wins_over_legacy() {
        for value in [0, 1, 2, 3, 4, 100] {
            let mut record = json!({ "fields": {
                "fatigue": { "value": 4, "source": "intervals_icu", "updatedAt": "old" },
                "subjectiveFatigue": { "value": value, "source": "intervals_icu", "updatedAt": "new" }
            }});
            fold_wellness_fields(&mut record);
            assert!(record["fields"].get("fatigue").is_none());
            assert_eq!(record["fields"]["subjectiveFatigue"]["value"], value);
            let once = record.clone();
            fold_wellness_fields(&mut record);
            assert_eq!(record, once);
        }
    }

    #[test]
    fn legacy_icu_fatigue_grades_fold_onto_the_hundred_scale() {
        let stamp = "2026-09-17T04:00:00.000Z";
        let fold = |fields: Value| {
            parse_wellness_record(&json!({ "day": "2026-09-17", "fields": fields, "updatedAt": stamp })).unwrap()
        };
        // Legacy device grades are remapped in place, keeping source and timestamp.
        for (grade, mapped) in [(1, 25), (2, 50), (3, 75), (4, 100)] {
            let record = fold(json!({ "fatigue": { "value": grade, "source": "intervals_icu", "updatedAt": stamp } }));
            assert_eq!(record["fields"]["subjectiveFatigue"], json!({ "value": mapped, "source": "intervals_icu", "updatedAt": stamp }));
        }
        // A real zero, already-mapped scores, fractional and out-of-band grades stay put.
        for value in [json!(0), json!(25), json!(75), json!(2.5), json!(5)] {
            let record = fold(json!({ "fatigue": { "value": value, "source": "intervals_icu", "updatedAt": stamp } }));
            assert_eq!(record["fields"]["subjectiveFatigue"]["value"], value);
        }
        // Manual entries are never remapped.
        let record = fold(json!({ "fatigue": { "value": 3, "source": "user", "updatedAt": stamp } }));
        assert_eq!(record["fields"]["subjectiveFatigue"]["value"], json!(3));
        // Folding is idempotent.
        let mut record = fold(json!({ "fatigue": { "value": 3, "source": "intervals_icu", "updatedAt": stamp } }));
        let once = record.clone();
        fold_wellness_fields(&mut record);
        assert_eq!(record, once);
    }
}
