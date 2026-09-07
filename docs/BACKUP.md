# Backup and restore

The Dashboard or `athria-service.exe backup` checkpoints SQLite and creates a timestamped ZIP under `%LOCALAPPDATA%\Athria\data\backups`.

Backups include the SQLite database, a versioned manifest, and retained import files when present. Windows Credential Manager secrets are deliberately excluded. Re-enter Intervals.icu credentials after restoring to another Windows account.

Restore requires an empty destination directory and rejects absolute paths and ZIP entries that escape the destination. Test the restored database before replacing an active data directory. Stop Athria before any final directory switch.

Pre-v0.1 databases are incompatible with this MVP and have no migration or recovery path. They are not deleted automatically during development; final cutover deletion is a separate, explicit acceptance step.
