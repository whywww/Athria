//! Stable error model shared by the store port, the application use cases and
//! every transport (Tauri IPC, MCP, CLI, HTTP).
//!
//! The string form of each code is byte-compatible with the TypeScript
//! implementation: `AthriaError` codes raised by `packages/application` and
//! the codes thrown by store implementations in `packages/data`. Frontends
//! and MCP clients match on these strings, so they must never change silently.

use std::fmt;

/// Every error code currently produced by the TypeScript application and
/// store layers. Kept in ASCII-alphabetical order of [`Self::as_str`].
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AthriaErrorCode {
    CompletedSessionCannotBeReplaced,
    DuplicatePlannedSessionId,
    ExplicitRecoveryInterval,
    FutureSessionCannotBeCompleted,
    ImportPreviewNotFound,
    InputSnapshotChanged,
    IntervalsNormalizationFailed,
    InvalidCalendarWindow,
    InvalidMoveDate,
    InvalidSummaryWindow,
    ManualDateChangeRequiresPlanMove,
    ManualDeleteFailed,
    ManualSourceNotFound,
    MatchUpdateFailed,
    MoveOutsidePlan,
    NextTrainingDayChanged,
    NoCurrentPlan,
    NoNextTrainingDay,
    OwnerMismatch,
    PlannedSessionAlreadyResolved,
    PlannedSessionNotFound,
    PlannedSessionNotSkipped,
    PlannedSessionRevisionConflict,
    PlannedSessionSkipped,
    PlanEnded,
    PlanHasBlockers,
    PlanWeekNotFound,
    PlanWorkoutDateMismatch,
    ProfileTrainingRhythm,
    RevisionConflict,
    RevisionRequired,
    TemplateAlreadyExists,
    TemplateInUse,
    TemplateNotFound,
    TrainingDayConflict,
    TrainingSessionNotFound,
    WriteBusy,
}

impl AthriaErrorCode {
    /// All known codes; the wire lookup [`Self::from_wire`] is built from it.
    pub const ALL: [Self; 37] = [
        Self::CompletedSessionCannotBeReplaced,
        Self::DuplicatePlannedSessionId,
        Self::ExplicitRecoveryInterval,
        Self::FutureSessionCannotBeCompleted,
        Self::ImportPreviewNotFound,
        Self::InputSnapshotChanged,
        Self::IntervalsNormalizationFailed,
        Self::InvalidCalendarWindow,
        Self::InvalidMoveDate,
        Self::InvalidSummaryWindow,
        Self::ManualDateChangeRequiresPlanMove,
        Self::ManualDeleteFailed,
        Self::ManualSourceNotFound,
        Self::MatchUpdateFailed,
        Self::MoveOutsidePlan,
        Self::NextTrainingDayChanged,
        Self::NoCurrentPlan,
        Self::NoNextTrainingDay,
        Self::OwnerMismatch,
        Self::PlannedSessionAlreadyResolved,
        Self::PlannedSessionNotFound,
        Self::PlannedSessionNotSkipped,
        Self::PlannedSessionRevisionConflict,
        Self::PlannedSessionSkipped,
        Self::PlanEnded,
        Self::PlanHasBlockers,
        Self::PlanWeekNotFound,
        Self::PlanWorkoutDateMismatch,
        Self::ProfileTrainingRhythm,
        Self::RevisionConflict,
        Self::RevisionRequired,
        Self::TemplateAlreadyExists,
        Self::TemplateInUse,
        Self::TemplateNotFound,
        Self::TrainingDayConflict,
        Self::TrainingSessionNotFound,
        Self::WriteBusy,
    ];

