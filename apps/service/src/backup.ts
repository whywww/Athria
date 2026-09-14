import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { AthriaError } from "@athria/application";
import { AthriaRepository } from "@athria/data";

export interface BackupPreview {
  path: string;
  counts: { workouts: number; templates: number; plans: number };
}

function requireSqliteFile(path: string): string {
  const resolved = resolve(path);
  if (extname(resolved).toLowerCase() !== ".sqlite3" || !statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
    throw new AthriaError("INVALID_BACKUP", "Select an existing .sqlite3 file.");
  }
  return resolved;
}

function requireAthriaSchema(path: string): void {
  let sqlite: Database | undefined;
  try {
    // This is always a disposable staged copy. A read-write handle is required
    // for WAL-mode databases whose shared-memory sidecar is not copied.
    sqlite = new Database(path, { create: false, readwrite: true });
    const integrity = sqlite.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null;
    if (integrity?.integrity_check !== "ok") throw new Error("SQLite integrity check failed");
    if (!sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'athria_migrations'").get()) throw new Error("Athria schema was not found");
  } catch (error) {
    throw new AthriaError("INVALID_BACKUP", `The selected database is not a valid Athria database: ${error instanceof Error ? error.message : String(error)}`);
  } finally { sqlite?.close(); }
}

function validateStaged(path: string, sourcePath: string): BackupPreview {
  requireAthriaSchema(path);
  let restored: AthriaRepository | undefined;
  try {
    restored = new AthriaRepository(path);
    const integrity = restored.sqlite.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null;
    if (integrity?.integrity_check !== "ok") throw new Error("SQLite integrity check failed");
    restored.checkpoint();
    const counts = restored.counts();
    return { path: sourcePath, counts: { workouts: counts.training_sessions ?? 0, templates: counts.session_templates ?? 0, plans: counts.current_mesocycles ?? 0 } };
  } catch (error) {
    throw new AthriaError("INVALID_BACKUP", `The selected database could not be opened: ${error instanceof Error ? error.message : String(error)}`);
  } finally { restored?.close(); }
}

export function createBackup(repository: AthriaRepository, databasePath: string, targetPath: string): string {
  const source = resolve(databasePath);
  const target = resolve(targetPath);
  if (extname(target).toLowerCase() !== ".sqlite3") throw new AthriaError("INVALID_BACKUP_PATH", "Backup filenames must end in .sqlite3.");
  if (source === target) throw new AthriaError("INVALID_BACKUP_PATH", "The active Athria database cannot be overwritten by a backup.");
  mkdirSync(dirname(target), { recursive: true });
  repository.checkpoint();
  copyFileSync(source, target);
  return target;
}

function stagedPath(databasePath: string, purpose: "preview" | "restore"): string {
  return resolve(dirname(databasePath), `.athria-${purpose}-${crypto.randomUUID()}.sqlite3`);
}

export function previewBackup(path: string, databasePath: string): BackupPreview {
  const source = requireSqliteFile(path);
  const target = stagedPath(databasePath, "preview");
  try { copyFileSync(source, target); return validateStaged(target, source); }
  finally { rmSync(target, { force: true }); rmSync(`${target}-wal`, { force: true }); rmSync(`${target}-shm`, { force: true }); }
}

export function prepareRestore(path: string, repository: AthriaRepository, databasePath: string): { stagePath: string; preview: BackupPreview } {
  const source = requireSqliteFile(path);
  if (source === resolve(databasePath)) throw new AthriaError("INVALID_BACKUP", "The selected database is already active.");
  const stagePath = stagedPath(databasePath, "restore");
  try {
    copyFileSync(source, stagePath);
    const preview = validateStaged(stagePath, source);
    repository.checkpoint();
    return { stagePath, preview };
  } catch (error) {
    rmSync(stagePath, { force: true }); rmSync(`${stagePath}-wal`, { force: true }); rmSync(`${stagePath}-shm`, { force: true });
    throw error;
  }
}
