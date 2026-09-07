import { afterEach, describe, expect, it } from "vitest";
import { AthriaRepository } from "@athria/data";
import { AthriaApplication, AthriaError } from "./index";

let repository: AthriaRepository | undefined;
afterEach(() => repository?.close());

const validDraft = (app: AthriaApplication) => {
  const now = "2026-09-02T10:00:00+08:00";
  return {
    id: "draft-1", ownerId: "local-user", clientRequestId: "request-1", title: "MVP plan", summary: "", sourceAgent: "test", model: null, skillVersion: "0.1.0",
    inputSnapshotHash: app.snapshotHash(), createdAt: now, updatedAt: now,
    mesocycle: { durationWeeks: 1, weeklyStructure: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, templateIds: dayOfWeek === 0 ? ["full-body"] : [] })), sessionTemplates: [{ id: "full-body", label: "A", name: "Full body", modality: "strength", intent: "strength", durationMinutes: 60, recoveryDemand: "high", notes: "", exercises: [{ exerciseKey: "goblet_squat", name: "Goblet Squat", sets: 3, repsMin: 8, repsMax: 12, targetRpe: 8, restSeconds: 120, referenceLoad: null, referenceLoadUnit: null, notes: "Primary lift" }] }], phases: [{ id: "base", phaseType: "foundation", name: "Base", startWeek: 1, endWeek: 1, focus: "Build capacity", progression: [] }], adjustmentRules: [{ trigger: "target reps are completed", action: "increase load", rationale: "Apply progressive overload" }] },
  };
};

