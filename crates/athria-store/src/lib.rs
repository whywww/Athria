//! Persistence port for the Athria runtime, the Rust port target of the
//! `AthriaStore` interface in `packages/application/src/store.ts`.
//!
//! Phase 2 established the crate boundary. Phase 3 added [`SqliteStore`], a
//! rusqlite implementation that opens databases created by the TypeScript
//! `AthriaRepository` (schema version 24). Phase 5 adds the training-session
//! reconciliation engine, the planned-session projection and the remaining
//! entity writes, all ported from `packages/data/src/index.ts` with the same
//! observable behavior. The store never changes the schema: opening an
//! unsupported version fails with `SCHEMA_VERSION_UNSUPPORTED`, and a fresh
//! database is created with the canonical v24 DDL captured from TypeScript.
//!
//! Still TypeScript-only until later phases: schema validation, snapshot
//! hashing and every vault/crypto operation (the Rust store only reads vault
//! metadata).

pub use athria_core::{clock, tz, vocab};

pub mod sessions;
mod planned;
mod port;
mod store;

pub use athria_application::{RecordImportBatchInput, ReplaceSourceSessionsInput, SaveCurrentPlannedSessionsInput, UpdateCurrentPlannedSessionsInput, WriteCounts};
pub use athria_core::{AthriaError, AthriaErrorCode, DEFAULT_OWNER_ID, Result};
pub use store::{SUPPORTED_SCHEMA_VERSION, SqliteStore};
