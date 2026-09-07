import { describe, expect, it } from "vitest";
import { defaultProfile, type ExerciseDefinition, type PlanDraft, type TrainingSession } from "@athria/schemas";
import { calculateHeartRateZones, calculateTrainingMetrics, estimateOneRepMax, evaluateDoubleProgression, evaluateRpeAutoregulation, stableHash, validatePlan } from "./index";

const session: TrainingSession = {
  id: "s1", ownerId: "local-user", source: "fixture", externalId: "one", modality: "strength", sport: null,
  name: "Strength", startAt: "2026-09-01T18:00:00+08:00", endAt: "2026-09-01T19:00:00+08:00", durationMinutes: 60,
  status: "completed", timezone: "Asia/Hong_Kong", endurance: null, missingFields: [], strengthSets: [
    { exerciseRaw: "Squat", exerciseKey: "squat", movement: "squat", primaryMuscles: ["quadriceps"], secondaryMuscles: ["glutes"], setIndex: 1, setType: "normal", weight: 100, weightUnit: "kg", reps: 5, rpe: 8 },
  ],
};

const catalog: ExerciseDefinition[] = [{ key: "squat", name: "Squat", movement: "squat", primaryMuscles: ["quadriceps"], secondaryMuscles: ["glutes"], equipment: ["barbell"], unilateral: false, tags: [] }];

const draft: PlanDraft = {
  id: "draft", ownerId: "local-user", clientRequestId: "request", title: "Plan", summary: "", sourceAgent: null, model: null, skillVersion: null,
  inputSnapshotHash: "snapshot", createdAt: "2026-09-01T00:00:00+08:00", updatedAt: "2026-09-01T00:00:00+08:00",
  mesocycle: { durationWeeks: 1, weeklyStructure: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, templateIds: dayOfWeek === 0 ? ["squat"] : [] })), sessionTemplates: [{ id: "squat", label: "A", name: "Squat", modality: "strength", intent: "strength", durationMinutes: 60, recoveryDemand: "high", notes: "", exercises: [{ exerciseKey: "squat", name: "Squat", sets: 3, repsMin: 5, repsMax: 8, targetRpe: 8, restSeconds: 120, referenceLoad: null, referenceLoadUnit: null, notes: "" }] }], phases: [{ id: "base", phaseType: "foundation", name: "Base", startWeek: 1, endWeek: 1, focus: "Build capacity", progression: [] }], adjustmentRules: [] },
};

describe("deterministic core", () => {
  it("uses the hand-calculable Epley formula", () => expect(estimateOneRepMax(100, 5, "kg").value).toBe(116.67));
  it("requires an explicit maximum heart rate", () => expect(calculateHeartRateZones(200).value.zone1).toEqual({ min: 100, max: 119 }));
  it("keeps direct and indirect volume separate", () => {
    const metrics = calculateTrainingMetrics([session]);
    expect(metrics.strength.rawVolume.value).toBe(500);
    expect(metrics.strength.directSetsByMuscle.value).toEqual({ quadriceps: 1 });
    expect(metrics.strength.indirectSetsByMuscle.value).toEqual({ glutes: 1 });
  });
  it("increases only when all sets reach the top of the range", () => expect(evaluateDoubleProgression({ completedReps: [8, 8, 8], repMin: 5, repMax: 8, currentLoad: 100, loadIncrement: 2.5, unit: "kg", rpeValues: [8, 8, 8], rpeCeiling: 8 }).proposedLoad).toBe(102.5));
  it("hard-blocks unavailable equipment", () => {
    const result = validatePlan(defaultProfile(), draft, catalog, new Date("2026-09-01T00:00:00Z"));
    expect(result.valid).toBe(false);
    expect(result.results.some((item) => item.reasonCode === "EXERCISE_EQUIPMENT" && !item.passed)).toBe(true);
  });
  it.each([[0, 5], [100, 0], [100, 13]])("rejects out-of-domain e1RM input", (load, reps) => expect(() => estimateOneRepMax(load, reps, "kg")).toThrow());
  it.each([79, 241, 180.5])("rejects an invalid explicit max heart rate", (max) => expect(() => calculateHeartRateZones(max)).toThrow());
  it("does not increase load when an explicit RPE ceiling cannot be evaluated", () => {
    const result = evaluateDoubleProgression({ completedReps: [8, 8, 8], repMin: 5, repMax: 8, currentLoad: 100, loadIncrement: 2.5, unit: "kg", rpeCeiling: 8 });
    expect(result).toMatchObject({ action: "hold", reasonCode: "RPE_DATA_MISSING", proposedLoad: 100 });
  });
  it("returns insufficient data when RPE is absent", () => expect(evaluateRpeAutoregulation({ actualRpe: null, targetRpe: 8, load: 100, increment: 2.5, unit: "kg" }).action).toBe("insufficient_data"));
  it("reports endurance gaps instead of inventing pace or zones", () => {
    const endurance = { ...session, id: "e1", modality: "endurance" as const, strengthSets: [], endurance: { distanceMeters: null, averageHeartRate: null, maxHeartRate: null, averagePowerWatts: null, maxPowerWatts: null, heartRateZoneSeconds: {} } };
    const metrics = calculateTrainingMetrics([endurance]);
    expect(metrics.endurance.paceSecondsPerKm.value).toBeNull();
    expect(metrics.endurance.paceSecondsPerKm.dataQuality.missingFields).toContain("distanceMeters");
    expect(metrics.endurance.timeInZoneSeconds.dataQuality.missingFields).toContain("heartRateZoneSeconds");
  });
  it("detects an explicit exercise exclusion on a template", () => {
    const profile = { ...defaultProfile(), equipment: ["barbell"], excludedExercises: ["squat"] };
    const result = validatePlan(profile, draft, catalog);
    expect(result.results.some((item) => item.reasonCode === "EXERCISE_EXCLUSION" && !item.passed)).toBe(true);
  });
  it("does not mutate plan inputs and hashes object keys canonically", () => {
    const before = JSON.stringify(draft.mesocycle);
    validatePlan({ ...defaultProfile(), equipment: ["barbell"] }, draft, catalog);
    expect(JSON.stringify(draft.mesocycle)).toBe(before);
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });

  it("rejects inconsistent mesocycle structure and template links", () => {
    const invalid = { ...draft, mesocycle: { ...draft.mesocycle!, durationWeeks: 2, weeklyStructure: draft.mesocycle!.weeklyStructure.map((item) => ({ ...item, templateIds: item.dayOfWeek === 1 ? ["missing"] : item.templateIds })) } };
    const result = validatePlan({ ...defaultProfile(), equipment: ["barbell"] }, invalid, catalog);
    expect(result.valid).toBe(false);
    expect(result.results.filter((item) => !item.passed).map((item) => item.reasonCode)).toEqual(expect.arrayContaining(["MESOCYCLE_WEEKLY_STRUCTURE", "MESOCYCLE_PHASE_PROGRESSION"]));
  });
});
