//! MCP transport adapter, the Rust port target of `packages/mcp`.
//!
//! Phase 2 establishes the crate boundary only; the tool registry and the
//! stdio/HTTP servers move here in Phase 8 with byte-compatible tool names,
//! input schemas, output shapes, readOnly/idempotent annotations and error
//! codes, so existing AI clients and skills keep working unchanged.

pub use athria_core::{AthriaError, AthriaErrorCode, Result};
