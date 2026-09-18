//! Composition root for the shared Athria runtime used by the desktop app,
//! the CLI, the MCP servers and (later) mobile shells.
//!
//! Phase 2 establishes the crate boundary only. This crate wires store,
//! application, integrations and transports together and must never depend on
//! Tauri or any other native shell: `athria doctor`, `athria mcp` and
//! `athria serve` (Phase 9) exist to prove the runtime stands alone.

pub use athria_core::{AthriaError, AthriaErrorCode, Result};

use athria_application::AthriaApplication;
use athria_integrations::{HttpClient, HttpRequest, HttpResponse};
use athria_store::SqliteStore;
use athria_vault::VaultEnvelope;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct WorkspaceId(String);
impl WorkspaceId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkspaceLocation {
    LocalDatabase(PathBuf),
    /// Opaque document identity owned by an iOS/Android shell. It is not a
    /// filesystem path and is never passed to application/domain code.
    PlatformDocument(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceHandle {
    id: WorkspaceId,
    location: WorkspaceLocation,
}
impl WorkspaceHandle {
    pub fn id(&self) -> &WorkspaceId {
        &self.id
    }
    pub fn location(&self) -> &WorkspaceLocation {
        &self.location
    }
}

pub struct OpenWorkspace {
    pub handle: WorkspaceHandle,
    pub application: AthriaApplication<SqliteStore>,
}

pub fn open_local_workspace(path: impl Into<PathBuf>) -> Result<OpenWorkspace> {
    let path = path.into();
    let store = SqliteStore::open(&path)?;
    let id = WorkspaceId(store.database_uuid()?);
    Ok(OpenWorkspace {
        handle: WorkspaceHandle {
            id,
            location: WorkspaceLocation::LocalDatabase(path),
        },
        application: AthriaApplication::new(store),
    })
}

/// Mobile/platform shells may open or hydrate SQLite themselves, then hand an
/// already-open store to the shared runtime with an opaque document handle.
pub fn open_workspace_store(
    id: impl Into<String>,
    location: WorkspaceLocation,
    store: SqliteStore,
) -> OpenWorkspace {
    OpenWorkspace {
        handle: WorkspaceHandle {
            id: WorkspaceId(id.into()),
            location,
        },
        application: AthriaApplication::new(store),
    }
}

/// Platform-neutral CLI configuration. Platform directory discovery remains
/// in shell adapters; the standalone runtime accepts an explicit argument or
/// `ATHRIA_DATABASE_PATH` and otherwise uses a local working database.
pub fn database_path(argument: Option<&str>) -> PathBuf {
    argument
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("ATHRIA_DATABASE_PATH").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("athria.sqlite3"))
}

pub fn doctor(path: &std::path::Path) -> Result<serde_json::Value> {
    let workspace = open_local_workspace(path)?;
    Ok(
        serde_json::json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION"), "workspaceId": workspace.handle.id().as_str(), "databasePath": path, "database": workspace.application.store().counts()? }),
    )
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCounts {
    pub workouts: i64,
    pub templates: i64,
    pub plans: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    pub path: String,
    pub counts: BackupCounts,
    pub includes_credentials: bool,
}

pub fn preview_backup(source: &Path, staging_directory: &Path) -> Result<BackupPreview> {
    if !source.is_absolute()
        || !source.is_file()
        || source
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("sqlite3"))
    {
        return Err(AthriaError::new(
            AthriaErrorCode::InvalidData,
            "Select an existing .sqlite3 file.",
        ));
    }
    fs::create_dir_all(staging_directory)
        .map_err(|error| AthriaError::new(AthriaErrorCode::InvalidData, error.to_string()))?;
    let stage = staging_directory.join(format!(".athria-preview-{}.sqlite3", Uuid::new_v4()));
    fs::copy(source, &stage).map_err(|error| {
        AthriaError::new(
            AthriaErrorCode::InvalidData,
            format!("The selected database could not be staged: {error}"),
        )
    })?;
    let result = (|| {
        let store = SqliteStore::open(&stage)?;
        let counts = store.counts()?;
        let vault = store.get_vault()?;
        let preview = BackupPreview {
            path: source.to_string_lossy().into_owned(),
            counts: BackupCounts {
                workouts: counts["training_sessions"].as_i64().unwrap_or(0),
                templates: counts["session_templates"].as_i64().unwrap_or(0),
                plans: counts["current_mesocycles"].as_i64().unwrap_or(0),
            },
            includes_credentials: !vault.secrets.is_empty(),
        };
        store.close();
        Ok(preview)
    })();
    let _ = fs::remove_file(&stage);
    let _ = fs::remove_file(stage.with_extension("sqlite3-wal"));
    let _ = fs::remove_file(stage.with_extension("sqlite3-shm"));
    result
}

pub fn create_local_workspace(
    target: &Path,
    database_uuid: &str,
    envelope: &VaultEnvelope,
) -> Result<PathBuf> {
    if target.exists() {
        return Err(AthriaError::new(
            AthriaErrorCode::InvalidData,
            "A file already exists at this path. Choose a different file name.",
        ));
    }
    let parent = target.parent().ok_or_else(|| {
        AthriaError::new(
            AthriaErrorCode::InvalidData,
            "The selected path has no parent folder.",
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| AthriaError::new(AthriaErrorCode::InvalidData, error.to_string()))?;
    let stage = parent.join(format!(".athria-create-{}.sqlite3", Uuid::new_v4()));
    let created = (|| {
        let store = SqliteStore::open(&stage)?;
        store.set_database_uuid(database_uuid)?;
        store.initialize_vault(envelope, &[])?;
        store.checkpoint()?;
        store.close();
        let reopened = SqliteStore::open(&stage)?;
        if reopened.database_uuid()? != database_uuid {
            return Err(AthriaError::new(
                AthriaErrorCode::InvalidData,
                "The new workspace identity could not be verified.",
            ));
        }
        reopened.close();
        fs::rename(&stage, target).map_err(|error| {
            AthriaError::new(
                AthriaErrorCode::InvalidData,
                format!("The new workspace could not be finalized: {error}"),
            )
        })?;
        Ok(target.to_path_buf())
    })();
    if created.is_err() {
        let _ = fs::remove_file(&stage);
        let _ = fs::remove_file(stage.with_extension("sqlite3-wal"));
        let _ = fs::remove_file(stage.with_extension("sqlite3-shm"));
    }
    created
}

#[derive(Clone, Default)]
pub struct ReqwestHttpClient {
    client: reqwest::blocking::Client,
}
impl HttpClient for ReqwestHttpClient {
    fn send(&self, request: &HttpRequest) -> std::result::Result<HttpResponse, String> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|error| error.to_string())?;
        let mut builder = self
            .client
            .request(method, &request.url)
            .timeout(std::time::Duration::from_millis(request.timeout_ms));
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }
        let response = builder.send().map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let body = response
            .json()
            .map_err(|error| format!("Invalid server response: {error}"))?;
        Ok(HttpResponse { status, body })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use athria_vault::{create_envelope, new_master_key};
    #[test]
    fn explicit_database_path_wins() {
        assert_eq!(
            database_path(Some("chosen.sqlite3")),
            PathBuf::from("chosen.sqlite3")
        );
    }
    #[test]
    fn doctor_opens_a_compatible_database() {
        let path = std::env::temp_dir().join(format!(
            "athria-runtime-doctor-{}.sqlite3",
            std::process::id()
        ));
        let value = doctor(&path).unwrap();
        assert_eq!(value["status"], "ok");
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn workspace_identity_survives_reopening() {
        let path = std::env::temp_dir().join(format!(
            "athria-runtime-workspace-{}.sqlite3",
            std::process::id()
        ));
        let first = open_local_workspace(&path)
            .unwrap()
            .handle
            .id()
            .as_str()
            .to_owned();
        let second = open_local_workspace(&path)
            .unwrap()
            .handle
            .id()
            .as_str()
            .to_owned();
        assert_eq!(first, second);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn accepts_an_opaque_mobile_document_handle() {
        let workspace = open_workspace_store(
            "mobile-workspace",
            WorkspaceLocation::PlatformDocument("document:42".into()),
            SqliteStore::open_in_memory().unwrap(),
        );
        assert_eq!(workspace.handle.id().as_str(), "mobile-workspace");
        assert_eq!(
            workspace.handle.location(),
            &WorkspaceLocation::PlatformDocument("document:42".into())
        );
    }
    #[test]
    fn creates_and_previews_a_native_workspace_without_touching_source() {
        let root = std::env::temp_dir().join(format!("athria-native-workspace-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("workspace.sqlite3");
        let id = Uuid::new_v4().to_string();
        let key = new_master_key();
        let envelope = create_envelope(&id, "password", &key).unwrap();
        create_local_workspace(&path, &id, &envelope).unwrap();
        assert!(create_local_workspace(&path, &id, &envelope).is_err());
        let before = std::fs::read(&path).unwrap();
        let preview = preview_backup(&path, &root).unwrap();
        let after = std::fs::read(&path).unwrap();
        assert_eq!(
            preview.counts,
            BackupCounts {
                workouts: 0,
                templates: 0,
                plans: 0
            }
        );
        assert!(!preview.includes_credentials);
        assert_eq!(before, after);
        assert!(std::fs::read_dir(&root).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".athria-preview-")
        }));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn backup_preview_rejects_non_athria_sqlite() {
        let root = std::env::temp_dir().join(format!("athria-invalid-backup-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("not-athria.sqlite3");
        std::fs::write(&path, b"not sqlite").unwrap();
        assert!(preview_backup(&path, &root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
