//! Persistence port for the Athria runtime, the Rust port target of the
//! `AthriaStore` interface in `packages/application/src/store.ts`.
//!
//! Phase 2 established the crate boundary. Phase 3 added [`SqliteStore`], a
//! rusqlite implementation that owns the Rust compatibility baseline
//! (schema version 24). Phase 5 adds the training-session
//! reconciliation engine, the planned-session projection and the remaining
//! entity writes, all ported from `packages/data/src/index.ts` with the same
//! observable behavior. Opening an unsupported development version fails with
//! `SCHEMA_VERSION_UNSUPPORTED`; fresh databases and future migrations are
//! authoritative here. Encrypted vault persistence is also owned here while
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
