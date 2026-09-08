import { afterEach, describe, expect, it } from "vitest";
import { AthriaRepository } from "@athria/data";
import { PLAN_SCHEMA_VERSION, TAXONOMY_VERSION } from "@athria/schemas";
import { AthriaApplication, AthriaError } from "./index";

let repository: AthriaRepository | undefined;
afterEach(() => repository?.close());
const fact = <T>(value: T) => ({ value, source: "catalog" as const, confidence: 1, evidence: "fixture", taxonomyVersion: TAXONOMY_VERSION });
const template = () => ({ id: "full-body", name: "Full body", intent: "Build strength", durationMinutes: 60, recoveryDemand: "high" as const, notes: "", components: [{ id: "strength", name: "Strength", domain: fact("strength" as const), prescription: { kind: "strength" as const, exercises: [{ id: "squat", displayName: "Goblet Squat", canonicalKey: "goblet_squat", classification: { primaryMovement: fact("squat" as const), primaryMuscles: fact(["quadriceps" as const]), secondaryMuscles: fact(["glutes" as const]), equipment: fact(["dumbbell" as const]), impact: fact("low" as const), laterality: fact("bilateral" as const) }, sets: 3, repsMin: 8, repsMax: 12, targetRpe: 8, restSeconds: 120, referenceLoad: null, referenceLoadUnit: null, notes: "" }] } }] });
const plan = (app: AthriaApplication, expectedRevision = 0) => ({ planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: "local-user", title: "Current plan", summary: "", effectiveStartDate: "2026-09-07", mesocycle: { durationWeeks: 1, schedule: { kind: "fixed_week" as const, days: [{ id: "monday", dayOfWeek: 0, templateIds: ["full-body"] }] }, phases: [{ id: "base", phaseType: "foundation" as const, name: "Base", startWeek: 1, endWeek: 1, focus: "Build capacity", progression: [] }], adjustmentRules: [] }, sourceAgent: "test", model: null, skillVersion: "0.3.0", inputSnapshotHash: app.snapshotHash(), expectedRevision });

