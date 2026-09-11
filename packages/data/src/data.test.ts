import { afterEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProfile } from "@athria/schemas";
import { AthriaRepository } from "./index";

let repository: AthriaRepository | undefined; let directory: string | undefined;
afterEach(() => { repository?.close(); repository = undefined; Bun.gc(true); if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); directory = undefined; });

describe("v7 planning resets", () => {
  it("creates v8/v9 storage and is idempotent", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v8-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = new AthriaRepository(path);
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=8").get()).toEqual({ version: 8 });
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=9").get()).toEqual({ version: 9 });
    expect(repository.counts()).toMatchObject({ session_templates: 0, current_mesocycles: 0 });
  });
  it("backs up and clears plans that predate domain progression timelines", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v9-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = undefined;
    const sqlite = new Database(path);
    sqlite.query("INSERT INTO current_mesocycles(owner_id,data,revision,updated_at) VALUES (?,?,?,?)").run("local-user", '{"legacyPlan":true}', 1, "2026-09-01T00:00:00Z");
    sqlite.query("DELETE FROM athria_migrations WHERE version=9").run(); sqlite.close();
    repository = new AthriaRepository(path);
    expect(repository.getCurrentPlan()).toBeNull();
    expect(repository.sqlite.query("SELECT table_name,row_id,data FROM domain_progression_v7_reset_backups WHERE table_name='current_mesocycles'").get()).toMatchObject({ table_name: "current_mesocycles", row_id: "local-user", data: '{"legacyPlan":true}' });
  });
  it("backs up and clears incompatible planning rows while preserving Profile data", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v8-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.saveProfile({ ...defaultProfile(), displayName: "Preserved" }); repository.close(); repository = undefined;
    const sqlite = new Database(path);
    sqlite.query("INSERT INTO session_templates(id,owner_id,data,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("old", "local-user", '{"legacy":true}', 1, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
    sqlite.query("DELETE FROM athria_migrations WHERE version=8").run(); sqlite.close();
    repository = new AthriaRepository(path);
    expect(repository.listTemplates()).toEqual([]);
    expect(repository.getProfile().displayName).toBe("Preserved");
    expect(repository.sqlite.query("SELECT table_name,row_id,data FROM planning_v7_reset_backups WHERE table_name='session_templates'").get()).toMatchObject({ table_name: "session_templates", row_id: "old", data: '{"legacy":true}' });
  });
  it("migrates legacy profile priority to preference and scrubs pending proposals (v10)", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v10-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = undefined;
    const sqlite = new Database(path);
    sqlite.query("INSERT INTO profiles(owner_id,data,updated_at) VALUES (?,?,?)").run("local-user", '{"ownerId":"local-user","displayName":"Legacy","priority":"strength"}', "2026-09-01T00:00:00Z");
    sqlite.query("INSERT INTO profile_update_proposals(id,owner_id,client_request_id,patch,rationale,base_snapshot_hash,status,created_at) VALUES (?,?,?,?,?,?,?,?)").run("proposal-1", "local-user", "req-1", '{"priority":"endurance","displayName":"Renamed"}', "because", "hash", "pending", "2026-09-01T00:00:00Z");
    sqlite.query("DELETE FROM athria_migrations WHERE version=10").run(); sqlite.close();
    repository = new AthriaRepository(path);
    const profile = repository.getProfile();
    expect(profile.preference).toBe("");
    expect("priority" in profile).toBe(false);
    const patch = JSON.parse(String((repository.sqlite.query("SELECT patch FROM profile_update_proposals WHERE id='proposal-1'").get() as { patch: string }).patch));
    expect("priority" in patch).toBe(false);
    expect(patch.displayName).toBe("Renamed");
  });
  it("reopens a pre-v7 database whose legacy profile still has priority without crashing (regression)", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v7-legacy-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = undefined;
    const sqlite = new Database(path);
    sqlite.query("INSERT INTO profiles(owner_id,data,updated_at) VALUES (?,?,?)").run("local-user", '{"ownerId":"local-user","displayName":"Legacy","priority":"strength","trainingDays":[1,3,5]}', "2026-09-01T00:00:00Z");
    sqlite.query("DELETE FROM athria_migrations WHERE version IN (7,10)").run(); sqlite.close();
    expect(() => { repository = new AthriaRepository(path); }).not.toThrow();
    const profile = repository!.getProfile();
    expect("priority" in profile).toBe(false);
    expect("preference" in profile).toBe(true);
    expect(profile.preference).toBe("");
    expect(repository!.sqlite.query("SELECT version FROM athria_migrations WHERE version=7").get()).toEqual({ version: 7 });
  });
});
