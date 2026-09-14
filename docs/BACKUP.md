# Backup and restore

The Dashboard checkpoints SQLite and saves a self-contained `.sqlite3` copy at the path selected in the Save dialog. The service CLI accepts the destination as `athria-service backup TARGET.sqlite3`.

Training records and import history stored in SQLite are included. Operating-system credential-manager secrets are deliberately excluded, so credentials must be re-entered after restoring under another account.

Restore is separate from opening another database. Select an Athria `.sqlite3` file in Settings to validate a temporary copy and review its record counts, then confirm replacement. The active database path does not change.

Athria prepares and migrates a copy beside the active database, stops the local service, and atomically replaces the active file. A transient rollback file protects only the replacement operation and is deleted after success; no retained safety backup is created. Athria then restarts automatically.

Restore rejects missing files, non-`.sqlite3` paths, corrupt SQLite databases, and databases without an Athria schema. Preview and preparation do not modify the selected source file.

Settings can also open an existing Athria `.sqlite3` database directly. The selected file is not copied or moved. Older `dataDir` configuration remains readable as `<dataDir>/athria.sqlite3`; existing companion folders are left untouched but are no longer created or managed.

Pre-v0.1 databases are incompatible with this MVP and have no migration or recovery path. They are not deleted automatically during development; final cutover deletion is a separate, explicit acceptance step.
