import { afterEach, describe, expect, it } from "vitest";
import { AthriaRepository } from "@athria/data";
import { PLAN_SCHEMA_VERSION, TAXONOMY_VERSION, equipmentTypeIds, type CurrentPlanWrite } from "@athria/schemas";
import { AthriaApplication, AthriaError } from "./index";

let repository: AthriaRepository | undefined;
afterEach(() => repository?.close());
const template = (name = "Lower pattern") => ({ id: "lower", name, intent: "Stable lower-body structure", domain: "strength" as const, nodes: [{ name: "Primary", role: "primary" as const, movementPatternIds: ["squat" as const], targetMuscleIds: ["quadriceps" as const], matchPolicy: "all" as const, variables: ["exercise_selection" as const] }] });
const fact = <T>(value: T): { value: T; source: "user_confirmed"; confidence: number; evidence: string; taxonomyVersion: typeof TAXONOMY_VERSION } => ({ value, source: "user_confirmed", confidence: 1, evidence: "fixture", taxonomyVersion: TAXONOMY_VERSION });
const plan = (app: AthriaApplication, revision = 0): any => {
  app.saveProfile({ ...app.getProfile(), trainingRhythm: { kind: "fixed_week", days: [0] } });
  const session = { id: "weekly-1", scheduledDate: "2026-09-07", order: 0, templateRef: { source: "user" as const, id: "lower", revision: 1 }, name: "Mobility and breathing", intent: "Recover", durationMinutes: 20, recoveryDemand: "low" as const, keySession: false, components: [{ id: "mobility", name: "Mobility", domain: fact("recovery" as const), prescription: { kind: "recovery" as const, blocks: [{ name: "Easy mobility", durationMinutes: 15 }] } }, { id: "breathing", name: "Breathing", domain: fact("mind_body" as const), prescription: { kind: "mind_body" as const, blocks: [{ name: "Down regulation", durationMinutes: 5 }] } }], progressionNote: null, schedulingRationale: null, legacySnapshot: false };
  return { planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: "local-user", title: "Current plan", summary: "", effectiveStartDate: "2026-09-07", mesocycle: { durationWeeks: 1, schedule: { kind: "fixed_week" as const, days: [0] }, domainProgressions: [{ domain: "recovery" as const, phases: [{ id: "recovery-base", phaseType: "foundation" as const, name: "Restore", startWeek: 1, endWeek: 1, focus: "Build recovery consistency", progression: ["Increase range only while movement stays comfortable"] }] }, { domain: "mind_body" as const, phases: [{ id: "mind-body-base", phaseType: "foundation" as const, name: "Settle", startWeek: 1, endWeek: 1, focus: "Build breath awareness", progression: ["Extend practice only while attention remains steady"] }] }], weeks: [{ weekNumber: 1, focus: null, sessions: [session] }], adjustmentRules: [] }, sourceAgent: "test", model: null, skillVersion: "0.6.0", inputSnapshotHash: app.snapshotHash(), expectedRevision: revision };
};

