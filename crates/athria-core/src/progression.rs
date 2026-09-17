//! Progression and autoregulation calculators, ported from `packages/core`
//! (`evaluateDoubleProgression`, `evaluateRpeAutoregulation`).
//!
//! Both return reason codes rather than sentences so callers (UI, MCP) can
//! translate them; the exact codes and the `confidenceLimit` semantics must
//! stay identical to TypeScript.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::FORMULA_VERSION;
use crate::error::{AthriaError, AthriaErrorCode, Result};
use crate::json::number;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoubleProgressionInput {
    pub completed_reps: Vec<f64>,
    pub rep_min: f64,
    pub rep_max: f64,
    pub current_load: f64,
    pub load_increment: f64,
    pub unit: String,
    #[serde(default)]
    pub rpe_values: Option<Vec<f64>>,
    #[serde(default)]
    pub rpe_ceiling: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpeAutoregulationInput {
    pub actual_rpe: Option<f64>,
    pub target_rpe: f64,
    pub load: f64,
    pub increment: f64,
    pub unit: String,
}

pub fn evaluate_double_progression(input: &DoubleProgressionInput) -> Result<Value> {
    if input.completed_reps.is_empty() {
        return Err(AthriaError::new(
            AthriaErrorCode::InvalidData,
            "at least one completed set is required",
        ));
    }
    if input.rep_min < 1.0 || input.rep_max < input.rep_min {
        return Err(AthriaError::new(
            AthriaErrorCode::InvalidData,
            "invalid repetition range",
        ));
    }
    let reached_top = input
        .completed_reps
        .iter()
        .all(|reps| *reps >= input.rep_max);
    let below_minimum = input
        .completed_reps
        .iter()
        .any(|reps| *reps < input.rep_min);
    let rpe_available = input
        .rpe_values
        .as_ref()
        .is_some_and(|values| values.len() == input.completed_reps.len());
    let rpe_acceptable = match (&input.rpe_values, input.rpe_ceiling) {
        (_, None) => true,
        (Some(values), Some(ceiling)) => rpe_available && values.iter().all(|rpe| *rpe <= ceiling),
        (None, Some(_)) => false,
    };
    let action = if reached_top && rpe_acceptable {
        "increase"
    } else if below_minimum {
        "review"
    } else {
        "hold"
    };
    let proposed_load = if action == "increase" {
        input.current_load + input.load_increment
    } else {
        input.current_load
    };
    let reason_code = if action == "increase" {
        "REP_RANGE_COMPLETE"
    } else if below_minimum {
        "BELOW_REP_FLOOR"
    } else if rpe_available || input.rpe_ceiling.is_none() {
        "REP_RANGE_IN_PROGRESS"
    } else {
        "RPE_DATA_MISSING"
    };
    let confidence_limit = if rpe_available || input.rpe_ceiling.is_none() {
        Value::Null
    } else {
        Value::String("RPE ceiling could not be evaluated.".to_string())
    };
    Ok(json!({
        "action": action,
        "proposedLoad": number(proposed_load),
        "unit": input.unit,
        "reasonCode": reason_code,
        "formulaVersion": FORMULA_VERSION,
        "confidenceLimit": confidence_limit,
    }))
}

pub fn evaluate_rpe_autoregulation(input: &RpeAutoregulationInput) -> Result<Value> {
    let Some(actual_rpe) = input.actual_rpe else {
        return Ok(json!({
            "action": "insufficient_data",
            "proposedLoad": number(input.load),
            "reasonCode": "RPE_DATA_MISSING",
            "formulaVersion": FORMULA_VERSION,
        }));
    };
    if actual_rpe < 0.0 || actual_rpe > 10.0 || input.target_rpe < 1.0 || input.target_rpe > 10.0 {
        return Err(AthriaError::new(
            AthriaErrorCode::InvalidData,
            "RPE values must be valid",
        ));
    }
    let difference = actual_rpe - input.target_rpe;
    let (action, proposed_load, reason_code) = if difference >= 1.0 {
        (
            "decrease",
            (input.load - input.increment).max(0.0),
            "RPE_ABOVE_TARGET",
        )
    } else if difference <= -1.0 {
        ("increase", input.load + input.increment, "RPE_BELOW_TARGET")
    } else {
        ("hold", input.load, "RPE_ON_TARGET")
    };
    Ok(json!({
        "action": action,
        "proposedLoad": number(proposed_load),
        "unit": input.unit,
        "reasonCode": reason_code,
        "formulaVersion": FORMULA_VERSION,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn double_progression_flags_a_missing_rpe_ceiling_evaluation() {
        let input: DoubleProgressionInput = serde_json::from_value(json!({
            "completedReps": [8, 8, 8], "repMin": 5, "repMax": 8, "currentLoad": 100, "loadIncrement": 2.5, "unit": "kg", "rpeCeiling": 8
        }))
        .unwrap();
        let result = evaluate_double_progression(&input).unwrap();
        assert_eq!(result["action"], "hold");
        assert_eq!(result["reasonCode"], "RPE_DATA_MISSING");
        assert_eq!(
            result["confidenceLimit"],
            "RPE ceiling could not be evaluated."
        );
    }

    #[test]
    fn double_progression_increases_only_when_the_range_and_effort_allow_it() {
        let input: DoubleProgressionInput = serde_json::from_value(json!({
            "completedReps": [8, 8, 8], "repMin": 5, "repMax": 8, "currentLoad": 100, "loadIncrement": 2.5, "unit": "kg", "rpeValues": [7, 7, 7], "rpeCeiling": 8
        }))
        .unwrap();
        let result = evaluate_double_progression(&input).unwrap();
        assert_eq!(result["action"], "increase");
        assert_eq!(result["reasonCode"], "REP_RANGE_COMPLETE");
        assert_eq!(result["proposedLoad"], 102.5);
        assert_eq!(result["confidenceLimit"], Value::Null);
    }

    #[test]
    fn autoregulation_requires_explicit_rpe_data() {
        let missing: RpeAutoregulationInput = serde_json::from_value(json!({ "actualRpe": null, "targetRpe": 8, "load": 100, "increment": 2.5, "unit": "kg" })).unwrap();
        let result = evaluate_rpe_autoregulation(&missing).unwrap();
        assert_eq!(result["action"], "insufficient_data");
        assert_eq!(result["reasonCode"], "RPE_DATA_MISSING");
        assert!(result.get("unit").is_none());
    }

    #[test]
    fn autoregulation_moves_load_away_from_the_target_rpe() {
        let over: RpeAutoregulationInput = serde_json::from_value(
            json!({ "actualRpe": 9, "targetRpe": 8, "load": 100, "increment": 2.5, "unit": "kg" }),
        )
        .unwrap();
        assert_eq!(
            evaluate_rpe_autoregulation(&over).unwrap()["reasonCode"],
            "RPE_ABOVE_TARGET"
        );
        let under: RpeAutoregulationInput = serde_json::from_value(json!({ "actualRpe": 6.5, "targetRpe": 8, "load": 100, "increment": 2.5, "unit": "kg" })).unwrap();
        assert_eq!(
            evaluate_rpe_autoregulation(&under).unwrap()["proposedLoad"],
            102.5
        );
        let clamped: RpeAutoregulationInput = serde_json::from_value(
            json!({ "actualRpe": 9, "targetRpe": 8, "load": 2, "increment": 5, "unit": "kg" }),
        )
        .unwrap();
        assert_eq!(
            evaluate_rpe_autoregulation(&clamped).unwrap()["proposedLoad"],
            0
        );
        let invalid = RpeAutoregulationInput {
            actual_rpe: Some(11.0),
            target_rpe: 8.0,
            load: 100.0,
            increment: 2.5,
            unit: "kg".to_string(),
        };
        let error = evaluate_rpe_autoregulation(&invalid).unwrap_err();
        assert_eq!(error.message(), "RPE values must be valid");
        assert_eq!(error.code(), AthriaErrorCode::InvalidData);
    }
}
