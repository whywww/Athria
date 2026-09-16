import { afterEach, describe, expect, it } from "vitest";
import { AthriaRepository } from "@athria/data";
import { PLAN_SCHEMA_VERSION, TAXONOMY_VERSION, equipmentTypeIds, trainingSessionSchema, type CurrentPlanWrite } from "@athria/schemas";
import { AthriaApplication, AthriaError, builtinSessionTemplates } from "./index";

let repository: AthriaRepository | undefined;
afterEach(() => repository?.close());
const template = (name = "Lower pattern") => ({ id: "lower", name, intent: "Stable lower-body structure", domain: "strength" as const, nodes: [{ name: "Primary", role: "primary" as const, movementPatternIds: ["squat" as const], targetMuscleIds: ["quadriceps" as const], matchPolicy: "all" as const, variables: ["exercise_selection" as const] }] });
const fact = <T>(value: T): { value: T; source: "user_confirmed"; confidence: number; evidence: string; taxonomyVersion: typeof TAXONOMY_VERSION } => ({ value, source: "user_confirmed", confidence: 1, evidence: "fixture", taxonomyVersion: TAXONOMY_VERSION });
const plan = (app: AthriaApplication, revision = 0): any => {
  app.saveProfile({ ...app.getProfile(), trainingRhythm: { kind: "fixed_week", days: [0] } });
  const session = { id: "weekly-1", scheduledDate: "2026-09-07", order: 0, templateRef: { source: "user" as const, id: "lower", revision: 1 }, name: "Mobility and breathing", intent: "Recover", durationMinutes: 20, recoveryDemand: "low" as const, keySession: false, components: [{ id: "mobility", name: "Mobility", domain: fact("recovery" as const), prescription: { kind: "recovery" as const, blocks: [{ name: "Easy mobility", durationMinutes: 15 }] } }, { id: "breathing", name: "Breathing", domain: fact("mind_body" as const), prescription: { kind: "mind_body" as const, blocks: [{ name: "Down regulation", durationMinutes: 5 }] } }], progressionNote: null, schedulingRationale: null, legacySnapshot: false };
  return { planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: "local-user", title: "Current plan", summary: "", effectiveStartDate: "2026-09-07", mesocycle: { durationWeeks: 1, schedule: { kind: "fixed_week" as const, days: [0] }, domainProgressions: [{ domain: "recovery" as const, phases: [{ id: "recovery-base", phaseType: "foundation" as const, name: "Restore", startWeek: 1, endWeek: 1, focus: "Build recovery consistency", progression: ["Increase range only while movement stays comfortable"] }] }, { domain: "mind_body" as const, phases: [{ id: "mind-body-base", phaseType: "foundation" as const, name: "Settle", startWeek: 1, endWeek: 1, focus: "Build breath awareness", progression: ["Extend practice only while attention remains steady"] }] }], weeks: [{ weekNumber: 1, focus: null, sessions: [session] }], adjustmentRules: [] }, sourceAgent: "test", model: null, skillVersion: "0.6.0", inputSnapshotHash: app.snapshotHash(), expectedRevision: revision };
};

