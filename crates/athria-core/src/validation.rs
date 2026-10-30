//! Plan validation rule engine.
//!
//! Rule order, reason codes, enforcement/status semantics, evidence shapes,
//! coverage counters, data gaps and the input hash must stay identical to the
//! TypeScript implementation; the golden fixtures under `tests/fixtures`
//! compare complete outputs. Like the rest of the core, the engine reads
//! schema-validated JSON directly (see [`crate::json`]).

use std::collections::{BTreeSet, HashSet};

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::date;
use crate::hash::stable_hash;
use crate::json::{
    array_field, bump, field, int_field, is_null_or_missing, number, number_field, optional_string,
    string_field,
};
use crate::schedule::expand_schedule;
use crate::{AI_HARD_CONFIDENCE, RULE_VERSION, TAXONOMY_VERSION};

/// Which hard checks ran and how many classification facts resolved; the
/// numbers gate how much the caller may trust a `valid` verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub hard_checks_resolved: usize,
    pub hard_checks_total: usize,
    pub movement_facts_resolved: i64,
    pub movement_facts_total: i64,
    pub muscle_facts_resolved: i64,
    pub muscle_facts_total: i64,
    pub equipment_facts_resolved: i64,
    pub equipment_facts_total: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanValidation {
    pub valid: bool,
    pub results: Vec<Value>,
    pub data_gaps: Vec<Value>,
    pub validated_at: String,
    pub input_hash: String,
    pub coverage: Coverage,
}

fn rule(
    enforcement: &str,
    reason_code: &str,
    status: &str,
    subject_refs: &[&str],
    evidence: Value,
    missing_facts: &[&str],
    confidence_limit: Value,
    rule_pack_id: &str,
) -> Value {
    json!({
        "status": status,
        "enforcement": enforcement,
        "reasonCode": reason_code,
        "rulePackId": rule_pack_id,
        "ruleVersion": RULE_VERSION,
        "subjectRefs": subject_refs,
        "evidence": evidence,
        "missingFacts": missing_facts,
        "confidenceLimit": confidence_limit,
    })
}

fn fact_trusted(fact: &Value) -> bool {
    let has_value = !field(fact, "value").is_null();
    let conflicts_empty = fact
        .get("conflicts")
        .and_then(Value::as_array)
        .is_none_or(|items| items.is_empty());
    let source = string_field(fact, "source");
    let source_ok = source == "user_confirmed" || conflicts_empty;
    let ai_ok = source != "ai_inferred"
        || (number_field(fact, "confidence") >= AI_HARD_CONFIDENCE
            && !string_field(fact, "evidence").trim().is_empty());
    has_value && source_ok && ai_ok
}

fn ratio_status(left: f64, right: f64) -> &'static str {
    if left == 0.0 && right == 0.0 {
        "not_applicable"
    } else if (left == 0.0 && right >= 4.0) || (right == 0.0 && left >= 4.0) {
        "fail"
    } else if left == 0.0 || right == 0.0 {
        "pass"
    } else {
        let ratio = left / right;
        if ratio > 2.0 || ratio < 0.5 {
            "fail"
        } else {
            "pass"
        }
    }
}

fn unique(values: &[&str]) -> bool {
    values.iter().collect::<HashSet<_>>().len() == values.len()
}

fn pattern_count(counts: &Map<String, Value>, key: &str) -> f64 {
    counts.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

/// Checks that only planned sessions on or after `validation_from` that are
/// not already resolved take part in Profile-dependent rules.
struct ValidationScope<'a> {
    validation_from: &'a str,
    resolved_session_ids: &'a BTreeSet<String>,
}

/// A session is editable while it is still planned, not yet resolved, and not
/// scheduled before `validation_from`.
pub fn session_in_validation_scope(
    session: &Value,
    validation_from: &str,
    resolved_session_ids: &BTreeSet<String>,
) -> bool {
    session["scheduledDate"]
        .as_str()
        .is_some_and(|date| date >= validation_from)
        && session["status"]
            .as_str()
            .is_none_or(|status| status == "planned")
        && !session["id"]
            .as_str()
            .is_some_and(|id| resolved_session_ids.contains(id))
}

pub fn validate_plan(profile: &Value, draft: &Value, now: &str) -> PlanValidation {
    validate_plan_with_scope(profile, draft, now, None)
}

/// Validates only the adjustable part of a plan: historical or resolved
/// sessions are excluded from Profile-dependent and per-session rules, while
/// plan structure and domain coverage still describe the whole document.
pub fn validate_plan_from(
    profile: &Value,
    draft: &Value,
    now: &str,
    validation_from: &str,
    resolved_session_ids: &BTreeSet<String>,
) -> PlanValidation {
    validate_plan_with_scope(
        profile,
        draft,
        now,
        Some(&ValidationScope {
            validation_from,
            resolved_session_ids,
        }),
    )
}

