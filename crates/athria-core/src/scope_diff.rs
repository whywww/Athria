//! Pure minimum-change policy for a proposed complete Current Plan.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{PlanValidation, RecommendedScope};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentScopePolicy {
    pub recommended_scope: RecommendedScope,
    pub review_date: String,
    pub target_session_ids: Vec<String>,
    pub target_week_numbers: Vec<i64>,
    pub expected_plan_revision: i64,
    pub input_snapshot_hash: String,
    pub profile_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ScopeViolationCode {
    MissingScopeTarget,
    ChangeOutsideRecommendedScope,
    HistoricalSessionChanged,
    HistoricalSessionRemoved,
    HistoricalSessionAdded,
    PlanStructureChanged,
    PlanMetadataChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeViolation {
    pub code: ScopeViolationCode,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeDiffValidation {
    pub valid: bool,
    pub violations: Vec<ScopeViolation>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentPlanValidation {
    pub valid: bool,
    pub plan_validation: PlanValidation,
    pub scope_validation: ScopeDiffValidation,
}

#[derive(Clone, Copy)]
struct SessionRef<'a> {
    week_number: i64,
    value: &'a Value,
}

/// Checks only the breadth of a complete-plan proposal. Schema and training
/// constraints remain the responsibility of the existing plan validator.
pub fn validate_adjustment_scope(
    original: &Value,
    proposed: &Value,
    policy: &AdjustmentScopePolicy,
) -> ScopeDiffValidation {
    let mut violations = Vec::new();
    let target_sessions: BTreeSet<&str> = policy
        .target_session_ids
        .iter()
        .map(String::as_str)
        .collect();
    let target_weeks: BTreeSet<i64> = policy.target_week_numbers.iter().copied().collect();

    if policy.recommended_scope == RecommendedScope::Workout && target_sessions.is_empty()
        || policy.recommended_scope == RecommendedScope::Week && target_weeks.is_empty()
    {
        violations.push(violation(
            ScopeViolationCode::MissingScopeTarget,
            "scope",
            None,
        ));
    }

    if policy.recommended_scope != RecommendedScope::Plan {
        for path in [
            "/mesocycle/durationWeeks",
            "/mesocycle/schedule",
            "/mesocycle/domainProgressions",
            "/mesocycle/adjustmentRules",
        ] {
            if pointer(original, path) != pointer(proposed, path) {
                violations.push(violation(
                    ScopeViolationCode::PlanStructureChanged,
                    path,
                    None,
                ));
            }
        }
        for path in [
            "/planSchemaVersion",
            "/ownerId",
            "/title",
            "/summary",
            "/target",
            "/effectiveStartDate",
            "/sourceAgent",
            "/model",
            "/skillVersion",
        ] {
            if pointer(original, path) != pointer(proposed, path) {
                violations.push(violation(
                    ScopeViolationCode::PlanMetadataChanged,
                    path,
                    None,
                ));
            }
        }
    }

    let original_sessions = sessions(original);
    let proposed_sessions = sessions(proposed);
    let session_ids: BTreeSet<&str> = original_sessions
        .keys()
        .chain(proposed_sessions.keys())
        .copied()
        .collect();
    for id in session_ids {
        let before = original_sessions.get(id);
        let after = proposed_sessions.get(id);
        let historical = before
            .map(|session| is_historical(session.value, &policy.review_date))
            .unwrap_or(false)
            || after
                .map(|session| is_historical(session.value, &policy.review_date))
                .unwrap_or(false);
        if historical {
            let code = match (before, after) {
                (Some(_), None) => ScopeViolationCode::HistoricalSessionRemoved,
                (None, Some(_)) => ScopeViolationCode::HistoricalSessionAdded,
                (Some(left), Some(right))
                    if left.week_number != right.week_number || left.value != right.value =>
                {
                    ScopeViolationCode::HistoricalSessionChanged
                }
                _ => continue,
            };
            violations.push(violation(code, "/mesocycle/weeks/sessions", Some(id)));
            continue;
        }
        if matches!((before, after), (Some(left), Some(right))
            if left.week_number == right.week_number && left.value == right.value)
        {
            continue;
        }
        let week = after.or(before).map(|item| item.week_number).unwrap_or(0);
        let allowed = match policy.recommended_scope {
            RecommendedScope::None => false,
            RecommendedScope::Workout => target_sessions.contains(id),
            RecommendedScope::Week => target_weeks.contains(&week),
            RecommendedScope::Plan => true,
        };
        if !allowed {
            violations.push(violation(
                ScopeViolationCode::ChangeOutsideRecommendedScope,
                "/mesocycle/weeks/sessions",
                Some(id),
            ));
        }
    }

    let original_focus = week_focus(original);
    let proposed_focus = week_focus(proposed);
    for week in original_focus
        .keys()
        .chain(proposed_focus.keys())
        .copied()
        .collect::<BTreeSet<_>>()
    {
        if original_focus.get(&week) == proposed_focus.get(&week) {
            continue;
        }
        let allowed = policy.recommended_scope == RecommendedScope::Plan
            || policy.recommended_scope == RecommendedScope::Week && target_weeks.contains(&week);
        if !allowed {
            violations.push(violation(
                ScopeViolationCode::ChangeOutsideRecommendedScope,
                "/mesocycle/weeks/focus",
                Some(&format!("week:{week}")),
            ));
        }
    }

    ScopeDiffValidation {
        valid: violations.is_empty(),
        violations,
    }
}

fn sessions(plan: &Value) -> BTreeMap<&str, SessionRef<'_>> {
    let mut result = BTreeMap::new();
    for week in plan["mesocycle"]["weeks"].as_array().into_iter().flatten() {
        let week_number = week["weekNumber"].as_i64().unwrap_or(0);
        for session in week["sessions"].as_array().into_iter().flatten() {
            if let Some(id) = session["id"].as_str() {
                result.insert(
                    id,
                    SessionRef {
                        week_number,
                        value: session,
                    },
                );
            }
        }
    }
    result
}

fn week_focus(plan: &Value) -> BTreeMap<i64, &Value> {
    plan["mesocycle"]["weeks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|week| (week["weekNumber"].as_i64().unwrap_or(0), &week["focus"]))
        .collect()
}

fn is_historical(session: &Value, review_date: &str) -> bool {
    session["status"]
        .as_str()
        .is_some_and(|status| status != "planned")
        || session["scheduledDate"]
            .as_str()
            .is_some_and(|date| date < review_date)
}

fn pointer<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    value.pointer(path)
}

fn violation(code: ScopeViolationCode, path: &str, subject_ref: Option<&str>) -> ScopeViolation {
    ScopeViolation {
        code,
        path: path.to_owned(),
        subject_ref: subject_ref.map(str::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plan() -> Value {
        json!({
            "title": "Block", "summary": "", "target": null,
            "mesocycle": {
                "durationWeeks": 2, "schedule": {"kind":"fixed_week","days":[0]},
                "domainProgressions": [{"domain":"endurance","phases":[]}],
                "adjustmentRules": [],
                "weeks": [
                    {"weekNumber":1,"focus":null,"sessions":[{"id":"past","scheduledDate":"2026-09-14","status":"skipped","name":"Past"}]},
                    {"weekNumber":2,"focus":null,"sessions":[{"id":"future","scheduledDate":"2026-09-21","status":"planned","name":"Future"}]}
                ]
            }
        })
    }

    fn policy(scope: RecommendedScope) -> AdjustmentScopePolicy {
        AdjustmentScopePolicy {
            recommended_scope: scope,
            review_date: "2026-09-18".to_owned(),
            target_session_ids: vec![],
            target_week_numbers: vec![],
            expected_plan_revision: 1,
            input_snapshot_hash: "snapshot".to_owned(),
            profile_hash: "profile".to_owned(),
        }
    }

    #[test]
    fn week_scope_rejects_unrelated_future_weeks() {
        let original = plan();
        let mut proposed = original.clone();
        proposed["mesocycle"]["weeks"][1]["sessions"][0]["name"] = json!("Changed");
        let mut policy = policy(RecommendedScope::Week);
        policy.target_week_numbers = vec![1];
        let result = validate_adjustment_scope(&original, &proposed, &policy);
        assert!(!result.valid);
        assert_eq!(
            result.violations[0].code,
            ScopeViolationCode::ChangeOutsideRecommendedScope
        );
    }

    #[test]
    fn historical_sessions_are_immutable_at_every_scope() {
        let original = plan();
        let mut proposed = original.clone();
        proposed["mesocycle"]["weeks"][0]["sessions"][0]["status"] = json!("planned");
        let result =
            validate_adjustment_scope(&original, &proposed, &policy(RecommendedScope::Plan));
        assert_eq!(
            result.violations[0].code,
            ScopeViolationCode::HistoricalSessionChanged
        );
    }

    #[test]
    fn targeted_workout_change_is_allowed() {
        let original = plan();
        let mut proposed = original.clone();
        proposed["mesocycle"]["weeks"][1]["sessions"][0]["name"] = json!("Changed");
        let mut policy = policy(RecommendedScope::Workout);
        policy.target_session_ids = vec!["future".to_owned()];
        assert!(validate_adjustment_scope(&original, &proposed, &policy).valid);
    }

    #[test]
    fn week_scope_cannot_change_domain_progressions() {
        let original = plan();
        let mut proposed = original.clone();
        proposed["mesocycle"]["domainProgressions"][0]["domain"] = json!("strength");
        let mut policy = policy(RecommendedScope::Week);
        policy.target_week_numbers = vec![2];
        let result = validate_adjustment_scope(&original, &proposed, &policy);
        assert_eq!(
            result.violations[0].code,
            ScopeViolationCode::PlanStructureChanged
        );
    }

    #[test]
    fn moving_a_session_to_an_untargeted_week_is_a_change() {
        let original = plan();
        let mut proposed = original.clone();
        let session = proposed["mesocycle"]["weeks"][1]["sessions"]
            .as_array_mut()
            .unwrap()
            .remove(0);
        proposed["mesocycle"]["weeks"][0]["sessions"]
            .as_array_mut()
            .unwrap()
            .push(session);
        let mut policy = policy(RecommendedScope::Week);
        policy.target_week_numbers = vec![2];

        let result = validate_adjustment_scope(&original, &proposed, &policy);
        assert_eq!(
            result.violations[0].code,
            ScopeViolationCode::ChangeOutsideRecommendedScope
        );
    }
}
