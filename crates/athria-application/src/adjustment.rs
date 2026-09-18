//! Read-only plan-adjustment review orchestration.
//!
//! This module projects persisted facts into the pure `athria-core`
//! assessment contract. Reconciliation and validation stay in their existing
//! owners; no decision rule is duplicated here.

use std::collections::BTreeSet;

use athria_core::date::{add_days, monday_weekday};
use athria_core::{
    AdjustmentAssessment, AdjustmentInput, AdjustmentPlanValidation, AdjustmentScopePolicy,
    AdjustmentTrigger, AthriaError, AthriaErrorCode, FeasibilityStatus, GoalModality,
    HealthRecoveryEvidence, PlannedSessionEvidence, ProfileChangeFacts, ProfileConstraintKind,
    ProfileConstraintMismatch, RecoveryStatus, Result, SessionOutcome, WeeklyReviewFacts,
    assess_adjustment, tz, validate_adjustment_scope, validate_plan,
};
use serde_json::{Value, json};

use crate::{AthriaApplication, AthriaStore};

impl<S: AthriaStore> AthriaApplication<S> {
    /// Reads the current authoritative facts and returns a derived assessment.
    /// The operation is read-only and deterministic for one unchanged snapshot.
    pub fn review_current_plan_for_adjustment(
        &self,
        trigger: AdjustmentTrigger,
    ) -> Result<AdjustmentAssessment> {
        let plan = self.get_current_plan()?.ok_or_else(|| {
            AthriaError::new(AthriaErrorCode::NoCurrentPlan, "There is no current plan.")
                .with_status(409)
        })?;
        let profile = self.get_profile()?;
        let state = self.get_training_state()?;
        let now = state["asOf"].as_str().unwrap_or("");
        let timezone = profile["timezone"].as_str().unwrap_or("UTC");
        let today = tz::local_date(now, timezone)?;
        let calendar = self.get_calendar(None, Some(&today))?;

        let validation = validate_plan(
            &profile,
            &json!({
                "effectiveStartDate": plan["effectiveStartDate"],
                "mesocycle": plan["mesocycle"],
            }),
            now,
        );
        let profile_change = profile_change_facts(&profile, &plan, &validation.results);
        let weekly_review = if trigger == AdjustmentTrigger::ProfileChange {
            None
        } else {
            Some(self.weekly_review_facts(&profile, &today, &calendar)?)
        };

        Ok(assess_adjustment(&AdjustmentInput {
            trigger,
            current_plan_revision: plan["revision"].as_i64().unwrap_or(0),
            input_snapshot_hash: state["inputSnapshotHash"].as_str().unwrap_or("").to_owned(),
            profile_hash: self.profile_hash()?,
            weekly_review,
            profile_change: Some(profile_change),
        }))
    }

    /// Runs the authoritative plan validator and the minimum-change policy
    /// against the same fresh Current Plan. It never writes the proposal.
    pub fn validate_current_plan_adjustment(
        &self,
        proposed: &Value,
        policy: &AdjustmentScopePolicy,
    ) -> Result<AdjustmentPlanValidation> {
        let current = self.get_current_plan()?.ok_or_else(|| {
            AthriaError::new(AthriaErrorCode::NoCurrentPlan, "There is no current plan.")
                .with_status(409)
        })?;
        if current["revision"].as_i64() != Some(policy.expected_plan_revision) {
            return Err(AthriaError::new(
                AthriaErrorCode::RevisionConflict,
                "The current plan changed. Refresh and try again.",
            )
            .with_status(409));
        }
        if self.snapshot_hash()? != policy.input_snapshot_hash
            || self.profile_hash()? != policy.profile_hash
        {
            return Err(AthriaError::new(
                AthriaErrorCode::InputSnapshotChanged,
                "Training state changed. Refresh and revise the plan.",
            )
            .with_status(409));
        }
        let plan_validation = self.validate_current_plan(proposed)?;
        let scope_validation = validate_adjustment_scope(&current, proposed, policy);
        Ok(AdjustmentPlanValidation {
            valid: plan_validation.valid && scope_validation.valid,
            plan_validation,
            scope_validation,
        })
    }

