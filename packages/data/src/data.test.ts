import { afterEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAN_SCHEMA_VERSION, TAXONOMY_VERSION, defaultProfile, trainingSessionSchema } from "@athria/schemas";
import { AthriaRepository } from "./index";

let repository: AthriaRepository | undefined; let directory: string | undefined;
afterEach(() => { repository?.close(); repository = undefined; Bun.gc(true); if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); directory = undefined; });

describe("v7 planning resets", () => {
  it("creates v8/v9 storage and is idempotent", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v8-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = new AthriaRepository(path);
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=8").get()).toEqual({ version: 8 });
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=9").get()).toEqual({ version: 9 });
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=11").get()).toEqual({ version: 11 });
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=13").get()).toEqual({ version: 13 });
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=14").get()).toEqual({ version: 14 });
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=15").get()).toEqual({ version: 15 });
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=16").get()).toEqual({ version: 16 });
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=17").get()).toEqual({ version: 17 });
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=18").get()).toEqual({ version: 18 });
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=19").get()).toEqual({ version: 19 });
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=20").get()).toEqual({ version: 20 });
    expect(repository.counts()).toMatchObject({ session_templates: 0, current_mesocycles: 0 });
  });
  it("removes duplicate, history, approval, proposal, raw and catalog tables", () => {
    repository = new AthriaRepository(":memory:");
    const names = repository.sqlite.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String((row as { name: string }).name));
    expect(names).toEqual(expect.arrayContaining(["profiles", "training_sessions", "training_session_sources", "training_session_type_overrides", "plan_workout_matches", "workout_plan_exclusions", "planned_session_events", "wellness", "session_templates", "current_mesocycles"]));
    expect(names).not.toEqual(expect.arrayContaining(["preferences", "exercises", "planned_sessions", "planned_session_changes", "raw_records", "approvals", "profile_update_proposals"]));
  });
  it("upgrades a v19 database with workout type override storage", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-type-v20-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = undefined;
    const sqlite = new Database(path); sqlite.exec("DROP TABLE training_session_type_overrides; DELETE FROM athria_migrations WHERE version=20;"); sqlite.close();
    repository = new AthriaRepository(path);
    expect(repository.sqlite.query("SELECT version FROM athria_migrations WHERE version=20").get()).toEqual({ version: 20 });
    expect(repository.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='training_session_type_overrides'").get()).toEqual({ name: "training_session_type_overrides" });
  });
  it("backs up and clears incompatible planning rows while preserving Profile data", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v8-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.saveProfile({ ...defaultProfile(), preferredName: "Preserved" }); repository.close(); repository = undefined;
    const sqlite = new Database(path);
    sqlite.query("INSERT INTO session_templates(id,owner_id,data,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("old", "local-user", '{"legacy":true}', 1, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
    sqlite.query("DELETE FROM athria_migrations WHERE version=8").run(); sqlite.close();
    repository = new AthriaRepository(path);
    expect(repository.listTemplates()).toEqual([]);
    expect(repository.getProfile().preferredName).toBe("Preserved");
    expect(repository.sqlite.query("SELECT table_name,row_id,data FROM planning_v7_reset_backups WHERE table_name='session_templates'").get()).toMatchObject({ table_name: "session_templates", row_id: "old", data: '{"legacy":true}' });
  });
  it("migrates displayName into Personal Information fields", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-personal-v17-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = undefined;
    const sqlite = new Database(path);
    const legacy = { ...defaultProfile(), displayName: "Sam" } as Record<string, unknown>; delete legacy.preferredName; delete legacy.gender; delete legacy.heightCm; delete legacy.birthDate;
    sqlite.query("INSERT INTO profiles(owner_id,data,updated_at) VALUES (?,?,?)").run("local-user", JSON.stringify(legacy), "2026-09-01T00:00:00Z");
    sqlite.query("DELETE FROM athria_migrations WHERE version=17").run(); sqlite.close();
    repository = new AthriaRepository(path);
    expect(repository.getProfile()).toMatchObject({ preferredName: "Sam", gender: null, heightCm: null, birthDate: null });
  });
  it("merges legacy preferences into Profile and drops the table", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v10-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = undefined;
    const sqlite = new Database(path);
    sqlite.exec("CREATE TABLE preferences(owner_id TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at TEXT NOT NULL)");
    sqlite.query("INSERT INTO profiles(owner_id,data,updated_at) VALUES (?,?,?)").run("local-user", JSON.stringify({ ...defaultProfile(), preference: "" }), "2026-09-01T00:00:00Z");
    sqlite.query("INSERT INTO preferences VALUES (?,?,?)").run("local-user", JSON.stringify({ preferredSessionMinutes: 90, notes: "Morning sessions", dislikedExercises: ["burpee"] }), "2026-09-01T00:00:00Z");
    sqlite.query("DELETE FROM athria_migrations WHERE version=12").run(); sqlite.close();
    repository = new AthriaRepository(path);
    const profile = repository.getProfile();
    expect(profile.preference).toBe("Morning sessions");
    expect(profile.constraintNotes).toContain("Avoid burpee");
    expect(repository.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='preferences'").get()).toBeNull();
  });
  it("keeps user wellness overrides when Intervals sync repeats", () => {
    repository = new AthriaRepository(":memory:", () => new Date("2026-09-11T00:00:00Z"));
    repository.upsertWellness("local-user", [{ id: "2026-09-10", restingHR: 50 }]);
    repository.saveWellness({ ...repository.getWellness("local-user", "2026-09-10")!, fields: { restingHeartRateBpm: { value: 55, source: "user", updatedAt: "2026-09-11T00:00:00Z" } } });
    repository.upsertWellness("local-user", [{ id: "2026-09-10", restingHR: 48 }]);
    expect(repository.getWellness("local-user", "2026-09-10")?.fields.restingHeartRateBpm?.value).toBe(55);
  });
  it("stores only compact template data while reconstructing API metadata", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-template-data-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path);
    const stored = repository.createTemplate({ id: "easy", name: "Easy", intent: "Build aerobic capacity.", domain: "endurance", nodes: [{ role: "steady", variables: ["duration"], optionalVariables: ["distance"] }] });
    expect(stored).toEqual({ id: "easy", name: "Easy", intent: "Build aerobic capacity.", domain: "endurance", nodes: [{ role: "steady", variables: ["duration"], optionalVariables: ["distance"] }], origin: "user", revision: 1 });
    const row = repository.sqlite.query("SELECT id, owner_id, revision, data FROM session_templates WHERE id='easy'").get() as Record<string, unknown>;
    expect(JSON.parse(String(row.data))).toEqual({ name: "Easy", intent: "Build aerobic capacity.", domain: "endurance", nodes: [{ role: "steady", variables: ["duration"], optionalVariables: ["distance"] }] });
    expect(row).toMatchObject({ id: "easy", owner_id: "local-user", revision: 1 });
  });
  it("migrates legacy templates and built-in references to catalog v2 without changing prescriptions", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-template-v11-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = undefined;
    const sqlite = new Database(path);
    const legacyTemplate = { id: "legacy-lower", ownerId: "local-user", revision: 3, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", origin: "user", name: "Lower", intent: "Train lower body.", domain: "strength", commonUseCases: ["Strength"], notes: "Legacy", structure: { kind: "strength", slots: [{ id: "squat", name: "Squat", role: "primary", required: true, movementPatternIds: ["squat"], targetMuscleIds: [], matchPolicy: "any", variables: [{ key: "exercise_selection", required: true }, { key: "load", required: false, identityConstraint: { min: 10, unit: "kg" } }] }] } };
    const fact = { value: "recovery", source: "user_confirmed", confidence: 1, evidence: "fixture", taxonomyVersion: TAXONOMY_VERSION };
    const weekly = { id: "weekly", scheduledDate: "2026-09-07", order: 0, templateRef: { source: "builtin", id: "builtin.easy-run", catalogVersion: "1.0" }, name: "Recovery", intent: "Recover", durationMinutes: 20, recoveryDemand: "low", keySession: false, components: [{ id: "recovery", name: "Recovery", domain: fact, prescription: { kind: "recovery", blocks: [{ name: "Easy", durationMinutes: 20 }] } }], progressionNote: null, schedulingRationale: null, legacySnapshot: false };
    const current = { planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: "local-user", title: "Plan", summary: "", effectiveStartDate: "2026-09-07", mesocycle: { durationWeeks: 1, schedule: { kind: "fixed_week", days: [0] }, domainProgressions: [{ domain: "recovery", phases: [{ id: "base", phaseType: "recovery", name: "Base", startWeek: 1, endWeek: 1, focus: "Recover", progression: [] }] }], weeks: [{ weekNumber: 1, focus: null, sessions: [weekly] }], adjustmentRules: [] }, revision: 4, sourceAgent: null, model: null, skillVersion: null, inputSnapshotHash: null, updatedAt: "2026-09-02T00:00:00Z" };
    const planned = { ...weekly, occurrenceId: "occ-weekly", ownerId: "local-user", planRevision: 4, weekNumber: 1, phaseRefs: [{ domain: "recovery", phaseId: "base" }], exerciseOverrides: [], notes: "", overrideReason: null, status: "planned", completedTrainingSessionId: null, completedAt: null, completionSource: null, createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z" };
    sqlite.query("INSERT INTO session_templates(id,owner_id,data,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("legacy-lower", "local-user", JSON.stringify(legacyTemplate), 3, legacyTemplate.createdAt, legacyTemplate.updatedAt);
    sqlite.query("INSERT INTO current_mesocycles(owner_id,data,revision,updated_at) VALUES (?,?,?,?)").run("local-user", JSON.stringify(current), 4, current.updatedAt);
    sqlite.query("DELETE FROM athria_migrations WHERE version=11").run(); sqlite.close();
    repository = new AthriaRepository(path);
    expect(repository.getTemplate("legacy-lower")).toMatchObject({ id: "legacy-lower", revision: 3, nodes: [{ name: "Squat", role: "primary", variables: ["exercise_selection"], optionalVariables: ["load"], movementPatternIds: ["squat"] }] });
    const templateData = JSON.parse(String((repository.sqlite.query("SELECT data FROM session_templates WHERE id='legacy-lower'").get() as { data: string }).data));
    expect(templateData).not.toHaveProperty("id"); expect(templateData).not.toHaveProperty("notes"); expect(templateData).not.toHaveProperty("structure");
    expect(repository.getCurrentPlan()?.mesocycle.weeks[0]?.sessions[0]?.templateRef).toEqual({ source: "builtin", id: "builtin.easy-run", catalogVersion: "2.0" });
    expect(repository.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='planned_sessions'").get()).toBeNull();
  });
  it("upgrades hour-based recovery and converts strength constraints in the v13 profile migration", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v13-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = undefined;
    const sqlite = new Database(path);
    const legacy: Record<string, unknown> = { ...defaultProfile(), explicitRecoveryHours: 50, strengthConstraints: [{ id: "c1", type: "exclude_exercise", canonicalKey: "burpee" }, { id: "c2", type: "prohibit_movement_pattern", movementPattern: "jump" }], constraintNotes: ["Left shoulder surgery", "Left shoulder surgery ", "Athlete", "x".repeat(250)] };
    delete legacy.explicitRecoveryDays;
    sqlite.query("INSERT INTO profiles(owner_id,data,updated_at) VALUES (?,?,?)").run("local-user", JSON.stringify(legacy), "2026-09-01T00:00:00Z");
    sqlite.query("DELETE FROM athria_migrations WHERE version=13").run(); sqlite.close();
    repository = new AthriaRepository(path);
    const profile = repository.getProfile();
    expect(profile.explicitRecoveryDays).toBe(3);
    expect(profile.injuries).toEqual([]);
    expect(profile.constraintNotes).toEqual(["Left shoulder surgery", "Athlete", "x".repeat(200), "Avoid burpee", "Avoid jump"]);
    const stored = JSON.parse(String((repository.sqlite.query("SELECT data FROM profiles WHERE owner_id='local-user'").get() as { data: string }).data)) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("explicitRecoveryHours");
    expect(stored).not.toHaveProperty("strengthConstraints");
  });
  it("converts legacy recovery hours and strength constraints in the v7 profile migration", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v7-keys-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = undefined;
    const sqlite = new Database(path);
    const legacy: Record<string, unknown> = { ...defaultProfile(), explicitRecoveryHours: 48, strengthConstraints: [{ id: "c1", type: "exclude_exercise", canonicalKey: "burpee" }], constraintNotes: ["Athlete", "Left shoulder surgery"] };
    delete legacy.explicitRecoveryDays;
    sqlite.query("INSERT INTO profiles(owner_id,data,updated_at) VALUES (?,?,?)").run("local-user", JSON.stringify(legacy), "2026-09-01T00:00:00Z");
    sqlite.query("DELETE FROM athria_migrations WHERE version=7").run(); sqlite.close();
    repository = new AthriaRepository(path);
    const profile = repository.getProfile();
    expect(profile.explicitRecoveryDays).toBe(2);
    expect(profile.constraintNotes).toEqual(["Athlete", "Left shoulder surgery", "Avoid burpee"]);
    const stored = JSON.parse(String((repository.sqlite.query("SELECT data FROM profiles WHERE owner_id='local-user'").get() as { data: string }).data)) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("strengthConstraints");
  });
  it("converts strength constraints in the v14 profile migration", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v14-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = undefined;
    const sqlite = new Database(path);
    const legacy: Record<string, unknown> = { ...defaultProfile(), strengthConstraints: [{ type: "exclude_exercise", canonicalKey: "burpee" }], constraintNotes: ["Keep sessions short"] };
    sqlite.query("INSERT INTO profiles(owner_id,data,updated_at) VALUES (?,?,?)").run("local-user", JSON.stringify(legacy), "2026-09-01T00:00:00Z");
    sqlite.query("DELETE FROM athria_migrations WHERE version=14").run(); sqlite.close();
    repository = new AthriaRepository(path);
    const profile = repository.getProfile();
    expect(profile.constraintNotes).toEqual(["Keep sessions short", "Avoid burpee"]);
    expect(profile.injuries).toEqual([]);
    const stored = JSON.parse(String((repository.sqlite.query("SELECT data FROM profiles WHERE owner_id='local-user'").get() as { data: string }).data)) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("strengthConstraints");
  });
  it("strips the removed plan target constraints in the v15 migration", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v15-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = undefined;
    const sqlite = new Database(path);
    const fact = { value: "recovery", source: "user_confirmed", confidence: 1, evidence: "fixture", taxonomyVersion: TAXONOMY_VERSION };
    const weekly = { id: "weekly", scheduledDate: "2026-09-07", order: 0, templateRef: { source: "builtin", id: "builtin.easy-run", catalogVersion: "2.0" }, name: "Recovery", intent: "Recover", durationMinutes: 20, recoveryDemand: "low", keySession: false, components: [{ id: "recovery", name: "Recovery", domain: fact, prescription: { kind: "recovery", blocks: [{ name: "Easy", durationMinutes: 20 }] } }], progressionNote: null, schedulingRationale: null, legacySnapshot: false };
    const plan = { planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: "local-user", title: "Plan", summary: "", effectiveStartDate: "2026-09-07", mesocycle: { durationWeeks: 1, schedule: { kind: "fixed_week", days: [0] }, domainProgressions: [{ domain: "recovery", phases: [{ id: "base", phaseType: "recovery", name: "Base", startWeek: 1, endWeek: 1, focus: "Recover", progression: [] }] }], weeks: [{ weekNumber: 1, focus: null, sessions: [weekly] }], adjustmentRules: [] }, revision: 4, sourceAgent: null, model: null, skillVersion: null, inputSnapshotHash: null, updatedAt: "2026-09-02T00:00:00Z", target: { primaryGoal: { label: "Demo" }, constraints: ["Sessions no longer than 90 minutes"] } };
    sqlite.query("INSERT INTO current_mesocycles(owner_id,data,revision,updated_at) VALUES (?,?,?,?)").run("local-user", JSON.stringify(plan), 4, plan.updatedAt);
    sqlite.query("DELETE FROM athria_migrations WHERE version=15").run(); sqlite.close();
    repository = new AthriaRepository(path);
    const storedPlan = JSON.parse(String((repository.sqlite.query("SELECT data FROM current_mesocycles WHERE owner_id='local-user'").get() as { data: string }).data)) as Record<string, unknown>;
    expect(storedPlan.target).not.toHaveProperty("constraints");
    expect(repository.getCurrentPlan()?.target?.primaryGoal?.label).toBe("Demo");
  });
  it("maps compatible equipment and removes retired profile values in v16", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v16-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = undefined;
    const sqlite = new Database(path);
    const legacy = { ...defaultProfile(), equipment: ["dumbbell", "band", "suspension", "bodyweight", "rings", "trap_bar", "ez_bar", "other"] };
    sqlite.query("INSERT INTO profiles(owner_id,data,updated_at) VALUES (?,?,?)").run("local-user", JSON.stringify(legacy), "2026-09-01T00:00:00Z");
    const classified = (value: unknown) => ({ value, source: "user_confirmed", confidence: 1, evidence: "fixture", taxonomyVersion: TAXONOMY_VERSION });
    const exercise = { id: "squat", displayName: "Squat", canonicalKey: null, classification: { primaryMovement: classified("squat"), primaryMuscles: classified(["quadriceps"]), secondaryMuscles: classified([]), equipment: classified(["band", "bodyweight"]), impact: classified("low"), laterality: classified("bilateral") }, sets: 3, repsMin: 8, repsMax: 10, targetRpe: 8, restSeconds: 90, referenceLoad: null, referenceLoadUnit: null, notes: "" };
    const plan = { planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: "local-user", title: "Legacy equipment", summary: "", effectiveStartDate: "2026-09-07", mesocycle: { durationWeeks: 1, schedule: { kind: "fixed_week", days: [0] }, domainProgressions: [{ domain: "strength", phases: [{ id: "base", phaseType: "foundation", name: "Base", startWeek: 1, endWeek: 1, focus: "Strength", progression: [] }] }], weeks: [{ weekNumber: 1, focus: null, sessions: [{ id: "weekly", scheduledDate: "2026-09-07", order: 0, status: "planned", templateRef: null, name: "Strength", intent: "Train", durationMinutes: 45, recoveryDemand: "normal", keySession: false, components: [{ id: "strength", name: "Strength", domain: classified("strength"), prescription: { kind: "strength", exercises: [exercise] } }], progressionNote: null, schedulingRationale: null, legacySnapshot: false }] }], adjustmentRules: [] }, revision: 1, sourceAgent: null, model: null, skillVersion: null, inputSnapshotHash: null, updatedAt: "2026-09-01T00:00:00Z" };
    sqlite.query("INSERT INTO current_mesocycles(owner_id,data,revision,updated_at) VALUES (?,?,?,?)").run("local-user", JSON.stringify(plan), 1, plan.updatedAt);
    sqlite.query("DELETE FROM athria_migrations WHERE version=16").run(); sqlite.close();
    repository = new AthriaRepository(path);
    expect(repository.getProfile().equipment).toEqual(["dumbbell", "resistance_band", "trx"]);
    expect(repository.getCurrentPlan()?.mesocycle.weeks[0]?.sessions[0]?.components[0]?.prescription).toMatchObject({ exercises: [{ classification: { equipment: { value: ["resistance_band"] } } }] });
    repository.close(); repository = new AthriaRepository(path);
    expect(repository.getProfile().equipment).toEqual(["dumbbell", "resistance_band", "trx"]);
  });
});