describe("approval boundary", () => {
  it("summarizes duration across every training modality", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-03T12:00:00Z"));
    const base = {
      ownerId: "local-user", source: "test", status: "completed" as const, timezone: "UTC", strengthSets: [], endurance: null, missingFields: [],
      startAt: "2026-09-02T10:00:00Z", endAt: "2026-09-02T11:00:00Z", sport: null,
    };
    repository.upsertSessions([
      { ...base, id: "strength", externalId: "strength", name: "Strength", modality: "strength", durationMinutes: 60 },
      { ...base, id: "endurance", externalId: "endurance", name: "Run", modality: "endurance", durationMinutes: 30 },
      { ...base, id: "mixed", externalId: "mixed", name: "Mixed", modality: "mixed", durationMinutes: 45 },
    ]);
    expect(app.getTrainingSummary(7).totalDurationMinutes).toBe(135);
  });
  it("saving a draft does not create a formal version", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-02T02:00:00Z"));
    app.saveDraft(validDraft(app));
    expect(repository.listVersions()).toHaveLength(0);
  });
  it("Dashboard approval creates an immutable version", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-02T02:00:00Z"));
    app.saveDraft(validDraft(app));
    expect(app.approveDraft("draft-1", "local-user", "Approve MVP").versionNumber).toBe(1);
  });
  it("keeps only the newest pending draft while preserving approved history", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-02T02:00:00Z"));
    app.saveDraft(validDraft(app));
    app.saveDraft({ ...validDraft(app), id: "draft-2", clientRequestId: "request-2", title: "Second" });
    expect(repository.listDrafts().map((item) => item.draft.id)).toEqual(["draft-2"]);
    app.approveDraft("draft-2", "local-user", "Approve second");
    app.saveDraft({ ...validDraft(app), id: "draft-3", clientRequestId: "request-3", title: "Third" });
    const ids = repository.listDrafts().map((item) => item.draft.id);
    expect(ids).toContain("draft-2");
    expect(ids).toContain("draft-3");
    expect(ids).not.toContain("draft-1");
  });
  it("rejects stale state", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository);
    expect(() => app.saveDraft({ ...validDraft(app), inputSnapshotHash: "stale" })).toThrowError(AthriaError);
  });
  it("exposes plan and next-day write tools", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository);
    const tools = app.toolRegistry();
    expect(tools.filter((tool) => !tool.readOnly).map((tool) => tool.name)).toEqual(["save_plan_draft", "save_next_training_day_sessions", "propose_profile_update"]);
    const savePlan = tools.find((tool) => tool.name === "save_plan_draft")!;
    const draft = validDraft(app);
    expect(savePlan.inputSchema.safeParse(draft).success).toBe(true);
    const { mesocycle: _mesocycle, ...legacy } = draft;
    expect(savePlan.inputSchema.safeParse(legacy).success).toBe(false);
  });
  it("requires Dashboard approval for an Agent profile proposal", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository);
    const proposal = app.proposeProfileUpdate({ clientRequestId: "profile-request", patch: { displayName: "Approved Athlete" }, rationale: "User supplied their name" });
    expect(app.getProfile().displayName).toBe("Athlete");
    app.approveProfileUpdate(proposal.id, "local-user");
    expect(app.getProfile().displayName).toBe("Approved Athlete");
  });
  it("allows Agent-managed fields but rejects removed profile fields", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository);
    const proposal = app.proposeProfileUpdate({ clientRequestId: "constraints", patch: { constraints: ["quiet workouts"], excludedExercises: ["burpee"], explicitRecoveryHours: 24 }, rationale: "User constraints" });
    app.approveProfileUpdate(proposal.id, "local-user");
    expect(app.getProfile()).toMatchObject({ constraints: ["quiet workouts"], excludedExercises: ["burpee"], explicitRecoveryHours: 24 });
    expect(() => app.proposeProfileUpdate({ clientRequestId: "legacy", patch: { maxHeartRate: 180 }, rationale: "Removed" })).toThrow();
  });
  it("does not let duplicate approval create another formal version", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-02T02:00:00Z"));
    app.saveDraft(validDraft(app)); app.approveDraft("draft-1", "local-user", "First approval");
    expect(() => app.approveDraft("draft-1", "local-user", "Duplicate approval")).toThrowError(/already/i);
    expect(repository.listVersions()).toHaveLength(1);
  });
  it("rejects an expired draft and a draft with hard violations", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-20T02:00:00Z"));
    const old = { ...validDraft(app), createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
    app.saveDraft(old);
    expect(() => app.approveDraft("draft-1", "local-user", "Too late")).toThrowError(/older than seven days/i);
    const timestamp = "2026-09-20T02:00:00Z";
    const base = validDraft(app);
    const template = base.mesocycle.sessionTemplates[0]!;
    const invalid = { ...base, id: "invalid", clientRequestId: "invalid-request", createdAt: timestamp, updatedAt: timestamp, mesocycle: { ...base.mesocycle, sessionTemplates: [{ ...template, exercises: [{ ...template.exercises[0]!, exerciseKey: "unknown_exercise" }] }] } };
    app.saveDraft(invalid);
    expect(() => app.approveDraft("invalid", "local-user", "Invalid")).toThrowError(/hard violations/i);
  });
  it("finds today inclusively and writes multiple next-day sessions idempotently", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T02:00:00Z"));
    app.saveDraft(validDraft(app));
    const version = app.approveDraft("draft-1", "local-user", "Approve");
    const next = app.getNextTrainingDay();
    expect(next.nextTrainingDay).toMatchObject({ scheduledDate: "2026-09-07", weekNumber: 1, expectedTemplateIds: ["full-body"], revision: 0 });
    const input = { clientRequestId: "schedule-1", planVersionId: version.id, scheduledDate: "2026-09-07", expectedRevision: 0, mode: "append", sessions: [{ id: "planned-1", templateId: "full-body" }, { id: "planned-2", templateId: "full-body" }] };
    expect(app.saveNextTrainingDaySessions(input)).toMatchObject({ revision: 1, sessions: [{ status: "planned" }, { status: "planned" }] });
    expect(app.saveNextTrainingDaySessions(input)).toMatchObject({ revision: 1, idempotentReplay: true });
  });
  it("requires an override reason and detects stale next-day revisions", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T02:00:00Z"));
    const extra = validDraft(app);
    const template = extra.mesocycle.sessionTemplates[0]!;
    extra.mesocycle.sessionTemplates.push({ ...template, id: "extra", label: "B", name: "Extra" });
    app.saveDraft(extra); const version = app.approveDraft("draft-1", "local-user", "Approve");
    const base = { clientRequestId: "schedule-extra", planVersionId: version.id, scheduledDate: "2026-09-07", expectedRevision: 0, mode: "append" as const };
    expect(() => app.saveNextTrainingDaySessions({ ...base, sessions: [{ id: "extra-1", templateId: "extra" }] })).toThrowError(/override reason/i);
    app.saveNextTrainingDaySessions({ ...base, sessions: [{ id: "base-1", templateId: "full-body" }] });
    expect(() => app.saveNextTrainingDaySessions({ ...base, clientRequestId: "stale", sessions: [{ id: "base-2", templateId: "full-body" }] })).toThrowError(/changed/i);
  });
  it("previews and commits overlapping Hevy imports idempotently", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository);
    expect(app.getHevyImportStatus()).toBeNull();
    const base = "title,start_time,end_time,exercise_title,set_index,weight_lbs,reps,rpe,notes\nFull Body,2026-08-24T18:00:00Z,2026-08-24T19:00:00Z,Goblet Squat,0,35,10,7,fixture\n";
    const first = app.previewHevy(new TextEncoder().encode(base), "first.csv");
    expect(app.commitHevy(first.previewToken)).toEqual({ added: 1, updated: 0 });
    const overlap = app.previewHevy(new TextEncoder().encode(`${base}Full Body,2026-08-24T18:00:00Z,2026-08-24T19:00:00Z,Goblet Squat,1,35,10,7.5,fixture\n`), "second.csv");
    expect(app.commitHevy(overlap.previewToken)).toEqual({ added: 0, updated: 1 });
    expect(app.listSessions(365)).toHaveLength(1);
    expect(app.listSessions(365)[0]?.strengthSets).toHaveLength(2);
    expect(repository.counts()).toMatchObject({ import_batches: 2, raw_records: 2 });
    expect(app.getHevyImportStatus()).toMatchObject({ fileName: "second.csv", status: "committed", counts: { sessions: 1, sets: 2, rows: 2 } });
  });
  it("persists Intervals raw payloads and wellness while preserving partial errors", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository);
    const result = app.commitIntervals({ activities: [{ id: "run", type: "Run", start_date: "2026-09-01T10:00:00Z", moving_time: 1800 }], events: [], wellness: [{ id: "2026-09-01", sleepSecs: 28800, hrv: 55 }] });
    expect(result).toMatchObject({ added: 1, rawCount: 2, wellnessCount: 1, errors: {} });
    const partial = app.commitIntervals({ activities: [], events: [], wellness: "timeout" });
    expect(partial.errors).toEqual({ wellness: "timeout" });
    expect(repository.counts()).toMatchObject({ training_sessions: 1, wellness_daily: 1, raw_records: 2 });
  });
  it("commits Xunji records and exposes discoverable read-only tools", () => {
    repository = new AthriaRepository(":memory:");
    const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-03T12:00:00Z"));
    const result = app.commitXunji({ rangeStart: "2026-06-06", rangeEnd: "2026-09-03", successfulDates: ["2026-09-03"], errors: [], records: [{ localid: 99, datestr: "2026-09-03", title: "训记力量", start: 1_788_400_000_000, end: 1_788_403_600_000, movements: [{ name: "深蹲", sets: [{ done: true, weight: 100, reps: 5 }] }] }] });
    expect(result).toMatchObject({ added: 1, sync: { status: "success", data: { records: 1 } } });
    expect(app.listXunjiSessions(30)).toMatchObject({ source: "xunji", sessions: [{ externalId: "99", source: "xunji" }] });
    const tools = app.toolRegistry();
    expect(tools.find((tool) => tool.name === "list_xunji_training_sessions")).toMatchObject({ readOnly: true });
    expect(tools.find((tool) => tool.name === "get_xunji_sync_status")).toMatchObject({ readOnly: true });
  });
});
