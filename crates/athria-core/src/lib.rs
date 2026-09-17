//! Deterministic Athria domain core, the Rust port target of `packages/core`
//! plus the hardcoded vocabularies of `packages/schemas`.
//!
//! This crate must stay free of platform, filesystem, network and SQLite
//! dependencies so every other runtime crate (and future mobile shells) can
//! link it. It consumes the same schema-validated JSON documents the
//! TypeScript core receives, which lets the golden fixtures under
//! `tests/fixtures` prove that both implementations agree until the
//! TypeScript core is retired.
//!
//! [`clock`] and [`tz`] are shared runtime services rather than pure formulas:
//! the injectable wall clock and the IANA time-zone helpers every store and
//! application use case needs.

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
/// `OWNER_ID` in `packages/schemas`.
pub const DEFAULT_OWNER_ID: &str = "local-user";

/// `JSON.stringify`-compatible number rendering: integral floats become
/// integers, so `3.0` serializes as `3`.
pub use json::number as js_number;

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
/// in `packages/schemas`.
pub const FORMULA_VERSION: &str = "0.2.0";

/// Plan-validation rule pack version; byte-identical to `RULE_VERSION` in
/// `packages/schemas`.
pub const RULE_VERSION: &str = "0.3.0";

/// Taxonomy version stamped into classified facts; byte-identical to
/// `TAXONOMY_VERSION` in `packages/schemas`.
pub const TAXONOMY_VERSION: &str = "strength-2.0";

/// Confidence an `ai_inferred` fact needs before a hard rule trusts it;
/// byte-identical to `AI_HARD_CONFIDENCE` in `packages/schemas`.
pub const AI_HARD_CONFIDENCE: f64 = 0.9;
