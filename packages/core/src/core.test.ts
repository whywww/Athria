import { describe, expect, it } from "vitest";
import { defaultProfile, mesocycleSchema, TAXONOMY_VERSION } from "@athria/schemas";
import { estimateOneRepMax, evaluateDoubleProgression, evaluateRpeAutoregulation, expandSchedule, validatePlan } from "./index";

const mesocycle = { durationWeeks: 1, schedule: { kind: "fixed_week" as const, days: [0] }, domainProgressions: [], weeks: [{ weekNumber: 1, focus: null, sessions: [] }], adjustmentRules: [] };

describe("deterministic v7 core", () => {
  it("expands rhythm without templates or dose generation", () => {
    expect(expandSchedule({ effectiveStartDate: "2026-09-07", durationWeeks: 2, schedule: { kind: "fixed_week", days: [0, 3] } }).map((item) => item.scheduledDate)).toEqual(["2026-09-07", "2026-09-10", "2026-09-14", "2026-09-17"]);
    expect(expandSchedule({ effectiveStartDate: "2026-09-07", durationWeeks: 1, schedule: { kind: "flexible_week", targetDaysPerWeek: 3, minDaysPerWeek: 2, maxDaysPerWeek: 4 } })).toHaveLength(3);
    expect(expandSchedule({ effectiveStartDate: "2026-09-07", durationWeeks: 1, schedule: { kind: "interval", intervalDays: 2 } })).toHaveLength(4);
  });
  it("rejects incomplete weeks and validates actual weekly sessions only", () => {
    expect(validatePlan(defaultProfile(), { effectiveStartDate: "2026-09-07", mesocycle: { ...mesocycle, weeks: [] } }).valid).toBe(false);
    expect(validatePlan({ ...defaultProfile(), trainingRhythm: { kind: "fixed_week", days: [0] } }, { effectiveStartDate: "2026-09-07", mesocycle }).results.find((item) => item.reasonCode === "MESOCYCLE_SCHEDULE")?.status).toBe("pass");
  });
  it("no longer emits exercise-exclusion or movement-pattern prohibition rules", () => {
    const codes = validatePlan(defaultProfile(), { effectiveStartDate: "2026-09-07", mesocycle }).results.map((item) => item.reasonCode);
    expect(codes).not.toContain("EXERCISE_EXCLUSION");
    expect(codes).not.toContain("MOVEMENT_PATTERN_PROHIBITED");
  });
  it("keeps explicit-input calculators independent from templates", () => {
    expect(estimateOneRepMax(100, 5, "kg").value).toBe(116.67);
    expect(evaluateDoubleProgression({ completedReps: [8, 8, 8], repMin: 5, repMax: 8, currentLoad: 100, loadIncrement: 2.5, unit: "kg", rpeCeiling: 8 }).reasonCode).toBe("RPE_DATA_MISSING");
    expect(evaluateRpeAutoregulation({ actualRpe: null, targetRpe: 8, load: 100, increment: 2.5, unit: "kg" }).action).toBe("insufficient_data");
  });
  it("compares explicit recovery days against day gaps between high-demand sessions", () => {
    const high = (id: string, scheduledDate: string) => ({ id, scheduledDate, order: 0, status: "planned" as const, templateRef: null, name: id, intent: "High-demand session", durationMinutes: 60, recoveryDemand: "high" as const, keySession: false, components: [], progressionNote: null, schedulingRationale: null, legacySnapshot: false });
    const recoveryPlan = { effectiveStartDate: "2026-09-07", mesocycle: { durationWeeks: 2, schedule: { kind: "fixed_week" as const, days: [0, 2] }, domainProgressions: [], weeks: [{ weekNumber: 1, focus: null, sessions: [high("mon-1", "2026-09-07"), high("wed-1", "2026-09-09")] }, { weekNumber: 2, focus: null, sessions: [high("mon-2", "2026-09-14"), high("wed-2", "2026-09-16")] }], adjustmentRules: [] } };
    const profile = (explicitRecoveryDays: number | null) => ({ ...defaultProfile(), trainingRhythm: { kind: "fixed_week" as const, days: [0, 2] }, explicitRecoveryDays });
    const required = validatePlan(profile(3), recoveryPlan);
    expect(required.results.find((item) => item.reasonCode === "EXPLICIT_RECOVERY_INTERVAL")).toMatchObject({ status: "fail", enforcement: "blocker", evidence: { closestDays: 2, requiredDays: 3 } });
    expect(required.valid).toBe(false);
    const accepted = validatePlan(profile(2), recoveryPlan);
    expect(accepted.results.find((item) => item.reasonCode === "EXPLICIT_RECOVERY_INTERVAL")).toMatchObject({ status: "pass" });
    expect(accepted.valid).toBe(true);
    const advisory = validatePlan(profile(null), recoveryPlan);
    expect(advisory.results.find((item) => item.reasonCode === "EXPLICIT_RECOVERY_INTERVAL")).toBeUndefined();
    expect(advisory.results.find((item) => item.reasonCode === "ADJACENT_HIGH_DEMAND_SESSIONS")).toMatchObject({ status: "pass", enforcement: "advisory", evidence: { closestDays: 2 } });
  });
  it("advises on domain-specific effort notation without blocking the plan", () => {
    const fact = (value: unknown) => ({ value, source: "user_confirmed", confidence: 1, evidence: "fixture", taxonomyVersion: TAXONOMY_VERSION });
    const phase = (domain: "strength" | "endurance") => ({ id: `${domain}-base`, phaseType: "foundation", name: "Base", startWeek: 1, endWeek: 1, focus: "Base", progression: [] });
    const exercise = (id: string, targetRpe: number | null, targetRir: number | null = null) => ({ id, displayName: id, canonicalKey: null, classification: { primaryMovement: fact("squat"), primaryMuscles: fact(["quadriceps"]), secondaryMuscles: fact([]), equipment: fact(["barbell"]), impact: fact("low"), laterality: fact("bilateral") }, sets: 3, repsMin: 8, repsMax: 10, targetRpe, targetRir, restSeconds: 90, referenceLoad: null, referenceLoadUnit: null, notes: "" });
    const strengthComponent = (exercises: unknown[]) => ({ id: "strength", name: "Strength", domain: fact("strength"), prescription: { kind: "strength", exercises } });
    const enduranceComponent = (segments: unknown[]) => ({ id: "endurance", name: "Endurance", domain: fact("endurance"), prescription: { kind: "endurance", segments } });
    const step = (name: string, heartRateZone?: string) => ({ type: "step", name, role: "work", ...(heartRateZone ? { heartRateZone } : {}) });
    const workPlan = (components: unknown[], domains: Array<"strength" | "endurance">) => mesocycleSchema.parse({ durationWeeks: 1, schedule: { kind: "fixed_week", days: [0] }, domainProgressions: domains.map((domain) => ({ domain, phases: [phase(domain)] })), weeks: [{ weekNumber: 1, focus: null, sessions: [{ id: "session-1", scheduledDate: "2026-09-07", order: 0, name: "Mixed", intent: "Train", durationMinutes: 60, components }] }], adjustmentRules: [] });
    const profile = { ...defaultProfile(), trainingRhythm: { kind: "fixed_week" as const, days: [0] } };
    const aligned = validatePlan(profile, { effectiveStartDate: "2026-09-07", mesocycle: workPlan([strengthComponent([exercise("squat", 7)]), enduranceComponent([step("Tempo work", "Zone 4")])], ["strength", "endurance"]) });
    expect(aligned.results.find((item) => item.reasonCode === "STRENGTH_EFFORT_RPE")).toMatchObject({ status: "pass", enforcement: "advisory", rulePackId: "strength" });
    expect(aligned.results.find((item) => item.reasonCode === "ENDURANCE_EFFORT_ZONE")).toMatchObject({ status: "pass", enforcement: "advisory", rulePackId: "structure", evidence: { stepCount: 1 } });
    const missing = validatePlan(profile, { effectiveStartDate: "2026-09-07", mesocycle: workPlan([strengthComponent([exercise("squat", null), exercise("row", null, 2)]), enduranceComponent([step("Tempo work"), { type: "repeat", name: "Repeats", repetitions: 4, work: step("Hard repeats"), recovery: step("Jog recovery", "Zone 1–2") }])], ["strength", "endurance"]) });
    expect(missing.results.find((item) => item.reasonCode === "STRENGTH_EFFORT_RPE")).toMatchObject({ status: "fail", evidence: { exerciseCount: 2, missingEffort: ["squat"] } });
    expect(missing.results.find((item) => item.reasonCode === "ENDURANCE_EFFORT_ZONE")).toMatchObject({ status: "fail", evidence: { stepCount: 3, missingZone: ["Tempo work", "Hard repeats"] } });
    expect(missing.valid).toBe(true);
    const enduranceOnly = validatePlan(profile, { effectiveStartDate: "2026-09-07", mesocycle: workPlan([enduranceComponent([step("Easy work", "Zone 2")])], ["endurance"]) });
    expect(enduranceOnly.results.find((item) => item.reasonCode === "STRENGTH_EFFORT_RPE")).toMatchObject({ status: "not_applicable" });
  });
});
