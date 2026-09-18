//! Deterministic Athria domain core and authoritative domain vocabularies.
//!
//! This crate must stay free of platform, filesystem, network and SQLite
//! dependencies so every other runtime crate (and future mobile shells) can
//! link it. It consumes schema-validated JSON documents, and the golden
//! fixtures under `tests/fixtures` preserve its stable behavior.
//!
//! [`clock`] and [`tz`] are shared runtime services rather than pure formulas:
//! the injectable wall clock and the IANA time-zone helpers every store and
//! application use case needs.

pub mod adjustment;
pub mod clock;
pub mod date;
pub mod error;
pub mod hash;
pub mod metrics;
pub mod progression;
pub mod schedule;
pub mod schema;
pub mod tz;
pub mod validation;
pub mod vocab;

mod json;

/// Owner id of the single-user desktop application; byte-identical to
/// Stable owner identifier for local data.
pub const DEFAULT_OWNER_ID: &str = "local-user";

/// `JSON.stringify`-compatible number rendering: integral floats become
/// integers, so `3.0` serializes as `3`.
pub use json::number as js_number;

pub use adjustment::{
    AdjustmentAssessment, AdjustmentInput, AdjustmentTrigger, DataGap, DomainPerformanceEvidence,
    EvidenceAxis, EvidenceSeverity, FeasibilityStatus, HardOverride, HealthRecoveryEvidence,
    PerformanceStatus, PlannedSessionEvidence, ReasonCode, RecommendedScope, RecoveryStatus,
    ReviewReason, ReviewStatus, SessionOutcome, WeeklyReviewFacts, assess_adjustment,
};
pub use clock::{Clock, FixedClock, SystemClock};
pub use error::{AthriaError, AthriaErrorCode, Result};
pub use hash::{canonical, js_locale_compare, stable_hash};
pub use metrics::{
    DataQuality, EnduranceMetrics, MetricResult, StrengthMetrics, TimeRange, TrainingMetrics,
    calculate_heart_rate_zones, calculate_training_metrics, estimate_one_rep_max,
};
pub use progression::{
    DoubleProgressionInput, RpeAutoregulationInput, evaluate_double_progression,
    evaluate_rpe_autoregulation,
};
pub use schedule::{ScheduleOccurrence, expand_schedule};
pub use validation::{Coverage, PlanValidation, validate_plan};

/// Version of the deterministic formulas; byte-identical to `FORMULA_VERSION`
/// used by persisted plans.
pub const FORMULA_VERSION: &str = "0.2.0";

/// Plan-validation rule pack version; byte-identical to `RULE_VERSION` in
/// used by the built-in template catalog.
pub const RULE_VERSION: &str = "0.3.0";

/// Taxonomy version stamped into classified facts; byte-identical to
/// Stable taxonomy version.
pub const TAXONOMY_VERSION: &str = "strength-2.0";

/// Confidence an `ai_inferred` fact needs before a hard rule trusts it;
/// Confidence threshold used for hard validation decisions.
pub const AI_HARD_CONFIDENCE: f64 = 0.9;
