import { copyFileSync, rmSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { AthriaError } from "@athria/application";
import { AthriaRepository } from "@athria/data";

export interface BackupPreview {
  path: string;
  counts: { workouts: number; templates: number; plans: number };
  includesCredentials: boolean;
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
    const credentials = restored.sqlite.query("SELECT COUNT(*) AS count FROM connection_secrets").get() as { count: number } | null;
    return { path: sourcePath, counts: { workouts: counts.training_sessions ?? 0, templates: counts.session_templates ?? 0, plans: counts.current_mesocycles ?? 0 }, includesCredentials: Number(credentials?.count ?? 0) > 0 };
  } catch (error) {
    throw new AthriaError("INVALID_BACKUP", `The selected database could not be opened: ${error instanceof Error ? error.message : String(error)}`);
  } finally { restored?.close(); }
}

function stagedPath(databasePath: string): string {
  return resolve(dirname(databasePath), `.athria-preview-${crypto.randomUUID()}.sqlite3`);
}

export function previewBackup(path: string, databasePath: string): BackupPreview {
  const source = requireSqliteFile(path);
  const target = stagedPath(databasePath);
  try { copyFileSync(source, target); return validateStaged(target, source); }
  finally { rmSync(target, { force: true }); rmSync(`${target}-wal`, { force: true }); rmSync(`${target}-shm`, { force: true }); }
}

