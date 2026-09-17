//! Schema-shape normalizers: the Rust port target of `packages/schemas`.
//!
//! The TypeScript schemas do two jobs: they reject malformed input and they
//! rebuild the parsed document with defaults applied in schema declaration
//! order (Zod's `parse` output). Every business write in Athria passes through
//! them, so byte-identical stored documents depend on reproducing that second
//! job faithfully — which is what this module does for the documents the
//! application and store layers exchange.
//!
//! Validation failures carry [`crate::AthriaErrorCode::InvalidData`]; the
//! transports own user-facing message formatting.

pub mod common;
pub mod plan;
pub mod profile;
pub mod session;
pub mod template;
pub mod wellness;

pub use plan::{
    PLAN_SCHEMA_VERSION, parse_current_plan, parse_current_plan_write, parse_mesocycle,
    parse_next_training_day_write, parse_planned_session, parse_planned_session_action,
};
pub use profile::{
    PersonalInformationWrite, ProfileUpdate, merge_profile, normalize_note,
    parse_personal_information, parse_profile, parse_profile_update, parse_race_days,
    parse_training_rhythm,
};
pub use session::parse_training_session;
pub use template::{
    builtin_session_template, parse_session_template, parse_session_template_create,
    parse_session_template_update, stored_session_template, template_variables,
};
pub use wellness::{
    WELLNESS_FIELD_ORDER, WellnessPatch, parse_wellness_patch, parse_wellness_record,
};
