//! One local SQLite working copy per selected external database. The external
//! file is only read for hydration and replaced with a verified snapshot.
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use athria_store::SqliteStore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone)]
pub struct Replica {
    external: PathBuf,
    directory: PathBuf,
}

/// A shared lock prevents replacing a working database while any local
/// desktop or MCP process has it open.
pub struct Lease(File);

impl Drop for Lease {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplicaState {
    external_path: PathBuf,
    database_uuid: String,
    base_hash: String,
    working_hash: String,
    #[serde(default)]
    local_file_hash: Option<String>,
    last_published_at: Option<u128>,
    status: String,
    conflict_snapshot_hash: Option<String>,
    conflict_path: Option<PathBuf>,
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut block = [0u8; 64 * 1024];
    loop {
        let size = file.read(&mut block).map_err(|error| error.to_string())?;
        if size == 0 {
            break;
        }
        digest.update(&block[..size]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn optional_hash(path: &Path) -> Result<Option<String>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let main = sha256(path)?;
    let wal = PathBuf::from(format!("{}-wal", path.display()));
    if !wal.is_file() {
        return Ok(Some(main));
    }
    let mut digest = Sha256::new();
    digest.update(main.as_bytes());
    digest.update(b"sqlite-wal");
    digest.update(sha256(&wal)?.as_bytes());
    Ok(Some(format!("{:x}", digest.finalize())))
}

fn has_sidecars(path: &Path) -> bool {
    ["-wal", "-shm", "-journal"]
        .iter()
        .any(|suffix| PathBuf::from(format!("{}{suffix}", path.display())).exists())
}

fn lock_file(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(path)
        .map_err(|error| format!("Could not open database coordination lock: {error}"))
}

fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        };
        let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(format!(
                "Could not replace database file: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, target).map_err(|error| error.to_string())
    }
}

fn checked_store(path: &Path) -> Result<SqliteStore, String> {
    let store = SqliteStore::open_read_only(path).map_err(|error| error.message().to_owned())?;
    store
        .verify_integrity()
        .map_err(|error| error.message().to_owned())?;
    Ok(store)
}

impl Replica {
    pub fn new(config_root: &Path, external: &Path) -> Result<Self, String> {
        if !external.is_absolute() {
            return Err("The selected database path must be absolute.".into());
        }
        let name = external.to_string_lossy();
        #[cfg(windows)]
        let name = name.to_lowercase();
        let digest = Sha256::digest(name.as_bytes());
        let directory = config_root.join("replicas").join(format!("{:x}", digest));
        Ok(Self {
            external: external.to_path_buf(),
            directory,
        })
    }

    pub fn working_path(&self) -> PathBuf {
        self.directory.join("working.sqlite3")
    }
    fn state_path(&self) -> PathBuf {
        self.directory.join("state.json")
    }
    fn publish_lock_path(&self) -> PathBuf {
        self.directory.join("publish.lock")
    }
    fn session_lock_path(&self) -> PathBuf {
        self.directory.join("session.lock")
    }

    fn read_state(&self) -> Result<Option<ReplicaState>, String> {
        let path = self.state_path();
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        let state: ReplicaState =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if state.external_path != self.external {
            return Err("The replica metadata points to a different database.".into());
        }
        Ok(Some(state))
    }

