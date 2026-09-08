import { afterEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TAXONOMY_VERSION, defaultProfile, sessionTemplateSchema } from "@athria/schemas";
import { AthriaRepository, INITIAL_MIGRATION_SQL } from "./index";

let repository: AthriaRepository | undefined; let directory: string | undefined;
afterEach(() => {
  repository?.close();
  repository = undefined;
  Bun.gc(true);
  if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  directory = undefined;
});
const fact = <T>(value: T) => ({ value, source: "catalog", confidence: 1, evidence: "fixture", taxonomyVersion: TAXONOMY_VERSION });
const legacyVersion = (versionNumber: number, title: string) => { const timestamp = `2026-09-0${versionNumber}T00:00:00Z`; return { id: `version-${versionNumber}`, parentVersionId: versionNumber === 1 ? null : `version-${versionNumber - 1}`, versionNumber, approvedAt: timestamp, approvedBy: "local-user", changeReason: "fixture", validation: { valid: true, results: [], dataGaps: [], validatedAt: timestamp, inputHash: "hash", coverage: { hardChecksResolved: 0, hardChecksTotal: 0, movementFactsResolved: 0, movementFactsTotal: 0, muscleFactsResolved: 0, muscleFactsTotal: 0, equipmentFactsResolved: 0, equipmentFactsTotal: 0 } }, plan: { planSchemaVersion: "3.0", id: `draft-${versionNumber}`, ownerId: "local-user", clientRequestId: `request-${versionNumber}`, title, summary: "", mesocycle: { durationWeeks: 1, weeklyStructure: [{ dayOfWeek: 0, templateIds: ["full-body"] }], sessionTemplates: [{ id: "full-body", name: `${title} template`, intent: "Strength", durationMinutes: 45, recoveryDemand: "normal", notes: "", components: [{ id: "component", name: "Strength", domain: fact("strength"), prescription: { kind: "strength", exercises: [{ id: "squat", displayName: "Goblet Squat", canonicalKey: "goblet_squat", classification: { primaryMovement: fact("squat"), primaryMuscles: fact(["quadriceps"]), secondaryMuscles: fact(["glutes"]), equipment: fact(["dumbbell"]), impact: fact("low"), laterality: fact("bilateral") }, sets: 3, repsMin: 8, repsMax: 12, targetRpe: null, restSeconds: 90, referenceLoad: null, referenceLoadUnit: null, notes: "" }] } }] }], phases: [{ id: "base", phaseType: "foundation", name: "Base", startWeek: 1, endWeek: 1, focus: "Base", progression: [] }], adjustmentRules: [] }, migration: null, sourceAgent: null, model: null, skillVersion: null, inputSnapshotHash: "hash", createdAt: timestamp, updatedAt: timestamp } }; };

describe("SQLite repository v5", () => {
  it("creates the template-library schema and stores current values", () => {
    repository = new AthriaRepository(":memory:");
    expect(repository.counts()).toMatchObject({ session_templates: 0, current_mesocycles: 0 });
    expect(repository.saveProfile({ ...defaultProfile(), displayName: "Test" }).displayName).toBe("Test");
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=5").get()).toEqual({ version: 5 });
  });
  it("keeps the embedded bootstrap aligned through v3", () => {
    const names = ["0001_initial.sql", "0002_connection_sync_state.sql", "0003_planned_sessions.sql", "0004_plan_schema_v3.sql"];
    const checked = names.map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")).join("\n");
    const normalize = (value: string) => value.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
    expect(normalize(INITIAL_MIGRATION_SQL)).toBe(normalize(checked));
  });
  it("migrates only the latest approved plan and removes active legacy history", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v5-")); const path = join(directory, "athria.sqlite3"); const sqlite = new Database(path);
    sqlite.exec(INITIAL_MIGRATION_SQL); sqlite.query("INSERT INTO profiles(owner_id,data,updated_at) VALUES (?,?,?)").run("local-user", JSON.stringify(defaultProfile()), "2026-09-01T00:00:00Z");
    for (const version of [legacyVersion(1, "Old"), legacyVersion(2, "Latest")]) sqlite.query("INSERT INTO plan_versions(id,owner_id,parent_version_id,version_number,data,created_at) VALUES (?,?,?,?,?,?)").run(version.id, "local-user", version.parentVersionId, version.versionNumber, JSON.stringify(version), version.approvedAt);
    sqlite.close(); repository = new AthriaRepository(path);
    expect(repository.getCurrentPlan()).toMatchObject({ title: "Latest", effectiveStartDate: "2026-09-08", revision: 1 });
    expect(repository.listTemplates()).toMatchObject([{ name: "Latest template", revision: 1 }]);
    expect(repository.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_versions'").get()).toBeNull();
  });
  it("falls back to the latest draft when no approved version exists", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v5-")); const path = join(directory, "athria.sqlite3"); const sqlite = new Database(path);
    sqlite.exec(INITIAL_MIGRATION_SQL); sqlite.query("INSERT INTO profiles(owner_id,data,updated_at) VALUES (?,?,?)").run("local-user", JSON.stringify(defaultProfile()), "2026-09-01T00:00:00Z");
    for (const version of [legacyVersion(1, "Old draft"), legacyVersion(2, "Latest draft")]) sqlite.query("INSERT INTO plan_drafts(id,owner_id,client_request_id,data,validation,updated_at) VALUES (?,?,?,?,?,?)").run(version.plan.id, "local-user", version.plan.clientRequestId, JSON.stringify(version.plan), JSON.stringify(version.validation), version.plan.updatedAt);
    sqlite.close(); repository = new AthriaRepository(path);
    expect(repository.getCurrentPlan()).toMatchObject({ title: "Latest draft", revision: 1 });
    expect(repository.listTemplates()).toMatchObject([{ name: "Latest draft template", revision: 1 }]);
  });
  it("reopens v5 without recreating legacy plan tables", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v5-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = new AthriaRepository(path);
    expect(repository.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_drafts'").get()).toBeNull();
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=5").get()).toEqual({ version: 5 });
  });
  it("uses optimistic revisions without creating template history", () => {
    repository = new AthriaRepository(":memory:"); const value = sessionTemplateSchema.parse(legacyVersion(1, "One").plan.mesocycle.sessionTemplates[0]!);
    expect(repository.createTemplate(value).revision).toBe(1);
    expect(repository.updateTemplate({ ...value, name: "Two" }, 1).revision).toBe(2);
    expect(() => repository!.updateTemplate(value, 1)).toThrow(/REVISION_CONFLICT/);
    expect(repository.listTemplates()).toHaveLength(1);
  });
});
