//! Persistence port for the Athria runtime, the Rust port target of the
//! `AthriaStore` interface in `packages/application/src/store.ts`.
//!
//! Phase 2 established the crate boundary. Phase 3 adds [`SqliteStore`]: a
//! rusqlite implementation that opens databases created by the TypeScript
//! `AthriaRepository` (schema version 24), reads every entity covered by the
//! cross-language compatibility fixtures, and performs the subset of writes
//! those fixtures exercise. It never silently changes the schema: opening an
//! unsupported version fails with `SCHEMA_VERSION_UNSUPPORTED`, and a fresh
//! database is created with the canonical v24 DDL captured from TypeScript.
//!
//! Still TypeScript-only until later phases: training-session reconciliation,
//! the planned-session projection, schema validation, snapshot hashing and
//! every vault/crypto operation (the Rust store only reads vault metadata).

mod store;

pub use athria_core::{AthriaError, AthriaErrorCode, Result};
pub use store::{DEFAULT_OWNER_ID, SUPPORTED_SCHEMA_VERSION, SqliteStore};
