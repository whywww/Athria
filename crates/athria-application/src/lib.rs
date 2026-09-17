//! Athria application use cases, the Rust port target of `packages/application`.
//!
//! Phase 2 establishes the crate boundary only; use cases (profile, personal
//! information, wellness, sessions, tags, templates, current plan, planned
//! sessions, imports) move here in Phase 5 behind an `AthriaStore` trait.
//!
//! This crate depends on the store port and the deterministic core only.
//! Transports (Tauri IPC, MCP, CLI, HTTP) depend on this crate, never the
//! reverse, so the same validated use cases serve every shell.

pub use athria_core::{AthriaError, AthriaErrorCode, Result};
