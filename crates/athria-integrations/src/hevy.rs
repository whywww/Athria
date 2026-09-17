use std::collections::{HashMap, HashSet};

use athria_core::{Result, schema::parse_training_session, tz};
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::invalid;

pub const HEVY_PARSER_VERSION: &str = "0.1.0";

#[derive(Clone, Debug, PartialEq)]
pub struct HevyPreview {
    pub value: Value,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn slug(value: &str) -> String {
    let mut result = String::new();
    let mut gap = false;
    for character in value.to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            if gap && !result.is_empty() {
                result.push('_');
            }
            result.push(character);
            gap = false;
        } else {
            gap = true;
        }
    }
    result
}
fn number(value: Option<&str>) -> std::result::Result<Value, String> {
    let Some(text) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(Value::Null);
    };
    text.parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .map(athria_core::js_number)
        .ok_or_else(|| format!("Invalid number: {text}"))
}
fn parse_date(value: &str) -> std::result::Result<i64, String> {
    if let Ok(milliseconds) = tz::millis(value) {
        return Ok(milliseconds);
    }
    let parts: Vec<_> = value
        .split([' ', ',', ':'])
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() == 5 {
        let month = match parts[1].to_ascii_lowercase().as_str() {
            "jan" => 1,
            "feb" => 2,
            "mar" => 3,
            "apr" => 4,
            "may" => 5,
            "jun" => 6,
            "jul" => 7,
            "aug" => 8,
            "sep" => 9,
            "oct" => 10,
            "nov" => 11,
            "dec" => 12,
            _ => 0,
        };
        if month > 0 {
            if let Ok(milliseconds) = tz::millis(&format!(
                "{}-{month:02}-{:0>2}T{:0>2}:{:0>2}:00Z",
                parts[2], parts[0], parts[3], parts[4]
            )) {
                return Ok(milliseconds);
            }
        }
    }
    Err(format!("Invalid date/time: {value}"))
}

