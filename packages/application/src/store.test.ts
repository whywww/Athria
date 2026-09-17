import { describe, expect, it } from "vitest";
import { defaultProfile, type AthleteProfile, type CurrentPlan, type SessionTemplate, type StoredSessionTemplate, type TrainingSession, type WellnessRecord } from "@athria/schemas";
import { AthriaApplication, AthriaError, builtinSessionTemplates } from "./index";
import type {
  AthriaStore,
  ConnectionSyncState,
  ImportBatchRecord,
  RecordImportBatchInput,
  ReplaceSourceSessionsInput,
  SaveConnectionSyncStateInput,
  SaveCurrentPlannedSessionsInput,
  SetTrainingSessionPlanMatchInput,
  UpdateCurrentPlannedSessionsInput,
  UpdateManualTrainingSessionInput,
} from "./store";

// An in-memory store proves AthriaApplication runs every use case through the
// AthriaStore port alone. Methods the fake does not model throw loudly so a
// test that starts depending on them fails instead of silently passing.
class FakeStore implements AthriaStore {
  readonly profiles = new Map<string, AthleteProfile>();
  readonly wellness = new Map<string, WellnessRecord>();
  readonly templates = new Map<string, StoredSessionTemplate>();
  readonly sessions = new Map<string, TrainingSession>();
  readonly plans = new Map<string, CurrentPlan>();
  readonly dismissed = new Set<string>();
  transactionCount = 0;

  private static notImplemented(method: string): never { throw new Error(`FAKE_STORE_NOT_IMPLEMENTED:${method}`); }
  private wellnessKey(ownerId: string, day: string): string { return `${ownerId}:${day}`; }

  transaction<T>(work: () => T): T { this.transactionCount += 1; return work(); }

  getProfile(ownerId: string): AthleteProfile { return this.profiles.get(ownerId) ?? defaultProfile(); }
  saveProfile(profile: AthleteProfile): AthleteProfile { this.profiles.set(profile.ownerId, profile); return profile; }

  listSessions(ownerId: string, since?: string): TrainingSession[] {
    return [...this.sessions.values()].filter((session) => session.ownerId === ownerId && (since === undefined || session.startAt >= since));
  }
  listSessionsBySource(source: string, ownerId: string, since?: string): TrainingSession[] {
    return this.listSessions(ownerId, since).filter((session) => session.source === source);
  }
  upsertSessions(sessions: TrainingSession[]): { added: number; updated: number } {
    const counts = { added: 0, updated: 0 };
    for (const session of sessions) { if (this.sessions.has(session.id)) counts.updated += 1; else counts.added += 1; this.sessions.set(session.id, session); }
    return counts;
  }
  replaceSourceSessions(_input: ReplaceSourceSessionsInput): { added: number; updated: number } { return FakeStore.notImplemented("replaceSourceSessions"); }
  setTrainingSessionPlanMatch(_input: SetTrainingSessionPlanMatchInput): TrainingSession { return FakeStore.notImplemented("setTrainingSessionPlanMatch"); }
  clearTrainingSessionPlanExclusion(_ownerId: string, _trainingSessionId: string): TrainingSession { return FakeStore.notImplemented("clearTrainingSessionPlanExclusion"); }
  setTrainingSessionTypeOverride(_ownerId: string, _trainingSessionId: string, _domain: TrainingSession["domains"][number]): TrainingSession { return FakeStore.notImplemented("setTrainingSessionTypeOverride"); }
  updateManualTrainingSession(_input: UpdateManualTrainingSessionInput): TrainingSession { return FakeStore.notImplemented("updateManualTrainingSession"); }
  deleteManualTrainingSession(_ownerId: string, _trainingSessionId: string): TrainingSession | null { return FakeStore.notImplemented("deleteManualTrainingSession"); }
  deleteTrainingSession(ownerId: string, trainingSessionId: string): void {
    const session = this.sessions.get(trainingSessionId);
    if (!session || session.ownerId !== ownerId) throw new Error("TRAINING_SESSION_NOT_FOUND");
    this.sessions.delete(trainingSessionId);
  }