fn validate_plan_with_scope(
    profile: &Value,
    draft: &Value,
    now: &str,
    scope: Option<&ValidationScope<'_>>,
) -> PlanValidation {
    let mut results: Vec<Value> = Vec::new();
    let mut data_gaps: Vec<Value> = Vec::new();
    let mut movement_facts_total = 0i64;
    let mut movement_facts_resolved = 0i64;
    let mut muscle_facts_total = 0i64;
    let mut muscle_facts_resolved = 0i64;
    let mut equipment_facts_total = 0i64;
    let mut equipment_facts_resolved = 0i64;

    let mesocycle = field(draft, "mesocycle");
    if !mesocycle.is_null() {
        let schedule = field(mesocycle, "schedule");
        let schedule_kind = string_field(schedule, "kind");
        let weekdays: Vec<i64> = if schedule_kind == "fixed_week" {
            array_field(schedule, "days")
                .iter()
                .filter_map(Value::as_i64)
                .collect()
        } else {
            Vec::new()
        };
        let effective_start = optional_string(draft, "effectiveStartDate").unwrap_or("2026-01-05");
        let duration_weeks = int_field(mesocycle, "durationWeeks");
        let schedule_occurrences = expand_schedule(effective_start, duration_weeks, schedule);
        let weeks = array_field(mesocycle, "weeks");
        let all_prescriptions: Vec<&Value> = weeks
            .iter()
            .flat_map(|week| array_field(week, "sessions").iter())
            .collect();
        let prescriptions: Vec<&Value> = all_prescriptions
            .iter()
            .copied()
            .filter(|session| match scope {
                Some(scope) => session_in_validation_scope(
                    session,
                    scope.validation_from,
                    scope.resolved_session_ids,
                ),
                None => true,
            })
            .collect();
        let historical_sessions: Vec<&Value> = match scope {
            Some(scope) => all_prescriptions
                .iter()
                .copied()
                .filter(|session| {
                    !session_in_validation_scope(
                        session,
                        scope.validation_from,
                        scope.resolved_session_ids,
                    )
                })
                .collect(),
            None => Vec::new(),
        };

        let mut scheduled_dates: Vec<String> = Vec::new();
        for session in &prescriptions {
            let scheduled = string_field(session, "scheduledDate").to_string();
            if !scheduled_dates.contains(&scheduled) {
                scheduled_dates.push(scheduled);
            }
        }
        scheduled_dates.sort();
        let rhythm = field(profile, "trainingRhythm");
        let rhythm_kind = string_field(rhythm, "kind");
        let rhythm_parameters_match = match rhythm_kind {
            "fixed_week" => {
                if schedule_kind != "fixed_week" {
                    false
                } else {
                    let mut profile_days: Vec<i64> = array_field(rhythm, "days")
                        .iter()
                        .filter_map(Value::as_i64)
                        .collect();
                    profile_days.sort_unstable();
                    let mut plan_days = weekdays.clone();
                    plan_days.sort_unstable();
                    profile_days == plan_days
                }
            }
            "flexible_week" => {
                schedule_kind == "flexible_week"
                    && int_field(schedule, "targetDaysPerWeek")
                        == int_field(rhythm, "targetDaysPerWeek")
                    && int_field(schedule, "minDaysPerWeek") == int_field(rhythm, "minDaysPerWeek")
                    && int_field(schedule, "maxDaysPerWeek") == int_field(rhythm, "maxDaysPerWeek")
            }
            _ => {
                schedule_kind == "interval"
                    && int_field(schedule, "intervalDays") == int_field(rhythm, "intervalDays")
            }
        };
        let weekly_rhythm_matches = match rhythm_kind {
            "fixed_week" => match scope {
                Some(_) if scheduled_dates.is_empty() => true,
                Some(_) => {
                    let profile_days: BTreeSet<i64> = array_field(rhythm, "days")
                        .iter()
                        .filter_map(Value::as_i64)
                        .collect();
                    let checked_days: BTreeSet<i64> = scheduled_dates
                        .iter()
                        .map(|date| date::monday_weekday(date) as i64)
                        .collect();
                    let historical_days: BTreeSet<i64> = historical_sessions
                        .iter()
                        .filter_map(|session| session["scheduledDate"].as_str())
                        .map(|date| date::monday_weekday(date) as i64)
                        .collect();
                    checked_days.is_subset(&profile_days)
                        && profile_days.iter().all(|day| {
                            checked_days.contains(day) || historical_days.contains(day)
                        })
                }
                None => {
                    let mut profile_days: Vec<i64> = array_field(rhythm, "days")
                        .iter()
                        .filter_map(Value::as_i64)
                        .collect();
                    profile_days.sort_unstable();
                    let mut actual_days: Vec<i64> = scheduled_dates
                        .iter()
                        .map(|date| date::monday_weekday(date) as i64)
                        .collect();
                    actual_days.sort_unstable();
                    actual_days.dedup();
                    actual_days == profile_days
                }
            },
            "flexible_week" => {
                let min_days = int_field(rhythm, "minDaysPerWeek");
                let max_days = int_field(rhythm, "maxDaysPerWeek");
                weeks.iter().all(|week| {
                    let sessions = array_field(week, "sessions");
                    let mut all_dates: Vec<&str> = sessions
                        .iter()
                        .map(|session| string_field(session, "scheduledDate"))
                        .collect();
                    all_dates.sort_unstable();
                    all_dates.dedup();
                    if let Some(scope) = scope {
                        let mut checked_dates: Vec<&str> = sessions
                            .iter()
                            .filter(|session| {
                                session_in_validation_scope(
                                    session,
                                    scope.validation_from,
                                    scope.resolved_session_ids,
                                )
                            })
                            .map(|session| string_field(session, "scheduledDate"))
                            .collect();
                        if checked_dates.is_empty() {
                            return true;
                        }
                        checked_dates.sort_unstable();
                        checked_dates.dedup();
                        let checked_days = checked_dates.len() as i64;
                        let total_days = all_dates.len() as i64;
                        checked_days <= max_days && total_days >= min_days
                    } else {
                        let training_days = all_dates.len() as i64;
                        training_days >= min_days && training_days <= max_days
                    }
                })
            }
            "interval" => {
                let interval_days = int_field(rhythm, "intervalDays");
                if scope.is_some() {
                    scheduled_dates
                        .windows(2)
                        .all(|pair| date::day_difference(&pair[0], &pair[1]) == interval_days)
                } else {
                    scheduled_dates.first().map(String::as_str) == Some(effective_start)
                        && scheduled_dates
                            .windows(2)
                            .all(|pair| date::day_difference(&pair[0], &pair[1]) == interval_days)
                }
            }
            _ => false,
        };

        let exercise_ids: Vec<&str> = prescriptions.iter()
            .filter(|session| crate::training_type::session_domain(session) == Some("strength"))
            .flat_map(|session| array_field(field(session, "prescription"), "blocks"))
            .map(|exercise| string_field(exercise, "id")).collect();
        let exercise_ids_unique = prescriptions.iter().all(|session| {
            if crate::training_type::session_domain(session) != Some("strength") { return true; }
            let ids: Vec<&str> = array_field(field(session, "prescription"), "blocks").iter()
                .map(|exercise| string_field(exercise, "id")).collect();
            unique(&ids)
        });
        results.push(rule(
            "blocker",
            "EXERCISE_IDS",
            if exercise_ids_unique { "pass" } else { "fail" },
            &[],
            json!({ "exerciseIds": exercise_ids }),
            &[],
            Value::Null,
            "structure",
        ));
        results.push(rule(
            "blocker",
            "MESOCYCLE_SCHEDULE",
            "pass",
            &[],
            json!({ "kind": schedule_kind, "weekdays": weekdays, "occurrenceCount": schedule_occurrences.len() }),
            &[],
            Value::Null,
            "structure",
        ));
        let (rhythm_enforcement, rhythm_status) = if !weekly_rhythm_matches
            || (rhythm_kind != "flexible_week" && !rhythm_parameters_match)
        {
            ("blocker", "fail")
        } else if !rhythm_parameters_match {
            ("advisory", "fail")
        } else {
            ("blocker", "pass")
        };
        results.push(rule(
            rhythm_enforcement,
            "PROFILE_TRAINING_RHYTHM",
            rhythm_status,
            &[],
            json!({ "profileRhythm": rhythm, "planSchedule": schedule, "scheduledDates": scheduled_dates }),
            &[],
            Value::Null,
            "structure",
        ));

        let progression_domains: Vec<&str> = array_field(mesocycle, "domainProgressions")
            .iter()
            .map(|progression| string_field(progression, "domain"))
            .collect();
        let mut session_domains: Vec<String> = Vec::new();
        for session in &all_prescriptions {
            if let Some(domain) = crate::training_type::session_domain(session) {
                if !session_domains.iter().any(|existing| existing == domain) { session_domains.push(domain.to_string()); }
            }
        }
        let domains_match = progression_domains.len()
            == progression_domains.iter().collect::<HashSet<_>>().len()
            && session_domains.len() == progression_domains.len()
            && progression_domains
                .iter()
                .all(|domain| session_domains.iter().any(|candidate| candidate == domain));
        let progressions_cover_duration =
            array_field(mesocycle, "domainProgressions")
                .iter()
                .all(|progression| {
                    let mut phases: Vec<&Value> =
                        array_field(progression, "phases").iter().collect();
                    phases.sort_by_key(|phase| int_field(phase, "startWeek"));
                    let phase_ids: Vec<&str> = phases
                        .iter()
                        .map(|phase| string_field(phase, "id"))
                        .collect();
                    if !unique(&phase_ids) {
                        return false;
                    }
                    let (Some(first), Some(last)) = (phases.first(), phases.last()) else {
                        return false;
                    };
                    if int_field(first, "startWeek") != 1
                        || int_field(last, "endWeek") != duration_weeks
                    {
                        return false;
                    }
                    phases.iter().enumerate().all(|(index, phase)| {
                        int_field(phase, "startWeek") <= int_field(phase, "endWeek")
                            && int_field(phase, "endWeek") <= duration_weeks
                            && (index == 0
                                || int_field(phase, "startWeek")
                                    == int_field(phases[index - 1], "endWeek") + 1)
                    })
                });
        results.push(rule(
            "blocker",
            "DOMAIN_PROGRESSION",
            if domains_match && progressions_cover_duration { "pass" } else { "fail" },
            &[],
            json!({ "durationWeeks": duration_weeks, "sessionDomains": session_domains, "progressions": field(mesocycle, "domainProgressions") }),
            &[],
            Value::Null,
            "structure",
        ));

        let mut direct_by_muscle: Map<String, Value> = Map::new();
        let mut indirect_by_muscle: Map<String, Value> = Map::new();
        let mut sets_by_pattern: Map<String, Value> = Map::new();
        for session in &prescriptions {
            let occurrences = 1.0 / duration_weeks as f64;
            let multiplier = 1.0f64.max(occurrences);
            let session_id = string_field(session, "id");
            if crate::training_type::session_domain(session).is_none() {
                results.push(rule("info", "SESSION_DOMAIN_MISSING", "unknown", &[session_id], json!({}), &["domain"], Value::Null, "structure"));
                data_gaps.push(json!({"code":"SESSION_DOMAIN_MISSING","subjectRef":session_id,"factPath":"domain","requiredByRuleCodes":[],"blocking":false,"resolution":"agent_infer"}));
            }
            if crate::training_type::session_domain(session) == Some("strength") {
                let has_strength = session["prescription"]["blocks"].as_array().is_some_and(|blocks| !blocks.is_empty() && blocks.iter().all(|block| block.get("sets").is_some() && block.get("classification").is_some()));
                results.push(rule("blocker", "SESSION_STRENGTH_PRESCRIPTION", if has_strength { "pass" } else { "fail" }, &[session_id], json!({"hasStrengthPrescription":has_strength}), &[], Value::Null, "structure"));
            }
            {
                let prescription = field(session, "prescription");
                if prescription.is_null() { continue; }
                if crate::training_type::session_domain(session) != Some("strength") {
                    continue;
                }
                for exercise in array_field(prescription, "blocks") {
                    let exercise_id = string_field(exercise, "id");
                    let classification = field(exercise, "classification");
                    let movement = field(classification, "primaryMovement");
                    let muscles = field(classification, "primaryMuscles");
                    let equipment = field(classification, "equipment");
                    movement_facts_total += 1;
                    muscle_facts_total += 1;
                    equipment_facts_total += 1;
                    let equipment_conflict = false;
                    let movement_trusted = fact_trusted(movement);
                    let muscle_values = array_field(muscles, "value");
                    let muscle_resolved = !muscle_values.is_empty() && fact_trusted(muscles);
                    let equipment_values = array_field(equipment, "value");
                    let equipment_trusted = !equipment_values.is_empty()
                        && fact_trusted(equipment)
                        && !equipment_conflict;
                    if movement_trusted {
                        movement_facts_resolved += 1;
                    }
                    if muscle_resolved {
                        muscle_facts_resolved += 1;
                    }
                    if equipment_trusted {
                        equipment_facts_resolved += 1;
                    }
                    let exercise_sets = int_field(exercise, "sets") as f64 * multiplier;
                    if let Some(pattern) = field(movement, "value")
                        .as_str()
                        .filter(|pattern| !pattern.is_empty())
                    {
                        bump(&mut sets_by_pattern, pattern, exercise_sets);
                    }
                    for muscle in muscle_values {
                        if let Some(name) = muscle.as_str() {
                            bump(&mut direct_by_muscle, name, exercise_sets);
                        }
                    }
                    for muscle in array_field(field(classification, "secondaryMuscles"), "value") {
                        if let Some(name) = muscle.as_str() {
                            bump(&mut indirect_by_muscle, name, exercise_sets);
                        }
                    }
                    let equipment_status = if equipment_trusted {
                        let available: Vec<&str> = array_field(profile, "equipment")
                            .iter()
                            .filter_map(Value::as_str)
                            .collect();
                        if equipment_values
                            .iter()
                            .filter_map(Value::as_str)
                            .any(|item| available.contains(&item))
                        {
                            "pass"
                        } else {
                            "fail"
                        }
                    } else {
                        "unknown"
                    };
                    results.push(rule(
                        "blocker",
                        "EXERCISE_EQUIPMENT",
                        equipment_status,
                        &[session_id, exercise_id],
                        json!({
                            "required": equipment_values,
                            "available": field(profile, "equipment"),
                            "source": string_field(equipment, "source"),
                            "conflict": equipment_conflict,
                        }),
                        if equipment_status == "unknown" { &["classification.equipment"] } else { &[] },
                        json!({ "required": number(AI_HARD_CONFIDENCE), "observed": number(number_field(equipment, "confidence")) }),
                        "constraints",
                    ));
                    if equipment_status == "unknown" {
                        data_gaps.push(json!({
                            "code": "EXERCISE_EQUIPMENT_UNKNOWN",
                            "subjectRef": exercise_id,
                            "factPath": "classification.equipment",
                            "requiredByRuleCodes": ["EXERCISE_EQUIPMENT"],
                            "blocking": true,
                            "resolution": if string_field(equipment, "source") == "ai_inferred" { "user_confirm" } else { "agent_infer" },
                        }));
                    }
                }
            }
        }

        results.push(rule(
            "info",
            "STRENGTH_VOLUME_DISTRIBUTION",
            "pass",
            &[],
            json!({
                "directSetsByMuscle": &direct_by_muscle,
                "indirectParticipationsByMuscle": &indirect_by_muscle,
                "setsByPattern": &sets_by_pattern,
            }),
            &[],
            Value::Null,
            "strength",
        ));
        let push_sets = pattern_count(&sets_by_pattern, "horizontal_push")
            + pattern_count(&sets_by_pattern, "vertical_push");
        let pull_sets = pattern_count(&sets_by_pattern, "horizontal_pull")
            + pattern_count(&sets_by_pattern, "vertical_pull");
        results.push(rule(
            "advisory",
            "STRENGTH_PUSH_PULL_BALANCE",
            ratio_status(push_sets, pull_sets),
            &[],
            json!({ "pushSets": number(push_sets), "pullSets": number(pull_sets), "boundary": 2 }),
            &[],
            Value::Null,
            "strength",
        ));
        let knee_sets =
            pattern_count(&sets_by_pattern, "squat") + pattern_count(&sets_by_pattern, "lunge");
        let hinge_sets = pattern_count(&sets_by_pattern, "hinge");
        results.push(rule(
            "advisory",
            "STRENGTH_KNEE_HINGE_BALANCE",
            ratio_status(knee_sets, hinge_sets),
            &[],
            json!({ "kneeDominantSets": number(knee_sets), "hingeSets": number(hinge_sets), "boundary": 2 }),
            &[],
            Value::Null,
            "strength",
        ));

        let mut strength_exercises: Vec<&Value> = Vec::new();
        let mut endurance_steps: Vec<&Value> = Vec::new();
        for session in &prescriptions {
            {
                let prescription = field(session, "prescription");
                if prescription.is_null() { continue; }
                match crate::training_type::session_domain(session).unwrap_or("") {
                    "strength" => strength_exercises.extend(array_field(prescription, "blocks")),
                    "endurance" => {
                        for segment in array_field(prescription, "blocks") {
                            if string_field(segment, "type") == "repeat" {
                                endurance_steps.push(field(segment, "work"));
                                let recovery = field(segment, "recovery");
                                if !recovery.is_null() {
                                    endurance_steps.push(recovery);
                                }
                            } else {
                                endurance_steps.push(segment);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        let effort_missing: Vec<&str> = strength_exercises
            .iter()
            .filter(|exercise| is_null_or_missing(exercise, "targetRpe"))
            .map(|exercise| string_field(exercise, "id"))
            .collect();
        results.push(rule(
            "advisory",
            "STRENGTH_EFFORT_RPE",
            if strength_exercises.is_empty() {
                "not_applicable"
            } else if effort_missing.is_empty() {
                "pass"
            } else {
                "fail"
            },
            &[],
            json!({ "exerciseCount": strength_exercises.len(), "missingEffort": effort_missing }),
            &[],
            Value::Null,
            "strength",
        ));
        let zone_missing: Vec<&str> = endurance_steps
            .iter()
            .filter(|step| {
                let zone = field(step, "heartRateZone");
                zone.is_null() || zone.as_str().is_some_and(|label| label.is_empty())
            })
            .map(|step| string_field(step, "name"))
            .collect();
        results.push(rule(
            "advisory",
            "ENDURANCE_EFFORT_ZONE",
            if endurance_steps.is_empty() {
                "not_applicable"
            } else if zone_missing.is_empty() {
                "pass"
            } else {
                "fail"
            },
            &[],
            json!({ "stepCount": endurance_steps.len(), "missingZone": zone_missing }),
            &[],
            Value::Null,
            "structure",
        ));

        let mut high_dates: Vec<String> = Vec::new();
        for session in &prescriptions {
            if string_field(session, "recoveryDemand") == "high" {
                let scheduled = string_field(session, "scheduledDate").to_string();
                if !high_dates.contains(&scheduled) {
                    high_dates.push(scheduled);
                }
            }
        }
        high_dates.sort();
        if high_dates.len() > 1 {
            let mut closest_days = i64::MAX;
            for index in 1..high_dates.len() {
                closest_days = closest_days.min(date::day_difference(
                    &high_dates[index - 1],
                    &high_dates[index],
                ));
            }
            let explicit_recovery_days = field(profile, "explicitRecoveryDays");
            if explicit_recovery_days.is_null() {
                results.push(rule(
                    "advisory",
                    "ADJACENT_HIGH_DEMAND_SESSIONS",
                    if closest_days > 1 { "pass" } else { "fail" },
                    &[],
                    json!({ "closestDays": closest_days }),
                    &[],
                    Value::Null,
                    "balance",
                ));
            } else {
                let required_days = explicit_recovery_days
                    .as_i64()
                    .unwrap_or_else(|| panic!("expected `explicitRecoveryDays` to be an integer"));
                results.push(rule(
                    "advisory",
                    "EXPLICIT_RECOVERY_INTERVAL",
                    if closest_days >= required_days {
                        "pass"
                    } else {
                        "fail"
                    },
                    &[],
                    json!({ "closestDays": closest_days, "requiredDays": required_days }),
                    &[],
                    Value::Null,
                    "constraints",
                ));
            }
        }
    }

    let blockers: Vec<&Value> = results
        .iter()
        .filter(|item| field(item, "enforcement").as_str() == Some("blocker"))
        .collect();
    let hard_checks_resolved = blockers
        .iter()
        .filter(|item| matches!(field(item, "status").as_str(), Some("pass" | "fail")))
        .count();
    let valid = !blockers
        .iter()
        .any(|item| matches!(field(item, "status").as_str(), Some("fail" | "unknown")));
    let coverage = Coverage {
        hard_checks_resolved,
        hard_checks_total: blockers.len(),
        movement_facts_resolved,
        movement_facts_total,
        muscle_facts_resolved,
        muscle_facts_total,
        equipment_facts_resolved,
        equipment_facts_total,
    };
    let input_hash = match scope {
        Some(scope) => stable_hash(&json!({
            "mesocycle": mesocycle,
            "profile": profile,
            "taxonomyVersion": TAXONOMY_VERSION,
            "rulePacks": {
                "structure": RULE_VERSION,
                "constraints": RULE_VERSION,
                "strength": RULE_VERSION,
                "balance": RULE_VERSION,
            },
            "validationFrom": scope.validation_from,
            "resolvedSessionIds": scope.resolved_session_ids,
        })),
        None => stable_hash(&json!({
            "mesocycle": mesocycle,
            "profile": profile,
            "taxonomyVersion": TAXONOMY_VERSION,
            "rulePacks": {
                "structure": RULE_VERSION,
                "constraints": RULE_VERSION,
                "strength": RULE_VERSION,
                "balance": RULE_VERSION,
            },
        })),
    };
    PlanValidation {
        valid,
        results,
        data_gaps,
        validated_at: now.to_string(),
        input_hash,
        coverage,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn high_session(id: &str, scheduled_date: &str) -> Value {
        json!({
            "id": id,
            "scheduledDate": scheduled_date,
            "order": 0,
            "recoveryDemand": "high",
            "durationMinutes": 45,
            "domain": "mobility",
            "prescription": {"blocks":[]},
        })
    }

    fn two_high_session_plan() -> Value {
        json!({
            "durationWeeks": 1,
            "schedule": { "kind": "fixed_week", "days": [0, 2] },
            "domainProgressions": [{
                "domain": "mobility",
                "phases": [{
                    "id": "recovery-base", "phaseType": "foundation", "name": "Base",
                    "startWeek": 1, "endWeek": 1, "focus": "Base", "progression": [],
                }],
            }],
            "weeks": [{
                "weekNumber": 1,
                "focus": null,
                "sessions": [high_session("mon-1", "2026-09-07"), high_session("wed-1", "2026-09-09")],
            }],
        })
    }

    fn profile(explicit_recovery_days: Value) -> Value {
        json!({
            "trainingRhythm": { "kind": "fixed_week", "days": [0, 2] },
            "usualSessionMinutes": 60,
            "equipment": ["barbell"],
            "explicitRecoveryDays": explicit_recovery_days,
        })
    }

    #[test]
    fn explicit_recovery_days_advise_on_a_tight_schedule() {
        let draft =
            json!({ "mesocycle": two_high_session_plan(), "effectiveStartDate": "2026-09-07" });
        let validation = validate_plan(&profile(json!(3)), &draft, "2026-09-17T00:00:00.000Z");
        assert!(validation.valid);
        let recovery = validation
            .results
            .iter()
            .find(|item| item["reasonCode"] == "EXPLICIT_RECOVERY_INTERVAL")
            .expect("rule must run");
        assert_eq!(recovery["status"], "fail");
        assert_eq!(recovery["enforcement"], "advisory");
        assert_eq!(
            recovery["evidence"],
            json!({ "closestDays": 2, "requiredDays": 3 })
        );
    }

    #[test]
    fn adjacent_high_demand_sessions_stay_advisory_without_explicit_recovery() {
        let draft =
            json!({ "mesocycle": two_high_session_plan(), "effectiveStartDate": "2026-09-07" });
        let validation = validate_plan(&profile(Value::Null), &draft, "2026-09-17T00:00:00.000Z");
        assert!(validation.valid);
        let advisory = validation
            .results
            .iter()
            .find(|item| item["reasonCode"] == "ADJACENT_HIGH_DEMAND_SESSIONS")
            .expect("rule must run");
        assert_eq!(advisory["status"], "pass");
        assert_eq!(advisory["enforcement"], "advisory");
    }

    #[test]
    fn session_duration_is_not_a_profile_constraint() {
        for duration in [30, 60, 120] {
            let mut draft = json!({ "mesocycle": two_high_session_plan(), "effectiveStartDate": "2026-09-07" });
            draft["mesocycle"]["weeks"][0]["sessions"][0]["durationMinutes"] = json!(duration);
            let validation = validate_plan(&profile(Value::Null), &draft, "2026-09-17T00:00:00.000Z");
            assert!(validation.valid);
            assert!(!validation.results.iter().any(|item| item["reasonCode"] == "MAX_SESSION_DURATION"));
        }
    }

    #[test]
    fn compatible_flexible_rhythm_metadata_drift_is_advisory() {
        let draft =
            json!({ "mesocycle": two_high_session_plan(), "effectiveStartDate": "2026-09-07" });
        let mut flexible_profile = profile(Value::Null);
        flexible_profile["trainingRhythm"] = json!({
            "kind": "flexible_week",
            "targetDaysPerWeek": 1,
            "minDaysPerWeek": 1,
            "maxDaysPerWeek": 2,
        });

        let validation = validate_plan(
            &flexible_profile,
            &draft,
            "2026-09-17T00:00:00.000Z",
        );

        assert!(validation.valid);
        let rhythm = validation
            .results
            .iter()
            .find(|item| item["reasonCode"] == "PROFILE_TRAINING_RHYTHM")
            .expect("rule must run");
        assert_eq!(rhythm["status"], "fail");
        assert_eq!(rhythm["enforcement"], "advisory");
    }

    #[test]
    fn a_missing_mesocycle_yields_a_valid_empty_validation() {
        let validation = validate_plan(
            &profile(Value::Null),
            &json!({ "mesocycle": null }),
            "2026-09-17T00:00:00.000Z",
        );
        assert!(validation.valid);
        assert!(validation.results.is_empty());
        assert!(validation.data_gaps.is_empty());
        assert_eq!(validation.coverage.hard_checks_total, 0);
        assert!(validation.input_hash.starts_with("fnv1a-"));
    }
    #[test]
    fn prescriptions_support_mobility_mind_body_and_functional_content() {
        for (domain, kind) in [("mobility","mobility"),("mind_body","mind_body"),("functional","functional")] {
            let mut mesocycle = two_high_session_plan();
            for session in mesocycle["weeks"][0]["sessions"].as_array_mut().unwrap() {
                session["domain"] = json!(domain);
                session["prescription"] = match kind {
                    "strength" => json!({"blocks":[]}),
                    "endurance" => json!({"blocks":[]}),
                    _ => json!({"blocks":[]}),
                };
            }
            mesocycle["domainProgressions"][0]["domain"] = json!(domain);
            let draft = json!({"mesocycle":mesocycle,"effectiveStartDate":"2026-09-07"});
            let validation = validate_plan(&profile(Value::Null), &draft, "2026-09-17T00:00:00Z");
            assert!(!validation.results.iter().any(|rule| rule["reasonCode"] == "COMPONENT_DOMAIN_MISSING"));
            assert!(validation.data_gaps.is_empty(), "{domain}/{kind}");
            assert!(validation.valid, "{domain}/{kind}");
        }
    }

    fn scoped_session(id: &str, scheduled_date: &str) -> Value {
        json!({
            "id": id,
            "scheduledDate": scheduled_date,
            "order": 0,
            "status": "planned",
            "domain": "mobility",
            "recoveryDemand": "normal",
            "durationMinutes": 30,
            "prescription": {"blocks": []},
        })
    }

    fn scoped_rhythm_draft() -> Value {
        json!({
            "effectiveStartDate": "2026-09-14",
            "mesocycle": {
                "durationWeeks": 2,
                "schedule": { "kind": "fixed_week", "days": [1] },
                "domainProgressions": [{
                    "domain": "mobility",
                    "phases": [{
                        "id": "base", "phaseType": "foundation", "name": "Base",
                        "startWeek": 1, "endWeek": 2, "focus": "Base", "progression": [],
                    }],
                }],
                "weeks": [
                    {"weekNumber": 1, "focus": null, "sessions": [scoped_session("s1", "2026-09-14")]},
                    {"weekNumber": 2, "focus": null, "sessions": [scoped_session("s2", "2026-09-22")]},
                ],
            },
        })
    }

    fn scoped_rhythm_profile() -> Value {
        json!({
            "trainingRhythm": { "kind": "fixed_week", "days": [1] },
            "usualSessionMinutes": 60,
            "equipment": ["barbell"],
        })
    }

    #[test]
    fn scoped_validation_skips_historical_equipment_conflicts() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/validate_plan.constraint_failures.json"
        ))
        .expect("fixture is JSON");
        let profile = &fixture["input"]["profile"];
        let draft = &fixture["input"]["draft"];
        let now = fixture["input"]["now"].as_str().unwrap();

        let full = validate_plan(profile, draft, now);
        assert!(!full.valid);
        assert!(full.results.iter().any(|rule| {
            rule["reasonCode"] == "EXERCISE_EQUIPMENT"
                && matches!(rule["status"].as_str(), Some("fail" | "unknown"))
        }));

        let scoped = validate_plan_from(profile, draft, now, "2026-09-17", &BTreeSet::new());
        assert!(scoped.valid);
        assert!(!scoped
            .results
            .iter()
            .any(|rule| rule["reasonCode"] == "EXERCISE_EQUIPMENT"));
        assert_ne!(scoped.input_hash, full.input_hash);
    }

    #[test]
    fn scoped_validation_skips_resolved_sessions_dated_today() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/validate_plan.constraint_failures.json"
        ))
        .expect("fixture is JSON");
        let profile = &fixture["input"]["profile"];
        let now = fixture["input"]["now"].as_str().unwrap();
        let mut draft = fixture["input"]["draft"].clone();
        draft["mesocycle"]["weeks"][0]["sessions"][0]["scheduledDate"] = json!("2026-09-17");

        let resolved = BTreeSet::from(["mon-strength".to_owned()]);
        let scoped = validate_plan_from(profile, &draft, now, "2026-09-17", &resolved);
        assert!(scoped.valid);
        assert!(!scoped
            .results
            .iter()
            .any(|rule| rule["reasonCode"] == "EXERCISE_EQUIPMENT"));

        let unchecked = validate_plan_from(profile, &draft, now, "2026-09-17", &BTreeSet::new());
        assert!(!unchecked.valid);
    }

    #[test]
    fn scoped_validation_ignores_historical_weekdays_after_a_rhythm_change() {
        let draft = scoped_rhythm_draft();
        let profile = scoped_rhythm_profile();
        let now = "2026-09-17T10:30:00.000Z";

        let full = validate_plan(&profile, &draft, now);
        assert!(!full.valid);
        let full_rhythm = full
            .results
            .iter()
            .find(|rule| rule["reasonCode"] == "PROFILE_TRAINING_RHYTHM")
            .expect("rhythm rule runs");
        assert_eq!(full_rhythm["status"], "fail");
        assert_eq!(full_rhythm["enforcement"], "blocker");

        let scoped = validate_plan_from(&profile, &draft, now, "2026-09-17", &BTreeSet::new());
        assert!(scoped.valid);
        let scoped_rhythm = scoped
            .results
            .iter()
            .find(|rule| rule["reasonCode"] == "PROFILE_TRAINING_RHYTHM")
            .expect("rhythm rule runs");
        assert_eq!(scoped_rhythm["status"], "pass");
        assert_eq!(scoped_rhythm["evidence"]["scheduledDates"], json!(["2026-09-22"]));
    }

    #[test]
    fn scoped_validation_lets_history_cover_fixed_week_days() {
        let draft = json!({
            "effectiveStartDate": "2026-09-14",
            "mesocycle": {
                "durationWeeks": 1,
                "schedule": { "kind": "fixed_week", "days": [0, 2, 4] },
                "domainProgressions": [{
                    "domain": "mobility",
                    "phases": [{
                        "id": "base", "phaseType": "foundation", "name": "Base",
                        "startWeek": 1, "endWeek": 1, "focus": "Base", "progression": [],
                    }],
                }],
                "weeks": [{
                    "weekNumber": 1,
                    "focus": null,
                    "sessions": [
                        scoped_session("s1", "2026-09-14"),
                        scoped_session("s2", "2026-09-16"),
                        scoped_session("s3", "2026-09-18"),
                    ],
                }],
            },
        });
        let profile = json!({
            "trainingRhythm": { "kind": "fixed_week", "days": [0, 2, 4] },
            "usualSessionMinutes": 60,
            "equipment": ["barbell"],
        });
        let now = "2026-09-17T10:30:00.000Z";

        assert!(validate_plan(&profile, &draft, now).valid);
        let scoped = validate_plan_from(&profile, &draft, now, "2026-09-17", &BTreeSet::new());
        assert!(scoped.valid, "{:?}", scoped.results);
    }

    #[test]
    fn scoped_validation_counts_history_toward_flexible_week_minimums() {
        let rhythm = json!({
            "kind": "flexible_week",
            "targetDaysPerWeek": 3,
            "minDaysPerWeek": 3,
            "maxDaysPerWeek": 4,
        });
        let draft = json!({
            "effectiveStartDate": "2026-09-14",
            "mesocycle": {
                "durationWeeks": 1,
                "schedule": rhythm,
                "domainProgressions": [{
                    "domain": "mobility",
                    "phases": [{
                        "id": "base", "phaseType": "foundation", "name": "Base",
                        "startWeek": 1, "endWeek": 1, "focus": "Base", "progression": [],
                    }],
                }],
                "weeks": [{
                    "weekNumber": 1,
                    "focus": null,
                    "sessions": [
                        scoped_session("s1", "2026-09-14"),
                        scoped_session("s2", "2026-09-16"),
                        scoped_session("s3", "2026-09-18"),
                    ],
                }],
            },
        });
        let profile = json!({
            "trainingRhythm": rhythm,
            "usualSessionMinutes": 60,
            "equipment": ["barbell"],
        });
        let now = "2026-09-17T10:30:00.000Z";

        assert!(validate_plan(&profile, &draft, now).valid);
        let scoped = validate_plan_from(&profile, &draft, now, "2026-09-17", &BTreeSet::new());
        assert!(scoped.valid, "{:?}", scoped.results);
    }
}
