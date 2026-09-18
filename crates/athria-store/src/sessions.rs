//! Training-session reconciliation and history CRUD: the Rust port of the
//! Training-session persistence and query operations.
//!
//! `rebuild_canonical_sessions` clusters per-source observations into canonical
//! sessions with the same `workout-reconciliation-v1` scoring rules and
//! `reconcile_plan_matches` re-derives automatic plan matches after every write
//! that can move either side. Both run inside the write transactions of the
//! session mutations below, mirroring the TypeScript store.
//!
//! Sessions are handled as schema-shaped `serde_json::Value` documents: the
//! application layer parses its inputs with the TypeScript schemas, so this
//! module never re-validates and instead reproduces the exact field
//! replacements the TypeScript store performs.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use athria_application::{ReplaceSourceSessionsInput, WriteCounts};
use athria_core::{AthriaError, AthriaErrorCode, Result, js_locale_compare};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::store::{DEFAULT_OWNER_ID, SqliteStore, database_error, parse_json_column};

/// Algorithm identifier recorded on `plan_workout_matches` rows.
pub const RECONCILIATION_VERSION: &str = "workout-reconciliation-v1";

pub(crate) fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

pub(crate) fn text_or<'a>(value: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    text(value, key).unwrap_or(fallback)
}

pub(crate) fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

pub(crate) fn integer(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn timestamp_millis(session: &Value, key: &str) -> Result<i64> {
    let raw = text(session, key).ok_or_else(|| {
        AthriaError::new(
            AthriaErrorCode::InvalidData,
            format!("session is missing required field `{key}`"),
        )
    })?;
    crate::tz::millis(raw)
}

/// `normalizedToken`: lowercase, sport-synonym folding, then keep only
/// `[a-z0-9` plus CJK-range characters `]`.
fn normalized_token(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .to_lowercase()
        .replace("running", "run")
        .replace("cycling", "ride")
        .replace("biking", "ride")
        .chars()
        .filter(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || ('\u{3400}'..='\u{9fff}').contains(character)
        })
        .collect()
}

/// `normalizedExercise`: `normalizedToken` with equipment prefixes removed.
fn normalized_exercise(value: Option<&str>) -> String {
    normalized_token(value)
        .replace("dumbbell", "")
        .replace("barbell", "")
        .replace("machine", "")
        .replace("cable", "")
}

/// `ratioScore`: 0 outside `bands`, otherwise the score of the first band whose
/// relative difference limit the two values satisfy.
fn ratio_score(left: f64, right: f64, bands: &[(f64, f64)]) -> f64 {
    if left <= 0.0 || right <= 0.0 {
        return 0.0;
    }
    let difference = (left - right).abs() / left.max(right);
    bands
        .iter()
        .find(|(limit, _)| difference <= *limit)
        .map(|(_, score)| *score)
        .unwrap_or(0.0)
}

fn jaccard(left: &BTreeSet<String>, right: &BTreeSet<String>) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(right).count();
    intersection as f64 / (left.len() + right.len() - intersection) as f64
}

/// `JSON.stringify(number)` for computed values: integral numbers serialize
/// without a fraction part (`80`, not `80.0`), matching JavaScript output in
/// stored plan-match evidence and wellness fields.
pub(crate) fn js_number_value(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::Number((value as i64).into())
    } else {
        Value::Number(serde_json::Number::from_f64(value).unwrap_or_else(|| 0.into()))
    }
}

fn exercise_tokens(sets: &[Value]) -> BTreeSet<String> {
    sets.iter()
        .filter_map(|set| text(set, "exerciseKey").or_else(|| text(set, "exerciseRaw")))
        .map(|value| normalized_exercise(Some(value)))
        .filter(|token| !token.is_empty())
        .collect()
}

