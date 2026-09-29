//! One-time removal of the working databases created by older desktop builds.
//! This deliberately does not publish unpublished writes to the selected file.
use std::{fs::{self, File, OpenOptions}, io::{Read, ErrorKind}, path::{Path, PathBuf}};

use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyState {
    external_path: PathBuf,
    conflict_path: Option<PathBuf>,
    conflict_snapshot_hash: Option<String>,
}

fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut block = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut block).map_err(|error| error.to_string())?;
        if read == 0 { break; }
        digest.update(&block[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove old Athria replica {}: {error}", path.display())),
    }
}

fn is_managed_file(name: &str) -> bool {
    matches!(name, "working.sqlite3" | "working.sqlite3-wal" | "working.sqlite3-shm" |
        "working.sqlite3-journal" | "hydrate.sqlite3" | "hydrate.sqlite3-wal" |
        "hydrate.sqlite3-shm" | "hydrate.sqlite3-journal" | "state.json" |
        "publish.lock" | "session.lock") ||
        (name.starts_with("snapshot-") &&
            (name.ends_with(".sqlite3") || name.ends_with(".sqlite3-wal") || name.ends_with(".sqlite3-shm"))) ||
        (name.starts_with("state-") && name.ends_with(".tmp"))
}

fn remove_verified_conflict(state: &LegacyState) -> Result<(), String> {
    let (Some(path), Some(expected)) = (&state.conflict_path, &state.conflict_snapshot_hash) else { return Ok(()); };
    if !path.is_absolute() || !state.external_path.is_absolute() || expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(());
    }
    let Some(parent) = state.external_path.parent() else { return Ok(()); };
    let Some(stem) = state.external_path.file_stem().and_then(|value| value.to_str()) else { return Ok(()); };
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else { return Ok(()); };
    if path.parent() != Some(parent) || !name.starts_with(&format!("{stem}-")) || !name.ends_with(".sqlite3") {
        return Ok(());
    }
    if !path.exists() { return Ok(()); }
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.is_symlink() || file_hash(path)? != *expected { return Ok(()); }
    remove_if_present(path)
}

fn cleanup_directory(directory: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(directory).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || metadata.is_symlink() { return Err("Unexpected entry in Athria's old replica directory.".into()); }
    let name = directory.file_name().and_then(|value| value.to_str()).unwrap_or_default();
    if name.len() != 64 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("Unrecognized entry in Athria's old replica directory: {}", directory.display()));
    }
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !metadata.is_file() || metadata.is_symlink() || !is_managed_file(&name) {
            return Err(format!("Unrecognized entry in Athria's old replica directory: {}", path.display()));
        }
        if name != "session.lock" { files.push(path); }
    }
    let lock_path = directory.join("session.lock");
    let lock = if lock_path.exists() {
        let lock = OpenOptions::new().read(true).write(true).open(&lock_path).map_err(|error| error.to_string())?;
        lock.try_lock().map_err(|_| "An older Athria or MCP process is still using the previous database copy. Close it and restart Athria.".to_string())?;
        Some(lock)
    } else { None };
    let state_path = directory.join("state.json");
    if state_path.exists() {
        let state: LegacyState = serde_json::from_slice(&fs::read(&state_path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Could not verify old Athria replica metadata: {error}"))?;
        let external = state.external_path.to_string_lossy();
        #[cfg(windows)]
        let external = external.to_lowercase();
        let digest = format!("{:x}", Sha256::digest(external.as_bytes()));
        if digest != name { return Err("Old Athria replica metadata does not match its directory.".into()); }
        remove_verified_conflict(&state)?;
    }
    for file in files { remove_if_present(&file)?; }
    drop(lock);
    remove_if_present(&lock_path)?;
    fs::remove_dir(directory).map_err(|error| format!("Could not remove old Athria replica directory: {error}"))
}

pub fn cleanup_legacy_replicas(config_root: &Path) -> Result<(), String> {
    let directory = config_root.join("replicas");
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_dir() || metadata.is_symlink() { return Err("Athria's old replica path is not a regular directory.".into()); }
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        cleanup_directory(&entry.map_err(|error| error.to_string())?.path())?;
    }
    fs::remove_dir(&directory).map_err(|error| format!("Could not remove old Athria replica storage: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("athria-cleanup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn removes_only_the_verified_managed_copy_and_preserves_selected_database() {
        let root = temp_root();
        let selected = root.join("selected.sqlite3");
        fs::write(&selected, b"selected").unwrap();
        let digest = format!("{:x}", Sha256::digest(selected.to_string_lossy().to_lowercase().as_bytes()));
        let directory = root.join("replicas").join(digest);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("working.sqlite3"), b"unpublished").unwrap();
        fs::write(directory.join("state.json"), serde_json::json!({"externalPath":selected,"conflictPath":null,"conflictSnapshotHash":null}).to_string()).unwrap();
        cleanup_legacy_replicas(&root).unwrap();
        assert_eq!(fs::read(&selected).unwrap(), b"selected");
        assert!(!root.join("replicas").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_unknown_files_without_deleting_them() {
        let root = temp_root();
        let directory = root.join("replicas").join("a".repeat(64));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("notes.txt"), b"keep").unwrap();
        assert!(cleanup_legacy_replicas(&root).is_err());
        assert!(directory.join("notes.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deletes_only_a_conflict_file_whose_recorded_hash_still_matches() {
        let root = temp_root();
        let selected = root.join("selected.sqlite3");
        fs::write(&selected, b"selected").unwrap();
        let unchanged = root.join("selected-device-1-first.sqlite3");
        let modified = root.join("selected-device-2-second.sqlite3");
        fs::write(&unchanged, b"old conflict").unwrap();
        fs::write(&modified, b"edited by user").unwrap();
        for (conflict, recorded_hash) in [
            (&unchanged, file_hash(&unchanged).unwrap()),
            (&modified, file_hash(&unchanged).unwrap()),
        ] {
            let digest = format!("{:x}", Sha256::digest(selected.to_string_lossy().to_lowercase().as_bytes()));
            let directory = root.join("replicas").join(digest);
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("working.sqlite3"), b"old copy").unwrap();
            fs::write(directory.join("state.json"), serde_json::json!({"externalPath":selected,"conflictPath":conflict,"conflictSnapshotHash":recorded_hash}).to_string()).unwrap();
            cleanup_legacy_replicas(&root).unwrap();
        }
        assert!(!unchanged.exists());
        assert!(modified.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_cleanup_while_an_older_process_holds_the_replica_lock() {
        let root = temp_root();
        let directory = root.join("replicas").join("a".repeat(64));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("working.sqlite3"), b"old copy").unwrap();
        let held = OpenOptions::new().read(true).write(true).create(true).open(directory.join("session.lock")).unwrap();
        held.lock().unwrap();
        assert!(cleanup_legacy_replicas(&root).unwrap_err().contains("still using"));
        assert!(directory.join("working.sqlite3").exists());
        drop(held);
        cleanup_legacy_replicas(&root).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