describe("v7 application boundary", () => {
  it("summarizes an exact local-date window across every training domain", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-09T04:00:00Z"));
    app.saveProfile({ ...app.getProfile(), timezone: "Asia/Hong_Kong" });
    const session = (id: string, startAt: string, domains: Array<"strength" | "endurance" | "sport_skill" | "mind_body" | "recovery">, durationMinutes: number, sport: string | null = null) => trainingSessionSchema.parse({ id, externalId: id, source: "test", modality: "mixed", domains, sport, name: id, startAt, endAt: new Date(new Date(startAt).getTime() + durationMinutes * 60_000).toISOString(), durationMinutes, strengthSets: domains.includes("strength") ? [{ exerciseRaw: "Squat", setIndex: 1, setType: "normal", weight: 40, weightUnit: "kg", reps: 8 }] : [], endurance: domains.includes("endurance") ? { distanceMeters: 5000 } : null });
    repository.upsertSessions([
      session("mixed", "2026-09-07T16:30:00Z", ["strength", "sport_skill"], 60, "Basketball"),
      session("run", "2026-09-08T02:00:00Z", ["endurance"], 30),
      session("before", "2026-09-06T15:00:00Z", ["recovery"], 20),
    ]);
    const summary = app.getTrainingSummary(7, "2026-09-07", "2026-09-09");
    expect(summary).toMatchObject({ sessionCount: 2, totalDurationMinutes: 90, byDomain: { strength: 1, endurance: 1, sport_skill: 1, recovery: 0 }, durationMinutesByDomain: { strength: 60, endurance: 30, sport_skill: 60 }, sports: [{ name: "Basketball", sessionCount: 1, durationMinutes: 60 }] });
    expect(summary.metrics.strength.workingSets.value).toBe(1);
    expect(summary.metrics.endurance.distanceMeters.value).toBe(5000);
  });
  it("derives user-owned replacements for built-ins and hides deleted ones", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    expect(app.listTemplates().some((item) => item.origin === "builtin")).toBe(true);
    expect(app.createTemplate(template())).toMatchObject({ origin: "user", revision: 1 });
    // Posting a built-in ID derives a user-owned replacement that shadows the original.
    expect(app.createTemplate({ ...template(), id: "builtin.lower-strength-a" })).toMatchObject({ id: "builtin.lower-strength-a", origin: "user", revision: 1 });
    expect(app.listTemplates().filter((item) => item.id === "builtin.lower-strength-a")).toEqual([expect.objectContaining({ origin: "user", revision: 1 })]);
    // The derived row keeps the built-in's catalog slot instead of appending to the end.
    const ids = app.listTemplates().map((item) => item.id);
    expect(ids.indexOf("builtin.lower-strength-a")).toBe(builtinSessionTemplates.findIndex((item) => item.id === "builtin.lower-strength-a"));
    expect(ids[ids.length - 1]).toBe("lower");
    expect(app.getTemplate("builtin.lower-strength-a")).toMatchObject({ origin: "user", revision: 1 });
    expect(app.updateTemplate({ template: { ...template(), id: "builtin.lower-strength-a" }, expectedRevision: 1 })).toMatchObject({ template: { origin: "user", revision: 2 } });
    // Deleting the derived row keeps the built-in hidden; the code-defined original stays resolvable.
    expect(app.deleteTemplate("builtin.lower-strength-a", 2)).toEqual({ deleted: true, id: "builtin.lower-strength-a" });
    expect(app.listTemplates().some((item) => item.id === "builtin.lower-strength-a")).toBe(false);
    expect(app.getTemplate("builtin.lower-strength-a")).toMatchObject({ origin: "builtin" });
    // Deleting an untouched built-in only hides it.
    expect(app.deleteTemplate("builtin.easy-run")).toEqual({ deleted: true, id: "builtin.easy-run" });
    expect(app.listTemplates().some((item) => item.id === "builtin.easy-run")).toBe(false);
    expect(app.getTemplate("builtin.easy-run")).toMatchObject({ origin: "builtin" });
    // A built-in original that was never derived has no stored row to update.
    expect(() => app.updateTemplate({ template: { ...template(), id: "builtin.easy-run" }, expectedRevision: 1 })).toThrow(/not found/i);
  });
  it("keeps template updates independent from saved Session prescriptions", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T00:00:00Z"));
    app.createTemplate(template()); app.saveCurrentPlan(plan(app));
    expect(app.getCalendar()[0]).toMatchObject({ id: "weekly-1", durationMinutes: 20, templateRef: { source: "user", id: "lower", revision: 1 }, phaseRefs: [{ domain: "recovery", phaseId: "recovery-base" }, { domain: "mind_body", phaseId: "mind-body-base" }] });
    expect(app.getNextTrainingDay().nextTrainingDay?.domainPhases).toEqual([{ domain: "recovery", phaseId: "recovery-base", phaseType: "foundation", name: "Restore" }, { domain: "mind_body", phaseId: "mind-body-base", phaseType: "foundation", name: "Settle" }]);
    expect(app.updateTemplate({ template: template("Changed"), expectedRevision: 1 })).toMatchObject({ impact: { affectedCount: 0, updatedCount: 0 } });
    expect(app.getCalendar()[0]).toMatchObject({ name: "Mobility and breathing", durationMinutes: 20 });
  });
  it("blocks deletion while the Current Plan references a user template", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    app.createTemplate(template()); app.saveCurrentPlan(plan(app));
    expect(() => app.deleteTemplate("lower", 1)).toThrow(/reference/i);
  });
  it("recomputes every domain phase reference when a combined session moves to another week", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T00:00:00Z"));
    app.createTemplate(template());
    const candidate = plan(app);
    const first = candidate.mesocycle.weeks[0]!.sessions[0]!;
    const copy = (id: string, scheduledDate: string) => ({ ...structuredClone(first), id, scheduledDate });
    candidate.mesocycle.durationWeeks = 2;
    candidate.mesocycle.schedule = { kind: "flexible_week", targetDaysPerWeek: 2, minDaysPerWeek: 1, maxDaysPerWeek: 3 };
    candidate.mesocycle.domainProgressions[0]!.phases = [{ id: "recovery-base", phaseType: "foundation", name: "Restore", startWeek: 1, endWeek: 1, focus: "Restore", progression: [] }, { id: "recovery-build", phaseType: "progression", name: "Build", startWeek: 2, endWeek: 2, focus: "Build range", progression: [] }];
    candidate.mesocycle.domainProgressions[1]!.phases[0]!.endWeek = 2;
    candidate.mesocycle.weeks = [{ weekNumber: 1, focus: null, sessions: [copy("move-me", "2026-09-07"), copy("stay-one", "2026-09-08")] }, { weekNumber: 2, focus: null, sessions: [copy("stay-two", "2026-09-14"), copy("stay-three", "2026-09-15")] }];
    app.saveProfile({ ...app.getProfile(), trainingRhythm: candidate.mesocycle.schedule });
    candidate.inputSnapshotHash = app.snapshotHash();
    app.saveCurrentPlan(candidate);
    const revision = app.getCalendar()[0]!.revision;
    app.updatePlannedSession("move-me", { action: "move_occurrence", scheduledDate: "2026-09-16", expectedRevision: revision });
    expect(app.getCalendar().find((session) => session.id === "move-me")).toMatchObject({ weekNumber: 2, phaseRefs: [{ domain: "recovery", phaseId: "recovery-build" }, { domain: "mind_body", phaseId: "mind-body-base" }] });
  });
  it("derives completion from Training History without writing completed into Current Plan", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T00:00:00Z"));
    app.createTemplate(template()); app.saveCurrentPlan(plan(app));
    const result = app.updatePlannedSession("weekly-1", { action: "complete", expectedRevision: 1 }) as { trainingSession: { id: string; status: string; plannedSessionId: string | null } };
    expect(result.trainingSession).toMatchObject({ status: "completed", plannedSessionId: "weekly-1", timePrecision: "date_only", missingFields: expect.arrayContaining(["actual start time"]) });
    expect(app.getCalendar()[0]).toMatchObject({ status: "completed", displayState: "completed", completedTrainingSessionId: result.trainingSession.id, match: { method: "manual" } });
    expect(repository.getCurrentPlan()!.mesocycle.weeks[0]!.sessions[0]!.status).toBe("planned");
    expect(app.getNextTrainingDay().nextTrainingDay).toBeNull();
  });
  it("replaces a manual completion with richer API data without duplicating History", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T00:00:00Z"));
    app.createTemplate(template()); app.saveCurrentPlan(plan(app));
    const manual = (app.updatePlannedSession("weekly-1", { action: "complete", expectedRevision: 1 }) as { trainingSession: { id: string } }).trainingSession;
    app.commitIntervals({ activities: [{ id: "apple-fitness", type: "Yoga", name: "Mobility and breathing", start_date: "2026-09-07T12:00:00Z", moving_time: 1200 }], wellness: [], events: [] }, { rangeStart: "2026-09-07", rangeEnd: "2026-09-07" });
    expect(app.listSessions()).toHaveLength(1);
    expect(app.listSessions()[0]).toMatchObject({ id: manual.id, source: "intervals", durationMinutes: 20, plannedSessionId: "weekly-1" });
    expect(app.getCalendar()[0]).toMatchObject({ status: "completed", completedTrainingSessionId: manual.id });
  });
  it("automatically matches one compatible canonical workout to one same-day plan", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T00:00:00Z"));
    app.createTemplate(template()); app.saveCurrentPlan(plan(app));
    app.commitIntervals({ activities: [{ id: "recovery", type: "Yoga", name: "Mobility and breathing", start_date: "2026-09-07T02:00:00Z", moving_time: 1200 }], wellness: [], events: [] }, { rangeStart: "2026-09-07", rangeEnd: "2026-09-07" });
    const actual = app.listSessions()[0]!;
    expect(actual.plannedSessionId).toBe("weekly-1");
    expect(app.getCalendar()[0]).toMatchObject({ status: "completed", completedTrainingSessionId: actual.id });
  });
  it("leaves an actual workout unmatched when two same-day plans score equally", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T00:00:00Z"));
    app.createTemplate(template()); const candidate = plan(app); const duplicate = structuredClone(candidate.mesocycle.weeks[0]!.sessions[0]!); duplicate.id = "weekly-2"; duplicate.order = 1; candidate.mesocycle.weeks[0]!.sessions.push(duplicate); app.saveCurrentPlan(candidate);
    app.commitIntervals({ activities: [{ id: "recovery", type: "Yoga", name: "Mobility and breathing", start_date: "2026-09-07T02:00:00Z", moving_time: 1200 }], wellness: [], events: [] }, { rangeStart: "2026-09-07", rangeEnd: "2026-09-07" });
    expect(app.listSessions()[0]?.plannedSessionId).toBeNull();
    expect(app.getCalendar().map((session) => session.status)).toEqual(["planned", "planned"]);
  });
  it("derives unrecorded only after the planned local date and rejects future completion", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-06T04:00:00Z"));
    app.createTemplate(template()); app.saveCurrentPlan(plan(app));
    expect(app.getCalendar()[0]?.displayState).toBe("scheduled");
    expect(() => app.updatePlannedSession("weekly-1", { action: "complete", expectedRevision: 1 })).toThrowError(expect.objectContaining({ code: "FUTURE_SESSION_CANNOT_BE_COMPLETED" }));
    const later = new AthriaApplication(repository, "local-user", () => new Date("2026-09-08T04:00:00Z"));
    expect(later.getCalendar()[0]?.displayState).toBe("unrecorded");
  });
  it("keeps date-only manual completion on the planned date in UTC+14", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T01:00:00Z"));
    app.saveProfile({ ...app.getProfile(), timezone: "Pacific/Kiritimati" }); app.createTemplate(template()); app.saveCurrentPlan(plan(app));
    const workout = (app.updatePlannedSession("weekly-1", { action: "complete", expectedRevision: 1 }) as { trainingSession: { id: string } }).trainingSession;
    const stored = app.listSessions().find((session) => session.id === workout.id)!;
    expect(new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Kiritimati", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(stored.startAt))).toBe("2026-09-07");
    expect(stored.timePrecision).toBe("date_only");
  });
  it("records skip and restore events and allows moving the same session in either direction", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T04:00:00Z"));
    app.createTemplate(template()); const candidate = plan(app); candidate.mesocycle.schedule = { kind: "flexible_week", targetDaysPerWeek: 1, minDaysPerWeek: 1, maxDaysPerWeek: 2 }; app.saveProfile({ ...app.getProfile(), trainingRhythm: candidate.mesocycle.schedule }); candidate.inputSnapshotHash = app.snapshotHash(); app.saveCurrentPlan(candidate);
    app.updatePlannedSession("weekly-1", { action: "skip", expectedRevision: 1, reason: { reasonCode: "schedule", note: "Work" } });
    expect(app.getCalendar()[0]).toMatchObject({ status: "skipped", displayState: "skipped" });
    app.updatePlannedSession("weekly-1", { action: "restore", expectedRevision: 2 });
    app.updatePlannedSession("weekly-1", { action: "move_occurrence", scheduledDate: "2026-09-10", expectedRevision: 3 });
    app.updatePlannedSession("weekly-1", { action: "move_occurrence", scheduledDate: "2026-09-08", expectedRevision: 4 });
    expect(app.getCalendar()[0]).toMatchObject({ id: "weekly-1", scheduledDate: "2026-09-08" });
    expect(repository.sqlite.query("SELECT action,reason_code,reason_note FROM planned_session_events ORDER BY revision_after").all()).toEqual([{ action: "skip", reason_code: "schedule", reason_note: "Work" }, { action: "restore", reason_code: null, reason_note: null }, { action: "move_occurrence", reason_code: null, reason_note: null }, { action: "move_occurrence", reason_code: null, reason_note: null }]);
  });
  it("supports manual re-linking, intentional unplanned state, and removing a manual completion", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T04:00:00Z"));
    app.createTemplate(template()); const candidate = plan(app); const second = structuredClone(candidate.mesocycle.weeks[0]!.sessions[0]!); second.id = "weekly-2"; second.order = 1; candidate.mesocycle.weeks[0]!.sessions.push(second); app.saveCurrentPlan(candidate);
    const manual = (app.updatePlannedSession("weekly-1", { action: "complete", expectedRevision: 1 }) as { trainingSession: { id: string } }).trainingSession;
    expect(app.setTrainingSessionPlanMatch(manual.id, { plannedSessionId: "weekly-2", expectedRevision: 1, confirmed: true }).planMatch).toMatchObject({ plannedSessionId: "weekly-2", method: "manual" });
    expect(app.setTrainingSessionPlanMatch(manual.id, { plannedSessionId: null, expectedRevision: 1, confirmed: true })).toMatchObject({ plannedSessionId: null, isPlanMatchExcluded: true });
    expect(app.clearTrainingSessionPlanExclusion(manual.id, { confirmed: true }).isPlanMatchExcluded).toBe(false);
    expect(app.deleteManualTrainingSession(manual.id, { confirmed: true })).toBeNull();
    expect(app.listSessions()).toHaveLength(0);
  });
  it("deletes an entire workout and reports a missing workout", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    const workout = app.recordTrainingSession({ name: "Workout", modality: "recovery", domains: ["recovery"], sport: null, startAt: "2026-09-07T02:00:00Z", endAt: "2026-09-07T03:00:00Z", durationMinutes: 60, timezone: "UTC", plannedSessionId: null, strengthSets: [], endurance: null, missingFields: [] });
    expect(app.deleteTrainingSession(workout.id, { confirmed: true })).toEqual({ deleted: true });
    expect(app.listSessions()).toEqual([]);
    expect(() => app.deleteTrainingSession(workout.id, { confirmed: true })).toThrowError(AthriaError);
  });
  it("persists each supported user-selected workout type and rejects invalid updates", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T04:00:00Z"));
    const workout = app.recordTrainingSession({ name: "Mixed session", modality: "mixed", domains: ["strength", "endurance"], sport: null, startAt: "2026-09-07T02:00:00Z", endAt: "2026-09-07T03:00:00Z", durationMinutes: 60, timezone: "UTC", plannedSessionId: null, strengthSets: [], endurance: null, missingFields: [] });
    for (const domain of ["strength", "endurance", "sport_skill", "mind_body", "recovery"] as const) expect(app.updateTrainingSessionType(workout.id, { domain, confirmed: true }).domains).toEqual([domain]);
    expect(() => app.updateTrainingSessionType(workout.id, { domain: "invalid", confirmed: true })).toThrow();
    expect(() => app.updateTrainingSessionType("missing", { domain: "recovery", confirmed: true })).toThrowError(AthriaError);
  });
  it("requires full Session input and exposes taxonomy through MCP", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    const taxonomy = app.getTrainingTaxonomy();
    expect(taxonomy.taxonomyVersion).toBe("strength-2.0");
    expect(taxonomy.strength.muscleGroups.some((item) => item.id === "gluteus_medius")).toBe(true);
    expect(taxonomy.equipmentCategories.flatMap((category) => category.groups.flatMap((group) => group.items.map((item) => item.id)))).toEqual(equipmentTypeIds);
    expect(taxonomy.strength.equipment).toEqual(equipmentTypeIds);
    const tool = app.toolRegistry().find((item) => item.name === "save_next_training_day_sessions")!;
    expect(tool.inputSchema.safeParse({ clientRequestId: "x", scheduledDate: "2026-09-07", expectedRevision: 0, mode: "append", sessions: [{ id: "x", templateRef: null }] }).success).toBe(false);
    expect(app.toolRegistry().some((item) => item.name === "preview_session_template_change")).toBe(false);
    expect(app.toolRegistry().some((item) => ["get_exercise_catalog", "find_exercise_candidates", "get_training_preferences"].includes(item.name))).toBe(false);
    expect(app.toolRegistry().some((item) => item.name === "record_training_session")).toBe(true);
  });
  it("directly applies an explicitly confirmed Profile update against its hash", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    const tool = app.toolRegistry().find((item) => item.name === "update_athlete_profile")!;
    expect(tool.inputSchema.safeParse({ patch: { preferredName: "Renamed" }, expectedProfileHash: app.profileHash(), confirmed: true }).success).toBe(true);
    expect(app.updateProfile({ patch: { preferredName: "Renamed" }, expectedProfileHash: app.profileHash(), confirmed: true }).preferredName).toBe("Renamed");
    expect(() => app.updateProfile({ patch: { preferredName: "Again" }, expectedProfileHash: "stale", confirmed: true })).toThrow(/changed/i);
  });
  it("atomically saves Personal Information and today's optional weight", () => {
    repository = new AthriaRepository(":memory:", () => new Date("2026-09-11T03:00:00Z")); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-11T03:00:00Z"));
    const current = app.getPersonalInformation();
    const saved = app.savePersonalInformation({ preferredName: "Taylor", gender: "non_binary", heightCm: 172.5, birthDate: "1995-04-03", weightKg: 68.2, expectedSnapshotHash: current.snapshotHash });
    expect(saved).toMatchObject({ preferredName: "Taylor", gender: "non_binary", heightCm: 172.5, birthDate: "1995-04-03", weightKg: 68.2, weightDate: "2026-09-11" });
    expect(repository.getWellness("local-user", "2026-09-11")?.fields.weightKg).toMatchObject({ value: 68.2, source: "user" });
    expect(() => app.savePersonalInformation({ preferredName: "Stale", gender: null, heightCm: null, birthDate: null, expectedSnapshotHash: current.snapshotHash })).toThrow(/changed/i);
  });
  it("persists the chosen unit system and keeps it when a save omits it", () => {
    repository = new AthriaRepository(":memory:", () => new Date("2026-09-11T03:00:00Z")); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-11T03:00:00Z"));
    const current = app.getPersonalInformation();
    expect(current.unitSystem).toBe("metric");
    const saved = app.savePersonalInformation({ preferredName: "Taylor", gender: null, heightCm: 172.5, birthDate: null, unitSystem: "imperial", expectedSnapshotHash: current.snapshotHash });
    expect(saved.unitSystem).toBe("imperial");
    expect(repository.getProfile().unitSystem).toBe("imperial");
    const unchanged = app.savePersonalInformation({ preferredName: "Taylor", gender: null, heightCm: 172.5, birthDate: null, expectedSnapshotHash: saved.snapshotHash });
    expect(unchanged.unitSystem).toBe("imperial");
  });
  it("does not copy an unchanged historical weight and allows a cleared user weight to sync again", () => {
    repository = new AthriaRepository(":memory:", () => new Date("2026-09-11T03:00:00Z")); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-11T03:00:00Z"));
    repository.upsertWellness("local-user", [{ id: "2026-09-10", weight: 70 }]);
    let current = app.getPersonalInformation();
    app.savePersonalInformation({ preferredName: "Athlete", gender: null, heightCm: null, birthDate: null, expectedSnapshotHash: current.snapshotHash });
    expect(repository.getWellness("local-user", "2026-09-11")).toBeNull();
    current = app.getPersonalInformation();
    app.savePersonalInformation({ preferredName: "Athlete", gender: null, heightCm: null, birthDate: null, weightKg: null, expectedSnapshotHash: current.snapshotHash });
    repository.upsertWellness("local-user", [{ id: "2026-09-11", weight: 69 }]);
    expect(repository.getWellness("local-user", "2026-09-11")?.fields.weightKg?.value).toBe(69);
  });
  it("rejects duplicated profile notes and accepts injuries beside constraint notes", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository);
    expect(() => app.updateProfile({ patch: { constraintNotes: ["Left shoulder surgery", " left  shoulder surgery "] }, expectedProfileHash: app.profileHash(), confirmed: true })).toThrow(/duplicate/i);
    expect(() => app.updateProfile({ patch: { injuries: ["Left knee tendinopathy", "left  KNEE tendinopathy"] }, expectedProfileHash: app.profileHash(), confirmed: true })).toThrow(/duplicate/i);
    const updated = app.updateProfile({ patch: { injuries: ["Left shoulder surgery (2024)"], constraintNotes: ["Avoid overhead pressing"] }, expectedProfileHash: app.profileHash(), confirmed: true });
    expect(updated.injuries).toEqual(["Left shoulder surgery (2024)"]);
    expect(updated.constraintNotes).toEqual(["Avoid overhead pressing"]);
  });
  it("summarises save_current_plan output and keeps blocker failures short", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T00:00:00Z"));
    app.createTemplate(template());
    const tool = app.toolRegistry().find((item) => item.name === "save_current_plan")!;
    const saved = tool.handler(plan(app)) as { revision: number; impact: Record<string, number>; blockerSummary: { valid: boolean; blockers: number; advisories: number; blockingDataGaps: number } };
    expect(Object.keys(saved).sort()).toEqual(["blockerSummary", "impact", "revision"]);
    expect(saved.revision).toBe(1);
    expect(saved.blockerSummary).toMatchObject({ valid: true, blockers: 0, blockingDataGaps: 0 });
    const blocked = plan(app, 1);
    blocked.mesocycle.weeks[0].sessions[0].durationMinutes = 90;
    let failure: unknown;
    try { app.saveCurrentPlan(blocked); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AthriaError);
    expect((failure as AthriaError).code).toBe("PLAN_HAS_BLOCKERS");
    const message = (failure as Error).message;
    expect(message).toMatch(/blocking issue/i);
    expect(message).toMatch(/MAX_SESSION_DURATION:fail/);
    expect(message).not.toContain("results");
    expect(message.length).toBeLessThan(500);
  });
  it("reports stale plan revisions with a machine-readable code", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-07T00:00:00Z"));
    app.createTemplate(template());
    app.saveCurrentPlan(plan(app));
    let failure: unknown;
    try { app.saveCurrentPlan(plan(app, 0)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AthriaError);
    expect((failure as AthriaError).code).toBe("REVISION_CONFLICT");
  });
  it("records Intervals sync state and only advances the baseline after full success", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-11T08:00:00Z"));
    const success = app.commitIntervals({ activities: [{ id: "run-1", type: "Run", start_date: "2026-09-10T10:00:00Z", moving_time: 1800 }], wellness: [{ id: "2026-09-10", restingHR: 50 }], events: [] }, { attemptedAt: "2026-09-11T08:00:00.000Z", rangeStart: "2026-09-04", rangeEnd: "2026-09-11" });
    expect(success).toMatchObject({ added: 1, updated: 0, wellnessCount: 1 });
    expect(success.sync).toMatchObject({ status: "success", lastSuccessAt: "2026-09-11T08:00:00.000Z", rangeStart: "2026-09-04", rangeEnd: "2026-09-11" });
    expect(app.getIntervalsSyncStatus()).toMatchObject({ source: "intervals", status: "success", lastSuccessAt: "2026-09-11T08:00:00.000Z" });
    const partial = app.commitIntervals({ activities: "Intervals.icu returned HTTP 500", wellness: [{ id: "2026-09-11", restingHR: 49 }], events: [] }, { attemptedAt: "2026-09-12T08:00:00.000Z", rangeStart: "2026-09-10", rangeEnd: "2026-09-12" });
    expect(partial.sync).toMatchObject({ status: "partial", lastSuccessAt: "2026-09-11T08:00:00.000Z" });
    expect(app.getIntervalsSyncStatus()).toMatchObject({ status: "partial", lastSuccessAt: "2026-09-11T08:00:00.000Z", lastAttemptAt: "2026-09-12T08:00:00.000Z" });
    expect(app.listSessions().map((session) => session.externalId)).toEqual(["activities:run-1"]);
  });
  it("replaces only successful Xunji dates and retains failed dates", () => {
    repository = new AthriaRepository(":memory:"); const app = new AthriaApplication(repository, "local-user", () => new Date("2026-09-08T08:00:00Z"));
    const record = (localid: string, datestr: string, startAt: string) => ({ localid, datestr, title: localid, start: Date.parse(startAt), end: Date.parse(startAt) + 30 * 60_000, movements: [{ name: "Run", cardio: true, metrics: { distance: 5 } }] });
    app.commitXunji({ rangeStart: "2026-09-06", rangeEnd: "2026-09-07", successfulDates: ["2026-09-06", "2026-09-07"], errors: [], records: [record("six", "2026-09-06", "2026-09-06T03:00:00Z"), record("seven", "2026-09-07", "2026-09-07T03:00:00Z")] });
    app.commitXunji({ rangeStart: "2026-09-06", rangeEnd: "2026-09-07", successfulDates: ["2026-09-07"], errors: [{ datestr: "2026-09-06", code: "request_failed", message: "fixture" }], records: [] });
    expect(app.listXunjiSessions(30).sessions.map((session) => session.externalId)).toEqual(["six"]);
  });
});