fn endurance_number(session: &Value, key: &str) -> f64 {
    session
        .get("endurance")
        .and_then(|endurance| endurance.get(key))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

fn inferred_domains(session: &Value) -> BTreeSet<String> {
    let declared: Vec<String> = array(session, "domains")
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    if !declared.is_empty() {
        return declared.into_iter().collect();
    }
    let modality = text_or(session, "modality", "");
    let mut domains = BTreeSet::new();
    if modality == "strength" || !array(session, "strengthSets").is_empty() {
        domains.insert("strength".to_string());
    }
    if modality == "endurance" {
        domains.insert("endurance".to_string());
    }
    if modality == "mixed" {
        domains.insert("strength".to_string());
        domains.insert("endurance".to_string());
    }
    if modality == "recovery" {
        domains.insert("recovery".to_string());
    }
    domains
}

fn duplicate_score(left: &Value, right: &Value) -> Result<Option<f64>> {
    if text_or(left, "source", "") == text_or(right, "source", "") {
        return Ok(None);
    }
    let left_start = timestamp_millis(left, "startAt")?;
    let right_start = timestamp_millis(right, "startAt")?;
    let left_end = timestamp_millis(left, "endAt")?;
    let right_end = timestamp_millis(right, "endAt")?;
    let start_difference = (left_start - right_start).abs() as f64 / 60_000.0;
    let overlap = (left_end.min(right_end) - left_start.max(right_start)).max(0);
    let shorter = (left_end - left_start)
        .max(0)
        .min((right_end - right_start).max(0));
    let overlap_ratio = if shorter > 0 {
        overlap as f64 / shorter as f64
    } else {
        0.0
    };
    let date_only = text_or(left, "timePrecision", "exact") == "date_only"
        || text_or(right, "timePrecision", "exact") == "date_only";
    if date_only {
        let timezone = text(left, "timezone")
            .or_else(|| text(right, "timezone"))
            .unwrap_or("UTC");
        if crate::tz::local_date(text_or(left, "startAt", ""), timezone)?
            != crate::tz::local_date(text_or(right, "startAt", ""), timezone)?
        {
            return Ok(None);
        }
    } else if start_difference > 30.0 && overlap_ratio < 0.5 {
        return Ok(None);
    }
    let left_modality = text_or(left, "modality", "");
    let right_modality = text_or(right, "modality", "");
    if left_modality != "unknown"
        && right_modality != "unknown"
        && left_modality != right_modality
        && left_modality != "mixed"
        && right_modality != "mixed"
    {
        return Ok(None);
    }
    let left_sport = normalized_token(text(left, "sport"));
    let right_sport = normalized_token(text(right, "sport"));
    if left_modality == "endurance"
        && right_modality == "endurance"
        && !left_sport.is_empty()
        && !right_sport.is_empty()
        && left_sport != right_sport
    {
        return Ok(None);
    }

    let start_score: f64 = if start_difference <= 2.0 {
        45.0
    } else if start_difference <= 5.0 {
        40.0
    } else if start_difference <= 10.0 {
        34.0
    } else if start_difference <= 20.0 {
        24.0
    } else {
        15.0
    };
    let time_score = if date_only {
        45.0
    } else {
        start_score.max((overlap_ratio * 45.0).round())
    };
    let modality_score = if left_modality == right_modality {
        20.0
    } else if left_modality == "mixed" || right_modality == "mixed" {
        14.0
    } else {
        5.0
    };
    let duration_score = ratio_score(
        number(left, "durationMinutes"),
        number(right, "durationMinutes"),
        &[(0.05, 15.0), (0.1, 12.0), (0.2, 8.0), (0.35, 4.0)],
    );
    let left_sets = array(left, "strengthSets");
    let right_sets = array(right, "strengthSets");
    let mut content_score = 0.0;
    if !left_sets.is_empty() && !right_sets.is_empty() {
        content_score =
            (jaccard(&exercise_tokens(left_sets), &exercise_tokens(right_sets)) * 20.0).round();
    } else if left_modality == "endurance" && right_modality == "endurance" {
        if !left_sport.is_empty() && left_sport == right_sport {
            content_score += 10.0;
        }
        content_score += ratio_score(
            endurance_number(left, "distanceMeters"),
            endurance_number(right, "distanceMeters"),
            &[(0.05, 10.0), (0.1, 8.0), (0.2, 4.0)],
        );
    } else {
        let left_name = normalized_token(text(left, "name"));
        if !left_name.is_empty() && left_name == normalized_token(text(right, "name")) {
            content_score = 5.0;
        }
    }
    Ok(Some(
        time_score + modality_score + duration_score + content_score,
    ))
}

fn information_score(session: &Value) -> i64 {
    let endurance_fields = session
        .get("endurance")
        .and_then(Value::as_object)
        .map(|fields| {
            fields
                .iter()
                .filter(|(key, value)| key.as_str() != "heartRateZoneSeconds" && !value.is_null())
                .count()
        })
        .unwrap_or(0);
    let mut score = 0i64;
    if text_or(session, "source", "") == "manual" {
        score -= 100;
    }
    score += array(session, "strengthSets").len() as i64 * 3;
    score += endurance_fields as i64 * 2;
    if number(session, "durationMinutes") > 0.0 {
        score += 5;
    }
    if text_or(session, "modality", "") != "unknown" {
        score += 3;
    }
    score -= array(session, "missingFields").len() as i64;
    score
}

#[derive(Clone, Debug)]
struct Observation {
    id: String,
    canonical_id: String,
    session: Value,
}

fn representative_session(cluster: &[Observation]) -> &Value {
    cluster
        .iter()
        .min_by(|left, right| {
            information_score(&right.session)
                .cmp(&information_score(&left.session))
                .then_with(|| js_locale_compare(&left.id, &right.id))
        })
        .map(|observation| &observation.session)
        .expect("clusters always contain at least one observation")
}

fn cluster_observations(observations: &[Observation]) -> Result<Vec<Vec<Observation>>> {
    let mut ambiguous: HashSet<String> = HashSet::new();
    for observation in observations {
        let mut by_source: BTreeMap<String, Vec<(String, f64)>> = BTreeMap::new();
        for candidate in observations {
            if candidate.id == observation.id
                || text_or(&candidate.session, "source", "")
                    == text_or(&observation.session, "source", "")
            {
                continue;
            }
            if let Some(score) = duplicate_score(&observation.session, &candidate.session)? {
                if score >= 75.0 {
                    by_source
                        .entry(text_or(&candidate.session, "source", "").to_string())
                        .or_default()
                        .push((candidate.id.clone(), score));
                }
            }
        }
        for candidates in by_source.values_mut() {
            candidates.sort_by(|left, right| {
                right
                    .1
                    .partial_cmp(&left.1)
                    .unwrap_or(Ordering::Equal)
                    .then_with(|| js_locale_compare(&left.0, &right.0))
            });
            let Some(best) = candidates.first() else {
                continue;
            };
            let best_score = best.1;
            if candidates
                .get(1)
                .is_some_and(|second| best_score - second.1 < 10.0)
            {
                for candidate in candidates
                    .iter()
                    .filter(|candidate| best_score - candidate.1 < 10.0)
                {
                    ambiguous.insert(format!("{}|{}", observation.id, candidate.0));
                }
            }
        }
    }

    let mut sorted: Vec<Observation> = observations.to_vec();
    sorted.sort_by(|left, right| {
        let left_key = format!(
            "{}:{}",
            text_or(&left.session, "source", ""),
            text_or(&left.session, "externalId", "")
        );
        let right_key = format!(
            "{}:{}",
            text_or(&right.session, "source", ""),
            text_or(&right.session, "externalId", "")
        );
        js_locale_compare(&left_key, &right_key)
    });
    let mut clusters: Vec<Vec<Observation>> = sorted
        .into_iter()
        .map(|observation| vec![observation])
        .collect();
    loop {
        let mut candidates: Vec<(usize, usize, f64)> = Vec::new();
        for left in 0..clusters.len() {
            for right in left + 1..clusters.len() {
                let sources: HashSet<&str> = clusters[left]
                    .iter()
                    .map(|item| text_or(&item.session, "source", ""))
                    .collect();
                if clusters[right]
                    .iter()
                    .any(|item| sources.contains(text_or(&item.session, "source", "")))
                {
                    continue;
                }
                let mut scores: Vec<f64> = Vec::new();
                let mut compatible = true;
                for a in &clusters[left] {
                    for b in &clusters[right] {
                        if ambiguous.contains(&format!("{}|{}", a.id, b.id))
                            || ambiguous.contains(&format!("{}|{}", b.id, a.id))
                        {
                            compatible = false;
                            break;
                        }
                        match duplicate_score(&a.session, &b.session)? {
                            Some(score) => scores.push(score),
                            None => {
                                compatible = false;
                                break;
                            }
                        }
                    }
                    if !compatible {
                        break;
                    }
                }
                if !compatible || scores.iter().any(|score| *score < 75.0) {
                    continue;
                }
                let minimum = scores.iter().copied().fold(f64::INFINITY, f64::min);
                candidates.push((left, right, minimum));
            }
        }
        candidates.sort_by(|left, right| {
            right
                .2
                .partial_cmp(&left.2)
                .unwrap_or(Ordering::Equal)
                .then_with(|| js_locale_compare(&clusters[left.0][0].id, &clusters[right.0][0].id))
        });
        let Some(best) = candidates.first().copied() else {
            break;
        };
        let merged = clusters[best.1].clone();
        clusters[best.0].extend(merged);
        clusters.remove(best.1);
    }
    Ok(clusters)
}

fn planned_content_score(planned: &Value, actual: &Value) -> Result<f64> {
    let mut planned_exercises: BTreeSet<String> = BTreeSet::new();
    for component in array(planned, "components") {
        let Some(prescription) = component.get("prescription") else {
            continue;
        };
        if text_or(prescription, "kind", "") != "strength" {
            continue;
        }
        for exercise in array(prescription, "exercises") {
            if let Some(name) =
                text(exercise, "canonicalKey").or_else(|| text(exercise, "displayName"))
            {
                let token = normalized_exercise(Some(name));
                if !token.is_empty() {
                    planned_exercises.insert(token);
                }
            }
        }
    }
    let actual_exercises = exercise_tokens(array(actual, "strengthSets"));
    if !planned_exercises.is_empty() && !actual_exercises.is_empty() {
        return Ok((jaccard(&planned_exercises, &actual_exercises) * 20.0).round());
    }
    let name = normalized_token(text(planned, "name"));
    Ok(
        if !name.is_empty() && name == normalized_token(text(actual, "name")) {
            5.0
        } else {
            0.0
        },
    )
}

fn plan_match_score(planned: &Value, actual: &Value, timezone: &str) -> Result<Option<f64>> {
    let actual_timezone = text(actual, "timezone").unwrap_or(timezone);
    if crate::tz::local_date(text_or(actual, "startAt", ""), actual_timezone)?
        != text_or(planned, "scheduledDate", "")
    {
        return Ok(None);
    }
    let planned_domains: BTreeSet<String> = array(planned, "components")
        .iter()
        .filter_map(|component| {
            component
                .get("domain")
                .and_then(|domain| domain.get("value"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
        .collect();
    let actual_domains = inferred_domains(actual);
    if planned_domains.is_disjoint(&actual_domains) {
        return Ok(None);
    }
    let domain_score = if planned_domains.len() == 1 && actual_domains.len() == 1 {
        30.0
    } else {
        20.0
    };
    let duration_score = ratio_score(
        number(planned, "durationMinutes"),
        number(actual, "durationMinutes"),
        &[(0.1, 15.0), (0.2, 12.0), (0.35, 8.0), (0.5, 4.0)],
    );
    Ok(Some(
        35.0 + domain_score + duration_score + planned_content_score(planned, actual)?,
    ))
}

impl SqliteStore {
    /// Local date of `now` in the profile timezone, the reference "today" of
    /// planned-session display states.
    pub(crate) fn profile_timezone(&self, owner_id: &str) -> Result<String> {
        let profile = self.get_profile(owner_id)?;
        Ok(profile
            .as_ref()
            .and_then(|value| value.get("timezone"))
            .and_then(Value::as_str)
            .unwrap_or(crate::vocab::DEFAULT_TIMEZONE)
            .to_string())
    }

    /// `training_session_id -> { plannedSessionId, method }` for auto and
    /// manual plan matches.
    pub(crate) fn match_details(&self, owner_id: &str) -> Result<HashMap<String, Value>> {
        let mut statement = self
            .sqlite()
            .prepare("SELECT training_session_id, planned_session_id, method FROM plan_workout_matches WHERE owner_id = ?1")
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![owner_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(database_error)?;
        let mut matches = HashMap::new();
        for row in rows {
            let (training_session_id, planned_session_id, method) = row.map_err(database_error)?;
            matches.insert(
                training_session_id,
                json!({ "plannedSessionId": planned_session_id, "method": method }),
            );
        }
        Ok(matches)
    }

    /// Canonical session id -> ordered `{ source, externalId }` summaries.
    pub(crate) fn source_summaries(&self, owner_id: &str) -> Result<HashMap<String, Vec<Value>>> {
        let mut statement = self
            .sqlite()
            .prepare("SELECT training_session_id, source, external_id FROM training_session_sources WHERE owner_id = ?1 ORDER BY source, external_id")
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![owner_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(database_error)?;
        let mut summaries: HashMap<String, Vec<Value>> = HashMap::new();
        for row in rows {
            let (training_session_id, source, external_id) = row.map_err(database_error)?;
            summaries
                .entry(training_session_id)
                .or_default()
                .push(json!({ "source": source, "externalId": external_id }));
        }
        Ok(summaries)
    }

    pub(crate) fn type_overrides(&self, owner_id: &str) -> Result<HashMap<String, String>> {
        let mut statement = self
            .sqlite()
            .prepare("SELECT training_session_id, domain FROM training_session_type_overrides WHERE owner_id = ?1")
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![owner_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(database_error)?;
        let mut overrides = HashMap::new();
        for row in rows {
            let (training_session_id, domain) = row.map_err(database_error)?;
            overrides.insert(training_session_id, domain);
        }
        Ok(overrides)
    }

    pub(crate) fn excluded_workouts(&self, owner_id: &str) -> Result<HashSet<String>> {
        let mut statement = self
            .sqlite()
            .prepare("SELECT training_session_id FROM workout_plan_exclusions WHERE owner_id = ?1")
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![owner_id], |row| row.get::<_, String>(0))
            .map_err(database_error)?;
        let mut excluded = HashSet::new();
        for row in rows {
            excluded.insert(row.map_err(database_error)?);
        }
        Ok(excluded)
    }

    fn with_derived_match(
        session: &Value,
        matches: &HashMap<String, Value>,
        sources: &HashMap<String, Vec<Value>>,
        excluded: &HashSet<String>,
        overrides: &HashMap<String, String>,
    ) -> Result<Value> {
        let id = text_or(session, "id", "").to_string();
        let plan_match = matches.get(&id);
        let Value::Object(mut fields) = session.clone() else {
            return Err(AthriaError::new(
                AthriaErrorCode::InvalidData,
                "stored training session is not a JSON object",
            ));
        };
        if let Some(domain) = overrides.get(&id) {
            fields.insert("domains".to_string(), json!([domain]));
            let missing: Vec<Value> = array(session, "missingFields")
                .iter()
                .filter(|item| item.as_str() != Some("domains"))
                .cloned()
                .collect();
            fields.insert("missingFields".to_string(), Value::Array(missing));
        }
        fields.insert(
            "plannedSessionId".to_string(),
            plan_match
                .and_then(|value| value.get("plannedSessionId"))
                .cloned()
                .unwrap_or(Value::Null),
        );
        fields.insert(
            "planMatch".to_string(),
            plan_match.cloned().unwrap_or(Value::Null),
        );
        let summary = sources
            .get(&id)
            .cloned()
            .unwrap_or_else(|| vec![json!({ "source": text_or(session, "source", ""), "externalId": text_or(session, "externalId", "") })]);
        fields.insert("sources".to_string(), Value::Array(summary));
        fields.insert(
            "isPlanMatchExcluded".to_string(),
            Value::Bool(excluded.contains(&id)),
        );
        Ok(Value::Object(fields))
    }

    /// `listSessions`: canonical history, newest start first, with derived
    /// match, source and type-override fields.
    pub fn list_sessions(&self, owner_id: &str, since: Option<&str>) -> Result<Vec<Value>> {
        let mut statement = self
            .sqlite()
            .prepare("SELECT data FROM training_sessions WHERE owner_id = ?1 AND (?2 IS NULL OR start_at >= ?2) ORDER BY start_at DESC")
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![owner_id, since], |row| row.get::<_, String>(0))
            .map_err(database_error)?;
        let mut stored = Vec::new();
        for row in rows {
            stored.push(parse_json_column(&row.map_err(database_error)?)?);
        }
        let matches = self.match_details(owner_id)?;
        let sources = self.source_summaries(owner_id)?;
        let excluded = self.excluded_workouts(owner_id)?;
        let overrides = self.type_overrides(owner_id)?;
        stored
            .into_iter()
            .map(|session| {
                Self::with_derived_match(&session, &matches, &sources, &excluded, &overrides)
            })
            .collect()
    }

    /// `listSessionsBySource`: per-source observations for one importer.
    pub fn list_sessions_by_source(
        &self,
        source: &str,
        owner_id: &str,
        since: Option<&str>,
    ) -> Result<Vec<Value>> {
        let mut statement = self
            .sqlite()
            .prepare("SELECT data, training_session_id FROM training_session_sources WHERE owner_id = ?1 AND source = ?2 AND (?3 IS NULL OR start_at >= ?3) ORDER BY start_at DESC")
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![owner_id, source, since], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(database_error)?;
        let matches = self.match_details(owner_id)?;
        let mut sessions = Vec::new();
        for row in rows {
            let (data, training_session_id) = row.map_err(database_error)?;
            let session = parse_json_column(&data)?;
            let plan_match = matches
                .get(&training_session_id)
                .cloned()
                .unwrap_or(Value::Null);
            let mut projected = session.clone();
            projected["plannedSessionId"] = plan_match
                .get("plannedSessionId")
                .cloned()
                .unwrap_or(Value::Null);
            projected["planMatch"] = plan_match;
            projected["sources"] = json!([{ "source": text_or(&session, "source", ""), "externalId": text_or(&session, "externalId", "") }]);
            sessions.push(projected);
        }
        Ok(sessions)
    }

    /// `upsertSessions`: merge observations by `(owner, source, externalId)`,
    /// then rebuild canonical sessions and plan matches.
    pub fn upsert_sessions(&self, sessions: &[Value]) -> Result<WriteCounts> {
        let mut counts = WriteCounts {
            added: 0,
            updated: 0,
        };
        self.transaction(&mut || {
            for value in sessions {
                let owner_id = text_or(value, "ownerId", DEFAULT_OWNER_ID);
                let source = text_or(value, "source", "");
                let external_id = text_or(value, "externalId", "");
                let existing = self
                    .sqlite()
                    .query_row(
                        "SELECT id, created_at, training_session_id FROM training_session_sources WHERE owner_id = ?1 AND source = ?2 AND external_id = ?3",
                        params![owner_id, source, external_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
                    )
                    .optional()
                    .map_err(database_error)?;
                if existing.is_some() {
                    counts.updated += 1;
                } else {
                    counts.added += 1;
                }
                let start_at = text_or(value, "startAt", "").to_string();
                let timezone = text(value, "timezone").map(str::to_string).unwrap_or(self.profile_timezone(owner_id)?);
                let local_date = crate::tz::local_date(&start_at, &timezone)?;
                let timestamp = self.now();
                let (row_id, training_session_id, created_at) = match &existing {
                    Some((row_id, created_at, training_session_id)) => (row_id.clone(), training_session_id.clone(), created_at.clone()),
                    None => (Uuid::new_v4().to_string(), text_or(value, "id", "").to_string(), timestamp.clone()),
                };
                let mut stored = value.clone();
                stored["plannedSessionId"] = Value::Null;
                self.sqlite()
                    .execute(
                        "INSERT INTO training_session_sources(id, owner_id, training_session_id, source, external_id, local_date, start_at, data, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                         ON CONFLICT(owner_id, source, external_id) DO UPDATE SET local_date = excluded.local_date, start_at = excluded.start_at, data = excluded.data, updated_at = excluded.updated_at",
                        params![row_id, owner_id, training_session_id, source, external_id, local_date, start_at, stored.to_string(), created_at, timestamp],
                    )
                    .map_err(database_error)?;
            }
            let mut owner_ids: Vec<&str> = Vec::new();
            for value in sessions {
                let owner_id = text_or(value, "ownerId", DEFAULT_OWNER_ID);
                if !owner_ids.contains(&owner_id) {
                    owner_ids.push(owner_id);
                }
            }
            for owner_id in owner_ids {
                self.rebuild_canonical_sessions(owner_id)?;
                for value in sessions.iter().filter(|value| text_or(value, "ownerId", DEFAULT_OWNER_ID) == owner_id) {
                    let Some(planned_session_id) = text(value, "plannedSessionId").filter(|id| !id.is_empty()) else { continue };
                    let source = text_or(value, "source", "");
                    let training_session_id: String = self
                        .sqlite()
                        .query_row(
                            "SELECT training_session_id FROM training_session_sources WHERE owner_id = ?1 AND source = ?2 AND external_id = ?3",
                            params![owner_id, source, text_or(value, "externalId", "")],
                            |row| row.get(0),
                        )
                        .map_err(database_error)?;
                    let manual = source == "manual";
                    self.insert_plan_match(owner_id, planned_session_id, &training_session_id, if manual { "manual" } else { "auto" }, if manual { 100.0 } else { 80.0 }, &json!({ "explicitSourceLink": true }))?;
                }
                self.reconcile_plan_matches(owner_id)?;
            }
            Ok(())
        })?;
        Ok(counts)
    }

    /// `replaceSourceSessions`: replace every observation of a source inside a
    /// date window or an explicit date list.
    pub fn replace_source_sessions(
        &self,
        input: &ReplaceSourceSessionsInput<'_>,
    ) -> Result<WriteCounts> {
        self.transaction(&mut || {
            let (select_sql, delete_sql, bound): (String, String, Vec<String>) = match input.dates {
                Some(dates) => {
                    let placeholders = vec!["?"; dates.len()].join(",");
                    (
                        format!("SELECT external_id FROM training_session_sources WHERE owner_id = ?1 AND source = ?2 AND local_date IN ({placeholders})"),
                        format!("DELETE FROM training_session_sources WHERE owner_id = ?1 AND source = ?2 AND local_date IN ({placeholders})"),
                        dates.to_vec(),
                    )
                }
                None => (
                    "SELECT external_id FROM training_session_sources WHERE owner_id = ?1 AND source = ?2 AND local_date >= ?3 AND local_date <= ?4".to_string(),
                    "DELETE FROM training_session_sources WHERE owner_id = ?1 AND source = ?2 AND local_date >= ?3 AND local_date <= ?4".to_string(),
                    vec![input.range_start.unwrap_or_default().to_string(), input.range_end.unwrap_or_default().to_string()],
                ),
            };
            let mut parameters: Vec<&dyn rusqlite::ToSql> = vec![&input.owner_id, &input.source];
            for value in &bound {
                parameters.push(value);
            }
            let mut existing_ids: HashSet<String> = HashSet::new();
            {
                let mut statement = self.sqlite().prepare(&select_sql).map_err(database_error)?;
                let rows = statement.query_map(parameters.as_slice(), |row| row.get::<_, String>(0)).map_err(database_error)?;
                for row in rows {
                    existing_ids.insert(row.map_err(database_error)?);
                }
            }
            self.sqlite().execute(&delete_sql, parameters.as_slice()).map_err(database_error)?;

            let timestamp = self.now();
            let timezone = self.profile_timezone(input.owner_id)?;
            let mut counts = WriteCounts { added: 0, updated: 0 };
            for value in input.sessions {
                let external_id = text_or(value, "externalId", "");
                let session_timezone = text(value, "timezone").unwrap_or(&timezone);
                let local_date = match input.local_dates.and_then(|dates| dates.get(external_id)).and_then(Value::as_str) {
                    Some(date) => date.to_string(),
                    None => crate::tz::local_date(text_or(value, "startAt", ""), session_timezone)?,
                };
                if existing_ids.contains(external_id) {
                    counts.updated += 1;
                } else {
                    counts.added += 1;
                }
                let mut stored = value.clone();
                stored["ownerId"] = json!(input.owner_id);
                stored["source"] = json!(input.source);
                stored["plannedSessionId"] = Value::Null;
                self.sqlite()
                    .execute(
                        "INSERT INTO training_session_sources(id, owner_id, training_session_id, source, external_id, local_date, start_at, data, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                        params![
                            Uuid::new_v4().to_string(),
                            input.owner_id,
                            text_or(value, "id", ""),
                            input.source,
                            external_id,
                            local_date,
                            text_or(value, "startAt", ""),
                            stored.to_string(),
                            timestamp,
                            timestamp
                        ],
                    )
                    .map_err(database_error)?;
            }
            self.rebuild_canonical_sessions(input.owner_id)?;
            self.reconcile_plan_matches(input.owner_id)?;
            Ok(counts)
        })
    }

    /// `insertPlanMatch`: deduplicate auto/manual matches the way the
    /// TypeScript store does before writing the row.
    pub(crate) fn insert_plan_match(
        &self,
        owner_id: &str,
        planned_session_id: &str,
        training_session_id: &str,
        method: &str,
        confidence: f64,
        evidence: &Value,
    ) -> Result<()> {
        let existing_plan = self
            .sqlite()
            .query_row(
                "SELECT method, training_session_id FROM plan_workout_matches WHERE owner_id = ?1 AND planned_session_id = ?2",
                params![owner_id, planned_session_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(database_error)?;
        let existing_workout = self
            .sqlite()
            .query_row(
                "SELECT method, planned_session_id FROM plan_workout_matches WHERE owner_id = ?1 AND training_session_id = ?2",
                params![owner_id, training_session_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(database_error)?;
        if method == "auto" && (existing_plan.is_some() || existing_workout.is_some()) {
            return Ok(());
        }
        if method == "manual"
            && existing_plan
                .as_ref()
                .is_some_and(|(_, existing)| existing == training_session_id)
            && existing_workout
                .as_ref()
                .is_some_and(|(_, existing)| existing == planned_session_id)
        {
            return Ok(());
        }
        if method == "manual" {
            self.sqlite()
                .execute(
                    "DELETE FROM plan_workout_matches WHERE owner_id = ?1 AND (planned_session_id = ?2 OR training_session_id = ?3)",
                    params![owner_id, planned_session_id, training_session_id],
                )
                .map_err(database_error)?;
        }
        self.sqlite()
            .execute(
                "INSERT INTO plan_workout_matches(id, owner_id, planned_session_id, training_session_id, method, confidence, algorithm_version, evidence, matched_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    Uuid::new_v4().to_string(),
                    owner_id,
                    planned_session_id,
                    training_session_id,
                    method,
                    confidence.round() as i64,
                    RECONCILIATION_VERSION,
                    evidence.to_string(),
                    self.now()
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    /// `rebuildCanonicalSessions`: cluster observations, pick canonical ids
    /// (protecting linked, excluded and overridden ids), then rewrite
    /// `training_sessions` and the observation assignments.
    pub fn rebuild_canonical_sessions(&self, owner_id: &str) -> Result<()> {
        let mut observations: Vec<Observation> = Vec::new();
        {
            let mut statement = self
                .sqlite()
                .prepare("SELECT id, training_session_id, data FROM training_session_sources WHERE owner_id = ?1")
                .map_err(database_error)?;
            let rows = statement
                .query_map(params![owner_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(database_error)?;
            for row in rows {
                let (id, canonical_id, data) = row.map_err(database_error)?;
                observations.push(Observation {
                    id,
                    canonical_id,
                    session: parse_json_column(&data)?,
                });
            }
        }
        let mut existing: HashMap<String, Value> = HashMap::new();
        {
            let mut statement = self
                .sqlite()
                .prepare("SELECT id, data FROM training_sessions WHERE owner_id = ?1")
                .map_err(database_error)?;
            let rows = statement
                .query_map(params![owner_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(database_error)?;
            for row in rows {
                let (id, data) = row.map_err(database_error)?;
                existing.insert(id, parse_json_column(&data)?);
            }
        }
        let linked = self.owner_scoped_ids("plan_workout_matches", owner_id)?;
        let has_exclusions = self.table_exists("workout_plan_exclusions")?;
        let mut excluded = if has_exclusions {
            self.excluded_workouts(owner_id)?
        } else {
            HashSet::new()
        };
        let has_overrides = self.table_exists("training_session_type_overrides")?;
        let override_ids: HashSet<String> = if has_overrides {
            self.type_overrides(owner_id)?.into_keys().collect()
        } else {
            HashSet::new()
        };
        let mut protected: HashSet<String> = linked.clone();
        protected.extend(excluded.iter().cloned());
        protected.extend(override_ids);

        let mut used: HashSet<String> = HashSet::new();
        let mut canonical: Vec<Value> = Vec::new();
        let mut assignments: Vec<(String, String)> = Vec::new();
        for cluster in cluster_observations(&observations)? {
            let mut member_ids: Vec<String> = Vec::new();
            for observation in &cluster {
                if !member_ids.contains(&observation.canonical_id) {
                    member_ids.push(observation.canonical_id.clone());
                }
            }
            let mut id = member_ids
                .iter()
                .find(|candidate| protected.contains(*candidate) && !used.contains(*candidate))
                .cloned();
            if id.is_none() {
                id = member_ids
                    .iter()
                    .find(|candidate| {
                        existing.contains_key(*candidate) && !used.contains(*candidate)
                    })
                    .cloned();
            }
            let id = match id {
                Some(value) => value,
                None => {
                    let representative = representative_session(&cluster);
                    let mut incoming = representative.clone();
                    incoming["source"] = json!(format!(
                        "incoming:{}",
                        text_or(representative, "source", "")
                    ));
                    let mut reusables: Vec<(String, f64)> = Vec::new();
                    for (candidate, session) in &existing {
                        if used.contains(candidate) {
                            continue;
                        }
                        reusables.push((
                            candidate.clone(),
                            duplicate_score(&incoming, session)?.unwrap_or(-1.0),
                        ));
                    }
                    reusables.sort_by(|left, right| {
                        right
                            .1
                            .partial_cmp(&left.1)
                            .unwrap_or(Ordering::Equal)
                            .then_with(|| js_locale_compare(&left.0, &right.0))
                    });
                    match reusables.first() {
                        Some((candidate, score)) if *score >= 75.0 => candidate.clone(),
                        _ => member_ids
                            .iter()
                            .find(|candidate| !used.contains(*candidate))
                            .cloned()
                            .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    }
                }
            };
            used.insert(id.clone());
            let mut session = representative_session(&cluster).clone();
            session["id"] = json!(id);
            session["ownerId"] = json!(owner_id);
            session["plannedSessionId"] = Value::Null;
            canonical.push(session);
            for observation in &cluster {
                assignments.push((observation.id.clone(), id.clone()));
            }
            if member_ids
                .iter()
                .any(|candidate| excluded.contains(candidate))
            {
                excluded.insert(id.clone());
            }
        }

        self.sqlite()
            .execute(
                "DELETE FROM training_sessions WHERE owner_id = ?1",
                params![owner_id],
            )
            .map_err(database_error)?;
        for session in &canonical {
            self.sqlite()
                .execute(
                    "INSERT INTO training_sessions(id, owner_id, source, external_id, modality, start_at, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        text_or(session, "id", ""),
                        owner_id,
                        text_or(session, "source", ""),
                        text_or(session, "externalId", ""),
                        text_or(session, "modality", ""),
                        text_or(session, "startAt", ""),
                        session.to_string()
                    ],
                )
                .map_err(database_error)?;
        }
        for (source_row_id, canonical_id) in &assignments {
            self.sqlite()
                .execute(
                    "UPDATE training_session_sources SET training_session_id = ?1 WHERE id = ?2",
                    params![canonical_id, source_row_id],
                )
                .map_err(database_error)?;
        }
        self.sqlite()
            .execute(
                "DELETE FROM plan_workout_matches WHERE owner_id = ?1 AND training_session_id NOT IN (SELECT id FROM training_sessions WHERE owner_id = ?1)",
                params![owner_id],
            )
            .map_err(database_error)?;
        if has_overrides {
            self.sqlite()
                .execute(
                    "DELETE FROM training_session_type_overrides WHERE owner_id = ?1 AND training_session_id NOT IN (SELECT id FROM training_sessions WHERE owner_id = ?1)",
                    params![owner_id],
                )
                .map_err(database_error)?;
        }
        if has_exclusions {
            self.sqlite()
                .execute(
                    "DELETE FROM workout_plan_exclusions WHERE owner_id = ?1",
                    params![owner_id],
                )
                .map_err(database_error)?;
            for training_session_id in excluded
                .iter()
                .filter(|candidate| used.contains(*candidate))
            {
                self.sqlite()
                    .execute(
                        "INSERT INTO workout_plan_exclusions(owner_id, training_session_id, created_at) VALUES (?1, ?2, ?3)",
                        params![owner_id, training_session_id, self.now()],
                    )
                    .map_err(database_error)?;
            }
        }
        Ok(())
    }

    fn owner_scoped_ids(&self, table: &str, owner_id: &str) -> Result<HashSet<String>> {
        let mut statement = self
            .sqlite()
            .prepare(&format!(
                "SELECT training_session_id FROM {table} WHERE owner_id = ?1"
            ))
            .map_err(database_error)?;
        let rows = statement
            .query_map(params![owner_id], |row| row.get::<_, String>(0))
            .map_err(database_error)?;
        let mut ids = HashSet::new();
        for row in rows {
            ids.insert(row.map_err(database_error)?);
        }
        Ok(ids)
    }

    /// `reconcilePlanMatches`: drop stale automatic matches and re-derive them
    /// with the 70-point threshold and 10-point win margins.
    pub fn reconcile_plan_matches(&self, owner_id: &str) -> Result<()> {
        let Some(plan) = self.get_current_plan(owner_id)? else {
            return Ok(());
        };
        let planned: Vec<&Value> = plan
            .get("mesocycle")
            .and_then(|mesocycle| mesocycle.get("weeks"))
            .and_then(Value::as_array)
            .map(|weeks| {
                weeks
                    .iter()
                    .flat_map(|week| array(week, "sessions").iter())
                    .filter(|session| text_or(session, "status", "planned") != "skipped")
                    .collect()
            })
            .unwrap_or_default();
        let planned_ids: HashSet<&str> = planned
            .iter()
            .map(|session| text_or(session, "id", ""))
            .collect();

        self.sqlite()
            .execute(
                "DELETE FROM plan_workout_matches WHERE owner_id = ?1 AND method = 'auto'",
                params![owner_id],
            )
            .map_err(database_error)?;
        let mut manual: Vec<(String, String)> = Vec::new();
        {
            let mut statement = self
                .sqlite()
                .prepare("SELECT planned_session_id, training_session_id FROM plan_workout_matches WHERE owner_id = ?1 AND method = 'manual'")
                .map_err(database_error)?;
            let rows = statement
                .query_map(params![owner_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(database_error)?;
            for row in rows {
                manual.push(row.map_err(database_error)?);
            }
        }
        for (planned_session_id, _) in &manual {
            if !planned_ids.contains(planned_session_id.as_str()) {
                self.sqlite()
                    .execute("DELETE FROM plan_workout_matches WHERE owner_id = ?1 AND planned_session_id = ?2", params![owner_id, planned_session_id])
                    .map_err(database_error)?;
            }
        }
        let occupied_plans: HashSet<&str> = manual
            .iter()
            .map(|(planned_session_id, _)| planned_session_id.as_str())
            .collect();
        let occupied_workouts: HashSet<&str> = manual
            .iter()
            .map(|(_, training_session_id)| training_session_id.as_str())
            .collect();
        let excluded = self.excluded_workouts(owner_id)?;
        let workouts: Vec<Value> = self
            .list_sessions(owner_id, None)?
            .into_iter()
            .filter(|session| {
                !occupied_workouts.contains(text_or(session, "id", ""))
                    && !excluded.contains(text_or(session, "id", ""))
            })
            .collect();
        let timezone = self.profile_timezone(owner_id)?;

        let mut candidates: Vec<(&Value, &Value, f64)> = Vec::new();
        for session in &planned {
            if occupied_plans.contains(text_or(session, "id", "")) {
                continue;
            }
            for workout in &workouts {
                if let Some(score) = plan_match_score(session, workout, &timezone)? {
                    if score >= 70.0 {
                        candidates.push((session, workout, score));
                    }
                }
            }
        }
        candidates.sort_by(|left, right| {
            right
                .2
                .partial_cmp(&left.2)
                .unwrap_or(Ordering::Equal)
                .then_with(|| {
                    js_locale_compare(text_or(left.0, "id", ""), text_or(right.0, "id", ""))
                })
                .then_with(|| {
                    js_locale_compare(text_or(left.1, "id", ""), text_or(right.1, "id", ""))
                })
        });
        let mut used_plans: HashSet<&str> = HashSet::new();
        let mut used_workouts: HashSet<&str> = HashSet::new();
        for (session, workout, score) in &candidates {
            let session_id = text_or(session, "id", "");
            let workout_id = text_or(workout, "id", "");
            let plan_alternative = candidates
                .iter()
                .find(|(other_session, other_workout, _)| {
                    text_or(other_session, "id", "") == session_id
                        && text_or(other_workout, "id", "") != workout_id
                })
                .map(|(_, _, score)| *score)
                .unwrap_or(f64::NEG_INFINITY);
            let workout_alternative = candidates
                .iter()
                .find(|(other_session, other_workout, _)| {
                    text_or(other_workout, "id", "") == workout_id
                        && text_or(other_session, "id", "") != session_id
                })
                .map(|(_, _, score)| *score)
                .unwrap_or(f64::NEG_INFINITY);
            if score - plan_alternative < 10.0
                || score - workout_alternative < 10.0
                || used_plans.contains(session_id)
                || used_workouts.contains(workout_id)
            {
                continue;
            }
            self.insert_plan_match(
                owner_id,
                session_id,
                workout_id,
                "auto",
                *score,
                &json!({ "scheduledDate": text_or(session, "scheduledDate", ""), "score": js_number_value(*score) }),
            )?;
            used_plans.insert(session_id);
            used_workouts.insert(workout_id);
        }
        Ok(())
    }

    /// `setTrainingSessionPlanMatch`: confirm or clear a manual plan link.
    pub fn set_training_session_plan_match(
        &self,
        owner_id: &str,
        training_session_id: &str,
        planned_session_id: Option<&str>,
        expected_revision: i64,
    ) -> Result<Value> {
        self.transaction(&mut || {
            let plan = self.get_current_plan(owner_id)?;
            let revision = plan.as_ref().and_then(|value| value.get("revision")).and_then(Value::as_i64).unwrap_or(0);
            if revision != expected_revision {
                return Err(AthriaError::new(AthriaErrorCode::PlannedSessionRevisionConflict, "PLANNED_SESSION_REVISION_CONFLICT"));
            }
            let workout: Option<String> = self
                .sqlite()
                .query_row("SELECT data FROM training_sessions WHERE owner_id = ?1 AND id = ?2", params![owner_id, training_session_id], |row| row.get(0))
                .optional()
                .map_err(database_error)?;
            let Some(workout_data) = workout else {
                return Err(AthriaError::new(AthriaErrorCode::TrainingSessionNotFound, "TRAINING_SESSION_NOT_FOUND"));
            };
            self.sqlite()
                .execute("DELETE FROM plan_workout_matches WHERE owner_id = ?1 AND training_session_id = ?2", params![owner_id, training_session_id])
                .map_err(database_error)?;
            match planned_session_id {
                None => {
                    self.sqlite()
                        .execute(
                            "INSERT INTO workout_plan_exclusions(owner_id, training_session_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(owner_id, training_session_id) DO UPDATE SET created_at = excluded.created_at",
                            params![owner_id, training_session_id, self.now()],
                        )
                        .map_err(database_error)?;
                }
                Some(planned_session_id) => {
                    let Some(plan) = plan.as_ref() else {
                        return Err(AthriaError::new(AthriaErrorCode::NoCurrentPlan, "NO_CURRENT_PLAN"));
                    };
                    let planned = plan
                        .get("mesocycle")
                        .and_then(|mesocycle| mesocycle.get("weeks"))
                        .and_then(Value::as_array)
                        .map(|weeks| weeks.iter().flat_map(|week| array(week, "sessions").iter()).find(|session| text_or(session, "id", "") == planned_session_id));
                    let Some(planned) = planned.flatten() else {
                        return Err(AthriaError::new(AthriaErrorCode::PlannedSessionNotFound, "PLANNED_SESSION_NOT_FOUND"));
                    };
                    if text_or(planned, "status", "planned") == "skipped" {
                        return Err(AthriaError::new(AthriaErrorCode::PlannedSessionSkipped, "PLANNED_SESSION_SKIPPED"));
                    }
                    let actual = parse_json_column(&workout_data)?;
                    let timezone = text(&actual, "timezone").map(str::to_string).unwrap_or(self.profile_timezone(owner_id)?);
                    if crate::tz::local_date(text_or(&actual, "startAt", ""), &timezone)? != text_or(planned, "scheduledDate", "") {
                        return Err(AthriaError::new(AthriaErrorCode::PlanWorkoutDateMismatch, "PLAN_WORKOUT_DATE_MISMATCH"));
                    }
                    self.sqlite()
                        .execute("DELETE FROM workout_plan_exclusions WHERE owner_id = ?1 AND training_session_id = ?2", params![owner_id, training_session_id])
                        .map_err(database_error)?;
                    self.insert_plan_match(owner_id, planned_session_id, training_session_id, "manual", 100.0, &json!({ "userConfirmed": true }))?;
                }
            }
            self.reconcile_plan_matches(owner_id)?;
            self.list_sessions(owner_id, None)?
                .into_iter()
                .find(|session| text_or(session, "id", "") == training_session_id)
                .ok_or_else(|| AthriaError::new(AthriaErrorCode::TrainingSessionNotFound, "TRAINING_SESSION_NOT_FOUND"))
        })
    }

    /// `clearTrainingSessionPlanExclusion`: remove the exclusion and re-derive
    /// automatic matches.
    pub fn clear_training_session_plan_exclusion(
        &self,
        owner_id: &str,
        training_session_id: &str,
    ) -> Result<Value> {
        self.sqlite()
            .execute("DELETE FROM workout_plan_exclusions WHERE owner_id = ?1 AND training_session_id = ?2", params![owner_id, training_session_id])
            .map_err(database_error)?;
        self.reconcile_plan_matches(owner_id)?;
        self.list_sessions(owner_id, None)?
            .into_iter()
            .find(|session| text_or(session, "id", "") == training_session_id)
            .ok_or_else(|| {
                AthriaError::new(
                    AthriaErrorCode::TrainingSessionNotFound,
                    "TRAINING_SESSION_NOT_FOUND",
                )
            })
    }

    /// `updateManualTrainingSession`: retime a manual observation without
    /// moving it to another local date.
    pub fn update_manual_training_session(
        &self,
        owner_id: &str,
        training_session_id: &str,
        start_at: Option<&str>,
        duration_minutes: Option<i64>,
    ) -> Result<Value> {
        self.transaction(&mut || {
            let row = self
                .sqlite()
                .query_row(
                    "SELECT id, local_date, data FROM training_session_sources WHERE owner_id = ?1 AND training_session_id = ?2 AND source = 'manual'",
                    params![owner_id, training_session_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
                )
                .optional()
                .map_err(database_error)?;
            let Some((row_id, local_date, data)) = row else {
                return Err(AthriaError::new(AthriaErrorCode::ManualSourceNotFound, "MANUAL_SOURCE_NOT_FOUND"));
            };
            let current = parse_json_column(&data)?;
            let requested_start = start_at.map(str::to_string);
            let start_at = requested_start.clone().unwrap_or_else(|| text_or(&current, "startAt", "").to_string());
            let timezone = text(&current, "timezone").map(str::to_string).unwrap_or(self.profile_timezone(owner_id)?);
            if crate::tz::local_date(&start_at, &timezone)? != local_date {
                return Err(AthriaError::new(AthriaErrorCode::ManualDateChangeRequiresPlanMove, "MANUAL_DATE_CHANGE_REQUIRES_PLAN_MOVE"));
            }
            let duration = duration_minutes.unwrap_or_else(|| integer(&current, "durationMinutes"));
            let end_at = crate::tz::iso_from_millis(crate::tz::millis(&start_at)? + duration * 60_000);
            let missing: Vec<Value> = if requested_start.is_some() {
                array(&current, "missingFields").iter().filter(|item| item.as_str() != Some("actual start time")).cloned().collect()
            } else {
                array(&current, "missingFields").to_vec()
            };
            let mut updated = current.clone();
            updated["startAt"] = json!(start_at);
            updated["endAt"] = json!(end_at);
            updated["durationMinutes"] = json!(duration);
            updated["timePrecision"] = json!(if requested_start.is_some() { "exact" } else { text_or(&current, "timePrecision", "exact") });
            updated["missingFields"] = Value::Array(missing);
            self.sqlite()
                .execute(
                    "UPDATE training_session_sources SET start_at = ?1, data = ?2, updated_at = ?3 WHERE id = ?4",
                    params![text_or(&updated, "startAt", ""), updated.to_string(), self.now(), row_id],
                )
                .map_err(database_error)?;
            self.rebuild_canonical_sessions(owner_id)?;
            self.reconcile_plan_matches(owner_id)?;
            self.list_sessions(owner_id, None)?
                .into_iter()
                .find(|session| text_or(session, "id", "") == training_session_id)
                .ok_or_else(|| AthriaError::new(AthriaErrorCode::TrainingSessionNotFound, "TRAINING_SESSION_NOT_FOUND"))
        })
    }

    /// `setTrainingSessionTypeOverride`: force one domain on a canonical
    /// session and re-derive plan matches.
    pub fn set_training_session_type_override(
        &self,
        owner_id: &str,
        training_session_id: &str,
        domain: &str,
    ) -> Result<Value> {
        let exists: Option<String> = self
            .sqlite()
            .query_row(
                "SELECT id FROM training_sessions WHERE owner_id = ?1 AND id = ?2",
                params![owner_id, training_session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        if exists.is_none() {
            return Err(AthriaError::new(
                AthriaErrorCode::TrainingSessionNotFound,
                "TRAINING_SESSION_NOT_FOUND",
            ));
        }
        self.sqlite()
            .execute(
                "INSERT INTO training_session_type_overrides(owner_id, training_session_id, domain, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(owner_id, training_session_id) DO UPDATE SET domain = excluded.domain, updated_at = excluded.updated_at",
                params![owner_id, training_session_id, domain, self.now()],
            )
            .map_err(database_error)?;
        self.reconcile_plan_matches(owner_id)?;
        self.list_sessions(owner_id, None)?
            .into_iter()
            .find(|session| text_or(session, "id", "") == training_session_id)
            .ok_or_else(|| {
                AthriaError::new(
                    AthriaErrorCode::TrainingSessionNotFound,
                    "TRAINING_SESSION_NOT_FOUND",
                )
            })
    }

    /// `deleteManualTrainingSession`: drop the manual observation and rebuild.
    pub fn delete_manual_training_session(
        &self,
        owner_id: &str,
        training_session_id: &str,
    ) -> Result<Option<Value>> {
        self.transaction(&mut || {
            let deleted = self
                .sqlite()
                .execute(
                    "DELETE FROM training_session_sources WHERE owner_id = ?1 AND training_session_id = ?2 AND source = 'manual'",
                    params![owner_id, training_session_id],
                )
                .map_err(database_error)?;
            if deleted == 0 {
                return Err(AthriaError::new(AthriaErrorCode::ManualSourceNotFound, "MANUAL_SOURCE_NOT_FOUND"));
            }
            self.rebuild_canonical_sessions(owner_id)?;
            self.reconcile_plan_matches(owner_id)?;
            Ok(self.list_sessions(owner_id, None)?.into_iter().find(|session| text_or(session, "id", "") == training_session_id))
        })
    }

    /// `deleteTrainingSession`: drop a canonical session and every derived row.
    pub fn delete_training_session(&self, owner_id: &str, training_session_id: &str) -> Result<()> {
        self.transaction(&mut || {
            let exists: Option<String> = self
                .sqlite()
                .query_row("SELECT id FROM training_sessions WHERE owner_id = ?1 AND id = ?2", params![owner_id, training_session_id], |row| row.get(0))
                .optional()
                .map_err(database_error)?;
            if exists.is_none() {
                return Err(AthriaError::new(AthriaErrorCode::TrainingSessionNotFound, "TRAINING_SESSION_NOT_FOUND"));
            }
            for statement in [
                "DELETE FROM training_session_sources WHERE owner_id = ?1 AND training_session_id = ?2",
                "DELETE FROM plan_workout_matches WHERE owner_id = ?1 AND training_session_id = ?2",
                "DELETE FROM workout_plan_exclusions WHERE owner_id = ?1 AND training_session_id = ?2",
                "DELETE FROM training_session_type_overrides WHERE owner_id = ?1 AND training_session_id = ?2",
                "DELETE FROM training_sessions WHERE owner_id = ?1 AND id = ?2",
            ] {
                self.sqlite().execute(statement, params![owner_id, training_session_id]).map_err(database_error)?;
            }
            self.rebuild_canonical_sessions(owner_id)?;
            self.reconcile_plan_matches(owner_id)?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FixedClock;
    use std::sync::Arc;

    fn store() -> SqliteStore {
        SqliteStore::open_in_memory_with_clock(Arc::new(FixedClock::new(
            "2026-09-17T04:00:00.000Z",
        )))
        .unwrap()
    }

    fn run(
        source: &str,
        external_id: &str,
        id: &str,
        start_at: &str,
        end_at: &str,
        minutes: i64,
        name: &str,
    ) -> Value {
        json!({
            "id": id, "ownerId": DEFAULT_OWNER_ID, "source": source, "externalId": external_id, "modality": "endurance",
            "domains": ["endurance"], "sport": "Run", "name": name, "startAt": start_at, "endAt": end_at,
            "durationMinutes": minutes, "status": "completed", "timezone": "Asia/Hong_Kong", "plannedSessionId": null,
            "timePrecision": "exact", "sources": [], "planMatch": null, "isPlanMatchExcluded": false,
            "strengthSets": [], "endurance": null, "missingFields": [],
        })
    }

    fn plan_with_run() -> Value {
        json!({
            "ownerId": DEFAULT_OWNER_ID, "revision": 1, "updatedAt": "2026-09-01T04:00:00.000Z",
            "mesocycle": {
                "durationWeeks": 1,
                "schedule": { "kind": "fixed_week", "days": [3, 6] },
                "domainProgressions": [{
                    "domain": "endurance",
                    "phases": [{ "id": "phase-1", "phaseType": "foundation", "name": "Base", "startWeek": 1, "endWeek": 1, "focus": "Aerobic base", "progression": [] }],
                }],
                "weeks": [{
                    "weekNumber": 1, "focus": null,
                    "sessions": [{
                        "id": "s1", "scheduledDate": "2026-09-10", "order": 0, "status": "planned", "templateRef": null,
                        "name": "Easy Run", "intent": "Aerobic base", "durationMinutes": 60, "recoveryDemand": "low", "keySession": false,
                        "components": [{
                            "id": "c1", "name": "Run",
                            "domain": { "value": "endurance", "source": "user_confirmed", "confidence": 1, "evidence": "", "taxonomyVersion": "strength-2.0" },
                            "prescription": { "kind": "duration_only", "notes": "" },
                        }],
                        "progressionNote": null, "schedulingRationale": null, "legacySnapshot": false,
                    }],
                }],
            },
        })
    }

    #[test]
    fn identical_sessions_from_two_sources_merge_into_one_canonical_record() {
        let store = store();
        let manual = run(
            "manual",
            "m1",
            "11111111-1111-4111-8111-111111111111",
            "2026-09-10T10:00:00.000Z",
            "2026-09-10T11:00:00.000Z",
            60,
            "Easy Run",
        );
        let hevy = run(
            "hevy",
            "h1",
            "22222222-2222-4222-8222-222222222222",
            "2026-09-10T10:05:00.000Z",
            "2026-09-10T11:00:00.000Z",
            60,
            "Easy Run",
        );
        let counts = store.upsert_sessions(&[manual, hevy]).unwrap();
        assert_eq!((counts.added, counts.updated), (2, 0));

        let sessions = store.list_sessions(DEFAULT_OWNER_ID, None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0]["sources"],
            json!([{ "source": "hevy", "externalId": "h1" }, { "source": "manual", "externalId": "m1" }])
        );
        assert_eq!(
            sessions[0]["id"],
            json!("22222222-2222-4222-8222-222222222222")
        );

        let counts = store
            .upsert_sessions(&[run(
                "hevy",
                "h1",
                "22222222-2222-4222-8222-222222222222",
                "2026-09-10T10:05:00.000Z",
                "2026-09-10T11:00:00.000Z",
                60,
                "Easy Run",
            )])
            .unwrap();
        assert_eq!((counts.added, counts.updated), (0, 1));
    }

    #[test]
    fn completed_sessions_auto_match_the_planned_session() {
        let store = store();
        store.save_current_plan(&plan_with_run(), 0).unwrap();
        assert!(
            store
                .list_sessions(DEFAULT_OWNER_ID, None)
                .unwrap()
                .is_empty()
        );

        store
            .upsert_sessions(&[run(
                "hevy",
                "h1",
                "22222222-2222-4222-8222-222222222222",
                "2026-09-10T10:00:00.000Z",
                "2026-09-10T11:00:00.000Z",
                60,
                "Easy Run",
            )])
            .unwrap();
        let sessions = store.list_sessions(DEFAULT_OWNER_ID, None).unwrap();
        assert_eq!(sessions[0]["plannedSessionId"], json!("s1"));
        assert_eq!(
            sessions[0]["planMatch"],
            json!({ "plannedSessionId": "s1", "method": "auto" })
        );

        let (confidence, evidence): (i64, String) = store
            .sqlite()
            .query_row(
                "SELECT confidence, evidence FROM plan_workout_matches WHERE owner_id = ?1",
                params![DEFAULT_OWNER_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(confidence, 85);
        assert_eq!(evidence, "{\"scheduledDate\":\"2026-09-10\",\"score\":85}");
    }

    #[test]
    fn skipped_planned_sessions_never_auto_match() {
        let store = store();
        let mut plan = plan_with_run();
        plan["mesocycle"]["weeks"][0]["sessions"][0]["status"] = json!("skipped");
        store.save_current_plan(&plan, 0).unwrap();
        store
            .upsert_sessions(&[run(
                "hevy",
                "h1",
                "22222222-2222-4222-8222-222222222222",
                "2026-09-10T10:00:00.000Z",
                "2026-09-10T11:00:00.000Z",
                60,
                "Easy Run",
            )])
            .unwrap();
        assert_eq!(
            store.list_sessions(DEFAULT_OWNER_ID, None).unwrap()[0]["plannedSessionId"],
            Value::Null
        );
    }

    #[test]
    fn manual_plan_links_win_over_auto_matching() {
        let store = store();
        store.save_current_plan(&plan_with_run(), 0).unwrap();
        let session = run(
            "hevy",
            "h1",
            "22222222-2222-4222-8222-222222222222",
            "2026-09-10T10:00:00.000Z",
            "2026-09-10T11:00:00.000Z",
            60,
            "Easy Run",
        );
        store.upsert_sessions(&[session]).unwrap();
        store
            .set_training_session_plan_match(
                DEFAULT_OWNER_ID,
                "22222222-2222-4222-8222-222222222222",
                None,
                1,
            )
            .unwrap();
        store
            .set_training_session_plan_match(
                DEFAULT_OWNER_ID,
                "22222222-2222-4222-8222-222222222222",
                Some("s1"),
                1,
            )
            .unwrap();

        let sessions = store.list_sessions(DEFAULT_OWNER_ID, None).unwrap();
        assert_eq!(
            sessions[0]["planMatch"],
            json!({ "plannedSessionId": "s1", "method": "manual" })
        );

        let (method, confidence): (String, i64) = store
            .sqlite()
            .query_row(
                "SELECT method, confidence FROM plan_workout_matches WHERE owner_id = ?1",
                params![DEFAULT_OWNER_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((method.as_str(), confidence), ("manual", 100));
    }

    #[test]
    fn excluded_workouts_stay_out_of_auto_matching() {
        let store = store();
        store.save_current_plan(&plan_with_run(), 0).unwrap();
        store
            .upsert_sessions(&[run(
                "hevy",
                "h1",
                "22222222-2222-4222-8222-222222222222",
                "2026-09-10T10:00:00.000Z",
                "2026-09-10T11:00:00.000Z",
                60,
                "Easy Run",
            )])
            .unwrap();
        store
            .set_training_session_plan_match(
                DEFAULT_OWNER_ID,
                "22222222-2222-4222-8222-222222222222",
                None,
                1,
            )
            .unwrap();
        let sessions = store.list_sessions(DEFAULT_OWNER_ID, None).unwrap();
        assert_eq!(sessions[0]["isPlanMatchExcluded"], json!(true));
        assert_eq!(sessions[0]["plannedSessionId"], Value::Null);
    }

    #[test]
    fn merging_keeps_the_existing_canonical_id_and_the_better_source_payload() {
        let store = store();
        let manual = run(
            "manual",
            "m1",
            "11111111-1111-4111-8111-111111111111",
            "2026-09-10T10:00:00.000Z",
            "2026-09-10T11:00:00.000Z",
            60,
            "Easy Run",
        );
        store.upsert_sessions(&[manual]).unwrap();
        let hevy = run(
            "hevy",
            "h1",
            "22222222-2222-4222-8222-222222222222",
            "2026-09-10T10:03:00.000Z",
            "2026-09-10T11:02:00.000Z",
            60,
            "Easy Run",
        );
        store.upsert_sessions(&[hevy]).unwrap();

        let sessions = store.list_sessions(DEFAULT_OWNER_ID, None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0]["id"],
            json!("11111111-1111-4111-8111-111111111111")
        );
        assert_eq!(sessions[0]["source"], json!("hevy"));
    }

    #[test]
    fn stored_sessions_keep_the_domains_the_importer_declared() {
        let store = store();
        let mut session = run(
            "hevy",
            "h1",
            "22222222-2222-4222-8222-222222222222",
            "2026-09-10T10:00:00.000Z",
            "2026-09-10T11:00:00.000Z",
            60,
            "Easy Run",
        );
        session["domains"] = json!([]);
        session["modality"] = json!("mixed");
        store.upsert_sessions(&[session]).unwrap();
        let stored: String = store
            .sqlite()
            .query_row("SELECT data FROM training_sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(parse_json_column(&stored).unwrap()["domains"], json!([]));
    }
}
