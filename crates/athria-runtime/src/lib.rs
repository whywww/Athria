//! Composition root for the shared Athria runtime used by the desktop app,
//! the CLI, the MCP servers and (later) mobile shells.
//!
//! Phase 2 establishes the crate boundary only. This crate wires store,
//! application, integrations and transports together and must never depend on
//! Tauri, Bun or any other shell: `athria doctor`, `athria mcp` and
//! `athria serve` (Phase 9) exist to prove the runtime stands alone.

pub use athria_core::{AthriaError, AthriaErrorCode, Result};

use std::path::PathBuf;

/// Platform-neutral CLI configuration. Platform directory discovery remains
/// in shell adapters; the standalone runtime accepts an explicit argument or
/// `ATHRIA_DATABASE_PATH` and otherwise uses a local working database.
pub fn database_path(argument: Option<&str>) -> PathBuf {
    argument.map(PathBuf::from)
        .or_else(|| std::env::var_os("ATHRIA_DATABASE_PATH").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("athria.sqlite3"))
}

pub fn doctor(path: &std::path::Path) -> Result<serde_json::Value> {
    let store = athria_store::SqliteStore::open(path)?;
    Ok(serde_json::json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION"), "databasePath": path, "database": store.counts()? }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn explicit_database_path_wins() { assert_eq!(database_path(Some("chosen.sqlite3")), PathBuf::from("chosen.sqlite3")); }
    #[test] fn doctor_opens_a_compatible_database() { let path = std::env::temp_dir().join(format!("athria-runtime-doctor-{}.sqlite3", std::process::id())); let value = doctor(&path).unwrap(); assert_eq!(value["status"], "ok"); std::fs::remove_file(path).unwrap(); }
}
