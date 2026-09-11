# Backup and restore

The Dashboard or `athria-service.exe backup` checkpoints SQLite and creates a timestamped ZIP under `%LOCALAPPDATA%\Athria\data\backups`.

Backups include the SQLite database, a versioned manifest, and retained import files when present. Windows Credential Manager secrets are deliberately excluded. Re-enter Intervals.icu credentials after restoring to another Windows account.

Restore is a separate action from changing the local data location. Select an Athria backup ZIP in Settings to validate its manifest and SQLite database, review its creation time, version, and record counts, and then confirm the replacement. The configured local data location does not change.

Before replacing current data, Athria creates a safety backup, prepares and validates the restored data beside the active directory, stops the local service, and switches directories. If the switch fails, Athria restores the original directory. After a successful restore, the safety backup is available in the restored data directory's `backups` folder and Athria restarts automatically.

Restore rejects archives with missing metadata or database files, invalid SQLite databases, absolute paths, and ZIP entries that escape the destination.

Pre-v0.1 databases are incompatible with this MVP and have no migration or recovery path. They are not deleted automatically during development; final cutover deletion is a separate, explicit acceptance step.
