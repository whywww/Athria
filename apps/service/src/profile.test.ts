import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AthriaRepository } from "@athria/data";
import { createProfileDatabase } from "./profile";

let root = "";
let repository: AthriaRepository | undefined;
afterEach(() => { repository?.close(); repository = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = ""; });

function setup(): { databasePath: string } {
  root = join(tmpdir(), `athria-profile-test-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const databasePath = join(root, "athria.sqlite3");
  repository = new AthriaRepository(databasePath);
  return { databasePath };
}

describe("Athria new profile database", () => {
  test("creates a fresh database with the current schema and an empty profile", () => {
    const { databasePath } = setup();
    const target = join(root, "fresh-profile.sqlite3");
    expect(createProfileDatabase(databasePath, target)).toBe(target);
    expect(existsSync(target)).toBe(true);
    const fresh = new AthriaRepository(target);
    try {
      expect(Object.values(fresh.counts()).every((count) => count === 0)).toBe(true);
      expect(fresh.sqlite.query("SELECT COUNT(*) AS count FROM profiles").get()).toEqual({ count: 0 });
      expect(fresh.sqlite.query("SELECT MAX(version) AS version FROM athria_migrations").get()).toEqual({ version: 24 });
    } finally { fresh.close(); }
  });

  test("writes the provided vault identity and envelope into a fresh database", () => {
    const { databasePath } = setup();
    const target = join(root, "vault-profile.sqlite3");
    const envelope = { formatVersion: 1, kdfAlgorithm: "argon2id", kdfMemoryKib: 65536, kdfIterations: 3, kdfParallelism: 1, salt: "salt", wrapNonce: "wrap", wrappedMasterKey: "wrapped", checkNonce: "check", checkCiphertext: "checked" };
    expect(createProfileDatabase(databasePath, target, { databaseUuid: "8c4ac6a3-6c4e-4e4a-9d5f-2b3a1c0d9e8f", envelope })).toBe(target);
    const fresh = new AthriaRepository(target);
    try {
      const vault = fresh.getVault();
      expect(vault.databaseUuid).toBe("8c4ac6a3-6c4e-4e4a-9d5f-2b3a1c0d9e8f");
      expect(vault.envelope).toEqual(envelope);
      expect(vault.secrets).toEqual([]);
    } finally { fresh.close(); }
  });

  test("rejects non-sqlite targets, the active database, and existing files", () => {
    const { databasePath } = setup();
    const nonSqlite = join(root, "notes.txt");
    expect(() => createProfileDatabase(databasePath, nonSqlite)).toThrow("end in .sqlite3");
    expect(() => createProfileDatabase(databasePath, databasePath)).toThrow("active Athria database");
    const existing = join(root, "existing.sqlite3");
    writeFileSync(existing, "keep me");
    expect(() => createProfileDatabase(databasePath, existing)).toThrow("already exists");
    expect(readFileSync(existing, "utf8")).toBe("keep me");
    expect(existsSync(nonSqlite)).toBe(false);
  });
});
