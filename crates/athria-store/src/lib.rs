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

pub mod clock;
pub mod sessions;
pub mod tz;
pub mod vocab;
mod planned;
mod store;

pub use athria_core::{AthriaError, AthriaErrorCode, Result};
pub use clock::{Clock, FixedClock, SystemClock};
pub use sessions::{ReplaceSourceSessionsInput, WriteCounts};
pub use store::{DEFAULT_OWNER_ID, RecordImportBatchInput, SUPPORTED_SCHEMA_VERSION, SqliteStore};