    fn weekly_review_facts(
        &self,
        profile: &Value,
        today: &str,
        calendar: &[Value],
    ) -> Result<WeeklyReviewFacts> {
        let week_start = add_days(today, -(monday_weekday(today) as i64));
        let current: Vec<&Value> = calendar
            .iter()
            .filter(|session| {
                session["scheduledDate"]
                    .as_str()
                    .is_some_and(|date| date >= week_start.as_str() && date <= today)
            })
            .collect();
        let sessions = current
            .iter()
            .map(|session| PlannedSessionEvidence {
                session_id: session["id"].as_str().unwrap_or("").to_owned(),
                domain: session_domain(session),
                key_session: session["keySession"].as_bool().unwrap_or(false),
                outcome: match session["status"].as_str() {
                    Some("completed") => SessionOutcome::Completed,
                    Some("skipped") => SessionOutcome::Skipped,
                    _ => SessionOutcome::Unresolved,
                },
            })
            .collect();

        let missed_key_domains: BTreeSet<String> = current
            .iter()
            .filter(|session| {
                session["keySession"].as_bool() == Some(true)
                    && session["status"].as_str() != Some("completed")
            })
            .filter_map(|session| session_domain(session))
            .collect();
        let history_start = add_days(&week_start, -21);
        let prior_key_issue = calendar.iter().any(|session| {
            let date = session["scheduledDate"].as_str().unwrap_or("");
            session["keySession"].as_bool() == Some(true)
                && session["status"].as_str() != Some("completed")
                && date >= history_start.as_str()
                && date < week_start.as_str()
                && session_domain(session)
                    .is_some_and(|domain| missed_key_domains.contains(&domain))
        });

        let history = self.list_sessions(28)?;
        let timezone = profile["timezone"].as_str().unwrap_or("UTC");
        let unmatched_actual_count = history
            .iter()
            .filter(|session| session["planMatch"].is_null())
            .filter(|session| {
                session["startAt"]
                    .as_str()
                    .and_then(|instant| tz::local_date(instant, timezone).ok())
                    .is_some_and(|day| day.as_str() >= week_start.as_str() && day.as_str() <= today)
            })
            .count() as u16;

        let wellness = self.list_wellness(28)?;
        let wellness_refs: Vec<String> = wellness
            .iter()
            .filter_map(|record| record["day"].as_str())
            .filter(|day| *day >= week_start.as_str() && *day <= today)
            .map(|day| format!("wellness:{day}"))
            .collect();

        Ok(WeeklyReviewFacts {
            sessions,
            unmatched_actual_count,
            key_session_persistence_windows: if prior_key_issue { 2 } else { 1 },
            // Existing metrics are domain-separated, but do not yet establish
            // prescription-vs-actual performance issues without new domain
            // thresholds. Phase 3 therefore supplies no invented signal.
            performance: Vec::new(),
            health_recovery: HealthRecoveryEvidence {
                status: if wellness_refs.is_empty() {
                    RecoveryStatus::Unknown
                } else {
                    RecoveryStatus::Normal
                },
                explicit_training_limitation: false,
                interruption_days: 0,
                phase_intent_invalidated: false,
                evidence_refs: wellness_refs,
            },
            // Profile conflicts are represented once through the validator-
            // backed profile facts below, avoiding duplicate hard reasons.
            next_week_feasibility: FeasibilityStatus::Feasible,
        })
    }
}

