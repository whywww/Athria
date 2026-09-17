//! Composition root for the shared Athria runtime used by the desktop app,
//! the CLI, the MCP servers and (later) mobile shells.
//!
//! Phase 2 establishes the crate boundary only. This crate wires store,
//! application, integrations and transports together and must never depend on
//! Tauri, Bun or any other shell: `athria doctor`, `athria mcp` and
//! `athria serve` (Phase 9) exist to prove the runtime stands alone.

pub use athria_core::{AthriaError, AthriaErrorCode, Result};
