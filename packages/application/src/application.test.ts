import { afterEach, describe, expect, it } from "vitest";
import { AthriaRepository } from "@athria/data";
import { PLAN_SCHEMA_VERSION, TAXONOMY_VERSION, type CurrentPlanWrite } from "@athria/schemas";
import { AthriaApplication } from "./index";

let repository: AthriaRepository | undefined;
afterEach(() => repository?.close());
const template = (name = "Lower pattern") => ({ id: "lower", name, intent: "Stable lower-body structure", domain: "strength" as const, commonUseCases: [], notes: "", structure: { kind: "strength" as const, slots: [{ id: "primary", name: "Primary", role: "primary" as const, required: true, movementPatternIds: ["squat" as const], targetMuscleIds: ["quadriceps" as const], matchPolicy: "all" as const, variables: [{ key: "exercise_selection" as const, required: true }] }] } });
const fact = <T>(value: T): { value: T; source: "user_confirmed"; confidence: number; evidence: string; taxonomyVersion: typeof TAXONOMY_VERSION } => ({ value, source: "user_confirmed", confidence: 1, evidence: "fixture", taxonomyVersion: TAXONOMY_VERSION });
const plan = (app: AthriaApplication, revision = 0): CurrentPlanWrite => {
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
  it("requires full Session input and exposes taxonomy through MCP", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    const taxonomy = app.getTrainingTaxonomy();
    expect(taxonomy.taxonomyVersion).toBe("strength-2.0");
    expect(taxonomy.strength.muscleGroups.some((item) => item.id === "gluteus_medius")).toBe(true);
    const tool = app.toolRegistry().find((item) => item.name === "save_next_training_day_sessions")!;
    expect(tool.inputSchema.safeParse({ clientRequestId: "x", scheduledDate: "2026-09-07", expectedRevision: 0, mode: "append", sessions: [{ id: "x", templateRef: null }] }).success).toBe(false);
    expect(app.toolRegistry().some((item) => item.name === "preview_session_template_change")).toBe(false);
  });
  it("ignores legacy profile keys in propose_profile_update instead of rejecting them (backward-compat)", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    const legacyPatch = { priority: "strength", trainingDays: [1, 3], weeklyStrengthSessions: 2, displayName: "Renamed" };
    const tool = app.toolRegistry().find((item) => item.name === "propose_profile_update")!;
    expect(tool.inputSchema.safeParse({ clientRequestId: "req-legacy", patch: legacyPatch, rationale: "legacy client" }).success).toBe(true);
    const patch = app.proposeProfileUpdate({ clientRequestId: "req-legacy", patch: legacyPatch, rationale: "legacy client" }).patch as Record<string, unknown>;
    expect(patch).toMatchObject({ displayName: "Renamed" });
    expect("priority" in patch).toBe(false);
    expect("trainingDays" in patch).toBe(false);
    expect("weeklyStrengthSessions" in patch).toBe(false);
  });
});
