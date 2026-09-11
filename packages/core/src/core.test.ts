import { describe, expect, it } from "vitest";
import { defaultProfile } from "@athria/schemas";
import { estimateOneRepMax, evaluateDoubleProgression, evaluateRpeAutoregulation, expandSchedule, validatePlan } from "./index";

const mesocycle = { durationWeeks: 1, schedule: { kind: "fixed_week" as const, days: [0] }, domainProgressions: [], weeks: [{ weekNumber: 1, focus: null, sessions: [] }], adjustmentRules: [] };

describe("deterministic v7 core", () => {
  it("expands rhythm without templates or dose generation", () => {
    expect(expandSchedule({ effectiveStartDate: "2026-09-07", durationWeeks: 2, schedule: { kind: "fixed_week", days: [0, 3] } }).map((item) => item.scheduledDate)).toEqual(["2026-09-07", "2026-09-10", "2026-09-14", "2026-09-17"]);
    expect(expandSchedule({ effectiveStartDate: "2026-09-07", durationWeeks: 1, schedule: { kind: "flexible_week", targetDaysPerWeek: 3, minDaysPerWeek: 2, maxDaysPerWeek: 4 } })).toHaveLength(3);
    expect(expandSchedule({ effectiveStartDate: "2026-09-07", durationWeeks: 1, schedule: { kind: "interval", intervalDays: 2 } })).toHaveLength(4);
  });
  it("rejects incomplete weeks and validates actual weekly sessions only", () => {
    expect(validatePlan(defaultProfile(), { effectiveStartDate: "2026-09-07", mesocycle: { ...mesocycle, weeks: [] } }, []).valid).toBe(false);
    expect(validatePlan({ ...defaultProfile(), trainingRhythm: { kind: "fixed_week", days: [0] } }, { effectiveStartDate: "2026-09-07", mesocycle }, []).results.find((item) => item.reasonCode === "MESOCYCLE_SCHEDULE")?.status).toBe("pass");
  });
  it("keeps explicit-input calculators independent from templates", () => {
    expect(estimateOneRepMax(100, 5, "kg").value).toBe(116.67);
    expect(evaluateDoubleProgression({ completedReps: [8, 8, 8], repMin: 5, repMax: 8, currentLoad: 100, loadIncrement: 2.5, unit: "kg", rpeCeiling: 8 }).reasonCode).toBe("RPE_DATA_MISSING");
    expect(evaluateRpeAutoregulation({ actualRpe: null, targetRpe: 8, load: 100, increment: 2.5, unit: "kg" }).action).toBe("insufficient_data");
  });
});