    /// The wire form, byte-identical to the TypeScript code strings.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CompletedSessionCannotBeReplaced => "COMPLETED_SESSION_CANNOT_BE_REPLACED",
            Self::DuplicatePlannedSessionId => "DUPLICATE_PLANNED_SESSION_ID",
            Self::ExplicitRecoveryInterval => "EXPLICIT_RECOVERY_INTERVAL",
            Self::FutureSessionCannotBeCompleted => "FUTURE_SESSION_CANNOT_BE_COMPLETED",
            Self::ImportPreviewNotFound => "IMPORT_PREVIEW_NOT_FOUND",
            Self::InputSnapshotChanged => "INPUT_SNAPSHOT_CHANGED",
            Self::IntervalsNormalizationFailed => "INTERVALS_NORMALIZATION_FAILED",
            Self::InvalidCalendarWindow => "INVALID_CALENDAR_WINDOW",
            Self::InvalidMoveDate => "INVALID_MOVE_DATE",
            Self::InvalidSummaryWindow => "INVALID_SUMMARY_WINDOW",
            Self::ManualDateChangeRequiresPlanMove => "MANUAL_DATE_CHANGE_REQUIRES_PLAN_MOVE",
            Self::ManualDeleteFailed => "MANUAL_DELETE_FAILED",
            Self::ManualSourceNotFound => "MANUAL_SOURCE_NOT_FOUND",
            Self::MatchUpdateFailed => "MATCH_UPDATE_FAILED",
            Self::MoveOutsidePlan => "MOVE_OUTSIDE_PLAN",
            Self::NextTrainingDayChanged => "NEXT_TRAINING_DAY_CHANGED",
            Self::NoCurrentPlan => "NO_CURRENT_PLAN",
            Self::NoNextTrainingDay => "NO_NEXT_TRAINING_DAY",
            Self::OwnerMismatch => "OWNER_MISMATCH",
            Self::PlannedSessionAlreadyResolved => "PLANNED_SESSION_ALREADY_RESOLVED",
            Self::PlannedSessionNotFound => "PLANNED_SESSION_NOT_FOUND",
            Self::PlannedSessionNotSkipped => "PLANNED_SESSION_NOT_SKIPPED",
            Self::PlannedSessionRevisionConflict => "PLANNED_SESSION_REVISION_CONFLICT",
            Self::PlannedSessionSkipped => "PLANNED_SESSION_SKIPPED",
            Self::PlanEnded => "PLAN_ENDED",
            Self::PlanHasBlockers => "PLAN_HAS_BLOCKERS",
            Self::PlanWeekNotFound => "PLAN_WEEK_NOT_FOUND",
            Self::PlanWorkoutDateMismatch => "PLAN_WORKOUT_DATE_MISMATCH",
            Self::ProfileTrainingRhythm => "PROFILE_TRAINING_RHYTHM",
            Self::RevisionConflict => "REVISION_CONFLICT",
            Self::RevisionRequired => "REVISION_REQUIRED",
            Self::TemplateAlreadyExists => "TEMPLATE_ALREADY_EXISTS",
            Self::TemplateInUse => "TEMPLATE_IN_USE",
            Self::TemplateNotFound => "TEMPLATE_NOT_FOUND",
            Self::TrainingDayConflict => "TRAINING_DAY_CONFLICT",
            Self::TrainingSessionNotFound => "TRAINING_SESSION_NOT_FOUND",
            Self::WriteBusy => "WRITE_BUSY",
        }
    }

    /// Parses the wire form; `None` for codes this runtime does not know.
    pub fn from_wire(code: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|candidate| candidate.as_str() == code)
    }
}

impl fmt::Display for AthriaErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Structured Athria failure mirroring the TypeScript `AthriaError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AthriaError {
    code: AthriaErrorCode,
    message: String,
    status: u16,
}

/// Result alias used across the runtime; defaults to [`AthriaError`].
pub type Result<T, E = AthriaError> = std::result::Result<T, E>;

impl AthriaError {
    /// `status` defaults to 400, matching the TypeScript constructor.
    pub fn new(code: AthriaErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), status: 400 }
    }

    /// Overrides the transport status, for example 409 for snapshot changes.
    pub fn with_status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }

    pub fn code(&self) -> AthriaErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn status(&self) -> u16 {
        self.status
    }
}

impl fmt::Display for AthriaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AthriaError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_round_trips_through_its_wire_form() {
        for code in AthriaErrorCode::ALL {
            assert_eq!(AthriaErrorCode::from_wire(code.as_str()), Some(code));
        }
    }

    #[test]
    fn wire_form_is_sorted_and_free_of_duplicates() {
        let strings: Vec<&str> = AthriaErrorCode::ALL.iter().map(|code| code.as_str()).collect();
        for pair in strings.windows(2) {
            assert!(pair[0] < pair[1], "{} must sort before {}", pair[0], pair[1]);
        }
    }

    #[test]
    fn unknown_wire_codes_are_rejected() {
        assert_eq!(AthriaErrorCode::from_wire("NOT_A_CODE"), None);
        assert_eq!(AthriaErrorCode::from_wire("input_snapshot_changed"), None);
    }

    #[test]
    fn defaults_match_the_typescript_contract() {
        let error = AthriaError::new(AthriaErrorCode::TemplateNotFound, "Template missing.");
        assert_eq!(error.status(), 400);
        assert_eq!(error.to_string(), "TEMPLATE_NOT_FOUND: Template missing.");

        let conflict = error.with_status(409);
        assert_eq!(conflict.status(), 409);
        assert_eq!(conflict.code().as_str(), "TEMPLATE_NOT_FOUND");
    }
}