describe("workout reconciliation", () => {
  const session = (input: { id: string; source: string; startAt: string; duration?: number; modality?: "strength" | "endurance" | "recovery" | "mixed" | "unknown"; sport?: string | null; name?: string }) => trainingSessionSchema.parse({
    id: input.id, ownerId: "local-user", source: input.source, externalId: input.id, modality: input.modality ?? "strength", sport: input.sport ?? null, name: input.name ?? "Training",
    startAt: input.startAt, endAt: new Date(Date.parse(input.startAt) + (input.duration ?? 60) * 60_000).toISOString(), durationMinutes: input.duration ?? 60,
  });

  it("replaces a successful source window instead of retaining stale provider ids", () => {
    repository = new AthriaRepository(":memory:");
    repository.replaceSourceSessions({ source: "intervals", rangeStart: "2026-09-06", rangeEnd: "2026-09-06", sessions: [session({ id: "activities:20069717815", source: "intervals", startAt: "2026-09-06T03:16:00Z", duration: 0, modality: "unknown" })] });
    repository.replaceSourceSessions({ source: "intervals", rangeStart: "2026-09-06", rangeEnd: "2026-09-06", sessions: [session({ id: "activities:i185865986", source: "intervals", startAt: "2026-09-06T03:16:00Z", duration: 59, name: "Lunch Weight Training" })] });
    expect(repository.listSessionsBySource("intervals").map((item) => item.externalId)).toEqual(["activities:i185865986"]);
    expect(repository.listSessions()).toHaveLength(1);
  });

  it("clears only the requested provider dates when a successful snapshot is empty", () => {
    repository = new AthriaRepository(":memory:");
    repository.upsertSessions([session({ id: "sep6", source: "intervals", startAt: "2026-09-06T03:00:00Z" }), session({ id: "sep7", source: "intervals", startAt: "2026-09-07T03:00:00Z" }), session({ id: "manual", source: "manual", startAt: "2026-09-06T03:00:00Z", modality: "recovery" })]);
    repository.replaceSourceSessions({ source: "intervals", rangeStart: "2026-09-06", rangeEnd: "2026-09-06", sessions: [] });
    expect(repository.listSessionsBySource("intervals").map((item) => item.externalId)).toEqual(["sep7"]);
    expect(repository.listSessionsBySource("manual").map((item) => item.externalId)).toEqual(["manual"]);
  });

  it("deduplicates compatible cross-source observations but preserves hard modality conflicts", () => {
    repository = new AthriaRepository(":memory:");
    repository.upsertSessions([
      session({ id: "hevy-strength", source: "hevy", startAt: "2026-09-06T03:16:00Z", duration: 59, name: "Lunch Weight Training" }),
      session({ id: "xunji-strength", source: "xunji", startAt: "2026-09-06T03:16:00Z", duration: 60, name: "Lunch Weight Training" }),
      session({ id: "intervals-run", source: "intervals", startAt: "2026-09-06T03:16:00Z", duration: 60, modality: "endurance", sport: "Run", name: "Run" }),
    ]);
    expect(repository.listSessions()).toHaveLength(2);
    expect(repository.sqlite.query("SELECT COUNT(*) AS count FROM training_session_sources").get()).toEqual({ count: 3 });
  });

  it("does not fuzzy merge different ids from the same source", () => {
    repository = new AthriaRepository(":memory:");
    repository.upsertSessions([session({ id: "one", source: "intervals", startAt: "2026-09-06T03:16:00Z" }), session({ id: "two", source: "intervals", startAt: "2026-09-06T03:16:00Z" })]);
    expect(repository.listSessions()).toHaveLength(2);
  });

  it("keeps a user-selected workout type across provider replacement and removes orphaned overrides", () => {
    repository = new AthriaRepository(":memory:");
    const original = session({ id: "synced", source: "intervals", startAt: "2026-09-06T03:16:00Z", modality: "endurance", name: "Run" });
    repository.upsertSessions([original]);
    expect(repository.setTrainingSessionTypeOverride("local-user", "synced", "recovery").domains).toEqual(["recovery"]);
    repository.replaceSourceSessions({ source: "intervals", rangeStart: "2026-09-06", rangeEnd: "2026-09-06", sessions: [{ ...original, name: "Updated Run" }] });
    expect(repository.listSessions()[0]).toMatchObject({ id: "synced", name: "Updated Run", domains: ["recovery"] });
    expect(JSON.parse((repository.sqlite.query("SELECT data FROM training_session_sources WHERE external_id='synced'").get() as { data: string }).data).domains).toEqual([]);
    repository.replaceSourceSessions({ source: "intervals", rangeStart: "2026-09-06", rangeEnd: "2026-09-06", sessions: [] });
    expect(repository.sqlite.query("SELECT COUNT(*) AS count FROM training_session_type_overrides").get()).toEqual({ count: 0 });
  });

  it("deletes a canonical workout with all sources and associated state", () => {
    repository = new AthriaRepository(":memory:");
    repository.upsertSessions([
      session({ id: "manual", source: "manual", startAt: "2026-09-06T03:16:00Z", name: "Lunch Weight Training" }),
      session({ id: "synced", source: "intervals", startAt: "2026-09-06T03:16:00Z", name: "Lunch Weight Training" }),
    ]);
    const workout = repository.listSessions()[0]!;
    repository.setTrainingSessionTypeOverride("local-user", workout.id, "recovery");
    repository.linkTrainingSession(workout.id, "planned-1");
    repository.sqlite.query("INSERT INTO workout_plan_exclusions(owner_id,training_session_id,created_at) VALUES (?,?,?)").run("local-user", workout.id, "2026-09-06T04:00:00Z");
    repository.deleteTrainingSession("local-user", workout.id);
    expect(repository.listSessions()).toEqual([]);
    for (const table of ["training_session_sources", "plan_workout_matches", "workout_plan_exclusions", "training_session_type_overrides"]) expect(repository.sqlite.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    expect(() => repository!.deleteTrainingSession("local-user", workout.id)).toThrow("TRAINING_SESSION_NOT_FOUND");
  });

  it("migrates away a same-source zero-detail placeholder when a richer record has the same start", () => {
    directory = mkdtempSync(join(tmpdir(), "athria-v18-")); const path = join(directory, "athria.sqlite3");
    repository = new AthriaRepository(path); repository.close(); repository = undefined;
    const sqlite = new Database(path);
    const placeholder = session({ id: "old", source: "intervals", startAt: "2026-09-06T03:16:00Z", duration: 0, modality: "unknown", name: "Intervals activity" });
    const replacement = session({ id: "new", source: "intervals", startAt: "2026-09-06T03:16:00Z", duration: 59, name: "Lunch Weight Training" });
    sqlite.query("DELETE FROM training_session_sources").run(); sqlite.query("DELETE FROM training_sessions").run(); sqlite.query("DELETE FROM athria_migrations WHERE version=18").run();
    for (const value of [placeholder, replacement]) sqlite.query("INSERT INTO training_sessions(id,owner_id,source,external_id,modality,start_at,data) VALUES (?,?,?,?,?,?,?)").run(value.id, value.ownerId, value.source, value.externalId, value.modality, value.startAt, JSON.stringify(value));
    sqlite.exec("DROP TABLE plan_workout_matches; DROP TABLE training_session_sources;"); sqlite.close();
    repository = new AthriaRepository(path);
    expect(repository.listSessionsBySource("intervals").map((item) => item.externalId)).toEqual(["new"]);
  });
});
