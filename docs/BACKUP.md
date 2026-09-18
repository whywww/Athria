# Backup and restore

Backing up means copying the active `.sqlite3` database file, whose path is shown in Settings. Include the companion `-wal` and `-shm` files when they exist, or copy the database while Athria is closed, so no committed data is missed. A copied file behaves like any Athria database: it can be restored in Settings or opened on another computer.

A copied database contains the training records, import history, connection settings, and encrypted API keys. Each database has one `database_uuid`, one independent master key, and one database password. The master key is wrapped by the database password; when the user chooses "Remember on this computer", creates a new profile, or sets the password for the first time, the operating-system credential manager caches the master key under that database UUID so the database unlocks automatically on that machine. API keys are never written to a backup in plaintext.

Restore makes a validated Athria `.sqlite3` file the active database. Select a file in Settings to review its record counts, then confirm; Athria records the selected path, stops the local service, and restarts with that file. On another computer, Athria asks for the database password before it shows any data and unlocks saved connection keys with it; choosing "Remember on this computer" caches the unlocked master key in that computer's credential manager. The selected file is not copied or moved, the previous database file is left untouched on disk, and the active database path becomes the selected file's path.

The database password gates access inside Athria and unlocks saved connection keys. The `.sqlite3` file itself is not encrypted at rest, so store databases and backups in locations you trust.

A forgotten password cannot be recovered because the master key it wraps has no second key. The Unlock dialog offers "Forgot password?" to reset it: setting a new password wraps a fresh master key, keeps all training data, and permanently removes the saved connection keys that only the retired password could unlock. Re-enter the connection credentials in Connections afterwards.

Restore rejects missing files, non-`.sqlite3` paths, corrupt SQLite databases, and databases without an Athria schema. Validation runs against a temporary copy, so the selected source file is never modified. Databases created by older Athria versions are migrated in place the next time Athria opens them, and a database without a password is asked to set one on first open.

Create a new profile writes a fresh, empty Athria database to a location you choose and switches to it. Creation asks for the new database's password before the file is written. The new file receives the same schema as a first launch, contains no training data, and is created with its own database password, which Athria asks for when the database is opened on another computer. Athria records the selected path, stops the local service, and restarts with the new file; the previous database file is left untouched on disk. Creation rejects paths that already contain a file and paths that name the active database, so an existing backup or database is never replaced; pick a new file name instead.

Older `dataDir` configuration remains readable as `<dataDir>/athria.sqlite3`; existing companion folders are left untouched but are no longer created or managed.

Pre-v0.1 databases are incompatible with this MVP and have no migration or recovery path. They are not deleted automatically during development; final cutover deletion is a separate, explicit acceptance step.
