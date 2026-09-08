import { describe, expect, it } from "vitest";
import { TAXONOMY_VERSION, defaultProfile, type ExerciseDefinition, type ResolvedMesocycle, type TrainingSession } from "@athria/schemas";
import { calculateHeartRateZones, calculateTrainingMetrics, estimateOneRepMax, evaluateDoubleProgression, evaluateRpeAutoregulation, expandSchedule, stableHash, validatePlan } from "./index";

const fact = <T>(value: T, source = "catalog", confidence = 1, evidence = "fixture") => ({ value, source: source as "catalog" | "ai_inferred" | "user_confirmed", confidence, evidence, taxonomyVersion: TAXONOMY_VERSION as typeof TAXONOMY_VERSION });
const exercise = (patch: Record<string, unknown> = {}) => ({
  id: "squat", displayName: "Squat", canonicalKey: "squat",
  classification: { primaryMovement: fact("squat" as const), primaryMuscles: fact(["quadriceps" as const]), secondaryMuscles: fact(["glutes" as const]), equipment: fact(["barbell" as const]), impact: fact("low" as const), laterality: fact("bilateral" as const) },
  sets: 3, repsMin: 5, repsMax: 8, targetRpe: 8, restSeconds: 120, referenceLoad: null, referenceLoadUnit: null, notes: "", ...patch,
});
const draft: { effectiveStartDate: string; mesocycle: ResolvedMesocycle } = { effectiveStartDate: "2026-09-07", mesocycle: { durationWeeks: 1, schedule: { kind: "fixed_week", days: [{ id: "monday", dayOfWeek: 0, templateIds: ["squat"] }] }, sessionTemplates: [{ id: "squat", name: "Squat", intent: "strength", durationMinutes: 60, recoveryDemand: "high", notes: "", components: [{ id: "strength-main", name: "Strength", domain: fact("strength" as const), prescription: { kind: "strength", exercises: [exercise()] } }] }], phases: [{ id: "base", phaseType: "foundation", name: "Base", startWeek: 1, endWeek: 1, focus: "Build capacity", progression: [] }], adjustmentRules: [] } };
const catalog: ExerciseDefinition[] = [{ key: "squat", name: "Squat", movement: "squat", primaryMuscles: ["quadriceps"], secondaryMuscles: ["glutes"], equipment: ["barbell"], unilateral: false, tags: [] }];
const session: TrainingSession = { id: "s1", ownerId: "local-user", source: "fixture", externalId: "one", modality: "strength", domains: ["strength"], sport: null, name: "Strength", startAt: "2026-09-01T18:00:00+08:00", endAt: "2026-09-01T19:00:00+08:00", durationMinutes: 60, status: "completed", timezone: "Asia/Hong_Kong", endurance: null, missingFields: [], strengthSets: [{ exerciseRaw: "Squat", exerciseKey: "squat", movement: "squat", primaryMuscles: ["quadriceps"], secondaryMuscles: ["glutes"], setIndex: 1, setType: "normal", weight: 100, weightUnit: "kg", reps: 5, rpe: 8 }] };

