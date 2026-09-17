use athria_core::{Result, date, schema::parse_training_session, tz};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::{HttpClient, HttpRequest, invalid};

pub const XUNJI_PARSER_VERSION: &str = "0.1.0";
pub const XUNJI_SYNC_DAYS: i64 = 90;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct XunjiAuthenticationError(pub String);

fn safe_message(value: &Value, fallback: String) -> String {
    value.as_str().filter(|value| !value.trim().is_empty()).or_else(|| value.as_object().and_then(|item| item.get("message").or_else(|| item.get("error")).or_else(|| item.get("msg"))).and_then(Value::as_str).filter(|value| !value.trim().is_empty())).unwrap_or(&fallback).chars().take(500).collect()
}

fn auth_failure(status: u16, message: &str) -> bool {
    if [401, 403].contains(&status) { return true; }
    let compact = message.to_ascii_lowercase().replace([' ', '-', '_'], "");
    compact.contains("apikeymissing") || compact.contains("apikeyinvalid") || message.contains("仅VIP可用") || message.contains("仅vip可用")
}

/// Fetches Xunji one local calendar date at a time. The transport is injected;
/// runtimes retain ownership of credential lookup and retry sleeping.
pub fn fetch_xunji_training<C: HttpClient>(client: &C, api_key: &str, days: i64, today: &str) -> std::result::Result<Value, XunjiAuthenticationError> {
    let days = days.clamp(1, 365);
    let end = today.get(..10).filter(|value| date::is_iso_date(value)).unwrap_or("1970-01-01");
    let end_day = date::epoch_day(end);
    let dates: Vec<String> = (0..days).map(|offset| date::format_iso_date(end_day - days + offset + 1)).collect();
    let mut successful_dates = Vec::new(); let mut errors = Vec::new(); let mut records = Vec::new();
    for datestr in &dates {
        let body = json!({ "schema_version": "train_open_api_v2", "datestr": datestr, "include_full_data": true }).to_string();
        let request = HttpRequest { method: "POST", url: "https://trains.xunjiapp.cn/api_trains_for_llm_v2".into(),
            headers: vec![("Authorization".into(), format!("Bearer {api_key}")), ("Content-Type".into(), "application/json".into()), ("User-Agent".into(), "Athria/0.1".into())], body: Some(body), timeout_ms: 30_000 };
        let mut completed = false; let mut last_message = "Xunji request failed".to_owned();
        for attempt in 0..3 {
            match client.send(&request) {
                Ok(response) => {
                    let message = safe_message(&response.body, format!("Xunji returned HTTP {}", response.status));
                    if auth_failure(response.status, &message) { return Err(XunjiAuthenticationError(message)); }
                    if (response.status == 429 || message.to_ascii_lowercase().contains("too frequent") || response.status >= 500) && attempt < 2 { last_message = message; continue; }
                    if !(200..300).contains(&response.status) { last_message = message; break; }
                    let container = response.body.get("res");
                    let trains = container.and_then(Value::as_array).or_else(|| container.and_then(|value| value.get("trains")).and_then(Value::as_array));
                    if let Some(items) = trains { records.extend(items.iter().filter(|item| item.is_object()).cloned()); successful_dates.push(json!(datestr)); completed = true; }
                    else { last_message = "Xunji returned an invalid response".into(); }
                    break;
                }
                Err(message) => { last_message = message; break; }
            }
        }
        if !completed { errors.push(json!({ "datestr": datestr, "code": "request_failed", "message": last_message.chars().take(500).collect::<String>() })); }
    }
    Ok(json!({ "rangeStart": dates.first(), "rangeEnd": dates.last(), "successfulDates": successful_dates, "errors": errors, "records": records }))
}

fn finite(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite() && *value >= 0.0),
        Value::String(text) if !text.is_empty() => text.parse().ok().filter(|value: &f64| value.is_finite() && *value >= 0.0),
        _ => None,
    }
}
fn number(value: Option<f64>) -> Value { value.map(athria_core::js_number).unwrap_or(Value::Null) }
fn hash(value: &str) -> String { format!("{:x}", Sha256::digest(value.as_bytes()))[..24].into() }

