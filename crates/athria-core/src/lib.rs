//! Deterministic Athria domain core, the Rust port target of `packages/core`.
//!
//! This crate must stay free of platform, filesystem, network and SQLite
//! dependencies so every other runtime crate (and future mobile shells) can
//! link it. Phase 2 of the migration establishes the boundary and the shared
//! error model only; schedule expansion, training metrics, stable hashing and
//! plan validation move here in later phases, each verified against golden
//! fixtures produced by the TypeScript implementation.

pub mod error;

pub use error::{AthriaError, AthriaErrorCode, Result};
