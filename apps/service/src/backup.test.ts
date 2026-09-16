import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AthriaRepository } from "@athria/data";
import { createBackup, previewBackup } from "./backup";

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

describe("Athria backup validation", () => {
  test("creates and previews a standalone SQLite backup", () => {
    const { databasePath } = setup();
    const path = createBackup(repository!, databasePath, join(root, "backup.sqlite3"));
    const preview = previewBackup(path, databasePath);
    expect(preview.counts).toEqual({ workouts: 0, templates: 0, plans: 0 });
  });

  test("preview does not modify the selected source", () => {
    const { databasePath } = setup();
    const source = createBackup(repository!, databasePath, join(root, "source.sqlite3"));
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

  test("rejects using the active database as a backup destination", () => {
    const { databasePath } = setup();
    expect(() => createBackup(repository!, databasePath, databasePath)).toThrow();
  });
});
