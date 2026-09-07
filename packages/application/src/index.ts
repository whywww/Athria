import * as z from "zod";
import {
  calculateHeartRateZones,
  calculateTrainingMetrics,
  comparePlans,
  estimateOneRepMax,
  evaluateDoubleProgression,
  evaluateRpeAutoregulation,
  findExerciseCandidates,
  stableHash,
  validatePlan,
} from "@athria/core";
import { AthriaRepository } from "@athria/data";
import { XUNJI_PARSER_VERSION, normalizeIntervalsActivity, normalizeXunjiTraining, parseHevyCsv, type HevyPreview, type XunjiSyncResult } from "@athria/integrations";
import {
  agentPlanDraftSchema,
  athleteProfileSchema,
  dateSchema,
  mesocycleSchema,
  nextTrainingDayWriteSchema,
  planDraftSchema,
  plannedSessionSchema,
  trainingPreferenceSchema,
  type AthleteProfile,
  type ExerciseDefinition,
  type PlanDraft,
  type PlanValidation,
  type NextTrainingDayWrite,
  type PlannedSession,
  type TrainingPreference,
  type TrainingSession,
} from "@athria/schemas";

export class AthriaError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export const exerciseCatalog: ExerciseDefinition[] = [
  { key: "goblet_squat", name: "Goblet Squat", movement: "squat", primaryMuscles: ["quadriceps", "glutes"], secondaryMuscles: ["core"], equipment: ["dumbbell"], unilateral: false, tags: ["strength"] },
  { key: "dumbbell_bench_press", name: "Dumbbell Bench Press", movement: "horizontal_push", primaryMuscles: ["chest"], secondaryMuscles: ["triceps", "shoulders"], equipment: ["dumbbell"], unilateral: false, tags: ["strength"] },
  { key: "seated_row", name: "Seated Cable Row", movement: "horizontal_pull", primaryMuscles: ["back"], secondaryMuscles: ["biceps"], equipment: ["cable", "machine"], unilateral: false, tags: ["strength"] },
  { key: "romanian_deadlift", name: "Romanian Deadlift", movement: "hinge", primaryMuscles: ["hamstrings", "glutes"], secondaryMuscles: ["back"], equipment: ["barbell", "dumbbell"], unilateral: false, tags: ["strength"] },
  { key: "split_squat", name: "Split Squat", movement: "squat", primaryMuscles: ["quadriceps", "glutes"], secondaryMuscles: ["core"], equipment: ["bodyweight", "dumbbell"], unilateral: true, tags: ["strength"] },
  { key: "lat_pulldown", name: "Lat Pulldown", movement: "vertical_pull", primaryMuscles: ["back"], secondaryMuscles: ["biceps"], equipment: ["cable", "machine"], unilateral: false, tags: ["strength"] },
  { key: "dumbbell_shoulder_press", name: "Dumbbell Shoulder Press", movement: "vertical_push", primaryMuscles: ["shoulders"], secondaryMuscles: ["triceps"], equipment: ["dumbbell"], unilateral: false, tags: ["strength"] },
  { key: "hip_thrust", name: "Hip Thrust", movement: "hinge", primaryMuscles: ["glutes"], secondaryMuscles: ["hamstrings"], equipment: ["bodyweight", "barbell", "dumbbell"], unilateral: false, tags: ["strength"] },
];

export interface AthriaTool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  readOnly: boolean;
  idempotent: boolean;
  handler: (input: unknown) => unknown | Promise<unknown>;
}