describe("v7 application boundary", () => {
  it("merges built-ins with local templates and protects built-ins", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    expect(app.listTemplates().some((item) => item.origin === "builtin")).toBe(true);
    expect(app.createTemplate(template())).toMatchObject({ origin: "user", revision: 1 });
    expect(() => app.updateTemplate({ template: { ...template(), id: "builtin.easy-run" }, expectedRevision: 1 })).toThrow(/read-only/i);
    expect(() => app.deleteTemplate("builtin.easy-run", 1)).toThrow(/built-in/i);
  });
  it("keeps template updates independent from saved Session prescriptions", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T00:00:00Z"));
    app.createTemplate(template()); app.saveCurrentPlan(plan(app));
    expect(app.getCalendar()[0]).toMatchObject({ id: "weekly-1", durationMinutes: 20, templateRef: { source: "user", id: "lower", revision: 1 }, phaseRefs: [{ domain: "recovery", phaseId: "recovery-base" }, { domain: "mind_body", phaseId: "mind-body-base" }] });
    expect(app.getNextTrainingDay().nextTrainingDay?.domainPhases).toEqual([{ domain: "recovery", phaseId: "recovery-base", phaseType: "foundation", name: "Restore" }, { domain: "mind_body", phaseId: "mind-body-base", phaseType: "foundation", name: "Settle" }]);
    expect(app.updateTemplate({ template: template("Changed"), expectedRevision: 1 })).toMatchObject({ impact: { affectedCount: 0, updatedCount: 0 } });
    expect(app.getCalendar()[0]).toMatchObject({ name: "Mobility and breathing", durationMinutes: 20 });
  });
  it("blocks deletion while the Current Plan references a user template", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    app.createTemplate(template()); app.saveCurrentPlan(plan(app));
    expect(() => app.deleteTemplate("lower", 1)).toThrow(/reference/i);
  });
  it("recomputes every domain phase reference when a combined session moves to another week", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T00:00:00Z"));
    app.createTemplate(template());
    const candidate = plan(app);
    const first = candidate.mesocycle.weeks[0]!.sessions[0]!;
    const copy = (id: string, scheduledDate: string) => ({ ...structuredClone(first), id, scheduledDate });
    candidate.mesocycle.durationWeeks = 2;
    candidate.mesocycle.schedule = { kind: "flexible_week", targetDaysPerWeek: 2, minDaysPerWeek: 1, maxDaysPerWeek: 3 };
    candidate.mesocycle.domainProgressions[0]!.phases = [{ id: "recovery-base", phaseType: "foundation", name: "Restore", startWeek: 1, endWeek: 1, focus: "Restore", progression: [] }, { id: "recovery-build", phaseType: "progression", name: "Build", startWeek: 2, endWeek: 2, focus: "Build range", progression: [] }];
    candidate.mesocycle.domainProgressions[1]!.phases[0]!.endWeek = 2;
    candidate.mesocycle.weeks = [{ weekNumber: 1, focus: null, sessions: [copy("move-me", "2026-09-07"), copy("stay-one", "2026-09-08")] }, { weekNumber: 2, focus: null, sessions: [copy("stay-two", "2026-09-14"), copy("stay-three", "2026-09-15")] }];
    app.saveProfile({ ...app.getProfile(), trainingRhythm: candidate.mesocycle.schedule });
    candidate.inputSnapshotHash = app.snapshotHash();
    app.saveCurrentPlan(candidate);
    const revision = app.getCalendar()[0]!.revision;
    app.updatePlannedSession("move-me", { action: "move_occurrence", scheduledDate: "2026-09-16", expectedRevision: revision });
    expect(app.getCalendar().find((session) => session.id === "move-me")).toMatchObject({ weekNumber: 2, phaseRefs: [{ domain: "recovery", phaseId: "recovery-build" }, { domain: "mind_body", phaseId: "mind-body-base" }] });
  });
  it("derives completion from Training History without writing completed into Current Plan", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T00:00:00Z"));
    app.createTemplate(template()); app.saveCurrentPlan(plan(app));
    const result = app.updatePlannedSession("weekly-1", { action: "complete", expectedRevision: 1 }) as { trainingSession: { id: string; status: string; plannedSessionId: string | null } };
    expect(result.trainingSession).toMatchObject({ status: "completed", plannedSessionId: "weekly-1" });
    expect(app.getCalendar()[0]).toMatchObject({ status: "completed", completedTrainingSessionId: result.trainingSession.id });
    expect(repository.getCurrentPlan()!.mesocycle.weeks[0]!.sessions[0]!.status).toBe("planned");
    expect(app.getNextTrainingDay().nextTrainingDay).toBeNull();
  });
  it("requires full Session input and exposes taxonomy through MCP", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    const taxonomy = app.getTrainingTaxonomy();
    expect(taxonomy.taxonomyVersion).toBe("strength-2.0");
    expect(taxonomy.strength.muscleGroups.some((item) => item.id === "gluteus_medius")).toBe(true);
    expect(taxonomy.equipmentCategories.flatMap((category) => category.groups.flatMap((group) => group.items.map((item) => item.id)))).toEqual(equipmentTypeIds);
    expect(taxonomy.strength.equipment).toEqual(equipmentTypeIds);
    const tool = app.toolRegistry().find((item) => item.name === "save_next_training_day_sessions")!;
    expect(tool.inputSchema.safeParse({ clientRequestId: "x", scheduledDate: "2026-09-07", expectedRevision: 0, mode: "append", sessions: [{ id: "x", templateRef: null }] }).success).toBe(false);
    expect(app.toolRegistry().some((item) => item.name === "preview_session_template_change")).toBe(false);
    expect(app.toolRegistry().some((item) => ["get_exercise_catalog", "find_exercise_candidates", "get_training_preferences"].includes(item.name))).toBe(false);
    expect(app.toolRegistry().some((item) => item.name === "record_training_session")).toBe(true);
  });
  it("directly applies an explicitly confirmed Profile update against its hash", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    const tool = app.toolRegistry().find((item) => item.name === "update_athlete_profile")!;
    expect(tool.inputSchema.safeParse({ patch: { preferredName: "Renamed" }, expectedProfileHash: app.profileHash(), confirmed: true }).success).toBe(true);
    expect(app.updateProfile({ patch: { preferredName: "Renamed" }, expectedProfileHash: app.profileHash(), confirmed: true }).preferredName).toBe("Renamed");
    expect(() => app.updateProfile({ patch: { preferredName: "Again" }, expectedProfileHash: "stale", confirmed: true })).toThrow(/changed/i);
  });
  it("atomically saves Personal Information and today's optional weight", () => {
    repository = new AthriaRepository(":memory:", () => new Date("2026-09-11T03:00:00Z")); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-11T03:00:00Z"));
    const current = app.getPersonalInformation();
    const saved = app.savePersonalInformation({ preferredName: "Taylor", gender: "non_binary", heightCm: 172.5, birthDate: "1995-04-03", weightKg: 68.2, expectedSnapshotHash: current.snapshotHash });
    expect(saved).toMatchObject({ preferredName: "Taylor", gender: "non_binary", heightCm: 172.5, birthDate: "1995-04-03", weightKg: 68.2, weightDate: "2026-09-11" });
    expect(repository.getWellness("local-user", "2026-09-11")?.fields.weightKg).toMatchObject({ value: 68.2, source: "user" });
    expect(() => app.savePersonalInformation({ preferredName: "Stale", gender: null, heightCm: null, birthDate: null, expectedSnapshotHash: current.snapshotHash })).toThrow(/changed/i);
  });
  it("does not copy an unchanged historical weight and allows a cleared user weight to sync again", () => {
    repository = new AthriaRepository(":memory:", () => new Date("2026-09-11T03:00:00Z")); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-11T03:00:00Z"));
    repository.upsertWellness("local-user", [{ id: "2026-09-10", weight: 70 }]);
    let current = app.getPersonalInformation();
    app.savePersonalInformation({ preferredName: "Athlete", gender: null, heightCm: null, birthDate: null, expectedSnapshotHash: current.snapshotHash });
    expect(repository.getWellness("local-user", "2026-09-11")).toBeNull();
    current = app.getPersonalInformation();
    app.savePersonalInformation({ preferredName: "Athlete", gender: null, heightCm: null, birthDate: null, weightKg: null, expectedSnapshotHash: current.snapshotHash });
    repository.upsertWellness("local-user", [{ id: "2026-09-11", weight: 69 }]);
    expect(repository.getWellness("local-user", "2026-09-11")?.fields.weightKg?.value).toBe(69);
  });
  it("rejects duplicated profile notes and accepts injuries beside constraint notes", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    expect(() => app.updateProfile({ patch: { constraintNotes: ["Left shoulder surgery", " left  shoulder surgery "] }, expectedProfileHash: app.profileHash(), confirmed: true })).toThrow(/duplicate/i);
    expect(() => app.updateProfile({ patch: { injuries: ["Left knee tendinopathy", "left  KNEE tendinopathy"] }, expectedProfileHash: app.profileHash(), confirmed: true })).toThrow(/duplicate/i);
    const updated = app.updateProfile({ patch: { injuries: ["Left shoulder surgery (2024)"], constraintNotes: ["Avoid overhead pressing"] }, expectedProfileHash: app.profileHash(), confirmed: true });
    expect(updated.injuries).toEqual(["Left shoulder surgery (2024)"]);
    expect(updated.constraintNotes).toEqual(["Avoid overhead pressing"]);
  });
  it("summarises save_current_plan output and keeps blocker failures short", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T00:00:00Z"));
    app.createTemplate(template());
    const tool = app.toolRegistry().find((item) => item.name === "save_current_plan")!;
    const saved = tool.handler(plan(app)) as { revision: number; impact: Record<string, number>; blockerSummary: { valid: boolean; blockers: number; advisories: number; blockingDataGaps: number } };
    expect(Object.keys(saved).sort()).toEqual(["blockerSummary", "impact", "revision"]);
    expect(saved.revision).toBe(1);
    expect(saved.blockerSummary).toMatchObject({ valid: true, blockers: 0, blockingDataGaps: 0 });
    const blocked = plan(app, 1);
    blocked.mesocycle.weeks[0].sessions[0].durationMinutes = 90;
    let failure: unknown;
    try { app.saveCurrentPlan(blocked); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AthriaError);
    expect((failure as AthriaError).code).toBe("PLAN_HAS_BLOCKERS");
    const message = (failure as Error).message;
    expect(message).toMatch(/blocking issue/i);
    expect(message).toMatch(/MAX_SESSION_DURATION:fail/);
    expect(message).not.toContain("results");
    expect(message.length).toBeLessThan(500);
  });
  it("reports stale plan revisions with a machine-readable code", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T00:00:00Z"));
    app.createTemplate(template());
    app.saveCurrentPlan(plan(app));
    let failure: unknown;
    try { app.saveCurrentPlan(plan(app, 0)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AthriaError);
    expect((failure as AthriaError).code).toBe("REVISION_CONFLICT");
  });
});
