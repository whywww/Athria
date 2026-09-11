import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { AthriaError } from "@athria/application";
import { AthriaRepository } from "@athria/data";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export interface BackupPreview {
  path: string;
  manifest: { athriaVersion: string; createdAt: string; secretsIncluded: false };
  counts: { workouts: number; templates: number; plans: number };
}

function safeEntries(path: string, currentVersion: string): { entries: Record<string, Uint8Array>; manifest: BackupPreview["manifest"] } {
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(new Uint8Array(readFileSync(path))); }
  catch { throw new AthriaError("INVALID_BACKUP", "The selected file is not a valid Athria backup ZIP."); }
  for (const name of Object.keys(entries)) {
    const normalized = name.replaceAll("\\", "/");
    if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
      throw new AthriaError("INVALID_BACKUP", "Backup contains an unsafe path.");
    }
  }
  const manifestBytes = entries["manifest.json"];
  if (!manifestBytes || !entries["athria.sqlite3"]) throw new AthriaError("INVALID_BACKUP", "Backup must contain manifest.json and athria.sqlite3.");
  try {
    const value = JSON.parse(strFromU8(manifestBytes)) as Partial<BackupPreview["manifest"]>;
    if (typeof value.athriaVersion !== "string" || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) throw new Error();
    const backupVersion = value.athriaVersion.split(".").map(Number);
    const runningVersion = currentVersion.split(".").map(Number);
    if (backupVersion.length < 2 || backupVersion.some(Number.isNaN) || backupVersion[0] !== runningVersion[0] || backupVersion[1]! > runningVersion[1]!) {
      throw new AthriaError("UNSUPPORTED_BACKUP_VERSION", `This backup was created by unsupported Athria version ${value.athriaVersion}.`);
    }
    return { entries, manifest: { athriaVersion: value.athriaVersion, createdAt: value.createdAt, secretsIncluded: false } };
  } catch (error) {
    if (error instanceof AthriaError) throw error;
    throw new AthriaError("INVALID_BACKUP", "Backup manifest is missing required Athria metadata.");
  }
}

async function extract(entries: Record<string, Uint8Array>, target: string): Promise<void> {
  mkdirSync(target, { recursive: true });
  for (const [name, content] of Object.entries(entries)) {
    const destination = resolve(target, name.replaceAll("\\", "/"));
    if (destination !== resolve(target) && !destination.startsWith(`${resolve(target)}${sep}`)) throw new AthriaError("INVALID_BACKUP", "Backup contains an unsafe path.");
    mkdirSync(dirname(destination), { recursive: true });
    await Bun.write(destination, content);
  }
}

function validateExtracted(path: string, manifest: BackupPreview["manifest"]): BackupPreview {
  let restored: AthriaRepository | undefined;
  try {
    restored = new AthriaRepository(join(path, "athria.sqlite3"));
    const integrity = restored.sqlite.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null;
    if (integrity?.integrity_check !== "ok") throw new Error("SQLite integrity check failed");
    const counts = restored.counts();
    return { path, manifest, counts: { workouts: counts.training_sessions ?? 0, templates: counts.session_templates ?? 0, plans: counts.current_mesocycles ?? 0 } };
  } catch (error) {
    throw new AthriaError("INVALID_BACKUP", `The backup database could not be opened: ${error instanceof Error ? error.message : String(error)}`);
  } finally { restored?.close(); }
}

export async function createBackup(repository: AthriaRepository, databasePath: string, dataDir: string, version: string): Promise<string> {
  repository.checkpoint();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(dataDir, "backups", `athria-backup-${stamp}.zip`);
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify({ athriaVersion: version, createdAt: new Date().toISOString(), secretsIncluded: false }, null, 2)),
  };
  if (statSync(databasePath, { throwIfNoEntry: false })?.isFile()) files["athria.sqlite3"] = new Uint8Array(await Bun.file(databasePath).arrayBuffer());
  const importsRoot = join(dataDir, "imports");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files[`imports/${relative(importsRoot, path).replaceAll("\\", "/")}`] = readFileSync(path);
    }
  };
  visit(importsRoot);
  await Bun.write(target, zipSync(files, { level: 6 }));
  return target;
}

export async function previewBackup(path: string, dataDir: string, version: string): Promise<BackupPreview> {
  const { entries, manifest } = safeEntries(path, version);
  const target = join(dirname(dataDir), `.athria-preview-${crypto.randomUUID()}`);
  try { await extract(entries, target); return { ...validateExtracted(target, manifest), path }; }
  finally { rmSync(target, { recursive: true, force: true }); }
}

export async function prepareRestore(path: string, repository: AthriaRepository, databasePath: string, dataDir: string, version: string): Promise<{ stagePath: string; safetyBackup: string; preview: BackupPreview }> {
  const { entries, manifest } = safeEntries(path, version);
  const stagePath = join(dirname(dataDir), `.athria-restore-${crypto.randomUUID()}`);
  try {
    await extract(entries, stagePath);
    const preview = validateExtracted(stagePath, manifest);
    for (const name of ["imports", "backups", "logs", "exports"]) mkdirSync(join(stagePath, name), { recursive: true });
    const safetyBackup = await createBackup(repository, databasePath, dataDir, version);
    copyFileSync(safetyBackup, join(stagePath, "backups", basename(safetyBackup)));
    return { stagePath, safetyBackup: basename(safetyBackup), preview: { ...preview, path } };
  } catch (error) {
    rmSync(stagePath, { recursive: true, force: true });
    throw error;
  }
}