describe("template library and current plan", () => {
  it("creates, updates and deletes an unreferenced latest template", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    expect(app.createTemplate(template())).toMatchObject({ revision: 1 });
    expect(app.updateTemplate({ template: { ...template(), name: "Updated" }, expectedRevision: 1 })).toMatchObject({ template: { name: "Updated", revision: 2 } });
    expect(app.deleteTemplate("full-body", 2)).toEqual({ deleted: true, id: "full-body" });
  });

  it("saves only one current plan and protects referenced templates", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T02:00:00Z"));
    app.createTemplate(template());
    expect(app.saveCurrentPlan(plan(app))).toMatchObject({ plan: { revision: 1, title: "Current plan" }, validation: { valid: true } });
    expect(() => app.deleteTemplate("full-body", 1)).toThrowError(/training rhythm/i);
    expect(app.saveCurrentPlan({ ...plan(app, 1), title: "Replacement", futureSessionPolicy: "update" })).toMatchObject({ plan: { revision: 2, title: "Replacement" } });
  });

  it("rejects missing template references, stale snapshots and revision conflicts", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    expect(() => app.saveCurrentPlan(plan(app))).toThrowError(AthriaError);
    app.createTemplate(template()); expect(() => app.saveCurrentPlan({ ...plan(app), inputSnapshotHash: "stale" })).toThrowError(/changed/i);
    app.saveCurrentPlan(plan(app)); expect(() => app.saveCurrentPlan(plan(app))).toThrowError(/changed/i);
  });

  it("uses the current plan for next-day sessions and requires future update policy", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T02:00:00Z"));
    app.createTemplate(template()); app.saveCurrentPlan(plan(app));
    expect(app.getNextTrainingDay().nextTrainingDay).toMatchObject({ scheduledDate: "2026-09-07", expectedTemplateIds: ["full-body"] });
    expect(() => app.updateTemplate({ template: { ...template(), name: "New name" }, expectedRevision: 1 })).toThrowError(/choose keep or update/i);
    expect(app.updateTemplate({ template: { ...template(), name: "New name" }, expectedRevision: 1, futureSessionPolicy: "update" })).toMatchObject({ impact: { updatedCount: 1 } });
    expect(repository.listCurrentPlannedSessions()[0]).toMatchObject({ name: "New name", status: "planned" });
  });

  it("moves interval occurrences, completes the current session, and skips without shifting later dates", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T02:00:00Z"));
    app.createTemplate(template());
    const base = plan(app); const candidate = { ...base, mesocycle: { ...base.mesocycle, durationWeeks: 2, schedule: { kind: "interval", intervalDays: 2, rotation: [{ id: "rotation-a", templateIds: ["full-body"] }] }, phases: [{ ...base.mesocycle.phases[0]!, endWeek: 2 }] } };
    app.saveCurrentPlan(candidate);
    const first = app.getNextTrainingDay().nextTrainingDay!;
    app.updatePlannedSession(first.existingSessions[0]!.id, { action: "move_occurrence", scheduledDate: "2026-09-08", expectedRevision: 0 });
    expect(repository.listCurrentPlannedSessions().slice(0, 2).map((item) => item.scheduledDate)).toEqual(["2026-09-08", "2026-09-10"]);
    const moved = app.getNextTrainingDay().nextTrainingDay!;
    app.updatePlannedSession(moved.existingSessions[0]!.id, { action: "complete", expectedRevision: 1 });
    expect(repository.listCurrentPlannedSessions()[0]).toMatchObject({ status: "completed", completionSource: "manual" });
    const second = app.getNextTrainingDay().nextTrainingDay!;
    const laterDate = repository.listCurrentPlannedSessions()[2]!.scheduledDate;
    app.updatePlannedSession(second.existingSessions[0]!.id, { action: "skip", expectedRevision: 2 });
    expect(repository.listCurrentPlannedSessions()[2]!.scheduledDate).toBe(laterDate);
    expect(app.getNextTrainingDay().nextTrainingDay?.scheduledDate).toBe(laterDate);
  });

  it("keeps a multi-session training day current until every session is handled", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T02:00:00Z"));
    app.createTemplate(template());
    app.createTemplate({ ...template(), id: "accessory", name: "Accessory", recoveryDemand: "low" });
    const base = plan(app);
    app.saveCurrentPlan({ ...base, mesocycle: { ...base.mesocycle, schedule: { kind: "fixed_week", days: [{ id: "monday", dayOfWeek: 0, templateIds: ["full-body", "accessory"] }] } } });

    const first = app.getNextTrainingDay().nextTrainingDay!;
    expect(first.existingSessions).toHaveLength(2);
    app.updatePlannedSession(first.existingSessions[0]!.id, { action: "complete", expectedRevision: 0 });
    expect(app.getNextTrainingDay().nextTrainingDay).toMatchObject({ occurrenceId: first.occurrenceId, scheduledDate: first.scheduledDate });
    app.updatePlannedSession(first.existingSessions[1]!.id, { action: "skip", expectedRevision: 1 });
    expect(app.getNextTrainingDay().nextTrainingDay).toBeNull();
  });

  it("exposes v4 MCP writes without draft or version tools", () => {
    repository = new AthriaRepository(":memory:"); const names = new AthriaApplication(repository).toolRegistry().map((item) => item.name);
    expect(names).toContain("save_current_plan"); expect(names).toContain("create_session_template"); expect(names).toContain("delete_session_template");
    expect(names).not.toContain("save_plan_draft"); expect(names).not.toContain("list_plan_versions");
  });

  it("keeps Profile suggestion approval unchanged", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    const proposal = app.proposeProfileUpdate({ clientRequestId: "profile", patch: { displayName: "Athlete Two" }, rationale: "User supplied name" });
    expect(app.getProfile().displayName).toBe("Athlete"); app.approveProfileUpdate(proposal.id, "local-user"); expect(app.getProfile().displayName).toBe("Athlete Two");
  });
});
