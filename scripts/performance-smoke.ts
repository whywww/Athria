import { AthriaApplication } from "../packages/application/src/index";
import { AthriaRepository } from "../packages/data/src/index";
import { PLAN_SCHEMA_VERSION, TAXONOMY_VERSION, type TrainingSession } from "../packages/schemas/src/index";

const repository = new AthriaRepository(":memory:");
const now = new Date("2026-09-02T12:00:00Z");
const application = new AthriaApplication(repository, "local-user", () => now);

try {
  const sessions: TrainingSession[] = Array.from({ length: 10_000 }, (_, index) => {
    const start = new Date(now.getTime() - index * 10 * 60_000);
    const end = new Date(start.getTime() + 45 * 60_000);
    return {
      id: `perf-${index}`, ownerId: "local-user", source: "performance-fixture", externalId: String(index), modality: index % 2 ? "strength" : "endurance",
      domains: [index % 2 ? "strength" : "endurance"],
      sport: index % 2 ? null : "Run", name: index % 2 ? "Strength" : "Run", startAt: start.toISOString(), endAt: end.toISOString(), durationMinutes: 45,
      status: "completed", timezone: "UTC", missingFields: [],
      strengthSets: index % 2 ? [{ exerciseRaw: "Goblet Squat", exerciseKey: "goblet_squat", movement: "squat", primaryMuscles: ["quadriceps"], secondaryMuscles: ["glutes"], setIndex: 1, setType: "normal", weight: 20, weightUnit: "kg", reps: 10, rpe: 8 }] : [],
      endurance: index % 2 ? null : { distanceMeters: 8_000, averageHeartRate: 150, maxHeartRate: 175, averagePowerWatts: 220, maxPowerWatts: 350, heartRateZoneSeconds: { zone2: 2_700 } },
    };
  });
  repository.upsertSessions(sessions);

  const stateStart = performance.now();
  const state = application.getTrainingState();
  const stateMs = performance.now() - stateStart;
  const fact = <T>(value: T) => ({ value, source: "structured_source" as const, confidence: 1, evidence: "performance fixture", taxonomyVersion: TAXONOMY_VERSION });
  const sessionTemplate = { id: "perf-plan", name: "Full body", intent: "general strength", durationMinutes: 60, recoveryDemand: "normal" as const, notes: "", components: [{ id: "perf-strength", name: "Strength", domain: fact("strength" as const), prescription: { kind: "strength" as const, exercises: [{ id: "perf-squat", displayName: "Goblet Squat", canonicalKey: "goblet_squat", classification: { primaryMovement: fact("squat" as const), primaryMuscles: fact(["quadriceps" as const]), secondaryMuscles: fact(["glutes" as const]), equipment: fact(["dumbbell" as const]), impact: fact("low" as const), laterality: fact("bilateral" as const) }, sets: 3, repsMin: 8, repsMax: 12, targetRpe: 8, restSeconds: 120, referenceLoad: null, referenceLoadUnit: null, notes: "" }] } }] };
  application.createTemplate(sessionTemplate);
  const draft = { planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: "local-user", title: "Performance plan", summary: "", effectiveStartDate: "2026-09-07", mesocycle: { durationWeeks: 4, schedule: { kind: "fixed_week" as const, days: [{ id: "monday", dayOfWeek: 0, templateIds: ["perf-plan"] }] }, phases: [{ id: "phase", phaseType: "foundation" as const, name: "Base", startWeek: 1, endWeek: 4, focus: "Foundation", progression: [] }], adjustmentRules: [] }, sourceAgent: "performance-smoke", model: null, skillVersion: "0.4.0", inputSnapshotHash: application.snapshotHash(), expectedRevision: 0 };
  const validationStart = performance.now();
  const validation = application.validateCurrentPlan(draft);
  const validationMs = performance.now() - validationStart;

  const result = { sessionCount: application.listSessions(90).length, stateMs: Number(stateMs.toFixed(2)), validationMs: Number(validationMs.toFixed(2)), stateHasMetrics: Boolean(state.metrics), validationPassed: validation.valid };
  console.log(JSON.stringify(result));
  if (stateMs >= 2_000) throw new Error(`10,000-session state exceeded 2 seconds: ${stateMs.toFixed(2)} ms`);
  if (validationMs >= 1_000) throw new Error(`Plan validation exceeded 1 second: ${validationMs.toFixed(2)} ms`);
} finally {
  repository.close();
}
