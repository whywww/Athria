import * as z from "zod";
import {
  calculateHeartRateZones,
  calculateTrainingMetrics,
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
  AI_HARD_CONFIDENCE,
  PLAN_SCHEMA_VERSION,
  TEMPLATE_CATALOG_VERSION,
  TAXONOMY_VERSION,
  athleteProfileSchema,
  currentPlanSchema,
  currentPlanWriteSchema,
  dateSchema,
  domainSchema,
  equipmentTypeSchema,
  mesocycleSchema,
  movementPatternSchema,
  movementPatternTaxonomy,
  muscleGroupSchema,
  muscleTaxonomy,
  nextTrainingDayWriteSchema,
  plannedSessionSchema,
  plannedSessionActionSchema,
  sessionTemplateSchema,
  sessionTemplateCreateSchema,
  sessionTemplateUpdateSchema,
  trainingPreferenceSchema,
  type AthleteProfile,
  type CurrentPlan,
  type CurrentPlanWrite,
  type ExerciseDefinition,
  type PhaseRef,
  type PlanValidation,
  type NextTrainingDayWrite,
  type PlannedSession,
  type PlannedSessionAction,
  type SessionTemplate,
  type TrainingPreference,
  type TrainingSession,
} from "@athria/schemas";
import { builtinSessionTemplates } from "./template-catalog";
export { builtinSessionTemplates } from "./template-catalog";

export class AthriaError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

