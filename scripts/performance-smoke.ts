import { AthriaApplication } from "../packages/application/src/index";
import { AthriaRepository } from "../packages/data/src/index";
import type { TrainingSession } from "../packages/schemas/src/index";

const repository = new AthriaRepository(":memory:");
const now = new Date("2026-09-02T12:00:00Z");
const application = new AthriaApplication(repository, "local-user", () => now);

try {
  const sessions: TrainingSession[] = Array.from({ length: 10_000 }, (_, index) => {
    const start = new Date(now.getTime() - index * 10 * 60_000);
    const end = new Date(start.getTime() + 45 * 60_000);
    return {
      id: `perf-${index}`, ownerId: "local-user", source: "performance-fixture", externalId: String(index), modality: index % 2 ? "strength" : "endurance",
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
  const draft = { sessions: [{ id: "perf-plan", name: "Full body", modality: "strength" as const, intent: "general strength", startAt: "2026-09-07T18:00:00+08:00", durationMinutes: 60, hard: true, notes: "", exercises: [{ exerciseKey: "goblet_squat", name: "Goblet Squat", sets: 3, repsMin: 8, repsMax: 12, targetRpe: 8, restSeconds: 120, referenceLoad: null, referenceLoadUnit: null }] }] };
  const validationStart = performance.now();
  const validation = application.validateDraft(draft);
  const validationMs = performance.now() - validationStart;

  const result = { sessionCount: application.listSessions(90).length, stateMs: Number(stateMs.toFixed(2)), validationMs: Number(validationMs.toFixed(2)), stateHasMetrics: Boolean(state.metrics), validationPassed: validation.valid };
  console.log(JSON.stringify(result));
  if (stateMs >= 2_000) throw new Error(`10,000-session state exceeded 2 seconds: ${stateMs.toFixed(2)} ms`);
  if (validationMs >= 1_000) throw new Error(`Plan validation exceeded 1 second: ${validationMs.toFixed(2)} ms`);
} finally {
  repository.close();
}
