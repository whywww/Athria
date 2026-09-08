import { describe, expect, it } from "vitest";
import { TAXONOMY_VERSION, athleteProfileSchema, currentPlanSchema, jsonSchemas, mesocycleSchema, resolvedMesocycleSchema, sessionTemplateSchema, trainingSessionSchema } from "./index";

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
    expect(jsonSchemas.currentPlan).toMatchObject({ type: "object", additionalProperties: false });
    expect(jsonSchemas.athleteProfile).toMatchObject({ properties: { trainingDays: { uniqueItems: true, maxItems: 7 } } });
  });
  it("requires an explicit start date and rejects embedded templates in current plans", () => {
    const base = { planSchemaVersion: "4.0", ownerId: "local-user", title: "Plan", summary: "", effectiveStartDate: "2026-09-01", mesocycle: { durationWeeks: 1, weeklyStructure: [{ dayOfWeek: 0, templateIds: ["a"] }], phases: [{ id: "base", phaseType: "foundation", name: "Base", startWeek: 1, endWeek: 1, focus: "Base", progression: [] }], adjustmentRules: [] }, revision: 1, sourceAgent: null, model: null, skillVersion: null, inputSnapshotHash: null, updatedAt: "2026-09-01T10:00:00Z" };
    expect(currentPlanSchema.parse(base).effectiveStartDate).toBe("2026-09-01");
    expect(currentPlanSchema.safeParse({ ...base, mesocycle: { ...base.mesocycle, sessionTemplates: [] } }).success).toBe(false);
  });
  it("accepts component domains and rejects the removed mixed modality", () => {
    const fact = <T>(value: T) => ({ value, source: "user_confirmed", confidence: 1, evidence: "fixture", taxonomyVersion: TAXONOMY_VERSION });
    const mesocycle = { durationWeeks: 1, weeklyStructure: [{ dayOfWeek: 0, templateIds: ["a", "b"] }], sessionTemplates: [{ id: "a", name: "Strength", intent: "Build strength", durationMinutes: 45, recoveryDemand: "high", components: [{ id: "strength", name: "Strength", domain: fact("strength"), prescription: { kind: "strength", exercises: [{ id: "squat", displayName: "Squat", canonicalKey: null, classification: { primaryMovement: fact("squat"), primaryMuscles: fact(["quadriceps"]), secondaryMuscles: fact(["glutes"]), equipment: fact(["barbell"]), impact: fact("low"), laterality: fact("bilateral") }, sets: 3, repsMin: 5, repsMax: 8 }] } }] }, { id: "b", name: "Run", intent: "Aerobic base", durationMinutes: 30, recoveryDemand: "normal", components: [{ id: "run", name: "Run", domain: fact("endurance"), prescription: { kind: "duration_only", notes: "Easy" } }] }], phases: [{ id: "base", phaseType: "foundation", name: "Base", startWeek: 1, endWeek: 1, focus: "Build capacity" }] };
    const { sessionTemplates, ...planMesocycle } = mesocycle;
    expect(mesocycleSchema.parse(planMesocycle).weeklyStructure).toHaveLength(1);
    expect(sessionTemplateSchema.parse(sessionTemplates[0])).toMatchObject({ id: "a" });
    const multiDomain = { ...mesocycle.sessionTemplates[0]!, components: [...mesocycle.sessionTemplates[0]!.components, mesocycle.sessionTemplates[1]!.components[0]!] };
    expect(resolvedMesocycleSchema.parse({ ...planMesocycle, sessionTemplates: [multiDomain, sessionTemplates[1]] }).sessionTemplates[0]?.components.map((component) => component.domain.value)).toEqual(["strength", "endurance"]);
    expect(sessionTemplateSchema.safeParse({ ...sessionTemplates[0], modality: "mixed" }).success).toBe(false);
    expect(mesocycleSchema.safeParse({ ...planMesocycle, phases: [{ ...mesocycle.phases[0], focus: "x".repeat(301) }] }).success).toBe(false);
  });
});
