//! Training metrics and explicit-input calculators, ported from
//! `packages/core` (`estimateOneRepMax`, `calculateHeartRateZones`,
//! `calculateTrainingMetrics`).
//!
//! Results keep the TypeScript `MetricResult` envelope field for field —
//! method names, formula version, time range, data quality flags and
//! limitation strings — because MCP responses and stored snapshots surface
//! them verbatim.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::FORMULA_VERSION;
use crate::error::{AthriaError, AthriaErrorCode, Result};
use crate::json::{array_field, bump, field, is_null, number, string_field};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TimeRange {
    pub start: Option<String>,
    pub end: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataQuality {
    pub completeness: i64,
    pub sources: Vec<String>,
    pub missing_fields: Vec<String>,
    pub anomalies: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricResult {
    pub value: Value,
    pub unit: String,
    pub method: String,
    pub formula_version: String,
    pub time_range: TimeRange,
    pub data_quality: DataQuality,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrengthMetrics {
    pub working_sets: MetricResult,
    pub raw_volume: MetricResult,
    pub direct_sets_by_muscle: MetricResult,
    pub indirect_sets_by_muscle: MetricResult,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnduranceMetrics {
    pub duration_minutes: MetricResult,
    pub distance_meters: MetricResult,
    pub pace_seconds_per_km: MetricResult,
    pub time_in_zone_seconds: MetricResult,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TrainingMetrics {
    pub strength: StrengthMetrics,
    pub endurance: EnduranceMetrics,
}

fn empty_quality(sources: &[String], missing_fields: &[&str]) -> DataQuality {
    DataQuality {
        completeness: if missing_fields.is_empty() { 1 } else { 0 },
        sources: sources.to_vec(),
        missing_fields: missing_fields
            .iter()
            .map(|value| value.to_string())
            .collect(),
        anomalies: Vec::new(),
    }
}

fn range_of(sessions: &[&Value]) -> TimeRange {
    if sessions.is_empty() {
        return TimeRange {
            start: None,
            end: None,
        };
    }
    let mut starts: Vec<&str> = sessions
        .iter()
        .filter_map(|session| session.get("startAt").and_then(Value::as_str))
        .collect();
    starts.sort_unstable();
    let mut ends: Vec<&str> = sessions
        .iter()
        .filter_map(|session| session.get("endAt").and_then(Value::as_str))
        .collect();
    ends.sort_unstable();
    TimeRange {
        start: starts.first().map(|value| value.to_string()),
        end: ends.last().map(|value| value.to_string()),
    }
}

fn metric(
    value: Value,
    unit: &str,
    method: &str,
    sessions: &[&Value],
    data_quality: DataQuality,
    limitations: Vec<String>,
) -> MetricResult {
    MetricResult {
        value,
        unit: unit.to_string(),
        method: method.to_string(),
        formula_version: FORMULA_VERSION.to_string(),
        time_range: range_of(sessions),
        data_quality,
        limitations,
    }
}

/// The TypeScript `Number(value.toFixed(2))` rounding.
fn to_fixed_2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub fn estimate_one_rep_max(load: f64, reps: f64, unit: &str) -> Result<MetricResult> {
    if !load.is_finite() || load <= 0.0 {
        return Err(AthriaError::new(
            AthriaErrorCode::InvalidData,
            "load must be greater than zero",
        ));
    }
    if reps.fract() != 0.0 || reps < 1.0 || reps > 12.0 {
        return Err(AthriaError::new(
            AthriaErrorCode::InvalidData,
            "reps must be an integer from 1 to 12",
        ));
    }
    let value = if reps == 1.0 {
        load
    } else {
        load * (1.0 + reps / 30.0)
    };
    Ok(metric(
        number(to_fixed_2(value)),
        unit,
        "epley",
        &[],
        empty_quality(&["explicit_input".to_string()], &[]),
        vec![
            "Estimated 1RM is not a measured maximal lift.".to_string(),
            "The formula is restricted to sets of 1-12 repetitions.".to_string(),
        ],
    ))
}

pub fn calculate_heart_rate_zones(max_heart_rate: f64) -> Result<MetricResult> {
    if max_heart_rate.fract() != 0.0 || max_heart_rate < 80.0 || max_heart_rate > 240.0 {
        return Err(AthriaError::new(
            AthriaErrorCode::InvalidData,
            "maxHeartRate must be an explicitly measured integer from 80 to 240",
        ));
    }
    let ratios = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    let bounds: Vec<f64> = ratios
        .iter()
        .map(|ratio| (max_heart_rate * ratio).round())
        .collect();
    let mut zones = Map::new();
    for (index, min) in bounds[..bounds.len() - 1].iter().enumerate() {
        let max = bounds[index + 1] - if index < 4 { 1.0 } else { 0.0 };
        zones.insert(
            format!("zone{}", index + 1),
            serde_json::json!({ "min": number(*min), "max": number(max) }),
        );
    }
    Ok(metric(
        Value::Object(zones),
        "bpm",
        "five_zone_percent_max_hr",
        &[],
        empty_quality(&["explicit_max_hr".to_string()], &[]),
        vec![
            "Zones are descriptive training ranges, not medical thresholds.".to_string(),
            "Age-predicted maximum heart rate is not used.".to_string(),
        ],
    ))
}

/// Domain resolution mirrors the TypeScript helper: declared domains win, and
/// a session with none is classified from its populated details.
fn session_domains(session: &Value) -> Vec<String> {
    let declared: Vec<String> = session
        .get("domains")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if !declared.is_empty() {
        return declared;
    }
    let mut derived = Vec::new();
    if session
        .get("strengthSets")
        .and_then(Value::as_array)
        .is_some_and(|sets| !sets.is_empty())
    {
        derived.push("strength".to_string());
    }
    if !field(session, "endurance").is_null() {
        derived.push("endurance".to_string());
    }
    derived
}

pub fn calculate_training_metrics(sessions: &[Value]) -> TrainingMetrics {
    let strength_sessions: Vec<&Value> = sessions
        .iter()
        .filter(|session| {
            session_domains(session)
                .iter()
                .any(|domain| domain == "strength")
        })
        .collect();
    let endurance_sessions: Vec<&Value> = sessions
        .iter()
        .filter(|session| {
            let domains = session_domains(session);
            domains
                .iter()
                .any(|domain| domain == "endurance" || domain == "recovery")
        })
        .collect();

    let mut working_sets: i64 = 0;
    let mut raw_volume = 0.0f64;
    let mut direct_by_muscle: Map<String, Value> = Map::new();
    let mut indirect_by_muscle: Map<String, Value> = Map::new();
    for session in &strength_sessions {
        for set in array_field(session, "strengthSets") {
            if string_field(set, "setType") == "warmup" {
                continue;
            }
            working_sets += 1;
            let weight = field(set, "weight");
            let reps = field(set, "reps");
            if !weight.is_null() && !reps.is_null() {
                raw_volume += weight.as_f64().unwrap_or(0.0) * reps.as_f64().unwrap_or(0.0);
            }
            for muscle in array_field(set, "primaryMuscles") {
                if let Some(name) = muscle.as_str() {
                    bump(&mut direct_by_muscle, name, 1.0);
                }
            }
            for muscle in array_field(set, "secondaryMuscles") {
                if let Some(name) = muscle.as_str() {
                    bump(&mut indirect_by_muscle, name, 1.0);
                }
            }
        }
    }

    let duration: i64 = endurance_sessions
        .iter()
        .map(|session| field(session, "durationMinutes").as_i64().unwrap_or(0))
        .sum();
    let distance: f64 = endurance_sessions
        .iter()
        .map(|session| {
            field(field(session, "endurance"), "distanceMeters")
                .as_f64()
                .unwrap_or(0.0)
        })
        .sum();
    let mut zone_seconds: Map<String, Value> = Map::new();
    for session in &endurance_sessions {
        if let Some(Value::Object(zones)) = session
            .get("endurance")
            .and_then(|endurance| endurance.get("heartRateZoneSeconds"))
        {
            for (zone, seconds) in zones {
                bump(&mut zone_seconds, zone, seconds.as_f64().unwrap_or(0.0));
            }
        }
    }

    let mut sources: Vec<String> = Vec::new();
    for session in sessions {
        if let Some(source) = session.get("source").and_then(Value::as_str) {
            if !sources.iter().any(|existing| existing == source) {
                sources.push(source.to_string());
            }
        }
    }

    let volume_missing = strength_sessions.iter().any(|session| {
        array_field(session, "strengthSets")
            .iter()
            .any(|set| is_null(set.get("weight")) || is_null(set.get("reps")))
    });
    let distance_missing = endurance_sessions.iter().any(|session| {
        is_null(
            session
                .get("endurance")
                .and_then(|endurance| endurance.get("distanceMeters")),
        )
    });
    let zones_missing = endurance_sessions
        .iter()
        .any(|session| match session.get("endurance") {
            None | Some(Value::Null) => true,
            Some(endurance) => endurance
                .get("heartRateZoneSeconds")
                .and_then(Value::as_object)
                .map_or(true, |zones| zones.is_empty()),
        });

    let shared_limit = vec![
        "Strength and endurance metrics are intentionally not combined into a single load score."
            .to_string(),
    ];
    TrainingMetrics {
        strength: StrengthMetrics {
            working_sets: metric(Value::from(working_sets), "sets", "completed_working_sets", &strength_sessions, empty_quality(&sources, &[]), shared_limit.clone()),
            raw_volume: metric(
                number(to_fixed_2(raw_volume)),
                "load_repetitions",
                "sum_load_times_reps",
                &strength_sessions,
                empty_quality(&sources, if volume_missing { &["weight_or_reps"] } else { &[] }),
                vec!["Volumes in different weight units must not be compared until normalized.".to_string()],
            ),
            direct_sets_by_muscle: metric(Value::Object(direct_by_muscle), "sets", "primary_muscle_set_count", &strength_sessions, empty_quality(&sources, &[]), Vec::new()),
            indirect_sets_by_muscle: metric(
                Value::Object(indirect_by_muscle),
                "participations",
                "secondary_muscle_participation_count",
                &strength_sessions,
                empty_quality(&sources, &[]),
                vec!["Indirect participation is not treated as equivalent to a direct set.".to_string()],
            ),
        },
        endurance: EnduranceMetrics {
            duration_minutes: metric(Value::from(duration), "min", "sum_duration", &endurance_sessions, empty_quality(&sources, &[]), shared_limit.clone()),
            distance_meters: metric(
                number(distance),
                "m",
                "sum_distance",
                &endurance_sessions,
                empty_quality(&sources, if distance_missing { &["distanceMeters"] } else { &[] }),
                Vec::new(),
            ),
            pace_seconds_per_km: metric(
                if distance > 0.0 { number(to_fixed_2((duration as f64 * 60.0 * 1000.0) / distance)) } else { Value::Null },
                "s/km",
                "elapsed_duration_per_kilometer",
                &endurance_sessions,
                empty_quality(&sources, if distance > 0.0 { &[] } else { &["distanceMeters"] }),
                vec!["Elapsed pace may include stopped time depending on the source.".to_string()],
            ),
            time_in_zone_seconds: metric(
                Value::Object(zone_seconds),
                "s",
                "sum_source_zone_durations",
                &endurance_sessions,
                empty_quality(&sources, if zones_missing { &["heartRateZoneSeconds"] } else { &[] }),
                vec!["Zone totals retain the source method and require a configured heart-rate basis.".to_string()],
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn one_rep_max_matches_epley_and_rejects_invalid_inputs() {
        assert_eq!(
            estimate_one_rep_max(100.0, 5.0, "kg").unwrap().value,
            json!(116.67)
        );
        assert_eq!(
            estimate_one_rep_max(60.0, 1.0, "lb").unwrap().value,
            json!(60)
        );
        assert_eq!(
            estimate_one_rep_max(0.0, 5.0, "kg").unwrap_err().message(),
            "load must be greater than zero"
        );
        assert_eq!(
            estimate_one_rep_max(100.0, 2.5, "kg")
                .unwrap_err()
                .message(),
            "reps must be an integer from 1 to 12"
        );
    }

    #[test]
    fn heart_rate_zones_follow_the_five_zone_bands() {
        let zones = calculate_heart_rate_zones(190.0).unwrap().value;
        assert_eq!(zones["zone1"], json!({ "min": 95, "max": 113 }));
        assert_eq!(zones["zone5"], json!({ "min": 171, "max": 190 }));
        assert_eq!(
            calculate_heart_rate_zones(190.5).unwrap_err().message(),
            "maxHeartRate must be an explicitly measured integer from 80 to 240"
        );
    }

    #[test]
    fn training_metrics_skip_warmups_and_join_zone_records() {
        let sessions = vec![json!({
            "source": "hevy", "startAt": "2026-09-07T08:00:00.000Z", "endAt": "2026-09-07T09:00:00.000Z",
            "domains": [], "durationMinutes": 60,
            "strengthSets": [
                { "setType": "warmup", "weight": 40, "reps": 10, "primaryMuscles": ["chest"], "secondaryMuscles": [] },
                { "setType": "normal", "weight": 100, "reps": 5, "primaryMuscles": ["chest"], "secondaryMuscles": ["triceps"] }
            ],
            "endurance": null
        })];
        let metrics = calculate_training_metrics(&sessions);
        assert_eq!(metrics.strength.working_sets.value, json!(1));
        assert_eq!(metrics.strength.raw_volume.value, json!(500));
        assert_eq!(
            metrics.strength.direct_sets_by_muscle.value,
            json!({ "chest": 1 })
        );
        assert_eq!(metrics.endurance.duration_minutes.value, json!(0));
        assert_eq!(metrics.endurance.pace_seconds_per_km.value, Value::Null);
    }
}