describe("deterministic core", () => {
  it("expands fixed, flexible, and interval rhythms deterministically", () => {
    const fixed = expandSchedule({ effectiveStartDate: "2026-09-07", durationWeeks: 2, schedule: { kind: "fixed_week", days: [{ id: "monday", dayOfWeek: 0, templateIds: ["a"] }] } });
    expect(fixed.map((item) => item.scheduledDate)).toEqual(["2026-09-07", "2026-09-14"]);
    const flexible = expandSchedule({ effectiveStartDate: "2026-09-07", durationWeeks: 2, schedule: { kind: "flexible_week", targetSessionsPerWeek: 3, minSessionsPerWeek: 2, maxSessionsPerWeek: 4, rotation: [{ id: "a", templateIds: ["a"] }, { id: "b", templateIds: ["b"] }] }, trainingDays: [0, 2, 4] });
    expect(flexible).toHaveLength(6); expect(flexible.every((item) => [0, 2, 4].includes(item.dayOfWeek))).toBe(true); expect(flexible.map((item) => item.slotId)).toEqual(["a", "b", "a", "b", "a", "b"]);
    const interval = expandSchedule({ effectiveStartDate: "2026-09-07", durationWeeks: 1, schedule: { kind: "interval", intervalDays: 2, rotation: [{ id: "a", templateIds: ["a"] }] }, trainingDays: [0, 2, 4] });
    expect(interval.map((item) => item.scheduledDate)).toEqual(["2026-09-07", "2026-09-09", "2026-09-11"]);
    const recovered = expandSchedule({ effectiveStartDate: "2026-09-07", durationWeeks: 1, schedule: { kind: "interval", intervalDays: 1, rotation: [{ id: "hard", templateIds: ["hard"] }] }, recoveryDemandByTemplate: { hard: "high" }, explicitRecoveryHours: 48 });
    expect(recovered.map((item) => item.scheduledDate)).toEqual(["2026-09-07", "2026-09-09", "2026-09-11", "2026-09-13"]);
  });
  it("uses hand-calculable metrics and preserves separated domains", () => {
    expect(estimateOneRepMax(100, 5, "kg").value).toBe(116.67);
    expect(calculateHeartRateZones(200).value.zone1).toEqual({ min: 100, max: 119 });
    const metrics = calculateTrainingMetrics([session]);
    expect(metrics.strength.rawVolume.value).toBe(500);
    expect(metrics.strength.directSetsByMuscle.value).toEqual({ quadriceps: 1 });
  });
  it("accepts sparse weeks and blocks unavailable equipment", () => {
    const result = validatePlan(defaultProfile(), draft, catalog, new Date("2026-09-01T00:00:00Z"));
    expect(result.results.find((item) => item.reasonCode === "MESOCYCLE_SCHEDULE")?.status).toBe("pass");
    expect(result.results.find((item) => item.reasonCode === "EXERCISE_EQUIPMENT")?.status).toBe("fail");
  });
  it("allows a custom exercise with a supported high-confidence AI classification", () => {
    const custom = structuredClone(draft);
    const item = custom.mesocycle!.sessionTemplates[0]!.components[0]!.prescription;
    if (item.kind !== "strength") throw new Error("fixture");
    item.exercises[0] = exercise({ id: "custom", displayName: "Custom press", canonicalKey: null, classification: { ...exercise().classification, primaryMovement: fact("horizontal_push" as const, "ai_inferred", 0.9, "Name and prescription indicate a press"), equipment: fact(["dumbbell" as const], "ai_inferred", 0.9, "Prescription explicitly uses dumbbells") } });
    expect(validatePlan(defaultProfile(), custom, catalog).valid).toBe(true);
  });
  it("returns blocking unknown below the AI confidence boundary", () => {
    const custom = structuredClone(draft); const prescription = custom.mesocycle!.sessionTemplates[0]!.components[0]!.prescription;
    if (prescription.kind !== "strength") throw new Error("fixture");
    prescription.exercises[0]!.classification.equipment = fact(["dumbbell"], "ai_inferred", 0.899, "uncertain") as typeof prescription.exercises[0]["classification"]["equipment"];
    const result = validatePlan(defaultProfile(), custom, catalog);
    expect(result.valid).toBe(false);
    expect(result.results.find((item) => item.reasonCode === "EXERCISE_EQUIPMENT")?.status).toBe("unknown");
    expect(result.dataGaps[0]).toMatchObject({ blocking: true, factPath: "classification.equipment" });
  });
  it("requires AI evidence, detects catalog conflicts, and lets user confirmation resolve them", () => {
    const withoutEvidence = structuredClone(draft); const first = withoutEvidence.mesocycle!.sessionTemplates[0]!.components[0]!.prescription;
    if (first.kind !== "strength") throw new Error("fixture");
    first.exercises[0]!.classification.equipment = fact(["barbell"], "ai_inferred", 0.99, "") as typeof first.exercises[0]["classification"]["equipment"];
    expect(validatePlan({ ...defaultProfile(), equipment: ["barbell"] }, withoutEvidence, catalog).results.find((item) => item.reasonCode === "EXERCISE_EQUIPMENT")?.status).toBe("unknown");

    const conflicting = structuredClone(draft); const second = conflicting.mesocycle!.sessionTemplates[0]!.components[0]!.prescription;
    if (second.kind !== "strength") throw new Error("fixture");
    second.exercises[0]!.classification.equipment = fact(["dumbbell"], "ai_inferred", 0.99, "Plan says dumbbell") as typeof second.exercises[0]["classification"]["equipment"];
    expect(validatePlan(defaultProfile(), conflicting, catalog).results.find((item) => item.reasonCode === "EXERCISE_EQUIPMENT")?.status).toBe("unknown");
    second.exercises[0]!.classification.equipment = { ...fact(["dumbbell"], "ai_inferred", 0.99, "Plan says dumbbell"), conflicts: [{ source: "structured_source" as const, value: ["barbell"], evidence: "Imported prescription says barbell" }] } as typeof second.exercises[0]["classification"]["equipment"];
    expect(validatePlan(defaultProfile(), { ...conflicting, mesocycle: conflicting.mesocycle }, []).results.find((item) => item.reasonCode === "EXERCISE_EQUIPMENT")?.status).toBe("unknown");
    second.exercises[0]!.classification.equipment = fact(["dumbbell"], "user_confirmed", 1, "User confirmed this variant") as typeof second.exercises[0]["classification"]["equipment"];
    expect(validatePlan(defaultProfile(), conflicting, catalog).results.find((item) => item.reasonCode === "EXERCISE_EQUIPMENT")?.status).toBe("pass");
  });
  it("keeps an unrelated unclassified duration component non-blocking", () => {
    const unclassified = structuredClone(draft);
    unclassified.mesocycle!.sessionTemplates[0]!.components.push({ id: "custom-duration", name: "Custom drill", domain: fact(null, "ai_inferred", 0.3, "Ambiguous drill"), prescription: { kind: "duration_only", notes: "Ten minutes" } });
    const result = validatePlan({ ...defaultProfile(), equipment: ["barbell"] }, unclassified, catalog);
    expect(result.valid).toBe(true);
    expect(result.results.find((item) => item.reasonCode === "COMPONENT_DOMAIN_MISSING")?.enforcement).toBe("info");
    expect(result.dataGaps.find((gap) => gap.code === "COMPONENT_DOMAIN_MISSING")).toMatchObject({ blocking: false, resolution: "agent_infer" });
  });
  it("enforces typed identity and movement constraints", () => {
    const profile = { ...defaultProfile(), equipment: ["barbell" as const], strengthConstraints: [{ id: "no-squat", type: "prohibit_movement_pattern" as const, movementPattern: "squat" as const }] };
    expect(validatePlan(profile, draft, catalog).results.find((item) => item.reasonCode === "MOVEMENT_PATTERN_PROHIBITED")?.status).toBe("fail");
  });
  it("treats exercise ids as unique per template, allowing reuse across templates", () => {
    const reused = structuredClone(draft);
    const second = structuredClone(reused.mesocycle!.sessionTemplates[0]!);
    second.id = "squat-b";
    reused.mesocycle!.sessionTemplates.push(second);
    expect(validatePlan({ ...defaultProfile(), equipment: ["barbell"] }, reused, catalog).results.find((item) => item.reasonCode === "EXERCISE_IDS")?.status).toBe("pass");
  });
  it("blocks a duplicated exercise id within the same template", () => {
    const duplicated = structuredClone(draft); const prescription = duplicated.mesocycle!.sessionTemplates[0]!.components[0]!.prescription;
    if (prescription.kind !== "strength") throw new Error("fixture");
    prescription.exercises.push(structuredClone(prescription.exercises[0]!));
    expect(validatePlan({ ...defaultProfile(), equipment: ["barbell"] }, duplicated, catalog).results.find((item) => item.reasonCode === "EXERCISE_IDS")?.status).toBe("fail");
  });
  it("reports strength distribution and advisory imbalance without blocking", () => {
    const result = validatePlan({ ...defaultProfile(), equipment: ["barbell"] }, draft, catalog);
    expect(result.results.find((item) => item.reasonCode === "STRENGTH_VOLUME_DISTRIBUTION")?.evidence).toMatchObject({ directSetsByMuscle: { quadriceps: 3 } });
    expect(result.results.find((item) => item.reasonCode === "STRENGTH_KNEE_HINGE_BALANCE")?.enforcement).toBe("advisory");
  });
  it("hashes the complete validation context", () => {
    const one = validatePlan({ ...defaultProfile(), equipment: ["barbell"] }, draft, catalog).inputHash;
    const two = validatePlan({ ...defaultProfile(), equipment: ["barbell"], maxSessionMinutes: 90 }, draft, catalog).inputHash;
    expect(one).not.toBe(two);
    expect(one).not.toBe(validatePlan({ ...defaultProfile(), equipment: ["barbell"] }, draft, [{ ...catalog[0]!, tags: ["changed"] }]).inputHash);
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });
  it("keeps progression missing-data behavior", () => {
    expect(evaluateDoubleProgression({ completedReps: [8, 8, 8], repMin: 5, repMax: 8, currentLoad: 100, loadIncrement: 2.5, unit: "kg", rpeCeiling: 8 }).reasonCode).toBe("RPE_DATA_MISSING");
    expect(evaluateRpeAutoregulation({ actualRpe: null, targetRpe: 8, load: 100, increment: 2.5, unit: "kg" }).action).toBe("insufficient_data");
  });
});