    fn write_state(&self, state: &ReplicaState) -> Result<(), String> {
        let temporary = self
            .directory
            .join(format!("state-{}.tmp", Uuid::new_v4().simple()));
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
        let result = (|| {
            let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
            file.write_all(&bytes).map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            replace_file(&temporary, &self.state_path())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn snapshot(&self) -> Result<PathBuf, String> {
        let source = checked_store(&self.working_path())?;
        let snapshot = self
            .directory
            .join(format!("snapshot-{}.sqlite3", Uuid::new_v4().simple()));
        if let Err(error) = source
            .backup_to(&snapshot)
            .map_err(|error| error.message().to_owned())
            .and_then(|_| checked_store(&snapshot).map(|_| ()))
        {
            let _ = fs::remove_file(&snapshot);
            return Err(error);
        }
        Ok(snapshot)
    }

    /// Hydrate only when no other local process holds the working database.
    /// Existing unpublished data is never replaced by a changed external file.
    pub fn open(&self) -> Result<(PathBuf, Lease), String> {
        fs::create_dir_all(&self.directory).map_err(|error| error.to_string())?;
        let publisher = lock_file(&self.publish_lock_path())?;
        publisher.lock().map_err(|error| error.to_string())?;
        let session = lock_file(&self.session_lock_path())?;
        let can_replace = session.try_lock().is_ok();
        let result = (|| {
            let target_hash = optional_hash(&self.external)?;
            let mut state = self.read_state()?;
            if state.is_none() {
                if !can_replace {
                    return Err("The database is being opened by another process.".into());
                }
                let baseline = target_hash.ok_or(
                    "The selected database does not exist or has not finished downloading.",
                )?;
                if self.working_path().exists() {
                    return Err(
                        "A local database copy exists without metadata; it was preserved.".into(),
                    );
                }
                let source = checked_store(&self.external)?;
                let database_uuid = source
                    .database_uuid()
                    .map_err(|error| error.message().to_owned())?;
                let temporary = self.directory.join("hydrate.sqlite3");
                source
                    .backup_to(&temporary)
                    .map_err(|error| error.message().to_owned())?;
                checked_store(&temporary)?;
                if optional_hash(&self.external)?.as_deref() != Some(baseline.as_str()) {
                    let _ = fs::remove_file(&temporary);
                    return Err("The selected database changed while it was being opened.".into());
                }
                let working_hash = sha256(&temporary)?;
                replace_file(&temporary, &self.working_path())?;
                state = Some(ReplicaState {
                    external_path: self.external.clone(),
                    database_uuid,
                    base_hash: baseline,
                    working_hash,
                    local_file_hash: Some(sha256(&self.working_path())?),
                    last_published_at: None,
                    status: "ready".into(),
                    conflict_snapshot_hash: None,
                    conflict_path: None,
                });
            } else {
                let current = state.as_mut().expect("state is present");
                let working = checked_store(&self.working_path())?;
                if working
                    .database_uuid()
                    .map_err(|error| error.message().to_owned())?
                    != current.database_uuid
                {
                    return Err("The local database identity does not match its metadata.".into());
                }
                drop(working);
                if target_hash.as_deref() != Some(current.base_hash.as_str()) {
                    if can_replace {
                        let local = self.snapshot()?;
                        let local_hash = sha256(&local)?;
                        let _ = fs::remove_file(&local);
                        if local_hash == current.working_hash && current.status != "conflict" {
                            let baseline =
                                target_hash.ok_or("The selected database has disappeared.")?;
                            let source = checked_store(&self.external)?;
                            if source
                                .database_uuid()
                                .map_err(|error| error.message().to_owned())?
                                != current.database_uuid
                            {
                                return Err("The selected database has a different identity; switch to it explicitly.".into());
                            }
                            let temporary = self.directory.join("hydrate.sqlite3");
                            source
                                .backup_to(&temporary)
                                .map_err(|error| error.message().to_owned())?;
                            checked_store(&temporary)?;
                            if optional_hash(&self.external)?.as_deref() != Some(baseline.as_str())
                            {
                                let _ = fs::remove_file(&temporary);
                                return Err(
                                    "The selected database changed while it was being opened."
                                        .into(),
                                );
                            }
                            current.working_hash = sha256(&temporary)?;
                            replace_file(&temporary, &self.working_path())?;
                            current.local_file_hash = Some(sha256(&self.working_path())?);
                            current.base_hash = baseline;
                            current.status = "ready".into();
                        } else {
                            current.status = "conflict".into();
                        }
                    } else {
                        current.status = "remote_changed".into();
                    }
                }
            }
            self.write_state(state.as_ref().expect("state was initialized"))?;
            Ok(self.working_path())
        })();
        if can_replace {
            let _ = session.unlock();
        }
        let lease = if result.is_ok() {
            session
                .lock_shared()
                .map_err(|error| error.to_string())
                .map(|()| Lease(session))
        } else {
            Err("Could not open the selected database.".into())
        };
        let _ = publisher.unlock();
        result.and(lease.map(|lease| (self.working_path(), lease)))
    }

    pub fn publish_if_changed(&self) -> Result<bool, String> {
        fs::create_dir_all(&self.directory).map_err(|error| error.to_string())?;
        let publisher = lock_file(&self.publish_lock_path())?;
        publisher.lock().map_err(|error| error.to_string())?;
        let result = self.publish_locked();
        let _ = publisher.unlock();
        result
    }

    fn publish_locked(&self) -> Result<bool, String> {
        let mut state = self
            .read_state()?
            .ok_or("This database has no local replica metadata.")?;
        let local_hash = sha256(&self.working_path())?;
        if state.local_file_hash.as_deref() == Some(local_hash.as_str()) {
            return Ok(false);
        }
        let snapshot = self.snapshot()?;
        let result = (|| {
            let snapshot_hash = sha256(&snapshot)?;
            if snapshot_hash == state.working_hash {
                state.local_file_hash = Some(local_hash);
                self.write_state(&state)?;
                return Ok(false);
            }
            let target_hash = optional_hash(&self.external)?;
            if state.status == "conflict"
                || target_hash.as_deref() != Some(state.base_hash.as_str())
            {
                if state.conflict_snapshot_hash.as_deref() != Some(&snapshot_hash) {
                    let parent = self
                        .external
                        .parent()
                        .ok_or("The database target has no parent folder.")?;
                    let stem = self
                        .external
                        .file_stem()
                        .and_then(|name| name.to_str())
                        .unwrap_or("athria");
                    let machine = std::env::var("COMPUTERNAME")
                        .or_else(|_| std::env::var("HOSTNAME"))
                        .unwrap_or_else(|_| "device".into());
                    let machine: String = machine
                        .chars()
                        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
                        .collect();
                    let machine = if machine.is_empty() {
                        "device"
                    } else {
                        &machine
                    };
                    let conflict = parent.join(format!(
                        "{stem}-{}-{}-{}.sqlite3",
                        machine,
                        now_millis(),
                        Uuid::new_v4().simple()
                    ));
                    let saved = fs::copy(&snapshot, &conflict)
                        .map_err(|error| error.to_string())
                        .and_then(|_| checked_store(&conflict).map(|_| ()))
                        .and_then(|_| {
                            OpenOptions::new()
                                .write(true)
                                .open(&conflict)
                                .map_err(|error| error.to_string())?
                                .sync_all()
                                .map_err(|error| error.to_string())
                        });
                    if let Err(error) = saved {
                        let _ = fs::remove_file(&conflict);
                        return Err(error);
                    }
                    state.conflict_snapshot_hash = Some(snapshot_hash);
                    state.conflict_path = Some(conflict);
                }
                state.status = "conflict".into();
                state.local_file_hash = Some(local_hash);
                self.write_state(&state)?;
                return Ok(false);
            }
            let parent = self
                .external
                .parent()
                .ok_or("The database target has no parent folder.")?;
            if has_sidecars(&self.external) {
                return Err("The selected database has SQLite journal files or is still open elsewhere; it was not replaced.".into());
            }
            let temporary = parent.join(format!(
                ".athria-publish-{}.sqlite3",
                Uuid::new_v4().simple()
            ));
            let replacement = (|| {
                fs::copy(&snapshot, &temporary)
                    .map_err(|error| format!("Could not stage snapshot: {error}"))?;
                checked_store(&temporary)?;
                OpenOptions::new()
                    .write(true)
                    .open(&temporary)
                    .map_err(|error| format!("Could not open staged snapshot: {error}"))?
                    .sync_all()
                    .map_err(|error| format!("Could not flush staged snapshot: {error}"))?;
                if optional_hash(&self.external)?.as_deref() != Some(state.base_hash.as_str()) {
                    return Err("The target database changed before replacement.".into());
                }
                if has_sidecars(&self.external) {
                    return Err(
                        "The target database opened before replacement; it was not replaced."
                            .into(),
                    );
                }
                replace_file(&temporary, &self.external)
                    .map_err(|error| format!("Could not commit snapshot: {error}"))
            })();
            if replacement.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            replacement?;
            state.base_hash = snapshot_hash.clone();
            state.working_hash = snapshot_hash;
            state.local_file_hash = Some(local_hash);
            state.last_published_at = Some(now_millis());
            state.status = "ready".into();
            state.conflict_snapshot_hash = None;
            state.conflict_path = None;
            self.write_state(&state)?;
            Ok(true)
        })();
        let _ = fs::remove_file(&snapshot);
        result
    }

    pub fn status(&self) -> Result<Value, String> {
        let state = self
            .read_state()?
            .ok_or("This database has no local replica metadata.")?;
        Ok(json!({
            "databasePath": self.external,
            "workingPath": self.working_path(),
            "lastPublishedAt": state.last_published_at,
            "status": state.status,
            "conflictPath": state.conflict_path,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, PathBuf, Replica, Lease) {
        let root = std::env::temp_dir().join(format!("athria-replica-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&root).unwrap();
        let external = root.join("selected.sqlite3");
        drop(SqliteStore::open(&external).unwrap());
        let replica = Replica::new(&root.join("app"), &external).unwrap();
        let (_, lease) = replica.open().unwrap();
        (root, external, replica, lease)
    }

    fn write_record(path: &Path, day: &str) {
        let store = SqliteStore::open(path).unwrap();
        store
            .save_wellness(
                &json!({"ownerId":"local-user", "day":day, "updatedAt":"2026-09-25T00:00:00Z"}),
            )
            .unwrap();
    }

    #[test]
    fn publishes_only_changes_as_single_verified_file() {
        let (_root, external, replica, _lease) = fixture();
        assert_eq!(replica.status().unwrap()["lastPublishedAt"], Value::Null);
        assert!(!replica.publish_if_changed().unwrap());
        write_record(&replica.working_path(), "2026-09-25");
        assert!(replica.publish_if_changed().unwrap());
        assert!(
            replica.status().unwrap()["lastPublishedAt"]
                .as_u64()
                .is_some()
        );
        assert!(!replica.publish_if_changed().unwrap());
        let copied = external.with_file_name("independent.sqlite3");
        fs::copy(&external, &copied).unwrap();
        let read = checked_store(&copied).unwrap();
        assert!(
            read.get_wellness("local-user", "2026-09-25")
                .unwrap()
                .is_some()
        );
        assert!(!external.with_file_name("selected.sqlite3-wal").exists());
        assert!(!external.with_file_name("selected.sqlite3-shm").exists());
    }

    #[test]
    fn changed_target_produces_conflict_copy_and_preserves_last_publish_time() {
        let (_root, external, replica, _lease) = fixture();
        write_record(&replica.working_path(), "2026-09-25");
        assert!(replica.publish_if_changed().unwrap());
        let published = replica.status().unwrap()["lastPublishedAt"].clone();
        write_record(&external, "2026-09-26");
        write_record(&replica.working_path(), "2026-09-27");
        assert!(!replica.publish_if_changed().unwrap());
        let status = replica.status().unwrap();
        assert_eq!(status["status"], "conflict");
        assert_eq!(status["lastPublishedAt"], published);
        let conflict = PathBuf::from(status["conflictPath"].as_str().unwrap());
        assert!(
            checked_store(&conflict)
                .unwrap()
                .get_wellness("local-user", "2026-09-27")
                .unwrap()
                .is_some()
        );
        let target = checked_store(&external).unwrap();
        assert!(
            target
                .get_wellness("local-user", "2026-09-26")
                .unwrap()
                .is_some()
        );
        assert!(
            target
                .get_wellness("local-user", "2026-09-27")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn two_local_clients_share_the_copy_and_publish_each_others_writes() {
        let (_root, external, replica, _desktop_lease) = fixture();
        let (second_path, _mcp_lease) = replica.open().unwrap();
        assert_eq!(second_path, replica.working_path());
        write_record(&second_path, "2026-09-25");
        assert!(replica.publish_if_changed().unwrap());
        assert!(
            checked_store(&external)
                .unwrap()
                .get_wellness("local-user", "2026-09-25")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn restart_with_two_sided_changes_keeps_both_databases() {
        let (_root, external, replica, lease) = fixture();
        write_record(&replica.working_path(), "2026-09-25");
        write_record(&external, "2026-09-26");
        drop(lease);
        let (_, _reopened) = replica.open().unwrap();
        assert_eq!(replica.status().unwrap()["status"], "conflict");
        assert!(!replica.publish_if_changed().unwrap());
        assert!(
            checked_store(&external)
                .unwrap()
                .get_wellness("local-user", "2026-09-26")
                .unwrap()
                .is_some()
        );
        let status = replica.status().unwrap();
        let conflict = PathBuf::from(status["conflictPath"].as_str().unwrap());
        assert!(
            checked_store(&conflict)
                .unwrap()
                .get_wellness("local-user", "2026-09-25")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn unchanged_local_copy_can_accept_a_new_remote_version_on_restart() {
        let (_root, external, replica, lease) = fixture();
        write_record(&external, "2026-09-26");
        drop(lease);
        let (_, _reopened) = replica.open().unwrap();
        assert_eq!(replica.status().unwrap()["status"], "ready");
        assert!(
            checked_store(&replica.working_path())
                .unwrap()
                .get_wellness("local-user", "2026-09-26")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn unavailable_target_keeps_the_local_write_and_last_save_time() {
        let (_root, external, replica, _lease) = fixture();
        write_record(&replica.working_path(), "2026-09-25");
        fs::remove_file(&external).unwrap();
        assert!(!replica.publish_if_changed().unwrap());
        assert_eq!(replica.status().unwrap()["status"], "conflict");
        assert_eq!(replica.status().unwrap()["lastPublishedAt"], Value::Null);
        assert!(
            checked_store(&replica.working_path())
                .unwrap()
                .get_wellness("local-user", "2026-09-25")
                .unwrap()
                .is_some()
        );
    }

    #[cfg(windows)]
    #[test]
    fn locked_target_keeps_the_local_write_for_retry() {
        let (_root, external, replica, _lease) = fixture();
        write_record(&replica.working_path(), "2026-09-25");
        let held = SqliteStore::open_read_only(&external).unwrap();
        assert!(replica.publish_if_changed().is_err());
        drop(held);
        assert!(replica.publish_if_changed().unwrap());
        assert!(
            checked_store(&external)
                .unwrap()
                .get_wellness("local-user", "2026-09-25")
                .unwrap()
                .is_some()
        );
    }
}
