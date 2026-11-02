//! `athleteProfileSchema` and the profile write contracts.
//!
//! Athlete-profile schema parsing and normalization. The
//! parsed profile is a 17-key document in schema declaration order, which is
//! the order every profile response serializes in.

use serde_json::{Map, Value, json};

use super::common::*;
use crate::vocab::{DEFAULT_TIMEZONE, equipment_type_ids};
use crate::{DEFAULT_OWNER_ID, Result};

const GENDERS: [&str; 4] = ["female", "male", "non_binary", "prefer_not_to_say"];
const UNIT_SYSTEMS: [&str; 2] = ["metric", "imperial"];

/// Numeric write constraints; historical reads intentionally remain permissive.
pub fn validate_profile_numbers(value: &Value) -> Result<()> {
    if value.get("maxSessionMinutes").is_some() { return Err(invalid("profile.maxSessionMinutes", "use usualSessionMinutes")); }
    fn number(value: &Value, key: &str, path: &str, min: f64, max: f64, integer: bool, nullable: bool) -> Result<()> {
        if let Some(input) = value.get(key) {
            if nullable && input.is_null() { return Ok(()); }
            let valid = input.as_f64().is_some_and(|n| n >= min && n <= max)
                && (!integer || input.as_i64().is_some());
            if !valid { return Err(invalid(path, &format!("expected {} in {min}..={max}", if integer { "integer" } else { "number" }))); }
        }
        Ok(())
    }
    number(value, "heightCm", "profile.heightCm", 50.0, 250.0, false, true)?;
    number(value, "usualSessionMinutes", "profile.usualSessionMinutes", 15.0, 240.0, true, false)?;
    number(value, "explicitRecoveryDays", "profile.explicitRecoveryDays", 1.0, 7.0, true, true)?;
    number(value, "mesocycleDurationWeeks", "profile.mesocycleDurationWeeks", 1.0, 8.0, true, false)?;
    if let Some(rhythm) = value.get("trainingRhythm") {
        object(rhythm, "profile.trainingRhythm")?;
        match text_or(rhythm, "kind", "flexible_week").as_str() {
            "fixed_week" => {
                if let Some(days) = rhythm.get("days") {
                    let days = days.as_array().ok_or_else(|| invalid("profile.trainingRhythm.days", "expected array"))?;
                    if days.is_empty() || days.len() > 7 { return Err(invalid("profile.trainingRhythm.days", "expected 1..=7 unique days")); }
                    let mut seen = std::collections::HashSet::new();
                    for day in days {
                        let day = day.as_i64().filter(|day| (0..=6).contains(day)).ok_or_else(|| invalid("profile.trainingRhythm.days", "expected integer in 0..=6"))?;
                        if !seen.insert(day) { return Err(invalid("profile.trainingRhythm.days", "duplicate day")); }
                    }
                }
            }
            "interval" => number(rhythm, "intervalDays", "profile.trainingRhythm.intervalDays", 1.0, 30.0, true, false)?,
            _ => for key in ["targetDaysPerWeek", "minDaysPerWeek", "maxDaysPerWeek"] {
                number(rhythm, key, &format!("profile.trainingRhythm.{key}"), 1.0, 7.0, true, false)?;
            },
        }
    }
    Ok(())
}

/// `athleteProfileSchema.parse(value)`.
pub fn parse_profile(value: &Value) -> Result<Value> {
    if value.get("maxSessionMinutes").is_some() { return Err(invalid("profile.maxSessionMinutes", "use usualSessionMinutes")); }
    let equipment_ids = equipment_type_ids();
    let mut profile = Map::new();
    profile.insert(
        "ownerId".into(),
        Value::String(text_or(value, "ownerId", DEFAULT_OWNER_ID)),
    );
    profile.insert(
        "preferredName".into(),
        Value::String(trimmed_or(value, "preferredName", "Athlete")),
    );
    profile.insert("gender".into(), nullable_enum(value, "gender", &GENDERS));
    profile.insert("heightCm".into(), number_or_null(value, "heightCm"));
    profile.insert("birthDate".into(), text_or_null(value, "birthDate"));
    profile.insert(
        "timezone".into(),
        Value::String(text_or(value, "timezone", DEFAULT_TIMEZONE)),
    );
    profile.insert(
        "goals".into(),
        text_array_or(value, "goals", &["general_fitness"]),
    );
    profile.insert(
        "preference".into(),
        Value::String(trimmed_or(value, "preference", "")),
    );
    profile.insert(
        "usualSessionMinutes".into(),
        int_or(value, "usualSessionMinutes", 60),
    );
    profile.insert(
        "trainingRhythm".into(),
        parse_training_rhythm(value.get("trainingRhythm"))?,
    );
    profile.insert(
        "equipment".into(),
        enum_array_or(value, "equipment", &equipment_ids, &equipment_ids),
    );
    profile.insert("injuries".into(), parse_note_list(value, "injuries")?);
    profile.insert(
        "constraintNotes".into(),
        parse_note_list(value, "constraintNotes")?,
    );
    profile.insert(
        "explicitRecoveryDays".into(),
        nullable_int(value, "explicitRecoveryDays"),
    );
    profile.insert(
        "unitSystem".into(),
        Value::String(enum_or(value, "unitSystem", &UNIT_SYSTEMS, "metric")),
    );
    profile.insert(
        "mesocycleDurationWeeks".into(),
        int_or(value, "mesocycleDurationWeeks", 8),
    );
    profile.insert("raceDays".into(), parse_race_days(value.get("raceDays"))?);
    Ok(Value::Object(profile))
}