function phaseRefsForSession(plan: CurrentPlan, weekNumber: number, components: CurrentPlan["mesocycle"]["weeks"][number]["sessions"][number]["components"]): PhaseRef[] {
  const domains = [...new Set(components.map((component) => component.domain.value).filter((domain): domain is NonNullable<typeof domain> => domain !== null))];
  return domains.map((domain) => {
    const progression = plan.mesocycle.domainProgressions.find((item) => item.domain === domain)!;
    const phase = progression.phases.find((item) => weekNumber >= item.startWeek && weekNumber <= item.endWeek)!;
    return { domain, phaseId: phase.id };
  });
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
const sessionDomains = (session: TrainingSession) => session.domains.length ? session.domains : [
  ...(session.strengthSets.length ? ["strength" as const] : []),
  ...(session.endurance ? ["endurance" as const] : []),
];

const plannedDatesFollowProfile = (profile: AthleteProfile, plan: CurrentPlan, sessions: PlannedSession[]): boolean => {
  const dates = [...new Set(sessions.map((session) => session.scheduledDate))].sort();
  const rhythm = profile.trainingRhythm;
  if (rhythm.kind === "fixed_week") {
    const expected = [...rhythm.days].sort((left, right) => left - right).join(",");
    return Array.from({ length: plan.mesocycle.durationWeeks }, (_, index) => index + 1).every((weekNumber) => {
      const actual = [...new Set(sessions.filter((session) => session.weekNumber === weekNumber).map((session) => mondayWeekday(session.scheduledDate)))].sort((left, right) => left - right).join(",");
      return actual === expected;
    });
  }
  if (rhythm.kind === "flexible_week") return Array.from({ length: plan.mesocycle.durationWeeks }, (_, index) => index + 1).every((weekNumber) => {
    const count = new Set(sessions.filter((session) => session.weekNumber === weekNumber).map((session) => session.scheduledDate)).size;
    return count >= rhythm.minDaysPerWeek && count <= rhythm.maxDaysPerWeek;
  });
  return dates[0] === plan.effectiveStartDate && dates.every((date, index) => index === 0 || dayDifference(dates[index - 1]!, date) === rhythm.intervalDays);
};

export class AthriaApplication {
  private readonly previews = new Map<string, HevyPreview>();

  constructor(readonly repository: AthriaRepository, readonly ownerId = "local-user", readonly now: () => Date = () => new Date()) {
    repository.seedExercises(exerciseCatalog);
    const current = repository.getCurrentPlan(ownerId);
    if (current && repository.listCurrentPlannedSessions(ownerId).length === 0) repository.saveCurrentPlan(current, current.revision, [], this.sessionsForPlan(current, current.effectiveStartDate));
  }

  getProfile(): AthleteProfile { return this.repository.getProfile(this.ownerId); }
  saveProfile(value: unknown): AthleteProfile { return this.repository.saveProfile(athleteProfileSchema.parse(value)); }
  getPreference(): TrainingPreference { return this.repository.getPreference(this.ownerId); }
  savePreference(value: unknown): TrainingPreference { return this.repository.savePreference(trainingPreferenceSchema.parse(value)); }
  listSessions(days = 90) { return this.repository.listSessions(this.ownerId, new Date(this.now().getTime() - days * 86_400_000).toISOString()).map((session) => ({ ...session, domains: sessionDomains(session), missingFields: sessionDomains(session).length ? session.missingFields : [...new Set([...session.missingFields, "domains"])] })); }
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
      byDomain: Object.fromEntries(domainSchema.options.map((domain) => [domain, sessions.filter((item) => item.domains.includes(domain)).length])),
      metrics: calculateTrainingMetrics(sessions),
    };
  }

  private assertTemplateReferences(mesocycle: CurrentPlanWrite["mesocycle"]): void {
    const user = new Map(this.repository.listTemplates(this.ownerId).map((item) => [item.id, item]));
    const builtin = new Map(builtinSessionTemplates.map((item) => [item.id, item]));
    for (const session of mesocycle.weeks.flatMap((week) => week.sessions)) {
      const ref = session.templateRef;
      if (!ref) continue;
      const valid = ref.source === "builtin" ? builtin.get(ref.id)?.catalogVersion === ref.catalogVersion : user.get(ref.id)?.revision === ref.revision;
      if (!valid) throw new AthriaError("TEMPLATE_NOT_FOUND", `Template reference ${ref.id} does not resolve to the requested version.`, 409);
    }
  }

  getTrainingTaxonomy() {
    return { planSchemaVersion: PLAN_SCHEMA_VERSION, taxonomyVersion: TAXONOMY_VERSION, templateCatalogVersion: TEMPLATE_CATALOG_VERSION, domains: domainSchema.options, strength: { movementPatterns: movementPatternTaxonomy, muscleGroups: muscleTaxonomy, equipment: equipmentTypeSchema.options }, templateVariables: { strength: ["exercise_selection", "sets", "repetitions", "duration", "load", "rpe", "rir", "rest", "tempo", "alternatives"], endurance: ["repetitions", "duration", "distance", "pace", "heart_rate_zone", "power", "cadence", "rpe", "talk_test", "terrain", "strides", "recovery_mode"], sport_skill: ["drill", "participants", "position", "duration", "intensity", "instructions"], recovery: ["body_region", "movement", "duration", "intensity", "instructions"], mind_body: ["technique", "duration", "intensity", "instructions"] }, factSources: ["catalog", "structured_source", "exact_alias", "ai_inferred", "user_confirmed", "migration"], aiHardConfidence: AI_HARD_CONFIDENCE };
  }

  validateCurrentPlan(value: unknown): PlanValidation {
    const input = currentPlanWriteSchema.parse(value);
    this.assertTemplateReferences(input.mesocycle);
    return validatePlan(this.getProfile(), { mesocycle: input.mesocycle, effectiveStartDate: input.effectiveStartDate }, this.repository.listExercises(), this.now());
  }

  listTemplates() { return [...builtinSessionTemplates, ...this.repository.listTemplates(this.ownerId)]; }
  getTemplate(id: string) {
    const template = builtinSessionTemplates.find((item) => item.id === id) ?? this.repository.getTemplate(id, this.ownerId);
    if (!template) throw new AthriaError("TEMPLATE_NOT_FOUND", "The session template was not found.", 404);
    return template;
  }
  createTemplate(value: unknown) {
    const parsed = sessionTemplateCreateSchema.parse(value);
    const { clientRequestId: _request, ...candidate } = parsed;
    const template = sessionTemplateSchema.parse(candidate);
    if (builtinSessionTemplates.some((item) => item.id === template.id)) throw new AthriaError("TEMPLATE_ALREADY_EXISTS", "That ID belongs to a built-in template.", 409);
    try { return this.repository.createTemplate(template, this.ownerId); }
    catch (error) { if (error instanceof Error && error.message === "TEMPLATE_ALREADY_EXISTS") throw new AthriaError(error.message, "A template with this ID already exists.", 409); throw error; }
  }
  updateTemplate(value: unknown) {
    const input = sessionTemplateUpdateSchema.parse(value);
    if (builtinSessionTemplates.some((item) => item.id === input.template.id)) throw new AthriaError("TEMPLATE_READ_ONLY", "Built-in templates are read-only; copy one to create a user template.", 409);
    try { return { template: this.repository.updateTemplate(input.template, input.expectedRevision, this.ownerId), impact: { affectedCount: 0, updatedCount: 0 } }; }
    catch (error) { if (error instanceof Error && ["TEMPLATE_NOT_FOUND", "REVISION_CONFLICT"].includes(error.message)) throw new AthriaError(error.message, error.message === "REVISION_CONFLICT" ? "The template changed. Refresh and try again." : "The session template was not found.", error.message === "REVISION_CONFLICT" ? 409 : 404); throw error; }
  }
  deleteTemplate(id: string, expectedRevision: number) {
    if (builtinSessionTemplates.some((item) => item.id === id)) throw new AthriaError("TEMPLATE_READ_ONLY", "Built-in templates cannot be deleted.", 409);
    const current = this.repository.getCurrentPlan(this.ownerId);
    const references = current?.mesocycle.weeks.flatMap((week) => week.sessions.filter((session) => session.templateRef?.source === "user" && session.templateRef.id === id).map((session) => session.id)) ?? [];
    if (references.length) throw new AthriaError("TEMPLATE_IN_USE", "Remove this template reference from the current plan before deleting it.", 409);
    try { this.repository.deleteTemplate(id, expectedRevision, this.ownerId); return { deleted: true, id }; }
    catch (error) { if (error instanceof Error && ["TEMPLATE_NOT_FOUND", "REVISION_CONFLICT"].includes(error.message)) throw new AthriaError(error.message, error.message === "REVISION_CONFLICT" ? "The template changed. Refresh and try again." : "The session template was not found.", error.message === "REVISION_CONFLICT" ? 409 : 404); throw error; }
  }

  getCurrentPlan() { return this.repository.getCurrentPlan(this.ownerId); }

  private sessionsForPlan(plan: CurrentPlan, onOrAfterDate: string): PlannedSession[] {
    const timestamp = this.now().toISOString();
    const occurrenceByDate = new Map<string, string>();
    return [...plan.mesocycle.weeks].sort((a, b) => a.weekNumber - b.weekNumber).flatMap((week) => [...week.sessions].sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || a.order - b.order).filter((session) => session.scheduledDate >= onOrAfterDate).map((session) => {
      const occurrenceId = occurrenceByDate.get(session.scheduledDate) ?? crypto.randomUUID();
      occurrenceByDate.set(session.scheduledDate, occurrenceId);
      return plannedSessionSchema.parse({ ...session, occurrenceId, ownerId: this.ownerId, planRevision: plan.revision, weekNumber: week.weekNumber, phaseRefs: phaseRefsForSession(plan, week.weekNumber, session.components), exerciseOverrides: [], notes: "", overrideReason: null, status: "planned", completedTrainingSessionId: null, completedAt: null, completionSource: null, createdAt: timestamp, updatedAt: timestamp });
    }));
  }

  saveCurrentPlan(value: unknown) {
    const input = currentPlanWriteSchema.parse(value);
    if (input.ownerId !== this.ownerId) throw new AthriaError("OWNER_MISMATCH", "The plan owner does not match the local athlete.", 403);
    if (input.inputSnapshotHash && input.inputSnapshotHash !== this.snapshotHash()) throw new AthriaError("INPUT_SNAPSHOT_CHANGED", "Training state changed. Refresh and revise the plan.", 409);
    this.assertTemplateReferences(input.mesocycle);
    const validation = validatePlan(this.getProfile(), { mesocycle: input.mesocycle, effectiveStartDate: input.effectiveStartDate }, this.repository.listExercises(), this.now());
    if (!validation.valid) throw new AthriaError("PLAN_HAS_BLOCKERS", JSON.stringify(validation), 409);
    const timestamp = this.now().toISOString();
    const { expectedRevision, ...candidate } = input;
    const plan = currentPlanSchema.parse({ ...candidate, revision: expectedRevision + 1, updatedAt: timestamp });
    const existing = this.repository.listCurrentPlannedSessions(this.ownerId);
    const terminalIds = new Set(existing.filter((session) => session.status !== "planned").map((session) => session.id));
    const desired = this.sessionsForPlan(plan, plan.effectiveStartDate).filter((session) => !terminalIds.has(session.id));
    const desiredIds = new Set(desired.map((session) => session.id));
    const deleted = existing.filter((session) => session.status === "planned" && !desiredIds.has(session.id)).map((session) => session.id);
    try { return { plan: this.repository.saveCurrentPlan(plan, input.expectedRevision, deleted, desired), validation, impact: { affectedCount: existing.length, updatedCount: desired.length, deletedCount: deleted.length, legacySkippedCount: 0 } }; }
    catch (error) { if (error instanceof Error && error.message === "REVISION_CONFLICT") throw new AthriaError(error.message, "The current plan changed. Refresh and try again.", 409); throw error; }
  }

  getNextTrainingDay(value: { onOrAfterDate?: string } = {}) {
    const plan = this.repository.getCurrentPlan(this.ownerId);
    if (!plan) return { nextTrainingDay: null, reasonCode: "NO_CURRENT_PLAN" };
    const profile = this.getProfile();
    const start = dateSchema.parse(value.onOrAfterDate ?? plan.effectiveStartDate);
    const all = this.repository.listCurrentPlannedSessions(this.ownerId).filter((session) => session.scheduledDate >= start);
    const next = all.find((session) => session.status === "planned");
    if (next) {
      const existingSessions = all.filter((session) => session.occurrenceId === next.occurrenceId);
      const refs = new Map(existingSessions.flatMap((session) => session.phaseRefs).map((ref) => [`${ref.domain}:${ref.phaseId}`, ref]));
      const domainPhases = [...refs.values()].map((ref) => {
        const phase = plan.mesocycle.domainProgressions.find((item) => item.domain === ref.domain)!.phases.find((item) => item.id === ref.phaseId)!;
        return { domain: ref.domain, phaseId: ref.phaseId, phaseType: phase.phaseType, name: phase.name };
      });
      return { nextTrainingDay: { occurrenceId: next.occurrenceId, scheduledDate: next.scheduledDate, dayOfWeek: mondayWeekday(next.scheduledDate), weekNumber: next.weekNumber, domainPhases, existingSessions, revision: this.repository.scheduleRevision(this.ownerId), timezone: profile.timezone }, reasonCode: null };
    }
    return { nextTrainingDay: null, reasonCode: "PLAN_ENDED" };
  }

  getCalendar(value: { from?: string; to?: string } = {}) {
    const from = value.from === undefined ? undefined : dateSchema.parse(value.from);
    const to = value.to === undefined ? undefined : dateSchema.parse(value.to);
    if (from !== undefined && to !== undefined && from > to) throw new AthriaError("INVALID_CALENDAR_WINDOW", "The calendar start date must not be after the end date.");
    const revision = this.repository.scheduleRevision(this.ownerId);
    return this.repository.listCurrentPlannedSessions(this.ownerId)
      .filter((session) => (from === undefined || session.scheduledDate >= from) && (to === undefined || session.scheduledDate <= to))
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || a.order - b.order)
      .map((session) => ({ id: session.id, occurrenceId: session.occurrenceId, revision, scheduledDate: session.scheduledDate, order: session.order, weekNumber: session.weekNumber, phaseRefs: session.phaseRefs, templateRef: session.templateRef, name: session.name, intent: session.intent, durationMinutes: session.durationMinutes, recoveryDemand: session.recoveryDemand, keySession: session.keySession, progressionNote: session.progressionNote, schedulingRationale: session.schedulingRationale, status: session.status, components: session.components, legacySnapshot: session.legacySnapshot, overrideReason: session.overrideReason }));
  }

  updatePlannedSession(id: string, value: unknown) {
    const input = plannedSessionActionSchema.parse(value) as PlannedSessionAction;
    const plan = this.repository.getCurrentPlan(this.ownerId);
    if (!plan) throw new AthriaError("NO_CURRENT_PLAN", "There is no current plan.", 409);
    const sessions = this.repository.listCurrentPlannedSessions(this.ownerId);
    const current = sessions.find((session) => session.id === id);
    if (!current) throw new AthriaError("PLANNED_SESSION_NOT_FOUND", "The planned session was not found.", 404);
    if (current.status !== "planned") throw new AthriaError("PLANNED_SESSION_ALREADY_RESOLVED", "Completed or skipped sessions cannot be changed.", 409);
    const timestamp = this.now().toISOString();
    let updates: PlannedSession[];
    if (input.action === "complete") {
      updates = [{ ...current, status: "completed", completedAt: timestamp, completionSource: "manual", updatedAt: timestamp }];
    } else if (input.action === "skip") {
      updates = [{ ...current, status: "skipped", updatedAt: timestamp }];
    } else {
      const sourceDate = current.scheduledDate;
      const delta = dayDifference(sourceDate, input.scheduledDate);
      if (delta <= 0) throw new AthriaError("INVALID_MOVE_DATE", "Move the training day to a later date.");
      if (plan.mesocycle.schedule.kind !== "interval" && sessions.some((session) => session.status === "planned" && session.occurrenceId !== current.occurrenceId && session.scheduledDate === input.scheduledDate)) throw new AthriaError("TRAINING_DAY_CONFLICT", "Another planned training day already uses that date.", 409);
      const planEnd = addDays(plan.effectiveStartDate, plan.mesocycle.durationWeeks * 7 - 1);
      updates = [current].map((session) => {
        const scheduledDate = input.scheduledDate;
        if (scheduledDate > planEnd) throw new AthriaError("MOVE_OUTSIDE_PLAN", "The moved training day falls after the plan ends.", 409);
        const elapsed = dayDifference(plan.effectiveStartDate, scheduledDate); const weekNumber = Math.floor(elapsed / 7) + 1;
        return { ...session, occurrenceId: crypto.randomUUID(), scheduledDate, weekNumber, phaseRefs: phaseRefsForSession(plan, weekNumber, session.components), updatedAt: timestamp };
      });
      const proposed = new Map(updates.map((session) => [session.id, session]));
      const proposedSessions = sessions.map((session) => proposed.get(session.id) ?? session);
      if (!plannedDatesFollowProfile(this.getProfile(), plan, proposedSessions)) throw new AthriaError("PROFILE_TRAINING_RHYTHM", "The moved training day would break your Profile training rhythm.", 409);
      const highDates = [...new Set(proposedSessions.filter((session) => session.status !== "skipped" && session.recoveryDemand === "high").map((session) => session.scheduledDate))].sort();
      const required = this.getProfile().explicitRecoveryHours;
      if (required !== null) for (let index = 1; index < highDates.length; index += 1) if (Math.abs(dayDifference(highDates[index - 1]!, highDates[index]!)) * 24 < required) throw new AthriaError("EXPLICIT_RECOVERY_INTERVAL", "The moved training day is too close to another high-recovery-demand session.", 409);
    }
    try { return this.repository.updateCurrentPlannedSessions({ ownerId: this.ownerId, expectedRevision: input.expectedRevision, mode: input.action, sessions: updates }); }
    catch (error) { if (error instanceof Error && error.message === "PLANNED_SESSION_REVISION_CONFLICT") throw new AthriaError(error.message, "The planned sessions changed. Refresh and try again.", 409); throw error; }
  }

  private buildNextTrainingDaySessions(raw: unknown) {
    const input = nextTrainingDayWriteSchema.parse(raw) as NextTrainingDayWrite;
    const next = this.getNextTrainingDay();
    if (!next.nextTrainingDay) throw new AthriaError(next.reasonCode ?? "NO_NEXT_TRAINING_DAY", "There is no available next training day.", 409);
    if (next.nextTrainingDay.scheduledDate !== input.scheduledDate) throw new AthriaError("NEXT_TRAINING_DAY_CHANGED", "Refresh the next training day before saving sessions.", 409);
    if (next.nextTrainingDay.revision !== input.expectedRevision) throw new AthriaError("PLANNED_SESSION_REVISION_CONFLICT", "The planned sessions changed. Refresh and confirm the update again.", 409);
    const plan = this.repository.getCurrentPlan(this.ownerId)!;
    const timestamp = this.now().toISOString();
    const ids = new Set<string>();
    const sessions = input.sessions.map((item, order): PlannedSession => {
      if (ids.has(item.id)) throw new AthriaError("DUPLICATE_PLANNED_SESSION_ID", "Session IDs must be unique.");
      ids.add(item.id);
      this.assertTemplateReferences({ ...plan.mesocycle, weeks: [{ weekNumber: next.nextTrainingDay!.weekNumber, focus: null, sessions: [{ ...item, scheduledDate: input.scheduledDate, order }] }] });
      return plannedSessionSchema.parse({
        ...item, occurrenceId: next.nextTrainingDay!.occurrenceId, ownerId: this.ownerId, planRevision: plan.revision, scheduledDate: input.scheduledDate, order,
        weekNumber: next.nextTrainingDay!.weekNumber, phaseRefs: phaseRefsForSession(plan, next.nextTrainingDay!.weekNumber, item.components), exerciseOverrides: [], notes: item.notes, overrideReason: item.overrideReason ?? null,
        status: "planned", completedTrainingSessionId: null, completedAt: null, completionSource: null, createdAt: timestamp, updatedAt: timestamp,
      });
    });
    if (this.getProfile().explicitRecoveryHours !== null && sessions.some((session) => session.recoveryDemand === "high")) {
      const otherHighDates = this.repository.listCurrentPlannedSessions(this.ownerId).filter((session) => session.recoveryDemand === "high" && session.status !== "skipped" && session.scheduledDate !== input.scheduledDate).map((session) => session.scheduledDate);
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
    const result = this.buildNextTrainingDaySessions(input);
    try {
      return this.repository.saveCurrentPlannedSessions({ ownerId: this.ownerId, ...result.input, sessions: result.sessions });
    } catch (error) {
      if (error instanceof Error && error.message === "PLANNED_SESSION_REVISION_CONFLICT") throw new AthriaError(error.message, "The planned sessions changed. Refresh and confirm the update again.", 409);
      if (error instanceof Error && error.message === "COMPLETED_SESSION_CANNOT_BE_REPLACED") throw new AthriaError(error.message, "Completed or skipped sessions cannot be replaced.", 409);
      throw error;
    }
  }

  private reconcileImportedSessions(sessions: TrainingSession[]): void {
    const plan = this.repository.getCurrentPlan(this.ownerId);
    if (!plan) return;
    const timezone = this.getProfile().timezone;
    const byDate = new Map<string, TrainingSession[]>();
    for (const session of sessions.filter((item) => item.status === "completed")) {
      const date = localDate(new Date(session.startAt), timezone);
      byDate.set(date, [...(byDate.get(date) ?? []), session]);
    }
    for (const [date, completed] of byDate) {
      const planned = this.repository.listCurrentPlannedSessions(this.ownerId, date).filter((item) => item.status === "planned");
      if (completed.length !== 1 || planned.length !== 1) continue;
      const actual = completed[0]!;
      const target = planned[0]!;
      const targetDomains = target.components.map((component) => component.domain.value).filter((domain) => domain !== null);
      const compatible = targetDomains.some((domain) => sessionDomains(actual).includes(domain));
      if (compatible) this.repository.completePlannedSession(target.id, actual.id, this.ownerId);
    }
  }

  proposeProfileUpdate(value: unknown) {
    const input = z.object({ clientRequestId: z.string().min(1), patch: z.record(z.string(), z.unknown()), rationale: z.string().min(1).max(4000) }).strict().parse(value);
    const patch = { ...input.patch };
    for (const key of ["priority", "weeklyStrengthSessions", "weeklyEnduranceSessions", "trainingDays"]) delete patch[key];
    athleteProfileSchema.partial().parse(patch);
    return this.repository.saveProfileUpdateProposal({ id: crypto.randomUUID(), ownerId: this.ownerId, ...input, patch, baseSnapshotHash: stableHash(this.getProfile()), createdAt: this.now().toISOString() });
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
      read("get_training_summary", "Get domain-separated recent training metrics.", z.object({ days: z.number().int().min(1).max(365).default(7) }), (input) => this.getTrainingSummary((input as { days: number }).days)),
      read("get_current_plan", "Get the user's single editable current mesocycle.", z.object({}), () => this.getCurrentPlan()),
      read("list_session_templates", "List built-in read-only and local user-owned single-domain training archetypes. Templates never contain an executable dose.", z.object({}), () => this.listTemplates()),
      read("get_session_template", "Get one stable single-domain training archetype by ID.", z.object({ id: z.string().min(1) }), (input) => this.getTemplate((input as { id: string }).id)),
      read("get_exercise_catalog", "Get normalized exercise definitions.", z.object({}), () => this.repository.listExercises()),
      read("get_training_taxonomy", "Get the authoritative versioned template vocabularies. Read this before writing a template and use only returned movement and muscle IDs.", z.object({}), () => this.getTrainingTaxonomy()),
      read("calculate_training_metrics", "Calculate deterministic strength and endurance metrics.", z.object({ days: z.number().int().min(1).max(365).default(90) }), (input) => calculateTrainingMetrics(this.listSessions((input as { days: number }).days))),
      read("estimate_1rm", "Estimate 1RM with the versioned Epley formula.", z.object({ load: z.number().positive(), reps: z.number().int().min(1).max(12), unit: z.enum(["kg", "lb"]) }), (input) => { const value = input as { load: number; reps: number; unit: "kg" | "lb" }; return estimateOneRepMax(value.load, value.reps, value.unit); }),
      read("calculate_heart_rate_zones", "Calculate five zones from an explicit maximum heart rate.", z.object({ maxHeartRate: z.number().int().min(80).max(240) }), (input) => calculateHeartRateZones((input as { maxHeartRate: number }).maxHeartRate)),
      read("evaluate_double_progression", "Evaluate a configured double-progression prescription.", z.object({ completedReps: z.array(z.number().int().min(0)).min(1), repMin: z.number().int().min(1), repMax: z.number().int().min(1), currentLoad: z.number().min(0), loadIncrement: z.number().positive(), unit: z.enum(["kg", "lb"]), rpeValues: z.array(z.number().min(0).max(10)).optional(), rpeCeiling: z.number().min(1).max(10).optional() }), (input) => evaluateDoubleProgression(input as Parameters<typeof evaluateDoubleProgression>[0])),
      read("evaluate_rpe_autoregulation", "Evaluate a load adjustment only when RPE is supplied.", z.object({ actualRpe: z.number().min(0).max(10).nullable(), targetRpe: z.number().min(1).max(10), load: z.number().min(0), increment: z.number().positive(), unit: z.enum(["kg", "lb"]) }), (input) => evaluateRpeAutoregulation(input as Parameters<typeof evaluateRpeAutoregulation>[0])),
      read("evaluate_progression", "Evaluate the MVP progression policy.", z.object({ completedReps: z.array(z.number().int().min(0)).min(1), repMin: z.number().int().min(1), repMax: z.number().int().min(1), currentLoad: z.number().min(0), loadIncrement: z.number().positive(), unit: z.enum(["kg", "lb"]) }), (input) => evaluateDoubleProgression(input as Parameters<typeof evaluateDoubleProgression>[0])),
      read("find_exercise_candidates", "Filter exercises and return explicit exclusion reasons.", z.object({ movement: z.string().optional(), muscles: z.array(z.string()).optional(), equipment: z.array(z.string()).optional() }), (input) => findExerciseCandidates(this.getProfile(), this.repository.listExercises(), input as { movement?: string; muscles?: string[]; equipment?: string[] })),
      read("validate_current_plan", "Resolve template-library references and validate a candidate current mesocycle.", currentPlanWriteSchema, (input) => this.validateCurrentPlan(input)),
      read("check_training_constraints", "Return blocker, advisory, and informational results for a candidate current mesocycle.", currentPlanWriteSchema, (input) => this.validateCurrentPlan(input).results),
      read("get_next_training_day", "Get the first unfinished scheduled training day on or after a local date.", z.object({ onOrAfterDate: dateSchema.optional() }).strict(), (input) => this.getNextTrainingDay(input as { onOrAfterDate?: string })),
      read("list_planned_sessions", "List planned sessions across the current plan, optionally filtered by an inclusive scheduledDate window.", z.object({ from: dateSchema.optional(), to: dateSchema.optional() }).strict(), (input) => this.getCalendar(input as { from?: string; to?: string })),
      read("validate_next_training_day_sessions", "Validate one or more sessions for the current next training day without saving them.", nextTrainingDayWriteSchema, (input) => this.validateNextTrainingDaySessions(input)),
      { name: "create_session_template", description: "Create a local reusable single-domain archetype. Read get_training_taxonomy first. Do not include exercises, sets, reps, distance, duration, load, or recovery demand.", inputSchema: sessionTemplateCreateSchema, readOnly: false, idempotent: true, handler: (input) => this.createTemplate(input) },
      { name: "update_session_template", description: "Update a local archetype. Built-ins are read-only and template edits never rewrite Weekly Sessions.", inputSchema: sessionTemplateUpdateSchema, readOnly: false, idempotent: false, handler: (input) => this.updateTemplate(input) },
      { name: "delete_session_template", description: "Delete an unreferenced template only after the user explicitly requests deletion.", inputSchema: z.object({ id: z.string().min(1), expectedRevision: z.number().int().positive(), confirmedExplicitRequest: z.literal(true) }), readOnly: false, idempotent: false, handler: (input) => { const value = input as { id: string; expectedRevision: number }; return this.deleteTemplate(value.id, value.expectedRevision); } },
      { name: "save_current_plan", description: "Validate and directly replace the single current mesocycle. No approval step follows.", inputSchema: currentPlanWriteSchema, readOnly: false, idempotent: false, handler: (input) => this.saveCurrentPlan(input) },
      { name: "save_next_training_day_sessions", description: "After explicit confirmation, append or replace complete executable Session prescriptions on the next training day. A templateRef is optional provenance and never supplies missing fields.", inputSchema: nextTrainingDayWriteSchema, readOnly: false, idempotent: true, handler: (input) => this.saveNextTrainingDaySessions(input) },
      { name: "update_planned_session", description: "Complete, skip, or move the current planned training occurrence after explicit user confirmation.", inputSchema: z.object({ id: z.string().min(1), update: plannedSessionActionSchema }).strict(), readOnly: false, idempotent: false, handler: (input) => { const value = input as { id: string; update: PlannedSessionAction }; return this.updatePlannedSession(value.id, value.update); } },
      { name: "propose_profile_update", description: "Create an idempotent profile update proposal for Dashboard approval.", inputSchema: z.object({ clientRequestId: z.string().min(1), patch: athleteProfileSchema.partial().loose(), rationale: z.string().min(1).max(4000) }), readOnly: false, idempotent: true, handler: (input) => this.proposeProfileUpdate(input) },
    ];
  }
}
