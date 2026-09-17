//! Plan validation rule engine, ported from `packages/core` `validatePlan`.
//!
//! Rule order, reason codes, enforcement/status semantics, evidence shapes,
//! coverage counters, data gaps and the input hash must stay identical to the
//! TypeScript implementation; the golden fixtures under `tests/fixtures`
//! compare complete outputs. Like the rest of the core, the engine reads
//! schema-validated JSON directly (see [`crate::json`]).

use std::collections::HashSet;

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

pub fn validate_plan(profile: &Value, draft: &Value, now: &str) -> PlanValidation {
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
        let prescriptions: Vec<&Value> = weeks
            .iter()
            .flat_map(|week| array_field(week, "sessions").iter())
            .collect();

        let mut scheduled_dates: Vec<String> = Vec::new();
        for session in &prescriptions {
            let scheduled = string_field(session, "scheduledDate").to_string();
            if !scheduled_dates.contains(&scheduled) {
                scheduled_dates.push(scheduled);
            }
        }
        scheduled_dates.sort();
        let mut expected_dates: Vec<String> = schedule_occurrences
            .iter()
            .map(|occurrence| occurrence.scheduled_date.clone())
            .collect();
        expected_dates.sort();
        let same_dates = scheduled_dates == expected_dates;

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
            "flexible_week" => {
                let min_days = int_field(rhythm, "minDaysPerWeek");
                let max_days = int_field(rhythm, "maxDaysPerWeek");
                weeks.iter().all(|week| {
                    let mut distinct: Vec<&str> = array_field(week, "sessions")
                        .iter()
                        .map(|session| string_field(session, "scheduledDate"))
                        .collect();
                    distinct.sort_unstable();
                    distinct.dedup();
                    let training_days = distinct.len() as i64;
                    training_days >= min_days && training_days <= max_days
                })
            }
            "interval" => {
                let interval_days = int_field(rhythm, "intervalDays");
                scheduled_dates.first().map(String::as_str) == Some(effective_start)
                    && scheduled_dates
                        .windows(2)
                        .all(|pair| date::day_difference(&pair[0], &pair[1]) == interval_days)
            }
            _ => same_dates,
        };

        let mut component_ids: Vec<String> = Vec::new();
        let mut exercise_ids: Vec<String> = Vec::new();
        for session in &prescriptions {
            for component in array_field(session, "components") {
                component_ids.push(string_field(component, "id").to_string());
                let prescription = field(component, "prescription");
                if string_field(prescription, "kind") == "strength" {
                    for exercise in array_field(prescription, "exercises") {
                        exercise_ids.push(string_field(exercise, "id").to_string());
                    }
                }
            }
        }
        let component_ids_unique = prescriptions.iter().all(|session| {
            let ids: Vec<&str> = array_field(session, "components")
                .iter()
                .map(|component| string_field(component, "id"))
                .collect();
            unique(&ids)
        });
        let exercise_ids_unique = prescriptions.iter().all(|session| {
            let ids: Vec<&str> = array_field(session, "components")
                .iter()
                .flat_map(|component| {
                    let prescription = field(component, "prescription");
                    if string_field(prescription, "kind") == "strength" {
                        array_field(prescription, "exercises")
                            .iter()
                            .map(|exercise| string_field(exercise, "id"))
                            .collect::<Vec<_>>()
                    } else {
                        Vec::new()
                    }
                })
                .collect();
            unique(&ids)
        });
        results.push(rule(
            "blocker",
            "COMPONENT_IDS",
            if component_ids_unique { "pass" } else { "fail" },
            &[],
            json!({ "componentIds": component_ids }),
            &[],
            Value::Null,
            "structure",
        ));
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
        results.push(rule(
            "blocker",
            "PROFILE_TRAINING_RHYTHM",
            if rhythm_parameters_match && weekly_rhythm_matches { "pass" } else { "fail" },
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
        for session in &prescriptions {
            for component in array_field(session, "components") {
                if let Some(domain) = field(field(component, "domain"), "value").as_str() {
                    if !session_domains.iter().any(|existing| existing == domain) {
                        session_domains.push(domain.to_string());
                    }
                }
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
            let session_duration = int_field(session, "durationMinutes");
            let maximum_duration = int_field(profile, "maxSessionMinutes");
            results.push(rule(
                "blocker",
                "MAX_SESSION_DURATION",
                if session_duration <= maximum_duration {
                    "pass"
                } else {
                    "fail"
                },
                &[session_id],
                json!({ "durationMinutes": session_duration, "maximum": maximum_duration }),
                &[],
                Value::Null,
                "structure",
            ));
            for component in array_field(session, "components") {
                let component_id = string_field(component, "id");
                let domain_value = field(field(component, "domain"), "value");
                let prescription = field(component, "prescription");
                let prescription_kind = string_field(prescription, "kind");
                let prescription_consistent = if prescription_kind == "duration_only" {
                    domain_value.as_str() != Some("strength")
                } else {
                    domain_value.as_str() == Some(prescription_kind)
                };
                results.push(rule(
                    "blocker",
                    "COMPONENT_PRESCRIPTION",
                    if prescription_consistent {
                        "pass"
                    } else {
                        "fail"
                    },
                    &[session_id, component_id],
                    json!({ "domain": domain_value, "prescription": prescription_kind }),
                    &[],
                    Value::Null,
                    "structure",
                ));
                if domain_value.is_null() {
                    results.push(rule(
                        "info",
                        "COMPONENT_DOMAIN_MISSING",
                        "unknown",
                        &[component_id],
                        json!({}),
                        &["domain"],
                        Value::Null,
                        "structure",
                    ));
                    data_gaps.push(json!({
                        "code": "COMPONENT_DOMAIN_MISSING",
                        "subjectRef": component_id,
                        "factPath": "domain",
                        "requiredByRuleCodes": [],
                        "blocking": false,
                        "resolution": "agent_infer",
                    }));
                }
                if prescription_kind != "strength" || domain_value.as_str() != Some("strength") {
                    continue;
                }
                for exercise in array_field(prescription, "exercises") {
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
                        &[session_id, component_id, exercise_id],
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
            for component in array_field(session, "components") {
                let prescription = field(component, "prescription");
                match string_field(prescription, "kind") {
                    "strength" => strength_exercises.extend(array_field(prescription, "exercises")),
                    "endurance" => {
                        for segment in array_field(prescription, "segments") {
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
            .filter(|exercise| {
                is_null_or_missing(exercise, "targetRpe")
                    && is_null_or_missing(exercise, "targetRir")
            })
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
                    "blocker",
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
    let input_hash = stable_hash(&json!({
        "mesocycle": mesocycle,
        "profile": profile,
        "taxonomyVersion": TAXONOMY_VERSION,
        "rulePacks": {
            "structure": RULE_VERSION,
            "constraints": RULE_VERSION,
            "strength": RULE_VERSION,
            "balance": RULE_VERSION,
        },
    }));
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

    fn fact(value: Value) -> Value {
        json!({ "value": value, "source": "user_confirmed", "confidence": 1, "evidence": "fixture", "taxonomyVersion": TAXONOMY_VERSION })
    }

    fn high_session(id: &str, scheduled_date: &str) -> Value {
        json!({
            "id": id,
            "scheduledDate": scheduled_date,
            "order": 0,
            "recoveryDemand": "high",
            "durationMinutes": 45,
            "components": [{
                "id": format!("{id}-recovery"),
                "name": "Recovery",
                "domain": fact(json!("recovery")),
                "prescription": { "kind": "duration_only", "notes": "" },
            }],
        })
    }

    fn two_high_session_plan() -> Value {
        json!({
            "durationWeeks": 1,
            "schedule": { "kind": "fixed_week", "days": [0, 2] },
            "domainProgressions": [{
                "domain": "recovery",
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
            "adjustmentRules": [],
        })
    }

    fn profile(explicit_recovery_days: Value) -> Value {
        json!({
            "trainingRhythm": { "kind": "fixed_week", "days": [0, 2] },
            "maxSessionMinutes": 60,
            "equipment": ["barbell"],
            "explicitRecoveryDays": explicit_recovery_days,
        })
    }

    #[test]
    fn explicit_recovery_days_block_a_tight_schedule() {
        let draft =
            json!({ "mesocycle": two_high_session_plan(), "effectiveStartDate": "2026-09-07" });
        let validation = validate_plan(&profile(json!(3)), &draft, "2026-09-17T00:00:00.000Z");
        assert!(!validation.valid);
        let recovery = validation
            .results
            .iter()
            .find(|item| item["reasonCode"] == "EXPLICIT_RECOVERY_INTERVAL")
            .expect("rule must run");
        assert_eq!(recovery["status"], "fail");
        assert_eq!(recovery["enforcement"], "blocker");
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
}
