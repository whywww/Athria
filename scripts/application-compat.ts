// Phase 5 cross-language application contract fixtures.
//
// The TypeScript application executes a stateful sequence against a fresh
// SQLite database and records every resolved command plus its normalized
// result/error. The Rust integration test replays the exact commands against
// its own fresh SQLite database. Random occurrence IDs are transport-opaque,
// so normalization removes only that field.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AthriaApplication, AthriaError } from "../packages/application/src/index.ts";
import { AthriaRepository } from "../packages/data/src/index.ts";

const now = new Date("2026-09-17T04:00:00.000Z");
const outputPath = resolve(import.meta.dir, "..", "crates", "athria-store", "tests", "fixtures", "application.json");
const repository = new AthriaRepository(":memory:");
const app = new AthriaApplication(repository, "local-user", () => now);

type Step = { operation: string; input?: unknown; expected?: unknown; error?: { code: string; message: string; status: number } };
const steps: Step[] = [];

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "occurrenceId").map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function capture(operation: string, input: unknown, run: () => unknown) {
  const step: Step = { operation, ...(input === undefined ? {} : { input: normalize(input) }) };
  try { step.expected = normalize(run()); }
  catch (error) {
    if (!(error instanceof AthriaError)) throw error;
    step.error = { code: error.code, message: error.message, status: error.status };
  }
  steps.push(step);
}

capture("get_profile", undefined, () => app.getProfile());
const profileUpdate = {
  patch: { preferredName: "Compat Athlete", timezone: "Asia/Hong_Kong", trainingRhythm: { kind: "fixed_week", days: [0] } },
  expectedProfileHash: app.profileHash(), confirmed: true,
};
capture("update_profile", profileUpdate, () => app.updateProfile(profileUpdate));
const staleProfile = { patch: { preferredName: "Stale" }, expectedProfileHash: "fnv1a-00000000", confirmed: true };
capture("update_profile", staleProfile, () => app.updateProfile(staleProfile));

capture("get_personal_information", undefined, () => app.getPersonalInformation());
const personal = { preferredName: "Compat Athlete", gender: "non_binary", heightCm: 171.5, birthDate: "1995-04-03", weightKg: 67.2, expectedSnapshotHash: app.getPersonalInformation().snapshotHash };
capture("save_personal_information", personal, () => app.savePersonalInformation(personal));
const wellness = { fields: { sleepScore: 82, restingHeartRateBpm: 51 }, source: "user", expectedSnapshotHash: "new", confirmed: true };
capture("update_wellness", { day: "2026-09-16", value: wellness }, () => app.updateWellness("2026-09-16", wellness));
const staleWellness = { fields: { sleepScore: 60 }, source: "user", expectedSnapshotHash: "new", confirmed: true };
capture("update_wellness", { day: "2026-09-16", value: staleWellness }, () => app.updateWellness("2026-09-16", staleWellness));

const session = {
  id: "compat-session", externalId: "compat-session", name: "Compat Run", modality: "endurance", domains: ["endurance"], sport: null,
  startAt: "2026-09-15T22:00:00.000Z", endAt: "2026-09-15T22:45:00.000Z", durationMinutes: 45, timezone: "Asia/Hong_Kong",
  plannedSessionId: null, strengthSets: [], endurance: { distanceMeters: 8000 }, missingFields: [],
};
capture("record_training_session", session, () => app.recordTrainingSession(session));
capture("get_training_summary", { days: 7, from: "2026-09-15", to: "2026-09-17" }, () => app.getTrainingSummary(7, "2026-09-15", "2026-09-17"));

const template = { id: "compat.tempo", name: "Tempo", intent: "Build sustainable aerobic speed.", domain: "endurance", nodes: [{ role: "steady", variables: ["duration"], optionalVariables: ["distance"] }] };
capture("create_template", template, () => app.createTemplate(template));
const templateUpdate = { template: { ...template, name: "Tempo v2" }, expectedRevision: 1 };
capture("update_template", templateUpdate, () => app.updateTemplate(templateUpdate));
capture("update_template", templateUpdate, () => app.updateTemplate(templateUpdate));

const domainFact = { value: "endurance", source: "user_confirmed", confidence: 1, evidence: "compat fixture", taxonomyVersion: "strength-2.0" };
const plan = {
  planSchemaVersion: "7.0", ownerId: "local-user", title: "Compat Plan", summary: "", effectiveStartDate: "2026-09-14",
  mesocycle: {
    durationWeeks: 1, schedule: { kind: "fixed_week", days: [0] },
    domainProgressions: [{ domain: "endurance", phases: [{ id: "base", phaseType: "foundation", name: "Base", startWeek: 1, endWeek: 1, focus: "Aerobic base", progression: [] }] }],
    weeks: [{ weekNumber: 1, focus: null, sessions: [{
      id: "compat-plan-session", scheduledDate: "2026-09-14", order: 0, status: "planned", templateRef: { source: "user", id: "compat.tempo", revision: 2 },
      name: "Easy Run", intent: "Aerobic base", durationMinutes: 40, recoveryDemand: "low", keySession: false,
      components: [{ id: "run", name: "Run", domain: domainFact, prescription: { kind: "duration_only", notes: "" } }],
      progressionNote: null, schedulingRationale: null, legacySnapshot: false,
    }] }], adjustmentRules: [],
  },
  sourceAgent: "compat", model: null, skillVersion: "phase-5", inputSnapshotHash: app.snapshotHash(), expectedRevision: 0,
};
capture("save_current_plan", plan, () => app.saveCurrentPlan(plan));
capture("save_current_plan", plan, () => app.saveCurrentPlan(plan));
capture("get_calendar", { from: "2026-09-14", to: "2026-09-14" }, () => app.getCalendar({ from: "2026-09-14", to: "2026-09-14" }));
const skip = { action: "skip", expectedRevision: 1, reason: { reasonCode: "schedule", note: "compat" } };
capture("update_planned_session", { id: "compat-plan-session", value: skip }, () => app.updatePlannedSession("compat-plan-session", skip));
capture("get_next_training_day", { onOrAfterDate: "2026-09-14" }, () => app.getNextTrainingDay({ onOrAfterDate: "2026-09-14" }));

repository.close();
mkdirSync(resolve(outputPath, ".."), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({ version: 1, now: now.toISOString(), steps }, null, 2)}\n`);
console.log(`Wrote ${steps.length} TypeScript application contract steps to ${outputPath}`);
