import { afterEach, describe, expect, test } from "vitest";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AthriaRepository } from "@athria/data";
import { previewBackup } from "./backup";

let root = "";
let repository: AthriaRepository | undefined;
afterEach(() => { repository?.close(); repository = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = ""; });

function setup(): { databasePath: string } {
  root = join(tmpdir(), `athria-backup-test-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const databasePath = join(root, "athria.sqlite3");
  repository = new AthriaRepository(databasePath);
  return { databasePath };
}

// Manual backups are plain file copies, so tests stage their sources the same way a user would.
function manualBackup(databasePath: string, targetPath: string): string {
  repository!.checkpoint();
  copyFileSync(databasePath, targetPath);
  return targetPath;
}

describe("Athria backup validation", () => {
  test("previews a manually copied SQLite database", () => {
    const { databasePath } = setup();
    const path = manualBackup(databasePath, join(root, "backup.sqlite3"));
    const preview = previewBackup(path, databasePath);
    expect(preview.counts).toEqual({ workouts: 0, templates: 0, plans: 0 });
  });

  test("preview does not modify the selected source", () => {
    const { databasePath } = setup();
    const source = manualBackup(databasePath, join(root, "source.sqlite3"));
    const before = readFileSync(source);
    expect(previewBackup(source, databasePath).path).toBe(source);
    expect(readFileSync(source)).toEqual(before);
  });

  test.each(["not-sqlite.txt", "invalid.sqlite3"])("rejects invalid source %s", (name) => {
    const { databasePath } = setup();
    const path = join(root, name);
    writeFileSync(path, "not a database");
    expect(() => previewBackup(path, databasePath)).toThrow();
  });
});

describe("backup connection vault", () => {
  test("includes encrypted connection rows without adding plaintext export rows", () => {
    const { databasePath } = setup();
    repository!.initializeVault({ formatVersion: 1, kdfAlgorithm: "argon2id", kdfMemoryKib: 65536, kdfIterations: 3, kdfParallelism: 1, salt: "salt", wrapNonce: "wrap", wrappedMasterKey: "wrapped", checkNonce: "check", checkCiphertext: "checked" }, [
      { source: "intervals", config: { athleteId: "i12345" }, cipherVersion: 1, nonce: "nonce", ciphertext: "encrypted-api-key" },
    ]);
    const path = manualBackup(databasePath, join(root, "backup.sqlite3"));
    expect(previewBackup(path, databasePath).includesCredentials).toBe(true);
    expect(repository!.sqlite.query("SELECT COUNT(*) AS count FROM connection_credentials").get()).toEqual({ count: 0 });
    expect(readFileSync(path).includes(Buffer.from("icu-secret"))).toBe(false);
  });
});