fn profile_change_facts(profile: &Value, plan: &Value, results: &[Value]) -> ProfileChangeFacts {
    let mut mismatches = Vec::new();
    for (kind, code) in [
        (
            ProfileConstraintKind::TrainingRhythm,
            "PROFILE_TRAINING_RHYTHM",
        ),
        (
            ProfileConstraintKind::MaxSessionDuration,
            "MAX_SESSION_DURATION",
        ),
        (ProfileConstraintKind::Equipment, "EXERCISE_EQUIPMENT"),
        (
            ProfileConstraintKind::ExplicitRecoveryDays,
            "EXPLICIT_RECOVERY_INTERVAL",
        ),
    ] {
        let failed: Vec<&Value> = results
            .iter()
            .filter(|result| {
                result["reasonCode"].as_str() == Some(code)
                    && result["status"].as_str() == Some("fail")
            })
            .collect();
        if !failed.is_empty() {
            let refs: Vec<String> = failed
                .iter()
                .flat_map(|result| {
                    result["subjectRefs"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                })
                .collect();
            mismatches.push(ProfileConstraintMismatch {
                kind,
                evidence_refs: if refs.is_empty() {
                    vec![code.to_owned()]
                } else {
                    refs
                },
                structural: kind == ProfileConstraintKind::TrainingRhythm,
            });
        }
    }

    ProfileChangeFacts {
        constraint_mismatches: mismatches,
        plan_modalities: plan_modalities(plan),
        profile_goal_modalities: text_modalities(&profile["goals"]),
        race_target_modalities: profile["raceDays"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|race| race["sport"].as_str())
            .map(normalize_modality)
            .collect(),
        // Current Plan v7 does not persist the profile value it was generated
        // from, so change detection for these advisory fields cannot be
        // reconstructed safely.
        preference_changed: false,
        mesocycle_duration_preference_changed: false,
    }
}

fn session_domain(session: &Value) -> Option<String> {
    session["components"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|component| component["domain"]["value"].as_str())
        .map(str::to_owned)
}

fn plan_modalities(plan: &Value) -> Vec<GoalModality> {
    let mut modalities = BTreeSet::new();
    for progression in plan["mesocycle"]["domainProgressions"]
        .as_array()
        .into_iter()
        .flatten()
    {
        match progression["domain"].as_str() {
            Some("strength") => {
                modalities.insert(GoalModality::Strength);
                modalities.insert(GoalModality::Hypertrophy);
            }
            Some("endurance") => {
                modalities.insert(GoalModality::Endurance);
            }
            Some("sport_skill") => {
                modalities.insert(GoalModality::SportSkill);
            }
            Some("recovery") => {
                modalities.insert(GoalModality::Recovery);
            }
            Some("mind_body") => {
                modalities.insert(GoalModality::MindBody);
            }
            _ => {}
        }
    }
    if let Some(label) = plan["target"]["primaryGoal"]["label"].as_str() {
        modalities.insert(normalize_modality(label));
    }
    modalities.into_iter().collect()
}

fn text_modalities(value: &Value) -> Vec<GoalModality> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(normalize_modality)
        .collect()
}

fn normalize_modality(value: &str) -> GoalModality {
    let value = value.to_lowercase().replace(['-', '_'], " ");
    if value.contains("hypertrophy") || value.contains("muscle") {
        GoalModality::Hypertrophy
    } else if value.contains("half marathon")
        || value.contains("marathon")
        || value.contains("running")
        || value.contains("run")
        || value.contains("endurance")
        || value.contains("cycling")
        || value.contains("triathlon")
    {
        GoalModality::Endurance
    } else if value.contains("strength") || value.contains("powerlifting") {
        GoalModality::Strength
    } else if value.contains("recovery") || value.contains("mobility") {
        GoalModality::Recovery
    } else if value.contains("yoga") || value.contains("pilates") || value.contains("mind body") {
        GoalModality::MindBody
    } else if value.contains("basketball") || value.contains("tennis") || value.contains("sport") {
        GoalModality::SportSkill
    } else if value.contains("general fitness") || value.contains("general_fitness") {
        GoalModality::GeneralFitness
    } else {
        GoalModality::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_supported_goal_and_race_modalities_without_free_text_in_core() {
        assert_eq!(normalize_modality("hypertrophy"), GoalModality::Hypertrophy);
        assert_eq!(normalize_modality("Half Marathon"), GoalModality::Endurance);
        assert_eq!(normalize_modality("powerlifting"), GoalModality::Strength);
        assert_eq!(normalize_modality("basketball"), GoalModality::SportSkill);
        assert_eq!(
            normalize_modality("unclassified target"),
            GoalModality::Other
        );
    }

    #[test]
    fn strength_plan_is_compatible_with_strength_and_hypertrophy_goals() {
        let plan = json!({
            "mesocycle": { "domainProgressions": [{ "domain": "strength" }] },
            "target": null,
        });
        assert_eq!(
            plan_modalities(&plan),
            vec![GoalModality::Hypertrophy, GoalModality::Strength]
        );
    }
}
