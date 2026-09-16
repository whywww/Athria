# Backup and restore

The Dashboard checkpoints SQLite and saves a self-contained `.sqlite3` copy at the path selected in the Save dialog. The service CLI accepts the destination as `athria-service backup TARGET.sqlite3`.

Training records and import history stored in SQLite are included. Operating-system credential-manager secrets are deliberately excluded, so credentials must be re-entered after restoring under another account.

Restore makes a validated Athria `.sqlite3` file the active database. Select a file in Settings to review its record counts, then confirm; Athria records the selected path, stops the local service, and restarts with that file. The selected file is not copied or moved, the previous database file is left untouched on disk, and the active database path becomes the selected file's path. Athria runs its database from the selected location, so that folder must stay writable and available.

Restore rejects missing files, non-`.sqlite3` paths, corrupt SQLite databases, and databases without an Athria schema. Validation runs against a temporary copy, so the selected source file is never modified. Databases created by older Athria versions are migrated in place the next time Athria opens them.

Older `dataDir` configuration remains readable as `<dataDir>/athria.sqlite3`; existing companion folders are left untouched but are no longer created or managed.

Pre-v0.1 databases are incompatible with this MVP and have no migration or recovery path. They are not deleted automatically during development; final cutover deletion is a separate, explicit acceptance step.