  getWellness(ownerId: string, day: string): WellnessRecord | null { return this.wellness.get(this.wellnessKey(ownerId, day)) ?? null; }
  listWellness(ownerId: string, since?: string): WellnessRecord[] {
    return [...this.wellness.values()].filter((record) => record.ownerId === ownerId && (since === undefined || record.day >= since));
  }
  saveWellness(record: WellnessRecord): WellnessRecord { this.wellness.set(this.wellnessKey(record.ownerId, record.day), record); return record; }
  upsertWellness(_ownerId: string, _records: unknown[]): number { return FakeStore.notImplemented("upsertWellness"); }

  listTemplates(_ownerId: string): StoredSessionTemplate[] { return [...this.templates.values()]; }
  getTemplate(id: string, _ownerId: string): StoredSessionTemplate | null { return this.templates.get(id) ?? null; }
  createTemplate(template: SessionTemplate, _ownerId: string): StoredSessionTemplate {
    if (this.templates.has(template.id)) throw new Error("TEMPLATE_ALREADY_EXISTS");
    const stored = { ...template, origin: "user", revision: 1 } as StoredSessionTemplate;
    this.templates.set(template.id, stored);
    return stored;
  }
  updateTemplate(template: SessionTemplate, expectedRevision: number, _ownerId: string): StoredSessionTemplate {
    const current = this.templates.get(template.id);
    if (!current) throw new Error("TEMPLATE_NOT_FOUND");
    if (current.revision !== expectedRevision) throw new Error("REVISION_CONFLICT");
    const stored = { ...template, origin: "user", revision: expectedRevision + 1 } as StoredSessionTemplate;
    this.templates.set(template.id, stored);
    return stored;
  }
  deleteTemplate(id: string, expectedRevision: number, _ownerId: string): void {
    const current = this.templates.get(id);
    if (!current) throw new Error("TEMPLATE_NOT_FOUND");
    if (current.revision !== expectedRevision) throw new Error("REVISION_CONFLICT");
    this.templates.delete(id);
  }
  listDismissedTemplateIds(_ownerId: string): string[] { return [...this.dismissed]; }
  dismissTemplate(id: string, _ownerId: string): void { this.dismissed.add(id); }

  getCurrentPlan(ownerId: string): CurrentPlan | null { return this.plans.get(ownerId) ?? null; }
  saveCurrentPlan(plan: CurrentPlan, expectedRevision: number, _deletedSessionIds: string[], _updatedSessions: unknown[]): CurrentPlan {
    if ((this.plans.get(plan.ownerId)?.revision ?? 0) !== expectedRevision) throw new Error("REVISION_CONFLICT");
    this.plans.set(plan.ownerId, plan);
    return plan;
  }
  listCurrentPlannedSessions(_ownerId: string, _scheduledDate?: string): import("@athria/schemas").PlannedSession[] { return FakeStore.notImplemented("listCurrentPlannedSessions"); }
  scheduleRevision(ownerId: string): number { return this.plans.get(ownerId)?.revision ?? 0; }
  updateCurrentPlannedSessions(_input: UpdateCurrentPlannedSessionsInput): { sessions: import("@athria/schemas").PlannedSession[]; revision: number } { return FakeStore.notImplemented("updateCurrentPlannedSessions"); }
  saveCurrentPlannedSessions(_input: SaveCurrentPlannedSessionsInput): { sessions: import("@athria/schemas").PlannedSession[]; revision: number; idempotentReplay: boolean } { return FakeStore.notImplemented("saveCurrentPlannedSessions"); }

  recordImportBatch(_input: RecordImportBatchInput): ImportBatchRecord { return FakeStore.notImplemented("recordImportBatch"); }
  latestImportBatch(_ownerId: string, _source: string): ImportBatchRecord | null { return FakeStore.notImplemented("latestImportBatch"); }
  getConnectionSyncState(_source: string, _ownerId: string): ConnectionSyncState | null { return FakeStore.notImplemented("getConnectionSyncState"); }
  saveConnectionSyncState(_input: SaveConnectionSyncStateInput): ConnectionSyncState { return FakeStore.notImplemented("saveConnectionSyncState"); }
}

const errorOf = (run: () => unknown): AthriaError => {
  try { run(); } catch (error) { return error as AthriaError; }
  throw new Error("Expected the call to throw.");
};

const template = (name = "Lower pattern") => ({ id: "lower", name, intent: "Stable lower-body structure", domain: "strength" as const, nodes: [{ name: "Primary", role: "primary" as const, movementPatternIds: ["squat" as const], targetMuscleIds: ["quadriceps" as const], matchPolicy: "all" as const, variables: ["exercise_selection" as const] }] });

