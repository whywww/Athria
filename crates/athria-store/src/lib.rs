//! Persistence port for the Athria runtime, the Rust port target of the
//! `AthriaStore` interface in `packages/application/src/store.ts`.
//!
//! Phase 2 establishes the crate boundary only. The store trait and the
//! rusqlite implementation arrive in Phase 3, together with TypeScript/Rust
//! database compatibility fixtures. Implementations own BEGIN IMMEDIATE
//! transaction semantics, surface failures as [`athria_core::AthriaErrorCode`]
//! codes, and never leak SQL or connection handles to callers.

pub use athria_core::{AthriaError, AthriaErrorCode, Result};