/// `trainingRhythmSchema.parse(value)` with the schema default.
pub fn parse_training_rhythm(value: Option<&Value>) -> Result<Value> {
    let Some(value) = value.filter(|candidate| candidate.is_object()) else {
        return Ok(
            json!({ "kind": "flexible_week", "targetDaysPerWeek": 4, "minDaysPerWeek": 3, "maxDaysPerWeek": 5 }),
        );
    };
    match enum_or(
        value,
        "kind",
        &["fixed_week", "flexible_week", "interval"],
        "flexible_week",
    )
    .as_str()
    {
        "fixed_week" => Ok(json!({
            "kind": "fixed_week",
            "days": match value.get("days").and_then(Value::as_array) {
                Some(days) => Value::Array(days.iter().filter_map(Value::as_i64).map(Value::from).collect()),
                None => json!([1, 3, 5]),
            },
        })),
        "interval" => {
            Ok(json!({ "kind": "interval", "intervalDays": int_or(value, "intervalDays", 2) }))
        }
        _ => Ok(json!({
            "kind": "flexible_week",
            "targetDaysPerWeek": int_or(value, "targetDaysPerWeek", 4),
            "minDaysPerWeek": int_or(value, "minDaysPerWeek", 3),
            "maxDaysPerWeek": int_or(value, "maxDaysPerWeek", 5),
        })),
    }
}

/// `raceDaySchema` array with the schema default.
pub fn parse_race_days(value: Option<&Value>) -> Result<Value> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Ok(Value::Array(Vec::new()));
    };
    let mut days = Vec::with_capacity(items.len());
    for (index, entry) in items.iter().enumerate() {
        let path = format!("raceDays.{index}");
        object(entry, &path)?;
        days.push(json!({
            "date": required_text(entry, "date", &path)?,
            "sport": required_trimmed(entry, "sport", &path)?,
        }));
    }
    Ok(Value::Array(days))
}

/// `profileNoteListSchema`: trimmed, unique after [`normalize_note`].
fn parse_note_list(value: &Value, key: &str) -> Result<Value> {
    let Some(items) = value.get(key).and_then(Value::as_array) else {
        return Ok(Value::Array(Vec::new()));
    };
    let mut notes: Vec<String> = Vec::with_capacity(items.len());
    for (index, entry) in items.iter().enumerate() {
        let path = format!("{key}.{index}");
        let note = entry
            .as_str()
            .ok_or_else(|| invalid_type(&path, "a string"))?
            .trim()
            .to_owned();
        if normalize_note(&note).is_empty() {
            return Err(invalid(&path, "note must not be empty"));
        }
        if notes
            .iter()
            .any(|existing| normalize_note(existing) == normalize_note(&note))
        {
            return Err(invalid(
                key,
                "profile notes must not contain duplicate entries",
            ));
        }
        notes.push(note);
    }
    Ok(Value::Array(notes.into_iter().map(Value::String).collect()))
}

