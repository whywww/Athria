use std::collections::HashSet;

use athria_core::{Result, date, schema::parse_training_session, tz};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::{HttpClient, HttpRequest, invalid};

fn finite(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
        Value::String(text) if !text.is_empty() => text.parse().ok().filter(|value: &f64| value.is_finite()),
        _ => None,
    }
}

pub fn interval_modality(value: Option<&Value>) -> &'static str {
    let normalized: String = value
        .filter(|value| !value.is_null())
        .map(|value| value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string()))
        .unwrap_or_default()
        .to_ascii_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    let strength = HashSet::from(["strengthtraining", "weighttraining"]);
    let endurance = HashSet::from(["hike", "ride", "rowing", "run", "swim", "walk"]);
    let mixed = HashSet::from(["crossfit", "functionalstrengthtraining", "functionaltraining", "highintensityintervaltraining", "hiit", "hyrox"]);
    let recovery = HashSet::from(["mobility", "pilates", "recovery", "stretching", "yoga"]);
    if strength.contains(normalized.as_str()) { "strength" }
    else if endurance.contains(normalized.as_str()) { "endurance" }
    else if mixed.contains(normalized.as_str()) { "mixed" }
    else if recovery.contains(normalized.as_str()) { "recovery" }
    else { "unknown" }
}

pub fn normalize_intervals_activity(item: &Value, resource: &str) -> Result<Option<Value>> {
    if resource == "events" { return Ok(None); }
    let Some(object) = item.as_object() else { return Ok(None); };
    let Some(start) = object.get("start_date").or_else(|| object.get("start_date_local")).or_else(|| object.get("start")).and_then(Value::as_str) else { return Ok(None); };
    let Ok(start_ms) = tz::millis(start) else { return Ok(None); };
    let duration_value = object.get("moving_time").or_else(|| object.get("elapsed_time")).or_else(|| object.get("duration"));
    let mut seconds = finite(duration_value).unwrap_or(0.0);
    if object.contains_key("duration") && seconds > 0.0 && seconds < 1000.0 { seconds *= 60.0; }
    let minutes = if seconds > 0.0 { (seconds / 60.0).round().max(1.0) as i64 } else { 0 };
    let kind = object.get("type").or_else(|| object.get("sport"));
    let external = object.get("id").or_else(|| object.get("external_id")).map(|value| value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string())).unwrap_or_else(|| format!("{:x}", Sha256::digest(item.to_string().as_bytes()))[..24].to_owned());
    let metric = |name: &str| object.get(name).and_then(|value| finite(Some(value))).map(athria_core::js_number).unwrap_or(Value::Null);
    let text = |value: &Value| value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string());
    let name = object.get("name").or(kind).map(text).unwrap_or_else(|| "Intervals activity".into());
    let sport = kind.map(text).map(Value::String).unwrap_or(Value::Null);
    parse_training_session(&json!({
        "id": format!("intervals:{resource}:{external}"), "source": "intervals", "externalId": format!("{resource}:{external}"),
        "modality": interval_modality(kind), "sport": sport, "name": name,
        "startAt": tz::iso_from_millis(start_ms), "endAt": tz::iso_from_millis(start_ms + minutes * 60_000), "durationMinutes": minutes,
        "status": "completed", "missingFields": if duration_value.is_none() { json!(["duration"]) } else { json!([]) },
        "endurance": { "distanceMeters": metric("distance"), "averageHeartRate": metric("average_heartrate"), "maxHeartRate": metric("max_heartrate"),
          "averagePowerWatts": metric("average_watts"), "maxPowerWatts": metric("max_watts"),
          "heartRateZoneSeconds": object.get("time_in_zones").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({})) },
    })).map(Some)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncDateWindow { pub days: i64, pub range_start: String, pub range_end: String }

pub fn sync_date_window(last_success_at: Option<&str>, requested_days: Option<i64>, today: &str) -> Result<SyncDateWindow> {
    let range_end = today.get(..10).filter(|value| date::is_iso_date(value)).ok_or_else(|| invalid("today must be an ISO timestamp"))?;
    let days = match requested_days {
        Some(days) => days.clamp(1, 365),
        None => last_success_at.and_then(|value| value.get(..10)).filter(|value| date::is_iso_date(value)).map(|start| (date::day_difference(start, range_end) + 1).clamp(1, 365)).unwrap_or(90),
    };
    let end_day = date::epoch_day(range_end);
    Ok(SyncDateWindow { days, range_start: date::format_iso_date(end_day - days + 1), range_end: range_end.into() })
}

/// Executes the three independent Intervals endpoints with retry isolation.
pub fn fetch_intervals<C: HttpClient>(client: &C, api_key: &str, athlete_id: &str, today: &str, activities_oldest: Option<&str>, wellness_oldest: Option<&str>) -> Value {
    let end = &today[..10];
    let end_day = date::epoch_day(end);
    let paths = [
        ("activities", format!("/athlete/{athlete_id}/activities?oldest={}&newest={end}", activities_oldest.map(str::to_owned).unwrap_or_else(|| date::format_iso_date(end_day - 90)))),
        ("wellness", format!("/athlete/{athlete_id}/wellness?oldest={}&newest={end}", wellness_oldest.map(str::to_owned).unwrap_or_else(|| date::format_iso_date(end_day - 42)))),
        ("events", format!("/athlete/{athlete_id}/events?oldest={}&newest={}", date::format_iso_date(end_day - 14), date::format_iso_date(end_day + 14))),
    ];
    let authorization = format!("Basic {}", BASE64.encode(format!("API_KEY:{api_key}")));
    let mut output = Map::new();
    for (name, path) in paths {
        let request = HttpRequest { method: "GET", url: format!("https://intervals.icu/api/v1{path}"), headers: vec![("Authorization".into(), authorization.clone()), ("User-Agent".into(), "Athria/0.1".into())], body: None, timeout_ms: 60_000 };
        let mut result = Value::String("Intervals.icu request failed".into());
        for attempt in 0..3 {
            match client.send(&request) {
                Ok(response) if [401, 403].contains(&response.status) => { result = json!("Intervals.icu rejected the API key"); break; }
                Ok(response) if (response.status == 429 || response.status >= 500) && attempt < 2 => continue,
                Ok(response) if !(200..300).contains(&response.status) => { result = json!(format!("Intervals.icu returned HTTP {}", response.status)); break; }
                Ok(response) if response.body.is_array() => { result = response.body; break; }
                Ok(_) => { result = json!("Intervals.icu response was not a list"); break; }
                Err(message) => { result = json!(message); break; }
            }
        }
        output.insert(name.into(), result);
    }
    Value::Object(output)
}
