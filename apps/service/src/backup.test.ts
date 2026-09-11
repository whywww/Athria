import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AthriaRepository } from "@athria/data";
import { strToU8, zipSync } from "fflate";
import { createBackup, previewBackup } from "./backup";

let root = "";
let repository: AthriaRepository | undefined;
afterEach(() => { repository?.close(); repository = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = ""; });

function setup(): { dataDir: string; databasePath: string } {
  root = join(tmpdir(), `athria-backup-test-${crypto.randomUUID()}`);
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "imports"), { recursive: true });
  mkdirSync(join(dataDir, "backups"), { recursive: true });
  const databasePath = join(dataDir, "athria.sqlite3");
  repository = new AthriaRepository(databasePath);
  return { dataDir, databasePath };
}

describe("Athria backup validation", () => {
  test("previews a backup created by the current service", async () => {
    const { dataDir, databasePath } = setup();
    const path = await createBackup(repository!, databasePath, dataDir, "0.2.0");
    const preview = await previewBackup(path, dataDir, "0.2.0");
    expect(preview.manifest.athriaVersion).toBe("0.2.0");
    expect(preview.counts).toEqual({ workouts: 0, templates: 0, plans: 0 });
  });

  test.each([
    ["missing database", { "manifest.json": strToU8(JSON.stringify({ athriaVersion: "0.2.0", createdAt: new Date().toISOString() })) }],
    ["unsafe path", { "../escape": strToU8("bad"), "manifest.json": strToU8("{}"), "athria.sqlite3": strToU8("bad") }],
    ["future version", { "manifest.json": strToU8(JSON.stringify({ athriaVersion: "0.3.0", createdAt: new Date().toISOString() })), "athria.sqlite3": strToU8("bad") }],
  ])("rejects %s", async (_name, entries) => {
    const { dataDir } = setup();
    const path = join(root, "invalid.zip");
    await Bun.write(path, zipSync(entries));
    await expect(previewBackup(path, dataDir, "0.2.0")).rejects.toThrow();
  });
});