const addDays = (date: string, days: number): string => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const dayDifference = (from: string, to: string): number => Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000);
const mondayWeekday = (date: string): number => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
const localDate = (date: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

export class AthriaApplication {
  private readonly previews = new Map<string, HevyPreview>();

  constructor(readonly repository: AthriaRepository, readonly ownerId = "local-user", readonly now: () => Date = () => new Date()) {
    repository.seedExercises(exerciseCatalog);
  }

  getProfile(): AthleteProfile { return this.repository.getProfile(this.ownerId); }
  saveProfile(value: unknown): AthleteProfile { return this.repository.saveProfile(athleteProfileSchema.parse(value)); }
  getPreference(): TrainingPreference { return this.repository.getPreference(this.ownerId); }
  savePreference(value: unknown): TrainingPreference { return this.repository.savePreference(trainingPreferenceSchema.parse(value)); }
  listSessions(days = 90) { return this.repository.listSessions(this.ownerId, new Date(this.now().getTime() - days * 86_400_000).toISOString()); }
  snapshotHash(): string { return stableHash({ profile: this.getProfile(), preference: this.getPreference(), sessions: this.listSessions(90) }); }

  getTrainingState() {
    const sessions = this.listSessions(90);
    return { asOf: this.now().toISOString(), inputSnapshotHash: this.snapshotHash(), metrics: calculateTrainingMetrics(sessions), dataGaps: [] };
  }

  getTrainingSummary(days = 7) {
    const sessions = this.listSessions(days);
    return {
      periodDays: days,
      sessionCount: sessions.length,
      totalDurationMinutes: sessions.reduce((total, session) => total + session.durationMinutes, 0),
      byModality: Object.fromEntries(["strength", "endurance", "recovery", "mixed", "unknown"].map((modality) => [modality, sessions.filter((item) => item.modality === modality).length])),
      metrics: calculateTrainingMetrics(sessions),
    };
  }

  validateDraft(value: Pick<PlanDraft, "mesocycle">): PlanValidation { return validatePlan(this.getProfile(), value, this.repository.listExercises(), this.now()); }

  saveDraft(value: unknown) {
    const draft = agentPlanDraftSchema.parse(value);
    if (draft.ownerId !== this.ownerId) throw new AthriaError("OWNER_MISMATCH", "The draft owner does not match the local athlete.", 403);
    if (draft.inputSnapshotHash !== this.snapshotHash()) throw new AthriaError("INPUT_SNAPSHOT_CHANGED", "Training state changed. Refresh the state and regenerate the draft.", 409);
    const validation = this.validateDraft(draft);
    return this.repository.saveDraft(draft, validation);
  }

  approveDraft(draftId: string, approvedBy: string, changeReason: string) {
    const stored = this.repository.getDraft(draftId, this.ownerId);
    if (!stored) throw new AthriaError("DRAFT_NOT_FOUND", "The plan draft was not found.", 404);
    if (this.repository.hasApproval(this.ownerId, "plan_draft", draftId)) throw new AthriaError("DRAFT_ALREADY_APPROVED", "This draft already produced a formal plan version.", 409);
    if (this.now().getTime() - new Date(stored.draft.updatedAt).getTime() > 7 * 86_400_000) throw new AthriaError("DRAFT_EXPIRED", "This draft is older than seven days. Refresh the state and create a new draft.", 409);
    if (stored.draft.inputSnapshotHash !== this.snapshotHash()) throw new AthriaError("INPUT_SNAPSHOT_CHANGED", "Training state changed after this draft was created.", 409);
    const validation = this.validateDraft(stored.draft);
    if (!validation.valid) throw new AthriaError("PLAN_HAS_HARD_VIOLATIONS", "A plan with hard violations cannot be approved.", 409);
    return this.repository.createApprovedVersion({ draft: stored.draft, validation, approvedBy, changeReason });
  }

  restoreVersion(versionId: string, approvedBy: string, changeReason: string) {
    const source = this.repository.listVersions(this.ownerId).find((item) => item.id === versionId);
    if (!source) throw new AthriaError("PLAN_VERSION_NOT_FOUND", "The plan version was not found.", 404);
    const timestamp = this.now().toISOString();
    const draft = { ...source.plan, id: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), inputSnapshotHash: this.snapshotHash(), createdAt: timestamp, updatedAt: timestamp };
    const validation = this.validateDraft(draft);
    if (!validation.valid) throw new AthriaError("PLAN_HAS_HARD_VIOLATIONS", "The historical plan no longer passes current hard constraints.", 409);
    return this.repository.createApprovedVersion({ draft, validation, approvedBy, changeReason });
  }

  getNextTrainingDay(value: { planVersionId?: string; onOrAfterDate?: string } = {}) {
    const versions = this.repository.listVersions(this.ownerId);
    const version = value.planVersionId ? versions.find((item) => item.id === value.planVersionId) : versions[0];
    if (!version?.plan.mesocycle) return { nextTrainingDay: null, reasonCode: "NO_APPROVED_PLAN" };
    const mesocycle = version.plan.mesocycle;
    if (!mesocycle.weeklyStructure.some((day) => day.templateIds.length)) return { nextTrainingDay: null, reasonCode: "NO_TRAINING_DAYS" };
    const profile = this.getProfile();
    const start = dateSchema.parse(value.onOrAfterDate ?? localDate(this.now(), profile.timezone));
    const activation = this.repository.getPlanActivation(version.id, this.ownerId);
    for (let offset = 0; offset < Math.max(7, mesocycle.durationWeeks * 7); offset += 1) {
      const scheduledDate = addDays(start, offset);
      let weekNumber = 1;
      if (activation) {
        const elapsed = dayDifference(activation.effectiveStartDate, scheduledDate);
        if (elapsed < 0) continue;
        weekNumber = Math.floor(elapsed / 7) + 1;
        if (weekNumber > mesocycle.durationWeeks) return { nextTrainingDay: null, reasonCode: "PLAN_ENDED" };
      }
      const entry = mesocycle.weeklyStructure.find((day) => day.dayOfWeek === mondayWeekday(scheduledDate));
      if (!entry?.templateIds.length) continue;
      const existingSessions = this.repository.listPlannedSessions(version.id, this.ownerId, scheduledDate);
      if (existingSessions.length && existingSessions.every((session) => session.status !== "planned")) continue;
      const phase = mesocycle.phases.find((item) => weekNumber >= item.startWeek && weekNumber <= item.endWeek)!;
      return {
        nextTrainingDay: {
          scheduledDate, dayOfWeek: entry.dayOfWeek, weekNumber, phaseId: phase.id, phaseType: phase.phaseType,
          expectedTemplateIds: entry.templateIds, existingSessions, revision: activation?.revision ?? 0, timezone: profile.timezone,
        },
        reasonCode: null,
      };
    }
    return { nextTrainingDay: null, reasonCode: activation ? "PLAN_ENDED" : "NO_TRAINING_DAYS" };
  }

  private buildNextTrainingDaySessions(raw: unknown) {
    const input = nextTrainingDayWriteSchema.parse(raw) as NextTrainingDayWrite;
    const next = this.getNextTrainingDay({ planVersionId: input.planVersionId });
    if (!next.nextTrainingDay) throw new AthriaError(next.reasonCode ?? "NO_NEXT_TRAINING_DAY", "There is no available next training day.", 409);
    if (next.nextTrainingDay.scheduledDate !== input.scheduledDate) throw new AthriaError("NEXT_TRAINING_DAY_CHANGED", "Refresh the next training day before saving sessions.", 409);
    if (next.nextTrainingDay.revision !== input.expectedRevision) throw new AthriaError("PLANNED_SESSION_REVISION_CONFLICT", "The planned sessions changed. Refresh and confirm the update again.", 409);
    const version = this.repository.listVersions(this.ownerId).find((item) => item.id === input.planVersionId)!;
    const mesocycle = version.plan.mesocycle!;
    const templates = new Map(mesocycle.sessionTemplates.map((item) => [item.id, item]));
    const timestamp = this.now().toISOString();
    const ids = new Set<string>();
    const sessions = input.sessions.map((item): PlannedSession => {
      if (ids.has(item.id)) throw new AthriaError("DUPLICATE_PLANNED_SESSION_ID", "Session IDs must be unique.");
      ids.add(item.id);
      const template = templates.get(item.templateId);
      if (!template) throw new AthriaError("TEMPLATE_NOT_IN_PLAN", `Template ${item.templateId} is not part of the approved plan.`);
      const expected = next.nextTrainingDay!.expectedTemplateIds.includes(item.templateId);
      if (!expected && !item.overrideReason) throw new AthriaError("OVERRIDE_REASON_REQUIRED", "An extra session outside the weekly structure requires an override reason.");
      const overrides = new Map(item.exerciseOverrides.map((override) => [override.exerciseKey, override]));
      for (const key of overrides.keys()) if (!template.exercises.some((exercise) => exercise.exerciseKey === key)) throw new AthriaError("EXERCISE_NOT_IN_TEMPLATE", `Exercise ${key} is not part of template ${template.id}.`);
      const exercises = template.exercises.map((exercise) => ({ ...exercise, ...(overrides.get(exercise.exerciseKey) ?? {}) }));
      return plannedSessionSchema.parse({
        id: item.id, ownerId: this.ownerId, planVersionId: version.id, scheduledDate: input.scheduledDate,
        weekNumber: next.nextTrainingDay!.weekNumber, phaseId: next.nextTrainingDay!.phaseId, templateId: template.id,
        name: template.name, modality: template.modality, intent: template.intent, recoveryDemand: template.recoveryDemand,
        durationMinutes: template.durationMinutes, exercises, notes: item.notes, overrideReason: item.overrideReason ?? null,
        status: "planned", completedTrainingSessionId: null, createdAt: timestamp, updatedAt: timestamp,
      });
    });
    if (this.getProfile().explicitRecoveryHours !== null && sessions.some((session) => session.recoveryDemand === "high")) {
      const otherHighDates = this.repository.listPlannedSessions(version.id, this.ownerId).filter((session) => session.recoveryDemand === "high" && session.status !== "skipped" && session.scheduledDate !== input.scheduledDate).map((session) => session.scheduledDate);
      const closestHours = otherHighDates.length ? Math.min(...otherHighDates.map((date) => Math.abs(dayDifference(date, input.scheduledDate)) * 24)) : Infinity;
      if (closestHours < this.getProfile().explicitRecoveryHours!) throw new AthriaError("EXPLICIT_RECOVERY_INTERVAL", "The high-recovery-demand sessions are too close together.", 409);
    }
    return { input, sessions, next: next.nextTrainingDay };
  }

  validateNextTrainingDaySessions(value: unknown) {
    const result = this.buildNextTrainingDaySessions(value);
    return { valid: true, sessions: result.sessions, revision: result.next.revision, scheduledDate: result.next.scheduledDate };
  }

  saveNextTrainingDaySessions(value: unknown) {
    const input = nextTrainingDayWriteSchema.parse(value) as NextTrainingDayWrite;
    const replay = this.repository.replayPlannedSessions({ ownerId: this.ownerId, clientRequestId: input.clientRequestId, planVersionId: input.planVersionId, expectedRevision: input.expectedRevision });
    if (replay) return replay;
    const result = this.buildNextTrainingDaySessions(input);
    try {
      return this.repository.savePlannedSessions({ ownerId: this.ownerId, ...result.input, effectiveStartDate: result.next.scheduledDate, sessions: result.sessions });
    } catch (error) {
      if (error instanceof Error && error.message === "PLANNED_SESSION_REVISION_CONFLICT") throw new AthriaError(error.message, "The planned sessions changed. Refresh and confirm the update again.", 409);
      if (error instanceof Error && error.message === "COMPLETED_SESSION_CANNOT_BE_REPLACED") throw new AthriaError(error.message, "Completed or skipped sessions cannot be replaced.", 409);
      throw error;
    }
  }

  private reconcileImportedSessions(sessions: TrainingSession[]): void {
    const version = this.repository.listVersions(this.ownerId)[0];
    if (!version) return;
    const timezone = this.getProfile().timezone;
    const byDate = new Map<string, TrainingSession[]>();
    for (const session of sessions.filter((item) => item.status === "completed")) {
      const date = localDate(new Date(session.startAt), timezone);
      byDate.set(date, [...(byDate.get(date) ?? []), session]);
    }
    for (const [date, completed] of byDate) {
      const planned = this.repository.listPlannedSessions(version.id, this.ownerId, date).filter((item) => item.status === "planned");
      if (completed.length !== 1 || planned.length !== 1) continue;
      const actual = completed[0]!;
      const target = planned[0]!;
      const compatible = target.modality === actual.modality || target.modality === "mixed" || actual.modality === "mixed";
      if (compatible) this.repository.completePlannedSession(target.id, actual.id, this.ownerId);
    }
  }

  proposeProfileUpdate(value: unknown) {
    const input = z.object({ clientRequestId: z.string().min(1), patch: z.record(z.string(), z.unknown()), rationale: z.string().min(1).max(4000) }).strict().parse(value);
    athleteProfileSchema.partial().parse(input.patch);
    return this.repository.saveProfileUpdateProposal({ id: crypto.randomUUID(), ownerId: this.ownerId, ...input, baseSnapshotHash: stableHash(this.getProfile()), createdAt: this.now().toISOString() });
  }

  approveProfileUpdate(proposalId: string, approvedBy: string) {
    const proposal = this.repository.listProfileUpdateProposals(this.ownerId).find((item) => item.id === proposalId);
    if (!proposal || proposal.status !== "pending") throw new AthriaError("PROFILE_PROPOSAL_NOT_PENDING", "The profile proposal is missing or is no longer pending.", 409);
    if (proposal.baseSnapshotHash !== stableHash(this.getProfile())) throw new AthriaError("INPUT_SNAPSHOT_CHANGED", "The athlete profile changed after this proposal was created.", 409);
    const profile = athleteProfileSchema.parse({ ...this.getProfile(), ...proposal.patch, ownerId: this.ownerId });
    return this.repository.approveProfileUpdate({ proposalId, ownerId: this.ownerId, profile, approvedBy, snapshotHash: proposal.baseSnapshotHash });
  }

  previewHevy(content: Uint8Array, fileName: string) {
    const preview = parseHevyCsv(content, fileName);
    this.previews.set(preview.contentHash, preview);
    return { previewToken: preview.contentHash, fileName, counts: preview.counts, errors: preview.errors, unknownColumns: preview.unknownColumns };
  }

  commitHevy(previewToken: string) {
    const preview = this.previews.get(previewToken);
    if (!preview) throw new AthriaError("IMPORT_PREVIEW_NOT_FOUND", "The import preview was not found.", 404);
    const counts = this.repository.upsertSessions(preview.sessions);
    this.reconcileImportedSessions(preview.sessions);
    this.repository.recordImportBatch({ ownerId: this.ownerId, source: "hevy", contentHash: preview.contentHash, fileName: preview.fileName, parserVersion: preview.parserVersion, status: preview.errors.length ? "partial" : "committed", data: { counts: preview.counts, errors: preview.errors, unknownColumns: preview.unknownColumns } });
    this.repository.upsertRawRecords(this.ownerId, "hevy", preview.rawRows);
    this.previews.delete(previewToken);
    return counts;
  }

  getHevyImportStatus() {
    const batch = this.repository.latestImportBatch(this.ownerId, "hevy");
    if (!batch) return null;
    const data = batch.data as { counts?: { sessions?: number; sets?: number; rows?: number } };
    return { fileName: batch.fileName, importedAt: batch.createdAt, status: batch.status, counts: data.counts ?? {} };
  }

  commitIntervals(payload: Record<"activities" | "events" | "wellness", unknown[] | string>) {
    const sessions = (["activities", "events"] as const).flatMap((resource) => Array.isArray(payload[resource]) ? payload[resource].map((item) => normalizeIntervalsActivity(item as Record<string, unknown>, resource)).filter((item) => item !== null) : []);
    const rawCount = (["activities", "events", "wellness"] as const).reduce((count, resource) => count + (Array.isArray(payload[resource]) ? this.repository.upsertRawRecords(this.ownerId, `intervals:${resource}`, payload[resource] as unknown[]) : 0), 0);
    const wellnessCount = Array.isArray(payload.wellness) ? this.repository.upsertWellness(this.ownerId, payload.wellness) : 0;
    const counts = this.repository.upsertSessions(sessions);
    this.reconcileImportedSessions(sessions);
    return { ...counts, rawCount, wellnessCount, errors: Object.fromEntries(Object.entries(payload).filter(([, value]) => typeof value === "string")) };
  }

  getXunjiSyncStatus() { return this.repository.getConnectionSyncState("xunji", this.ownerId); }

  listXunjiSessions(days = 30) {
    const since = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    return { source: "xunji", sync: this.getXunjiSyncStatus(), sessions: this.repository.listSessionsBySource("xunji", this.ownerId, since) };
  }

  recordXunjiFailure(input: { attemptedAt: string; rangeStart: string; rangeEnd: string; code: string; message: string }) {
    const previous = this.getXunjiSyncStatus();
    return this.repository.saveConnectionSyncState({ source: "xunji", lastAttemptAt: input.attemptedAt, lastSuccessAt: previous?.lastSuccessAt ?? null, rangeStart: input.rangeStart, rangeEnd: input.rangeEnd, status: "failed", data: { successfulDays: 0, failedDays: 1, errors: [{ code: input.code, message: input.message.slice(0, 500) }] } });
  }

  commitXunji(result: XunjiSyncResult, attemptedAt = this.now().toISOString()) {
    const sessions = [];
    const normalizationErrors: Array<{ code: string; message: string }> = [];
    for (const record of result.records) {
      try { sessions.push(normalizeXunjiTraining(record)); }
      catch (error) { normalizationErrors.push({ code: "normalization_failed", message: (error instanceof Error ? error.message : String(error)).slice(0, 500) }); }
    }
    const counts = this.repository.upsertSessions(sessions);
    this.reconcileImportedSessions(sessions);
    const rawCount = this.repository.upsertRawRecords(this.ownerId, "xunji", result.records);
    const errors = [...result.errors, ...normalizationErrors];
    const status = errors.length === 0 ? "success" : result.successfulDates.length > 0 ? "partial" : "failed";
    const previous = this.getXunjiSyncStatus();
    const state = this.repository.saveConnectionSyncState({
      source: "xunji", lastAttemptAt: attemptedAt, lastSuccessAt: result.successfulDates.length ? attemptedAt : previous?.lastSuccessAt ?? null,
      rangeStart: result.rangeStart, rangeEnd: result.rangeEnd, status,
      data: { successfulDays: result.successfulDates.length, failedDays: result.errors.length, records: result.records.length, normalizationFailures: normalizationErrors.length, errors },
    });
    this.repository.recordImportBatch({ ownerId: this.ownerId, source: "xunji", contentHash: stableHash({ rangeStart: result.rangeStart, rangeEnd: result.rangeEnd, records: result.records }), fileName: "Xunji Open API", parserVersion: XUNJI_PARSER_VERSION, status, data: { ...counts, rawCount, sync: state } });
    return { ...counts, rawCount, sync: state };
  }

  toolRegistry(): AthriaTool[] {
    const read = (name: string, description: string, inputSchema: z.ZodTypeAny, handler: AthriaTool["handler"]): AthriaTool => ({ name, description, inputSchema, handler, readOnly: true, idempotent: true });
    return [
      read("get_athlete_profile", "Get confirmed local athlete facts and constraints.", z.object({}), () => this.getProfile()),
      read("get_training_preferences", "Get editable exercise and session preferences.", z.object({}), () => this.getPreference()),
      read("get_training_state", "Get the current state snapshot, metrics, and snapshot hash.", z.object({}), () => this.getTrainingState()),
      read("list_training_sessions", "List normalized training sessions.", z.object({ days: z.number().int().min(1).max(365).default(30) }), (input) => this.listSessions((input as { days: number }).days)),
      read("list_xunji_training_sessions", "获取我的训记记录 / List locally synced Xunji training sessions with sync freshness. Credentials are never exposed.", z.object({ days: z.number().int().min(1).max(365).default(30) }), (input) => this.listXunjiSessions((input as { days: number }).days)),
      read("get_xunji_sync_status", "Get the local Athria Devices sync status for 训记/Xunji without exposing its API key.", z.object({}), () => this.getXunjiSyncStatus()),
      read("get_training_summary", "Get modality-separated recent training metrics.", z.object({ days: z.number().int().min(1).max(365).default(7) }), (input) => this.getTrainingSummary((input as { days: number }).days)),
      read("get_current_plan", "Get the latest approved immutable plan version.", z.object({}), () => this.repository.listVersions(this.ownerId)[0] ?? null),
      read("list_plan_versions", "List immutable approved plan versions.", z.object({}), () => this.repository.listVersions(this.ownerId)),
      read("get_exercise_catalog", "Get normalized exercise definitions.", z.object({}), () => this.repository.listExercises()),
      read("calculate_training_metrics", "Calculate deterministic strength and endurance metrics.", z.object({ days: z.number().int().min(1).max(365).default(90) }), (input) => calculateTrainingMetrics(this.listSessions((input as { days: number }).days))),
      read("estimate_1rm", "Estimate 1RM with the versioned Epley formula.", z.object({ load: z.number().positive(), reps: z.number().int().min(1).max(12), unit: z.enum(["kg", "lb"]) }), (input) => { const value = input as { load: number; reps: number; unit: "kg" | "lb" }; return estimateOneRepMax(value.load, value.reps, value.unit); }),
      read("calculate_heart_rate_zones", "Calculate five zones from an explicit maximum heart rate.", z.object({ maxHeartRate: z.number().int().min(80).max(240) }), (input) => calculateHeartRateZones((input as { maxHeartRate: number }).maxHeartRate)),
      read("evaluate_double_progression", "Evaluate a configured double-progression prescription.", z.object({ completedReps: z.array(z.number().int().min(0)).min(1), repMin: z.number().int().min(1), repMax: z.number().int().min(1), currentLoad: z.number().min(0), loadIncrement: z.number().positive(), unit: z.enum(["kg", "lb"]), rpeValues: z.array(z.number().min(0).max(10)).optional(), rpeCeiling: z.number().min(1).max(10).optional() }), (input) => evaluateDoubleProgression(input as Parameters<typeof evaluateDoubleProgression>[0])),
      read("evaluate_rpe_autoregulation", "Evaluate a load adjustment only when RPE is supplied.", z.object({ actualRpe: z.number().min(0).max(10).nullable(), targetRpe: z.number().min(1).max(10), load: z.number().min(0), increment: z.number().positive(), unit: z.enum(["kg", "lb"]) }), (input) => evaluateRpeAutoregulation(input as Parameters<typeof evaluateRpeAutoregulation>[0])),
      read("evaluate_progression", "Evaluate the MVP progression policy.", z.object({ completedReps: z.array(z.number().int().min(0)).min(1), repMin: z.number().int().min(1), repMax: z.number().int().min(1), currentLoad: z.number().min(0), loadIncrement: z.number().positive(), unit: z.enum(["kg", "lb"]) }), (input) => evaluateDoubleProgression(input as Parameters<typeof evaluateDoubleProgression>[0])),
      read("find_exercise_candidates", "Filter exercises and return explicit exclusion reasons.", z.object({ movement: z.string().optional(), muscles: z.array(z.string()).optional(), equipment: z.array(z.string()).optional() }), (input) => findExerciseCandidates(this.getProfile(), this.repository.listExercises(), input as { movement?: string; muscles?: string[]; equipment?: string[] })),
      read("validate_plan", "Validate a mesocycle without creating dated sessions.", z.object({ mesocycle: mesocycleSchema }), (input) => this.validateDraft(input as Pick<PlanDraft, "mesocycle">)),
      read("check_training_constraints", "Return hard, soft, and informational rule results for a mesocycle.", z.object({ mesocycle: mesocycleSchema }), (input) => this.validateDraft(input as Pick<PlanDraft, "mesocycle">).results),
      read("compare_plan_versions", "Compare a draft with the current approved plan.", z.object({ draft: planDraftSchema }), (input) => comparePlans(this.repository.listVersions(this.ownerId)[0]?.plan ?? null, (input as { draft: PlanDraft }).draft)),
      read("explain_validation_result", "Group mesocycle validation evidence and blocking reasons.", z.object({ mesocycle: mesocycleSchema }), (input) => { const result = this.validateDraft(input as Pick<PlanDraft, "mesocycle">); return { valid: result.valid, hardViolations: result.results.filter((item) => item.severity === "hard" && !item.passed), advisoryResults: result.results.filter((item) => item.severity !== "hard"), dataGaps: result.dataGaps }; }),
      read("get_next_training_day", "Get the first unfinished scheduled training day on or after a local date.", z.object({ planVersionId: z.string().min(1).optional(), onOrAfterDate: dateSchema.optional() }).strict(), (input) => this.getNextTrainingDay(input as { planVersionId?: string; onOrAfterDate?: string })),
      read("validate_next_training_day_sessions", "Validate one or more sessions for the current next training day without saving them.", nextTrainingDayWriteSchema, (input) => this.validateNextTrainingDaySessions(input)),
      { name: "save_plan_draft", description: "Save an idempotent mesocycle draft without dated sessions. Dashboard approval is still required.", inputSchema: agentPlanDraftSchema, readOnly: false, idempotent: true, handler: (input) => this.saveDraft(input) },
      { name: "save_next_training_day_sessions", description: "After explicit conversational confirmation, append or replace planned sessions on the current next training day.", inputSchema: nextTrainingDayWriteSchema, readOnly: false, idempotent: true, handler: (input) => this.saveNextTrainingDaySessions(input) },
      { name: "propose_profile_update", description: "Create an idempotent profile update proposal for Dashboard approval.", inputSchema: z.object({ clientRequestId: z.string().min(1), patch: athleteProfileSchema.partial(), rationale: z.string().min(1).max(4000) }), readOnly: false, idempotent: true, handler: (input) => this.proposeProfileUpdate(input) },
    ];
  }
}
