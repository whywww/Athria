import { describe, expect, it } from "vitest";
import { agentPlanDraftSchema, athleteProfileSchema, jsonSchemas, mesocycleSchema, planDraftSchema, trainingSessionSchema } from "./index";

describe("public schema contracts", () => {
  it("rejects unknown profile fields", () => expect(() => athleteProfileSchema.parse({ unexpected: true })).toThrow());
  it("accepts unique training days and rejects legacy or duplicate availability", () => {
    expect(athleteProfileSchema.parse({ trainingDays: [0, 3, 6] }).trainingDays).toEqual([0, 3, 6]);
    expect(() => athleteProfileSchema.parse({ trainingDays: [0, 0] })).toThrow(/unique/i);
    expect(() => athleteProfileSchema.parse({ availability: [] })).toThrow();
    expect(() => athleteProfileSchema.parse({ maxHeartRate: 180 })).toThrow();
  });
  it("rejects timestamps without an explicit timezone offset", () => expect(() => trainingSessionSchema.parse({ id: "x", source: "fixture", externalId: "x", modality: "strength", name: "x", startAt: "2026-09-01T10:00:00", endAt: "2026-09-01T11:00:00", durationMinutes: 60 })).toThrow());
  it("rejects undeclared weight units", () => expect(() => trainingSessionSchema.parse({ id: "x", source: "fixture", externalId: "x", modality: "strength", name: "x", startAt: "2026-09-01T10:00:00Z", endAt: "2026-09-01T11:00:00Z", durationMinutes: 60, strengthSets: [{ exerciseRaw: "Squat", setIndex: 1, weight: 100, weightUnit: "stone", reps: 5 }] })).toThrow());
  it("exports strict JSON Schema for shared contracts", () => {
    expect(jsonSchemas.planDraft).toMatchObject({ type: "object", additionalProperties: false });
    expect(jsonSchemas.athleteProfile).toMatchObject({ properties: { trainingDays: { uniqueItems: true, maxItems: 7 } } });
  });
  it("requires mesocycle structure and rejects dated sessions in Agent drafts", () => {
    const base = { id: "draft", ownerId: "local-user", clientRequestId: "request", title: "Plan", summary: "", sourceAgent: null, model: null, skillVersion: null, inputSnapshotHash: "hash", createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-01T10:00:00Z" };
    expect(planDraftSchema.parse(base).mesocycle).toBeNull();
    expect(agentPlanDraftSchema.safeParse({ ...base, sessions: [] }).success).toBe(false);
  });
  it("enforces compact plan fields, stable labels, and plan-only modalities", () => {
    const mesocycle = { durationWeeks: 1, weeklyStructure: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, templateIds: dayOfWeek === 0 ? ["a", "b"] : [] })), sessionTemplates: [{ id: "a", label: "A", name: "Strength", modality: "strength", intent: "Build strength", durationMinutes: 45, recoveryDemand: "high", exercises: [] }, { id: "b", label: "B", name: "Run", modality: "endurance", intent: "Aerobic base", durationMinutes: 30, recoveryDemand: "normal", exercises: [] }], phases: [{ id: "base", phaseType: "foundation", name: "Base", startWeek: 1, endWeek: 1, focus: "Build capacity" }] };
    expect(mesocycleSchema.parse(mesocycle).sessionTemplates).toHaveLength(2);
    expect(mesocycleSchema.safeParse({ ...mesocycle, sessionTemplates: [{ ...mesocycle.sessionTemplates[0], label: "B" }, mesocycle.sessionTemplates[1]] }).success).toBe(false);
    expect(mesocycleSchema.safeParse({ ...mesocycle, sessionTemplates: [{ ...mesocycle.sessionTemplates[0], modality: "unknown" }, mesocycle.sessionTemplates[1]] }).success).toBe(false);
    expect(mesocycleSchema.safeParse({ ...mesocycle, phases: [{ ...mesocycle.phases[0], focus: "x".repeat(301) }] }).success).toBe(false);
  });
});
