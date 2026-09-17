//! Training-data integrations, the Rust port target of `packages/integrations`:
//! Hevy CSV parsing, Intervals.icu and Xunji normalization.
//!
//! Phase 2 establishes the crate boundary only. When ported (Phase 6), parsing
//! and normalization must stay fixture-compatible with the TypeScript code
//! (timezone behavior, sync date windows, partial failure semantics). Network
//! transport stays in this crate behind an injectable client, while credential
//! access belongs to the runtime/platform layer, never to the application.

pub use athria_core::{AthriaError, AthriaErrorCode, Result};