pub fn parse_hevy_csv(content: &[u8], file_name: &str) -> Result<HevyPreview> {
    let text = std::str::from_utf8(content)
        .map_err(|_| invalid("Hevy CSV must be valid UTF-8"))?
        .trim_start_matches('\u{feff}');
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(text.as_bytes());
    let headers = reader
        .headers()
        .map_err(|error| invalid(error.to_string()))?
        .clone();
    if headers.is_empty() {
        return Err(invalid("CSV has no header row"));
    }
    let aliases: [(&str, &[&str]); 12] = [
        ("title", &["title", "workout_title", "workout name"]),
        (
            "start_time",
            &["start_time", "start time", "workout_start_time"],
        ),
        ("end_time", &["end_time", "end time", "workout_end_time"]),
        (
            "exercise_title",
            &["exercise_title", "exercise title", "exercise_name"],
        ),
        ("set_index", &["set_index", "set index", "set_number"]),
        ("set_type", &["set_type", "set type"]),
        ("weight_kg", &["weight_kg", "weight kg"]),
        ("weight_lbs", &["weight_lbs", "weight lbs", "weight_lb"]),
        ("reps", &["reps", "repetitions"]),
        ("rpe", &["rpe"]),
        ("workout_id", &["workout_id", "workout id"]),
        ("set_id", &["set_id", "set id"]),
    ];
    let names: HashMap<String, usize> = headers
        .iter()
        .enumerate()
        .map(|(index, header)| (header.trim().to_ascii_lowercase(), index))
        .collect();
    let mut fields = HashMap::new();
    for (target, choices) in aliases {
        if let Some(index) = choices
            .iter()
            .find_map(|choice| names.get(*choice).copied())
        {
            fields.insert(target, index);
        }
    }
    let missing: Vec<_> = ["title", "start_time", "exercise_title", "set_index"]
        .into_iter()
        .filter(|name| !fields.contains_key(name))
        .collect();
    if !missing.is_empty() {
        return Err(invalid(format!(
            "Missing required Hevy columns: {}",
            missing.join(", ")
        )));
    }
    if !fields.contains_key("weight_kg") && !fields.contains_key("weight_lbs") {
        return Err(invalid(
            "A declared weight_kg or weight_lbs column is required",
        ));
    }

    struct Group {
        name: String,
        start: String,
        start_ms: i64,
        end: String,
        end_ms: i64,
        sets: Vec<Value>,
    }
    let mut groups: IndexMap<String, Group> = IndexMap::new();
    let mut raw_rows = Vec::new();
    let mut errors = Vec::new();
    let mut valid_rows = 0;
    for (row_index, row) in reader.records().enumerate() {
        let row = row.map_err(|error| invalid(error.to_string()))?;
        raw_rows.push(Value::Object(Map::from_iter(
            headers
                .iter()
                .enumerate()
                .map(|(index, header)| (header.into(), json!(row.get(index).unwrap_or("")))),
        )));
        let parsed: std::result::Result<(), String> = (|| {
            let get = |name: &str| fields.get(name).and_then(|index| row.get(*index));
            let title = get("title").unwrap_or("").trim();
            let exercise = get("exercise_title").unwrap_or("").trim();
            if title.is_empty() || exercise.is_empty() {
                return Err("Workout title and exercise title are required".into());
            }
            let start_ms = parse_date(get("start_time").unwrap_or(""))?;
            let start = tz::iso_from_millis(start_ms);
            let end_ms = match get("end_time")
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                Some(value) => parse_date(value)?,
                None => start_ms,
            };
            let end = tz::iso_from_millis(end_ms);
            let workout_id = get("workout_id").unwrap_or("").trim();
            let external = if workout_id.is_empty() {
                hash(format!("{start}|{title}").as_bytes())[..24].into()
            } else {
                workout_id.into()
            };
            let kg = number(get("weight_kg"))?;
            let lb = number(get("weight_lbs"))?;
            let set = json!({ "exerciseRaw": exercise, "exerciseKey": slug(exercise), "movement": null, "primaryMuscles": [], "secondaryMuscles": [],
                "setIndex": number(get("set_index"))?.as_f64().unwrap_or(0.0).trunc() as i64, "setType": get("set_type").map(str::trim).filter(|value| !value.is_empty()).unwrap_or("normal"),
                "weight": if kg.is_null() { lb.clone() } else { kg.clone() }, "weightUnit": if !kg.is_null() { json!("kg") } else if !lb.is_null() { json!("lb") } else { Value::Null },
                "reps": number(get("reps"))?, "rpe": number(get("rpe"))? });
            let group = groups.entry(external).or_insert_with(|| Group {
                name: title.into(),
                start: start.clone(),
                start_ms,
                end: end.clone(),
                end_ms,
                sets: Vec::new(),
            });
            if end_ms > group.end_ms {
                group.end_ms = end_ms;
                group.end = end;
            }
            group.sets.push(set);
            Ok(())
        })();
        match parsed {
            Ok(()) => valid_rows += 1,
            Err(message) => errors.push(json!({ "line": row_index + 2, "message": message })),
        }
    }
    let mut sessions = Vec::new();
    for (external, group) in groups {
        sessions.push(parse_training_session(&json!({ "id": format!("hevy:{external}"), "source": "hevy", "externalId": external,
        "modality": "strength", "name": group.name, "startAt": group.start, "endAt": group.end,
        "durationMinutes": ((group.end_ms - group.start_ms) as f64 / 60_000.0).round().max(0.0) as i64, "strengthSets": group.sets }))?);
    }
    let used: HashSet<_> = fields.values().copied().collect();
    let unknown: Vec<_> = headers
        .iter()
        .enumerate()
        .filter(|(index, _)| !used.contains(index))
        .map(|(_, value)| json!(value))
        .collect();
    let sets: usize = sessions
        .iter()
        .map(|session| session["strengthSets"].as_array().map_or(0, Vec::len))
        .sum();
    Ok(HevyPreview {
        value: json!({ "contentHash": hash(content), "fileName": file_name, "parserVersion": HEVY_PARSER_VERSION,
        "counts": { "rows": raw_rows.len(), "sessions": sessions.len(), "sets": sets, "validRows": valid_rows, "invalidRows": errors.len() },
        "errors": errors, "unknownColumns": unknown, "sessions": sessions, "rawRows": raw_rows }),
    })
}
