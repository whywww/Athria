//! Athria application use cases, the Rust port of `packages/application`.
//!
//! [`AthriaApplication`] owns every business read and write, including the
//! commit boundary for Hevy, intervals.icu and Xunji. Network and credential
//! access remain runtime adapters. The MCP tool registry arrives in Phase 8.
//! It depends only on the [`AthriaStore`] port, deterministic core and pure
//! integration adapters, so desktop, CLI and mobile shells run the same use
//! cases.
//!
//! Transports (Tauri IPC, MCP, CLI, HTTP) depend on this crate, never the
//! reverse.

pub mod app;
pub mod catalog;
pub mod store;

/// `PLAN_SCHEMA_VERSION` in `packages/schemas`.
pub const PLAN_SCHEMA_VERSION: &str = "7.0";

/// `TEMPLATE_CATALOG_VERSION` in `packages/schemas`.
pub const TEMPLATE_CATALOG_VERSION: &str = "2.0";

pub use app::AthriaApplication;
pub use athria_core::{AthriaError, AthriaErrorCode, Result};
pub use catalog::{builtin_session_templates, builtin_template};
pub use store::{
    AthriaStore, RecordImportBatchInput, ReplaceSourceSessionsInput, SaveCurrentPlannedSessionsInput, UpdateCurrentPlannedSessionsInput, WriteCounts,
};
