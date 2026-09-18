//! Pure, deterministic plan-adjustment review.
//!
//! The caller supplies already structured facts. This module neither reads IO
//! nor interprets free-form medical text; it preserves unknown inputs as data
//! gaps and combines independent evidence with an explicit decision table.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdjustmentTrigger {
    WeeklyReview,
    ProfileChange,
    UserRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewStatus {
    Keep,
    Watch,
    ReviewRecommended,
    ReviewRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecommendedScope {
    None,
    Workout,
    Week,
    Plan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSeverity {
    Info,
    Soft,
    Strong,
    Hard,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum EvidenceAxis {
    Adherence,
    KeySession,
    ScheduleFeasibility,
    HealthRecovery,
    Performance { domain: String },
    ProfileMismatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReasonCode {
    AdherenceMinorDeviation,
    AdherenceLowCompletion,
    KeySessionMissed,
    KeySessionIssuePersistent,
    DomainPerformanceIssue,
    DomainPerformanceIssuePersistent,
    RecoverySignal,
    HealthLimitation,
    TrainingInterruption,
    NextWeekInfeasible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewReason {
    pub reason_code: ReasonCode,
    pub severity: EvidenceSeverity,
    pub axis: EvidenceAxis,
    pub evidence_refs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_domain: Option<String>,
    pub affected_scope: RecommendedScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HardOverride {
    ExplicitHealthLimitation,
    TrainingInterruptionSevenDays,
    NextWeekStructurallyInfeasible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGap {
    pub axis: EvidenceAxis,
    pub code: String,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionOutcome {
    Completed,
    Skipped,
    Unresolved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedSessionEvidence {
    pub session_id: String,
    pub domain: Option<String>,
    pub key_session: bool,
    pub outcome: SessionOutcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PerformanceStatus {
    Normal,
    Issue,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainPerformanceEvidence {
    pub domain: String,
    pub status: PerformanceStatus,
    pub persistence_windows: u8,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryStatus {
    Normal,
    Issue,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthRecoveryEvidence {
    pub status: RecoveryStatus,
    pub explicit_training_limitation: bool,
    pub interruption_days: u16,
    pub phase_intent_invalidated: bool,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum FeasibilityStatus {
    Feasible,
    Unknown,
    Conflict { minimum_scope: RecommendedScope },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyReviewFacts {
    pub sessions: Vec<PlannedSessionEvidence>,
    pub unmatched_actual_count: u16,
    pub key_session_persistence_windows: u8,
    pub performance: Vec<DomainPerformanceEvidence>,
    pub health_recovery: HealthRecoveryEvidence,
    pub next_week_feasibility: FeasibilityStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentInput {
    pub trigger: AdjustmentTrigger,
    pub current_plan_revision: i64,
    pub input_snapshot_hash: String,
    pub profile_hash: String,
    pub weekly_review: WeeklyReviewFacts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentAssessment {
    pub trigger: AdjustmentTrigger,
    pub review_status: ReviewStatus,
    pub recommended_scope: RecommendedScope,
    pub reasons: Vec<ReviewReason>,
    pub hard_overrides: Vec<HardOverride>,
    pub data_gaps: Vec<DataGap>,
    pub current_plan_revision: i64,
    pub input_snapshot_hash: String,
    pub profile_hash: String,
    pub suggested_read_window: u8,
    pub targeted_evidence_needs: Vec<String>,
}

fn reason(
    reason_code: ReasonCode,
    severity: EvidenceSeverity,
    axis: EvidenceAxis,
    evidence_refs: Vec<String>,
    affected_scope: RecommendedScope,
) -> ReviewReason {
    let affected_domain = match &axis {
        EvidenceAxis::Performance { domain } => Some(domain.clone()),
        _ => None,
    };
    ReviewReason {
        reason_code,
        severity,
        axis,
        evidence_refs,
        affected_domain,
        affected_scope,
    }
}

/// Evaluates structured weekly facts with the v2 hard-override and independent
/// soft-axis policy. It intentionally does not derive sport-science thresholds.
pub fn assess_adjustment(input: &AdjustmentInput) -> AdjustmentAssessment {
    let facts = &input.weekly_review;
    let mut reasons = Vec::new();
    let mut hard_overrides = Vec::new();
    let mut data_gaps = Vec::new();
    let mut targeted_evidence_needs = BTreeSet::new();

    let completed = facts
        .sessions
        .iter()
        .filter(|session| session.outcome == SessionOutcome::Completed)
        .count();
    let missed: Vec<&PlannedSessionEvidence> = facts
        .sessions
        .iter()
        .filter(|session| session.outcome != SessionOutcome::Completed)
        .collect();
    let missed_key: Vec<&PlannedSessionEvidence> = missed
        .iter()
        .copied()
        .filter(|session| session.key_session)
        .collect();

    if facts.sessions.len() == 4 && completed == 3 && missed_key.is_empty() {
        reasons.push(reason(
            ReasonCode::AdherenceMinorDeviation,
            EvidenceSeverity::Soft,
            EvidenceAxis::Adherence,
            missed
                .iter()
                .map(|session| session.session_id.clone())
                .collect(),
            RecommendedScope::None,
        ));
    } else if facts.sessions.len() == 4 && completed <= 2 {
        reasons.push(reason(
            ReasonCode::AdherenceLowCompletion,
            EvidenceSeverity::Soft,
            EvidenceAxis::Adherence,
            missed
                .iter()
                .map(|session| session.session_id.clone())
                .collect(),
            RecommendedScope::Week,
        ));
    }

    if !missed_key.is_empty() {
        let persistent = facts.key_session_persistence_windows >= 2;
        reasons.push(reason(
            if persistent {
                ReasonCode::KeySessionIssuePersistent
            } else {
                ReasonCode::KeySessionMissed
            },
            if persistent {
                EvidenceSeverity::Strong
            } else {
                EvidenceSeverity::Soft
            },
            EvidenceAxis::KeySession,
            missed_key
                .iter()
                .map(|session| session.session_id.clone())
                .collect(),
            RecommendedScope::Week,
        ));
        if !persistent {
            targeted_evidence_needs.insert("prior_key_sessions".to_owned());
        }
    }

    for performance in &facts.performance {
        let axis = EvidenceAxis::Performance {
            domain: performance.domain.clone(),
        };
        match performance.status {
            PerformanceStatus::Normal => {}
            PerformanceStatus::Issue => {
                let persistent = performance.persistence_windows >= 2;
                reasons.push(reason(
                    if persistent {
                        ReasonCode::DomainPerformanceIssuePersistent
                    } else {
                        ReasonCode::DomainPerformanceIssue
                    },
                    if persistent {
                        EvidenceSeverity::Strong
                    } else {
                        EvidenceSeverity::Soft
                    },
                    axis,
                    performance.evidence_refs.clone(),
                    RecommendedScope::Week,
                ));
                if !persistent {
                    targeted_evidence_needs
                        .insert(format!("prior_{}_performance", performance.domain));
                }
            }
            PerformanceStatus::Unknown => data_gaps.push(DataGap {
                axis,
                code: "PERFORMANCE_HISTORY_MISSING".to_owned(),
                evidence_refs: performance.evidence_refs.clone(),
            }),
        }
    }

    match facts.health_recovery.status {
        RecoveryStatus::Normal => {}
        RecoveryStatus::Issue => reasons.push(reason(
            ReasonCode::RecoverySignal,
            EvidenceSeverity::Soft,
            EvidenceAxis::HealthRecovery,
            facts.health_recovery.evidence_refs.clone(),
            RecommendedScope::Week,
        )),
        RecoveryStatus::Unknown => data_gaps.push(DataGap {
            axis: EvidenceAxis::HealthRecovery,
            code: "WELLNESS_EVIDENCE_MISSING".to_owned(),
            evidence_refs: facts.health_recovery.evidence_refs.clone(),
        }),
    }

    if facts.health_recovery.explicit_training_limitation {
        hard_overrides.push(HardOverride::ExplicitHealthLimitation);
        reasons.push(reason(
            ReasonCode::HealthLimitation,
            EvidenceSeverity::Hard,
            EvidenceAxis::HealthRecovery,
            facts.health_recovery.evidence_refs.clone(),
            if facts.health_recovery.phase_intent_invalidated {
                RecommendedScope::Plan
            } else {
                RecommendedScope::Week
            },
        ));
    }
    if facts.health_recovery.interruption_days >= 7 {
        hard_overrides.push(HardOverride::TrainingInterruptionSevenDays);
        reasons.push(reason(
            ReasonCode::TrainingInterruption,
            EvidenceSeverity::Hard,
            EvidenceAxis::HealthRecovery,
            facts.health_recovery.evidence_refs.clone(),
            if facts.health_recovery.phase_intent_invalidated {
                RecommendedScope::Plan
            } else {
                RecommendedScope::Week
            },
        ));
    }

    match facts.next_week_feasibility {
        FeasibilityStatus::Feasible => {}
        FeasibilityStatus::Unknown => data_gaps.push(DataGap {
            axis: EvidenceAxis::ScheduleFeasibility,
            code: "NEXT_WEEK_FEASIBILITY_UNKNOWN".to_owned(),
            evidence_refs: Vec::new(),
        }),
        FeasibilityStatus::Conflict { minimum_scope } => {
            hard_overrides.push(HardOverride::NextWeekStructurallyInfeasible);
            reasons.push(reason(
                ReasonCode::NextWeekInfeasible,
                EvidenceSeverity::Hard,
                EvidenceAxis::ScheduleFeasibility,
                Vec::new(),
                minimum_scope,
            ));
        }
    }

    if facts.unmatched_actual_count > 0 {
        targeted_evidence_needs.insert("unmatched_actual_sessions".to_owned());
    }
    if !data_gaps.is_empty() {
        targeted_evidence_needs.insert("missing_evidence".to_owned());
    }

    let soft_axes: BTreeSet<EvidenceAxis> = reasons
        .iter()
        .filter(|item| item.severity == EvidenceSeverity::Soft)
        .map(|item| item.axis.clone())
        .collect();
    let persistent = reasons
        .iter()
        .any(|item| item.severity == EvidenceSeverity::Strong);
    let hard = !hard_overrides.is_empty();
    let review_status = if hard {
        ReviewStatus::ReviewRequired
    } else if persistent || soft_axes.len() >= 2 {
        ReviewStatus::ReviewRecommended
    } else if !reasons.is_empty() || !data_gaps.is_empty() {
        ReviewStatus::Watch
    } else {
        ReviewStatus::Keep
    };
    let recommended_scope =
        if review_status == ReviewStatus::Keep || review_status == ReviewStatus::Watch {
            RecommendedScope::None
        } else {
            reasons
                .iter()
                .map(|item| item.affected_scope)
                .max()
                .unwrap_or(RecommendedScope::None)
        };
    let suggested_read_window = if persistent || !targeted_evidence_needs.is_empty() {
        3
    } else {
        1
    };

    AdjustmentAssessment {
        trigger: input.trigger,
        review_status,
        recommended_scope,
        reasons,
        hard_overrides,
        data_gaps,
        current_plan_revision: input.current_plan_revision,
        input_snapshot_hash: input.input_snapshot_hash.clone(),
        profile_hash: input.profile_hash.clone(),
        suggested_read_window,
        targeted_evidence_needs: targeted_evidence_needs.into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(
        id: &str,
        domain: &str,
        key: bool,
        outcome: SessionOutcome,
    ) -> PlannedSessionEvidence {
        PlannedSessionEvidence {
            session_id: id.to_owned(),
            domain: Some(domain.to_owned()),
            key_session: key,
            outcome,
        }
    }

    fn input(sessions: Vec<PlannedSessionEvidence>) -> AdjustmentInput {
        AdjustmentInput {
            trigger: AdjustmentTrigger::WeeklyReview,
            current_plan_revision: 7,
            input_snapshot_hash: "snapshot-7".to_owned(),
            profile_hash: "profile-3".to_owned(),
            weekly_review: WeeklyReviewFacts {
                sessions,
                unmatched_actual_count: 0,
                key_session_persistence_windows: 1,
                performance: vec![],
                health_recovery: HealthRecoveryEvidence {
                    status: RecoveryStatus::Normal,
                    explicit_training_limitation: false,
                    interruption_days: 0,
                    phase_intent_invalidated: false,
                    evidence_refs: vec![],
                },
                next_week_feasibility: FeasibilityStatus::Feasible,
            },
        }
    }

    #[test]
    fn ordinary_three_of_four_completion_is_watch_without_a_rewrite_scope() {
        let assessment = assess_adjustment(&input(vec![
            session("s1", "strength", true, SessionOutcome::Completed),
            session("s2", "strength", false, SessionOutcome::Completed),
            session("s3", "endurance", true, SessionOutcome::Completed),
            session("s4", "strength", false, SessionOutcome::Skipped),
        ]));
        assert_eq!(assessment.review_status, ReviewStatus::Watch);
        assert_eq!(assessment.recommended_scope, RecommendedScope::None);
        assert_eq!(assessment.reasons.len(), 1);
        assert_eq!(
            assessment.reasons[0].reason_code,
            ReasonCode::AdherenceMinorDeviation
        );
    }

    #[test]
    fn two_of_four_with_a_key_miss_and_recovery_issue_recommends_a_week_review() {
        let mut input = input(vec![
            session("s1", "strength", true, SessionOutcome::Skipped),
            session("s2", "strength", false, SessionOutcome::Completed),
            session("s3", "endurance", true, SessionOutcome::Completed),
            session("s4", "strength", false, SessionOutcome::Unresolved),
        ]);
        input.weekly_review.health_recovery.status = RecoveryStatus::Issue;
        let assessment = assess_adjustment(&input);
        assert_eq!(assessment.review_status, ReviewStatus::ReviewRecommended);
        assert_eq!(assessment.recommended_scope, RecommendedScope::Week);
        assert_eq!(assessment.reasons.len(), 3);
    }

    #[test]
    fn seven_day_interruption_is_a_hard_override_and_phase_loss_raises_plan_scope() {
        let mut input = input(vec![]);
        input.weekly_review.health_recovery.interruption_days = 7;
        input.weekly_review.health_recovery.phase_intent_invalidated = true;
        input.weekly_review.health_recovery.evidence_refs = vec!["user_report:1".to_owned()];
        let assessment = assess_adjustment(&input);
        assert_eq!(assessment.review_status, ReviewStatus::ReviewRequired);
        assert_eq!(assessment.recommended_scope, RecommendedScope::Plan);
        assert_eq!(
            assessment.hard_overrides,
            vec![HardOverride::TrainingInterruptionSevenDays]
        );
    }

    #[test]
    fn endurance_issue_does_not_create_strength_or_unified_performance_evidence() {
        let mut input = input(vec![]);
        input.weekly_review.performance = vec![
            DomainPerformanceEvidence {
                domain: "strength".to_owned(),
                status: PerformanceStatus::Normal,
                persistence_windows: 0,
                evidence_refs: vec!["strength:1".to_owned()],
            },
            DomainPerformanceEvidence {
                domain: "endurance".to_owned(),
                status: PerformanceStatus::Issue,
                persistence_windows: 2,
                evidence_refs: vec!["run:1".to_owned(), "run:2".to_owned()],
            },
        ];
        let assessment = assess_adjustment(&input);
        assert_eq!(assessment.review_status, ReviewStatus::ReviewRecommended);
        assert_eq!(assessment.reasons.len(), 1);
        assert_eq!(
            assessment.reasons[0].affected_domain.as_deref(),
            Some("endurance")
        );
    }

    #[test]
    fn missing_wellness_is_a_gap_not_a_normal_recovery_result() {
        let mut input = input(vec![]);
        input.weekly_review.health_recovery.status = RecoveryStatus::Unknown;
        let assessment = assess_adjustment(&input);
        assert_eq!(assessment.review_status, ReviewStatus::Watch);
        assert!(assessment.reasons.is_empty());
        assert_eq!(assessment.data_gaps[0].code, "WELLNESS_EVIDENCE_MISSING");
    }

    #[test]
    fn identical_inputs_produce_identical_serialized_assessments() {
        let input = input(vec![session(
            "s1",
            "endurance",
            true,
            SessionOutcome::Skipped,
        )]);
        let first = serde_json::to_string(&assess_adjustment(&input)).unwrap();
        let second = serde_json::to_string(&assess_adjustment(&input)).unwrap();
        assert_eq!(first, second);
    }
}