pub fn normalize_xunji_training(record: &Value) -> Result<Value> {
    let object = record.as_object().ok_or_else(|| invalid("Xunji record must be an object"))?;
    let movements: Vec<&Map<String, Value>> = object.get("movements").and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_object).collect()).unwrap_or_default();
    let cardio: Vec<_> = movements.iter().filter(|item| item.get("cardio") == Some(&Value::Bool(true)) || item.get("metrics").is_some_and(Value::is_object)).copied().collect();
    let strength: Vec<_> = movements.iter().filter(|item| item.get("sets").and_then(Value::as_array).is_some_and(|sets| !sets.is_empty()) && item.get("cardio") != Some(&Value::Bool(true))).copied().collect();
    let modality = if !cardio.is_empty() && !strength.is_empty() { "mixed" } else if !cardio.is_empty() { "endurance" } else if !strength.is_empty() { "strength" } else { "unknown" };
    let mut missing = Vec::new();
    let start_ms = finite(object.get("start")).map(|value| if value < 10_000_000_000.0 { value * 1000.0 } else { value }).map(|value| value as i64)
        .or_else(|| object.get("start").and_then(Value::as_str).and_then(|value| tz::millis(value).ok()))
        .unwrap_or_else(|| { missing.push(json!("startAt")); object.get("datestr").and_then(Value::as_str).filter(|value| date::is_iso_date(value)).and_then(|value| tz::millis(&format!("{value}T00:00:00.000Z")).ok()).unwrap_or(0) });
    let mut end_ms = finite(object.get("end")).map(|value| if value < 10_000_000_000.0 { value * 1000.0 } else { value }).map(|value| value as i64).unwrap_or_else(|| { missing.push(json!("endAt")); start_ms });
    if end_ms < start_ms { end_ms = start_ms; missing.push(json!("duration")); }
    let mut sets = Vec::new();
    for movement in strength {
        for (index, raw) in movement.get("sets").and_then(Value::as_array).into_iter().flatten().enumerate() {
            let Some(set) = raw.as_object() else { continue; }; if set.get("done") == Some(&Value::Bool(false)) { continue; }
            let get = |names: &[&str]| names.iter().find_map(|name| finite(set.get(*name)));
            sets.push(json!({ "exerciseRaw": movement.get("name").and_then(Value::as_str).unwrap_or("Unknown exercise"), "exerciseKey": null, "movement": null,
                "primaryMuscles": [], "secondaryMuscles": [], "setIndex": index, "setType": set.get("type").or_else(|| set.get("setType")).and_then(Value::as_str).unwrap_or("normal"),
                "weight": number(get(&["weight", "weight_kg"])), "weightUnit": if set.get("unit").and_then(Value::as_str).is_some_and(|unit| unit.eq_ignore_ascii_case("lb")) { "lb" } else { "kg" },
                "reps": get(&["reps"]).map(|value| json!(value.trunc() as i64)).unwrap_or(Value::Null), "rpe": number(get(&["rpe"])),
                "leftWeight": number(get(&["leftWeight", "weightLeft", "left_weight"])), "rightWeight": number(get(&["rightWeight", "weightRight", "right_weight"])),
                "durationSeconds": number(get(&["duration_s", "time", "workoutTime"])), "restSeconds": number(get(&["restSeconds", "rest_times"])),
                "plannedRestSeconds": number(finite(movement.get("restTime"))) }));
        }
    }
    let metrics: Vec<&Map<String, Value>> = cardio.iter().flat_map(|movement| {
        let mut values = Vec::new(); if let Some(value) = movement.get("metrics").and_then(Value::as_object) { values.push(value); }
        if let Some(raw_sets) = movement.get("sets").and_then(Value::as_array) { values.extend(raw_sets.iter().filter_map(|set| set.get("metrics")).filter_map(Value::as_object)); } values
    }).collect();
    let metric = |names: &[&str]| metrics.iter().find_map(|item| names.iter().find_map(|name| finite(item.get(*name))));
    let distance = metric(&["distanceMeters", "distance_m"]).or_else(|| metric(&["distance"]).map(|value| value * 1000.0));
    let external = object.get("localid").map(|value| value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string())).unwrap_or_else(|| hash(&format!("{}|{}|{}", object.get("datestr").unwrap_or(&Value::Null), object.get("start").unwrap_or(&Value::Null), object.get("title").unwrap_or(&Value::Null))));
    parse_training_session(&json!({ "id": format!("xunji:{external}"), "source": "xunji", "externalId": external, "modality": modality,
        "sport": cardio.first().map(|movement| movement.get("recordPreset").or_else(|| movement.get("name")).and_then(Value::as_str).unwrap_or("cardio")).map(Value::from).unwrap_or(Value::Null),
        "name": object.get("title").or_else(|| object.get("name")).and_then(Value::as_str).unwrap_or("Xunji workout"),
        "startAt": tz::iso_from_millis(start_ms), "endAt": tz::iso_from_millis(end_ms), "durationMinutes": ((end_ms - start_ms) as f64 / 60_000.0).round().max(0.0) as i64,
        "status": "completed", "timezone": null, "strengthSets": sets,
        "endurance": if cardio.is_empty() { Value::Null } else { json!({ "distanceMeters": number(distance), "averageHeartRate": number(metric(&["avgHeartRate", "averageHeartRate", "bpm"])),
            "maxHeartRate": number(metric(&["maxHeartRate"])), "averagePowerWatts": number(metric(&["averagePowerWatts", "avgPower"])), "maxPowerWatts": number(metric(&["maxPowerWatts", "maxPower"])), "heartRateZoneSeconds": {} }) },
        "missingFields": missing }))
}
