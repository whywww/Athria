import { existsSync, mkdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { AthriaError } from "@athria/application";
import { AthriaRepository, type VaultEnvelope } from "@athria/data";

export interface NewProfileVault { databaseUuid: string; envelope: VaultEnvelope }

export function createProfileDatabase(databasePath: string, targetPath: string, vault?: NewProfileVault): string {
  const active = resolve(databasePath);
  const target = resolve(targetPath);
  if (extname(target).toLowerCase() !== ".sqlite3") throw new AthriaError("INVALID_PROFILE_PATH", "The new database file must end in .sqlite3.");
  if (target === active) throw new AthriaError("INVALID_PROFILE_PATH", "The active Athria database cannot be replaced by a new profile.");
  if (existsSync(target)) throw new AthriaError("INVALID_PROFILE_PATH", "A file already exists at this path. Choose a different file name.");
  mkdirSync(dirname(target), { recursive: true });
  // A fresh database is created exactly like a first launch: the full current
  // schema is migrated in, and no profile row exists yet, so profile reads
  // fall back to the defaults until the athlete fills in their information.
  const repository = new AthriaRepository(target);
  // The desktop shell pre-generates the vault identity so a new profile is
  // protected by its database password from the first launch.
  if (vault) {
    repository.sqlite.query("UPDATE vault_meta SET database_uuid = ?").run(vault.databaseUuid);
    repository.initializeVault(vault.envelope, []);
  }
  repository.close();
  return target;
}
