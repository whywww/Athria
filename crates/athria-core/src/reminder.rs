//! Pure reminder acknowledgement policy for adjustment assessments.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{AdjustmentAssessment, ReviewStatus, stable_hash};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentReminder {
    pub assessment: AdjustmentAssessment,
    pub idempotency_context: String,
    pub show_reminder: bool,
}

/// Applies acknowledgement without hiding hard overrides or newly changed
/// facts. The caller owns acknowledgement storage and supplies it explicitly.
pub fn evaluate_adjustment_reminder(
    assessment: AdjustmentAssessment,
    acknowledged_context: Option<&str>,
) -> AdjustmentReminder {
    let reason_codes = assessment
        .reasons
        .iter()
        .map(|reason| reason.reason_code)
        .collect::<Vec<_>>();
    let idempotency_context = stable_hash(&json!({
        "reasonCodes": reason_codes,
        "currentPlanRevision": assessment.current_plan_revision,
        "profileHash": assessment.profile_hash,
        "inputSnapshotHash": assessment.input_snapshot_hash,
    }));
    let show_reminder = assessment.review_status != ReviewStatus::Keep
        && (!assessment.hard_overrides.is_empty()
            || acknowledged_context != Some(idempotency_context.as_str()));
    AdjustmentReminder {
        assessment,
        idempotency_context,
        show_reminder,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AdjustmentTrigger, HardOverride, RecommendedScope};

    fn assessment(status: ReviewStatus) -> AdjustmentAssessment {
        AdjustmentAssessment {
            trigger: AdjustmentTrigger::WeeklyReview,
            review_status: status,
            recommended_scope: RecommendedScope::None,
            reasons: Vec::new(),
            hard_overrides: Vec::new(),
            data_gaps: Vec::new(),
            current_plan_revision: 2,
            input_snapshot_hash: "snapshot".to_owned(),
            profile_hash: "profile".to_owned(),
            suggested_read_window: 1,
            targeted_evidence_needs: Vec::new(),
        }
    }

    #[test]
    fn acknowledgement_suppresses_only_the_same_soft_context() {
        let first = evaluate_adjustment_reminder(assessment(ReviewStatus::Watch), None);
        assert!(first.show_reminder);
        let acknowledged = evaluate_adjustment_reminder(
            assessment(ReviewStatus::Watch),
            Some(&first.idempotency_context),
        );
        assert!(!acknowledged.show_reminder);

        let mut changed = assessment(ReviewStatus::Watch);
        changed.input_snapshot_hash = "new-snapshot".to_owned();
        assert!(
            evaluate_adjustment_reminder(changed, Some(&first.idempotency_context)).show_reminder
        );
    }

    #[test]
    fn hard_overrides_bypass_acknowledgement_and_keep_is_silent() {
        let keep = evaluate_adjustment_reminder(assessment(ReviewStatus::Keep), None);
        assert!(!keep.show_reminder);

        let mut hard = assessment(ReviewStatus::ReviewRequired);
        hard.hard_overrides = vec![HardOverride::ExplicitHealthLimitation];
        let first = evaluate_adjustment_reminder(hard.clone(), None);
        assert!(evaluate_adjustment_reminder(hard, Some(&first.idempotency_context)).show_reminder);
    }
}
