//! Composition root for the shared Athria runtime used by the desktop app,
//! the CLI, the MCP servers and (later) mobile shells.
//!
//! Phase 2 establishes the crate boundary only. This crate wires store,
//! application, integrations and transports together and must never depend on
//! Tauri, Bun or any other shell: `athria doctor`, `athria mcp` and
//! `athria serve` (Phase 9) exist to prove the runtime stands alone.

pub use athria_core::{AthriaError, AthriaErrorCode, Result};

use std::path::PathBuf;
use athria_application::AthriaApplication;
use athria_store::SqliteStore;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct WorkspaceId(String);
impl WorkspaceId { pub fn as_str(&self) -> &str { &self.0 } }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkspaceLocation {
    LocalDatabase(PathBuf),
    /// Opaque document identity owned by an iOS/Android shell. It is not a
    /// filesystem path and is never passed to application/domain code.
    PlatformDocument(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceHandle { id: WorkspaceId, location: WorkspaceLocation }
impl WorkspaceHandle {
    pub fn id(&self) -> &WorkspaceId { &self.id }
    pub fn location(&self) -> &WorkspaceLocation { &self.location }
}

pub struct OpenWorkspace {
    pub handle: WorkspaceHandle,
    pub application: AthriaApplication<SqliteStore>,
}

pub fn open_local_workspace(path: impl Into<PathBuf>) -> Result<OpenWorkspace> {
    let path = path.into();
    let store = SqliteStore::open(&path)?;
    let id = WorkspaceId(store.database_uuid()?);
    Ok(OpenWorkspace { handle: WorkspaceHandle { id, location: WorkspaceLocation::LocalDatabase(path) }, application: AthriaApplication::new(store) })
}

/// Mobile/platform shells may open or hydrate SQLite themselves, then hand an
/// already-open store to the shared runtime with an opaque document handle.
pub fn open_workspace_store(id: impl Into<String>, location: WorkspaceLocation, store: SqliteStore) -> OpenWorkspace {
    OpenWorkspace { handle: WorkspaceHandle { id: WorkspaceId(id.into()), location }, application: AthriaApplication::new(store) }
}

/// Platform-neutral CLI configuration. Platform directory discovery remains
/// in shell adapters; the standalone runtime accepts an explicit argument or
/// `ATHRIA_DATABASE_PATH` and otherwise uses a local working database.
pub fn database_path(argument: Option<&str>) -> PathBuf {
    argument.map(PathBuf::from)
        .or_else(|| std::env::var_os("ATHRIA_DATABASE_PATH").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("athria.sqlite3"))
}

pub fn doctor(path: &std::path::Path) -> Result<serde_json::Value> {
    let workspace = open_local_workspace(path)?;
    Ok(serde_json::json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION"), "workspaceId": workspace.handle.id().as_str(), "databasePath": path, "database": workspace.application.store().counts()? }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn explicit_database_path_wins() { assert_eq!(database_path(Some("chosen.sqlite3")), PathBuf::from("chosen.sqlite3")); }
    #[test] fn doctor_opens_a_compatible_database() { let path = std::env::temp_dir().join(format!("athria-runtime-doctor-{}.sqlite3", std::process::id())); let value = doctor(&path).unwrap(); assert_eq!(value["status"], "ok"); std::fs::remove_file(path).unwrap(); }
    #[test] fn workspace_identity_survives_reopening() { let path = std::env::temp_dir().join(format!("athria-runtime-workspace-{}.sqlite3", std::process::id())); let first = open_local_workspace(&path).unwrap().handle.id().as_str().to_owned(); let second = open_local_workspace(&path).unwrap().handle.id().as_str().to_owned(); assert_eq!(first, second); std::fs::remove_file(path).unwrap(); }
    #[test] fn accepts_an_opaque_mobile_document_handle() { let workspace = open_workspace_store("mobile-workspace", WorkspaceLocation::PlatformDocument("document:42".into()), SqliteStore::open_in_memory().unwrap()); assert_eq!(workspace.handle.id().as_str(), "mobile-workspace"); assert_eq!(workspace.handle.location(), &WorkspaceLocation::PlatformDocument("document:42".into())); }
}
