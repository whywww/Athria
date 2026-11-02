//! Persistence port for the Athria runtime, the Rust port target of the
//! the shared `AthriaStore` interface.
//!
//! [`SqliteStore`] is the rusqlite implementation that owns the Rust
//! current schema (version 41), the training-session
//! reconciliation engine, planned-session projection, and entity writes with
//! stable application-facing behavior and error codes. Only the current schema
//! version opens; other versions fail with `SCHEMA_VERSION_UNSUPPORTED`.
//! Fresh database creation is authoritative here. Encrypted vault persistence is also owned here while
//! portable cryptography lives in `athria-vault`.

pub use athria_core::{clock, tz, vocab};

mod planned;
mod port;
pub mod sessions;
mod store;

pub use athria_application::{
    RecordImportBatchInput, ReplaceSourceSessionsInput, SaveCurrentPlannedSessionsInput,
    UpdateCurrentPlannedSessionsInput, WriteCounts,
};
pub use athria_core::{AthriaError, AthriaErrorCode, DEFAULT_OWNER_ID, Result};
pub use athria_vault::{EncryptedSecret, VaultBundle, VaultEnvelope};
pub use store::{SUPPORTED_SCHEMA_VERSION, SqliteStore};

mod review_context;