/// `normalizeProfileNote`: trim, collapse whitespace, lowercase.
pub fn normalize_note(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// The keys `athleteProfileSchema.partial().omit({ ownerId: true })` accepts.
/// Absent keys stay absent so the merge keeps the stored profile value.
pub fn patch_keys(patch: &Value) -> Vec<String> {
    const PATCHABLE: [&str; 16] = [
        "preferredName",
        "gender",
        "heightCm",
        "birthDate",
        "timezone",
        "goals",
        "preference",
        "usualSessionMinutes",
        "trainingRhythm",
        "equipment",
        "injuries",
        "constraintNotes",
        "explicitRecoveryDays",
        "unitSystem",
        "mesocycleDurationWeeks",
        "raceDays",
    ];
    let Some(entries) = patch.as_object() else {
        return Vec::new();
    };
    PATCHABLE
        .iter()
        .filter(|key| entries.contains_key(**key))
        .map(|key| (*key).to_owned())
        .collect()
}

/// Merges a profile patch over a stored profile, then re-parses: the
/// TypeScript `athleteProfileSchema.parse({ ...profile, ...patch, ownerId })`.
pub fn merge_profile(profile: &Value, patch: &Value, owner_id: &str) -> Result<Value> {
    validate_profile_numbers(patch)?;
    let mut merged = profile.clone();
    if let Some(entries) = merged.as_object_mut() {
        if let Some(source) = patch.as_object() {
            for key in patch_keys(&patch) {
                let value = source[&key].clone();
                entries.insert(key, value);
            }
        }
        entries.insert("ownerId".into(), Value::String(owner_id.to_owned()));
    }
    validate_profile_numbers(&merged)?;
    parse_profile(&merged)
}

/// `profileUpdateSchema.parse(value)`: the partial patch plus the profile hash
/// the caller confirmed against.
#[derive(Debug, Clone, PartialEq)]
pub struct ProfileUpdate {
    pub patch: Value,
    pub expected_profile_hash: String,
}

/// `profileUpdateSchema.parse(value)`.
pub fn parse_profile_update(value: &Value) -> Result<ProfileUpdate> {
    object(value, "profileUpdate")?;
    let patch = value
        .get("patch")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    object(&patch, "profileUpdate.patch")?;
    validate_profile_numbers(&patch)?;
    Ok(ProfileUpdate {
        patch,
        expected_profile_hash: required_text(value, "expectedProfileHash", "profileUpdate")?,
    })
}

/// `personalInformationWriteSchema.parse(value)`.
pub fn parse_personal_information(value: &Value) -> Result<PersonalInformationWrite> {
    object(value, "personalInformation")?;
    validate_profile_numbers(value)?;
    Ok(PersonalInformationWrite {
        preferred_name: required_trimmed(value, "preferredName", "personalInformation")?,
        gender: nullable_enum(value, "gender", &GENDERS),
        height_cm: number_or_null(value, "heightCm"),
        birth_date: text_or_null(value, "birthDate"),
        weight_kg: value.get("weightKg").cloned(),
        unit_system: value
            .get("unitSystem")
            .and_then(Value::as_str)
            .filter(|candidate| UNIT_SYSTEMS.contains(candidate))
            .map(str::to_owned),
        expected_snapshot_hash: required_text(
            value,
            "expectedSnapshotHash",
            "personalInformation",
        )?,
    })
}

/// Parsed `personalInformationWriteSchema`.
#[derive(Debug, Clone, PartialEq)]
pub struct PersonalInformationWrite {
    pub preferred_name: String,
    pub gender: Value,
    pub height_cm: Value,
    pub birth_date: Value,
    /// `Some(null)` clears the stored weight for today.
    pub weight_kg: Option<Value>,
    pub unit_system: Option<String>,
    pub expected_snapshot_hash: String,
}

#[cfg(test)]
mod tests {
    use super::*;




}

#[cfg(test)]
mod numeric_write_tests {
    use super::*;

    #[test]
    fn numeric_boundaries_and_defaults_match_schema() {
        for value in [json!({}), json!({"heightCm":null,"explicitRecoveryDays":null}),
            json!({"heightCm":50,"usualSessionMinutes":15,"explicitRecoveryDays":1,"mesocycleDurationWeeks":1}),
            json!({"heightCm":250,"usualSessionMinutes":240,"explicitRecoveryDays":7,"mesocycleDurationWeeks":8}),
            json!({"trainingRhythm":{"kind":"fixed_week","days":[0,1,2,3,4,5,6]}}),
            json!({"trainingRhythm":{"kind":"interval","intervalDays":30}}),
            json!({"trainingRhythm":{"kind":"flexible_week","targetDaysPerWeek":1,"minDaysPerWeek":7,"maxDaysPerWeek":1}})] {
            validate_profile_numbers(&value).unwrap();
        }
        for (key,min,max,nullable) in [("heightCm",50,250,true),("usualSessionMinutes",15,240,false),
            ("explicitRecoveryDays",1,7,true),("mesocycleDurationWeeks",1,8,false)] {
            for invalid_value in [json!(min-1),json!(max+1),json!("60"),json!(true)] {
                let error=validate_profile_numbers(&json!({key:invalid_value})).unwrap_err();
                assert_eq!(error.code(),crate::AthriaErrorCode::InvalidData);
                assert!(error.to_string().contains(key));
            }
            if !nullable { assert!(validate_profile_numbers(&json!({key:null})).is_err()); }
        }
        for value in [json!({"usualSessionMinutes":60.5}),json!({"trainingRhythm":{"kind":"fixed_week","days":[]}}),
            json!({"trainingRhythm":{"kind":"fixed_week","days":[1,1]}}),
            json!({"trainingRhythm":{"kind":"fixed_week","days":[7]}}),
            json!({"trainingRhythm":{"kind":"fixed_week","days":[1.5]}}),
            json!({"trainingRhythm":{"kind":"interval","intervalDays":0}}),
            json!({"trainingRhythm":{"kind":"flexible_week","targetDaysPerWeek":8}})] {
            assert!(validate_profile_numbers(&value).is_err(),"{value}");
        }
    }

    #[test]
    fn legacy_reads_are_preserved_but_updates_require_correction() {
        let old=parse_profile(&json!({"heightCm":-1})).unwrap();
        assert_eq!(old["heightCm"],-1);
        assert!(merge_profile(&old,&json!({"preference":"new"}),"a").is_err());
        assert_eq!(merge_profile(&old,&json!({"heightCm":180}),"a").unwrap()["heightCm"],180);
        assert!(parse_profile_update(&json!({"patch":{"usualSessionMinutes":"60"},"expectedProfileHash":"hash"})).is_err());
        assert!(merge_profile(&json!({}),&json!({"maxSessionMinutes":30}),"a").is_err());
    }
}