describe("AthriaStore persistence port", () => {
  it("drives profile and personal-information use cases through an in-memory store", () => {
    const store = new FakeStore();
    const app = new AthriaApplication(store, "local-user", () => new Date("2026-09-11T03:00:00Z"));
    expect(app.getProfile().preferredName).toBe(defaultProfile().preferredName);
    expect(app.updateProfile({ patch: { preferredName: "Renamed" }, expectedProfileHash: app.profileHash(), confirmed: true }).preferredName).toBe("Renamed");
    expect(store.profiles.get("local-user")?.preferredName).toBe("Renamed");
    expect(errorOf(() => app.updateProfile({ patch: { preferredName: "Again" }, expectedProfileHash: "stale", confirmed: true })).code).toBe("INPUT_SNAPSHOT_CHANGED");
    const current = app.getPersonalInformation();
    const saved = app.savePersonalInformation({ preferredName: "Taylor", gender: null, heightCm: 172.5, birthDate: "1995-04-03", weightKg: 68.2, expectedSnapshotHash: current.snapshotHash });
    expect(store.transactionCount).toBe(1);
    expect(saved).toMatchObject({ preferredName: "Taylor", heightCm: 172.5, weightKg: 68.2, weightDate: "2026-09-11" });
    expect(store.wellness.get("local-user:2026-09-11")?.fields.weightKg).toMatchObject({ value: 68.2, source: "user" });
    expect(errorOf(() => app.savePersonalInformation({ preferredName: "Stale", gender: null, heightCm: null, birthDate: null, expectedSnapshotHash: current.snapshotHash })).code).toBe("INPUT_SNAPSHOT_CHANGED");
  });

  it("round-trips wellness days through the store port", () => {
    const store = new FakeStore();
    const app = new AthriaApplication(store);
    expect(app.getWellnessDay("2026-09-01")).toEqual({ record: null, snapshotHash: "new" });
    const saved = app.updateWellness("2026-09-01", { fields: { sleepScore: 82, mood: 4 }, source: "user", expectedSnapshotHash: "new", confirmed: true });
    expect(saved.fields.sleepScore?.value).toBe(82);
    expect(app.getWellnessDay("2026-09-01").record?.fields.mood?.value).toBe(4);
    expect(errorOf(() => app.updateWellness("2026-09-01", { fields: { sleepScore: 90 }, source: "user", expectedSnapshotHash: "new", confirmed: true })).code).toBe("INPUT_SNAPSHOT_CHANGED");
  });

  it("merges built-in templates with stored rows and reports a missing plan", () => {
    const store = new FakeStore();
    const app = new AthriaApplication(store);
    expect(app.listTemplates().filter((item) => item.origin === "builtin")).toHaveLength(builtinSessionTemplates.length);
    expect(app.createTemplate(template())).toMatchObject({ id: "lower", origin: "user", revision: 1 });
    expect(store.templates.get("lower")).toMatchObject({ origin: "user", revision: 1 });
    expect(app.getTemplate("builtin.easy-run")).toMatchObject({ origin: "builtin" });
    expect(app.getNextTrainingDay()).toEqual({ nextTrainingDay: null, reasonCode: "NO_CURRENT_PLAN" });
  });

  it("records and deletes manual workouts through the store port", () => {
    const store = new FakeStore();
    const app = new AthriaApplication(store);
    const workout = app.recordTrainingSession({ name: "Workout", modality: "recovery", domains: ["recovery"], sport: null, startAt: "2026-09-07T02:00:00Z", endAt: "2026-09-07T03:00:00Z", durationMinutes: 60, timezone: "UTC", plannedSessionId: null, strengthSets: [], endurance: null, missingFields: [] });
    expect(workout).toMatchObject({ source: "manual", status: "completed" });
    expect(store.sessions.size).toBe(1);
    expect(app.deleteTrainingSession(workout.id, { confirmed: true })).toEqual({ deleted: true });
    expect(store.sessions.size).toBe(0);
    expect(errorOf(() => app.deleteTrainingSession(workout.id, { confirmed: true })).code).toBe("TRAINING_SESSION_NOT_FOUND");
  });
});
