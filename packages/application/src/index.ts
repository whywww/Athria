import * as z from "zod";
import {
  calculateHeartRateZones,
  calculateTrainingMetrics,
  estimateOneRepMax,
  evaluateDoubleProgression,
  evaluateRpeAutoregulation,
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
  equipmentCategories,
  equipmentTypeSchema,
  mesocycleSchema,
  movementPatternSchema,
  movementPatternTaxonomy,
  muscleGroupSchema,
  muscleTaxonomy,
  nextTrainingDayWriteSchema,
  plannedSessionSchema,
  plannedSessionActionSchema,
  personalInformationWriteSchema,
  profileUpdateSchema,
  sessionTemplateSchema,
  sessionTemplateCreateSchema,
  sessionTemplateUpdateSchema,
  trainingSessionWriteSchema,
  trainingSessionSchema,
  wellnessPatchSchema,
  wellnessRecordSchema,
  type AthleteProfile,
  type BuiltinSessionTemplate,
  type CurrentPlan,
  type CurrentPlanWrite,
  type PhaseRef,
  type PlanValidation,
  type NextTrainingDayWrite,
  type PlannedSession,
  type PlannedSessionAction,
  type PersonalInformationWrite,
  type SessionTemplate,
  type StoredSessionTemplate,
  type TrainingSession,
  type WellnessPatch,
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

const blockerSummaryFor = (validation: PlanValidation) => ({
  valid: validation.valid,
  blockers: validation.results.filter((item) => item.enforcement === "blocker" && (item.status === "fail" || item.status === "unknown")).length,
  advisories: validation.results.filter((item) => item.enforcement === "advisory").length,
  blockingDataGaps: validation.dataGaps.filter((gap) => gap.blocking).length,
});

const blockerFailureMessage = (validation: PlanValidation): string => {
  const failed = validation.results.filter((item) => item.enforcement === "blocker" && (item.status === "fail" || item.status === "unknown"));
  const reasons = [...new Set(failed.map((item) => `${item.reasonCode}:${item.status}`))].slice(0, 5);
  return `Plan has ${failed.length} blocking issue(s)${reasons.length ? ` (${reasons.join(", ")})` : ""}. Call validate_current_plan for the full report.`;
};

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
const localNoon = (date: string, timeZone: string): Date => {
  const target = Date.parse(`${date}T12:00:00.000Z`);
  let instant = target;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = formatter.formatToParts(new Date(instant));
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const represented = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
    instant += target - represented;
  }
  return new Date(instant);
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

  constructor(readonly repository: AthriaRepository, readonly ownerId = "local-user", readonly now: () => Date = () => new Date()) {}

  getProfile(): AthleteProfile { return this.repository.getProfile(this.ownerId); }
  saveProfile(value: unknown): AthleteProfile { return this.repository.saveProfile(athleteProfileSchema.parse(value)); }
  listSessions(days = 90) { return this.repository.listSessions(this.ownerId, new Date(this.now().getTime() - days * 86_400_000).toISOString()).map((session) => ({ ...session, domains: sessionDomains(session), missingFields: sessionDomains(session).length ? session.missingFields : [...new Set([...session.missingFields, "domains"])] })); }
  snapshotHash(): string { return stableHash({ profile: this.getProfile(), sessions: this.listSessions(90), wellness: this.listWellness(42) }); }
  profileHash(): string { return stableHash(this.getProfile()); }

  updateProfile(value: unknown): AthleteProfile {
    const input = profileUpdateSchema.parse(value);
    if (input.expectedProfileHash !== this.profileHash()) throw new AthriaError("INPUT_SNAPSHOT_CHANGED", "The athlete profile changed. Refresh before applying the confirmed update.", 409);
    return this.repository.saveProfile(athleteProfileSchema.parse({ ...this.getProfile(), ...input.patch, ownerId: this.ownerId }));
  }

  getPersonalInformation() {
    const profile = this.getProfile();
    const today = localDate(this.now(), profile.timezone);
    const wellness = this.repository.listWellness(this.ownerId);
    const latestWeight = wellness.find((record) => record.fields.weightKg?.value != null);
    const state = { profile, latestWeight: latestWeight ? { weightKg: latestWeight.fields.weightKg!.value, weightDate: latestWeight.day } : { weightKg: null, weightDate: null }, todayWellness: this.repository.getWellness(this.ownerId, today) };
    return { preferredName: profile.preferredName, gender: profile.gender, heightCm: profile.heightCm, birthDate: profile.birthDate, unitSystem: profile.unitSystem, ...state.latestWeight, snapshotHash: stableHash(state) };
  }

  savePersonalInformation(value: unknown) {
    const input = personalInformationWriteSchema.parse(value) as PersonalInformationWrite;
    return this.repository.sqlite.transaction(() => {
      if (input.expectedSnapshotHash !== this.getPersonalInformation().snapshotHash) throw new AthriaError("INPUT_SNAPSHOT_CHANGED", "Personal information changed. Refresh before saving.", 409);
      const profile = this.getProfile();
      this.repository.saveProfile(athleteProfileSchema.parse({ ...profile, preferredName: input.preferredName, gender: input.gender, heightCm: input.heightCm, birthDate: input.birthDate, unitSystem: input.unitSystem ?? profile.unitSystem }));
      if ("weightKg" in input) {
        const day = localDate(this.now(), profile.timezone);
        const current = this.repository.getWellness(this.ownerId, day);
        const fields = { ...(current?.fields ?? {}) } as Record<string, unknown>;
        if (input.weightKg === null) delete fields.weightKg;
        else fields.weightKg = { value: input.weightKg, source: "user", updatedAt: this.now().toISOString() };
        const updatedAt = this.now().toISOString();
        this.repository.saveWellness(wellnessRecordSchema.parse({ ownerId: this.ownerId, day, fields, updatedAt }));
      }
      return this.getPersonalInformation();
    }).immediate();
  }

  getTrainingState() {
    const sessions = this.listSessions(90);
    return { asOf: this.now().toISOString(), inputSnapshotHash: this.snapshotHash(), personalInformation: this.getPersonalInformation(), metrics: calculateTrainingMetrics(sessions), wellness: this.listWellness(42), dataGaps: [] };
  }

  getTrainingSummary(days = 7, from?: string, to?: string) {
    const start = from === undefined ? undefined : dateSchema.parse(from);
    const end = to === undefined ? undefined : dateSchema.parse(to);
    if (start !== undefined && end !== undefined && start > end) throw new AthriaError("INVALID_SUMMARY_WINDOW", "The summary start date must not be after the end date.");
    const profile = this.getProfile();
    const lookbackDays = start ? Math.max(days, dayDifference(start, localDate(this.now(), profile.timezone)) + 2) : days;
    const sessions = this.listSessions(lookbackDays).filter((session) => {
      const day = localDate(new Date(session.startAt), session.timezone ?? profile.timezone);
      return (start === undefined || day >= start) && (end === undefined || day <= end);
    });
    const durationMinutesByDomain = Object.fromEntries(domainSchema.options.map((domain) => [domain, sessions.filter((item) => item.domains.includes(domain)).reduce((total, item) => total + item.durationMinutes, 0)]));
    const sports = new Map<string, { name: string; sessionCount: number; durationMinutes: number }>();
    for (const session of sessions.filter((item) => item.domains.includes("sport_skill") && item.sport?.trim())) {
      const name = session.sport!.trim();
      const current = sports.get(name) ?? { name, sessionCount: 0, durationMinutes: 0 };
      current.sessionCount += 1;
      current.durationMinutes += session.durationMinutes;
      sports.set(name, current);
    }
    return {
      periodDays: days,
      sessionCount: sessions.length,
      totalDurationMinutes: sessions.reduce((total, session) => total + session.durationMinutes, 0),
      byDomain: Object.fromEntries(domainSchema.options.map((domain) => [domain, sessions.filter((item) => item.domains.includes(domain)).length])),
      durationMinutesByDomain,
      sports: [...sports.values()].sort((left, right) => right.durationMinutes - left.durationMinutes || left.name.localeCompare(right.name)),
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
    return { planSchemaVersion: PLAN_SCHEMA_VERSION, taxonomyVersion: TAXONOMY_VERSION, templateCatalogVersion: TEMPLATE_CATALOG_VERSION, domains: domainSchema.options, equipmentCategories, strength: { movementPatterns: movementPatternTaxonomy, muscleGroups: muscleTaxonomy, equipment: equipmentTypeSchema.options }, templateVariables: { strength: ["exercise_selection", "sets", "repetitions", "duration", "load", "rpe", "rir", "rest", "tempo", "alternatives"], endurance: ["repetitions", "duration", "distance", "pace", "heart_rate_zone", "power", "cadence", "rpe", "talk_test", "terrain", "strides", "recovery_mode"], sport_skill: ["drill", "participants", "position", "duration", "intensity", "instructions"], recovery: ["body_region", "movement", "duration", "intensity", "instructions"], mind_body: ["technique", "duration", "intensity", "instructions"] }, factSources: ["structured_source", "exact_alias", "ai_inferred", "user_confirmed"], aiHardConfidence: AI_HARD_CONFIDENCE };
  }

  validateCurrentPlan(value: unknown): PlanValidation {
    const input = currentPlanWriteSchema.parse(value);
    this.assertTemplateReferences(input.mesocycle);
    return validatePlan(this.getProfile(), { mesocycle: input.mesocycle, effectiveStartDate: input.effectiveStartDate }, this.now());
  }

  listTemplates() {
    const user = this.repository.listTemplates(this.ownerId);
    const dismissed = new Set(this.repository.listDismissedTemplateIds(this.ownerId));
    const userById = new Map(user.map((row) => [row.id, row]));
    // A user row with a built-in ID is the derived replacement of that built-in: it keeps the
    // built-in's catalog slot instead of being appended. Dismissals hide removed built-ins.
    const merged = builtinSessionTemplates.flatMap<BuiltinSessionTemplate | StoredSessionTemplate>((item) => {
      const replacement = userById.get(item.id);
      if (replacement) return [replacement];
      return dismissed.has(item.id) ? [] : [item];
    });
    const builtinIds = new Set(builtinSessionTemplates.map((item) => item.id));
    return [...merged, ...user.filter((row) => !builtinIds.has(row.id))];
  }
  getTemplate(id: string) {
    const template = this.repository.getTemplate(id, this.ownerId) ?? builtinSessionTemplates.find((item) => item.id === id);
    if (!template) throw new AthriaError("TEMPLATE_NOT_FOUND", "The session template was not found.", 404);
    return template;
  }
  createTemplate(value: unknown) {
    const parsed = sessionTemplateCreateSchema.parse(value);
    const { clientRequestId: _request, ...candidate } = parsed;
    const template = sessionTemplateSchema.parse(candidate);
    try { return this.repository.createTemplate(template, this.ownerId); }
    catch (error) { if (error instanceof Error && error.message === "TEMPLATE_ALREADY_EXISTS") throw new AthriaError(error.message, "A template with this ID already exists.", 409); throw error; }
  }
  updateTemplate(value: unknown) {
    const input = sessionTemplateUpdateSchema.parse(value);
    try { return { template: this.repository.updateTemplate(input.template, input.expectedRevision, this.ownerId), impact: { affectedCount: 0, updatedCount: 0 } }; }
    catch (error) { if (error instanceof Error && ["TEMPLATE_NOT_FOUND", "REVISION_CONFLICT"].includes(error.message)) throw new AthriaError(error.message, error.message === "REVISION_CONFLICT" ? "The template changed. Refresh and try again." : "The session template was not found.", error.message === "REVISION_CONFLICT" ? 409 : 404); throw error; }
  }
  deleteTemplate(id: string, expectedRevision?: number) {
    const stored = this.repository.getTemplate(id, this.ownerId);
    // Deleting a built-in that has no derived row only hides it; the code-defined original
    // remains and existing plan references keep resolving against the catalog.
    if (!stored && builtinSessionTemplates.some((item) => item.id === id)) { this.repository.dismissTemplate(id, this.ownerId); return { deleted: true, id }; }
    const current = this.repository.getCurrentPlan(this.ownerId);
    const references = current?.mesocycle.weeks.flatMap((week) => week.sessions.filter((session) => session.templateRef?.source === "user" && session.templateRef.id === id).map((session) => session.id)) ?? [];
    if (references.length) throw new AthriaError("TEMPLATE_IN_USE", "Remove this template reference from the current plan before deleting it.", 409);
    if (expectedRevision === undefined) throw new AthriaError("REVISION_REQUIRED", "expectedRevision is required to delete a stored template.", 400);
    try { this.repository.deleteTemplate(id, expectedRevision, this.ownerId); }
    catch (error) { if (error instanceof Error && ["TEMPLATE_NOT_FOUND", "REVISION_CONFLICT"].includes(error.message)) throw new AthriaError(error.message, error.message === "REVISION_CONFLICT" ? "The template changed. Refresh and try again." : "The session template was not found.", error.message === "REVISION_CONFLICT" ? 409 : 404); throw error; }
    // Removing the derived replacement of a built-in keeps that built-in hidden.
    if (builtinSessionTemplates.some((item) => item.id === id)) this.repository.dismissTemplate(id, this.ownerId);
    return { deleted: true, id };
  }

  getCurrentPlan() { return this.repository.getCurrentPlan(this.ownerId); }

  private sessionsForPlan(plan: CurrentPlan, onOrAfterDate: string): PlannedSession[] {
    const timestamp = this.now().toISOString();
    const occurrenceByDate = new Map<string, string>();
    return [...plan.mesocycle.weeks].sort((a, b) => a.weekNumber - b.weekNumber).flatMap((week) => [...week.sessions].sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || a.order - b.order).filter((session) => session.scheduledDate >= onOrAfterDate).map((session) => {
      const occurrenceId = occurrenceByDate.get(session.scheduledDate) ?? crypto.randomUUID();
      occurrenceByDate.set(session.scheduledDate, occurrenceId);
      return plannedSessionSchema.parse({ ...session, occurrenceId, ownerId: this.ownerId, planRevision: plan.revision, weekNumber: week.weekNumber, phaseRefs: phaseRefsForSession(plan, week.weekNumber, session.components), exerciseOverrides: [], notes: "", overrideReason: null, completedTrainingSessionId: null, completedAt: null, completionSource: null, createdAt: timestamp, updatedAt: timestamp });
    }));
  }

  saveCurrentPlan(value: unknown) {
    const input = currentPlanWriteSchema.parse(value);
    if (input.ownerId !== this.ownerId) throw new AthriaError("OWNER_MISMATCH", "The plan owner does not match the local athlete.", 403);
    if (input.inputSnapshotHash && input.inputSnapshotHash !== this.snapshotHash()) throw new AthriaError("INPUT_SNAPSHOT_CHANGED", "Training state changed. Refresh and revise the plan.", 409);
    this.assertTemplateReferences(input.mesocycle);
    const validation = validatePlan(this.getProfile(), { mesocycle: input.mesocycle, effectiveStartDate: input.effectiveStartDate }, this.now());
    if (!validation.valid) throw new AthriaError("PLAN_HAS_BLOCKERS", blockerFailureMessage(validation), 409);
    const timestamp = this.now().toISOString();
    const { expectedRevision, ...candidate } = input;
    const plan = currentPlanSchema.parse({ ...candidate, revision: expectedRevision + 1, updatedAt: timestamp });
    const existing = this.repository.listCurrentPlannedSessions(this.ownerId);
    const terminalIds = new Set(existing.filter((session) => session.status !== "planned").map((session) => session.id));
    const desired = this.sessionsForPlan(plan, plan.effectiveStartDate).filter((session) => !terminalIds.has(session.id));
    const desiredIds = new Set(desired.map((session) => session.id));
    const deleted = existing.filter((session) => session.status === "planned" && !desiredIds.has(session.id)).map((session) => session.id);
    try { return { plan: this.repository.saveCurrentPlan(plan, input.expectedRevision, deleted, desired), validation, impact: { affectedCount: existing.length, updatedCount: desired.length, deletedCount: deleted.length, legacySkippedCount: 0 } }; }
    catch (error) { if (error instanceof Error && error.message === "REVISION_CONFLICT") throw new AthriaError(error.message, "The current plan changed. Refresh and try again.", 409); if (error instanceof Error && error.message === "WRITE_BUSY") throw new AthriaError(error.message, "The database is busy. Retry the save.", 503); throw error; }
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
    const today = localDate(this.now(), this.getProfile().timezone);
    return this.repository.listCurrentPlannedSessions(this.ownerId)
      .filter((session) => (from === undefined || session.scheduledDate >= from) && (to === undefined || session.scheduledDate <= to))
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || a.order - b.order)
      .map((session) => ({ id: session.id, occurrenceId: session.occurrenceId, revision, scheduledDate: session.scheduledDate, order: session.order, weekNumber: session.weekNumber, phaseRefs: session.phaseRefs, templateRef: session.templateRef, name: session.name, intent: session.intent, durationMinutes: session.durationMinutes, recoveryDemand: session.recoveryDemand, keySession: session.keySession, progressionNote: session.progressionNote, schedulingRationale: session.schedulingRationale, status: session.status, displayState: session.status === "completed" ? "completed" as const : session.status === "skipped" ? "skipped" as const : session.scheduledDate < today ? "unrecorded" as const : "scheduled" as const, components: session.components, legacySnapshot: session.legacySnapshot, overrideReason: session.overrideReason, completedTrainingSessionId: session.completedTrainingSessionId, completedAt: session.completedAt, completionSource: session.completionSource, match: session.match }));
  }

  updatePlannedSession(id: string, value: unknown) {
    const input = plannedSessionActionSchema.parse(value) as PlannedSessionAction;
    const plan = this.repository.getCurrentPlan(this.ownerId);
    if (!plan) throw new AthriaError("NO_CURRENT_PLAN", "There is no current plan.", 409);
    const sessions = this.repository.listCurrentPlannedSessions(this.ownerId);
    const current = sessions.find((session) => session.id === id);
    if (!current) throw new AthriaError("PLANNED_SESSION_NOT_FOUND", "The planned session was not found.", 404);
    const timestamp = this.now().toISOString();
    let updates: PlannedSession[];
    if (input.action === "complete") {
      if (current.status !== "planned") throw new AthriaError("PLANNED_SESSION_ALREADY_RESOLVED", "Completed or skipped sessions cannot be added again.", 409);
      if (current.scheduledDate > localDate(this.now(), this.getProfile().timezone)) throw new AthriaError("FUTURE_SESSION_CANNOT_BE_COMPLETED", "Move this planned session to the date you completed it before adding it as a completed workout.", 409);
      const startAt = localNoon(current.scheduledDate, this.getProfile().timezone); const endAt = new Date(startAt.getTime() + current.durationMinutes * 60_000);
      const session = this.recordTrainingSession({ name: current.name, modality: current.components.some((item) => item.domain.value === "strength") ? "strength" : current.components.some((item) => item.domain.value === "endurance") ? "endurance" : "recovery", domains: current.components.map((item) => item.domain.value).filter(Boolean), sport: null, startAt: startAt.toISOString(), endAt: endAt.toISOString(), durationMinutes: current.durationMinutes, timezone: this.getProfile().timezone, plannedSessionId: current.id, timePrecision: "date_only", strengthSets: [], endurance: null, missingFields: ["actual start time", "exercise details"] });
      return { sessions: this.repository.listCurrentPlannedSessions(this.ownerId).filter((item) => item.id === current.id), revision: plan.revision, trainingSession: session };
    } else if (input.action === "skip") {
      if (current.status !== "planned") throw new AthriaError("PLANNED_SESSION_ALREADY_RESOLVED", "Completed or skipped sessions cannot be skipped.", 409);
      updates = [{ ...current, status: "skipped", updatedAt: timestamp }];
    } else if (input.action === "restore") {
      if (current.status !== "skipped") throw new AthriaError("PLANNED_SESSION_NOT_SKIPPED", "Only a skipped planned session can be restored.", 409);
      updates = [{ ...current, status: "planned", updatedAt: timestamp }];
    } else {
      if (current.status !== "planned") throw new AthriaError("PLANNED_SESSION_ALREADY_RESOLVED", "Completed or skipped sessions must be unresolved before they can be moved.", 409);
      const sourceDate = current.scheduledDate;
      if (sourceDate === input.scheduledDate) throw new AthriaError("INVALID_MOVE_DATE", "Choose a different date for the planned session.");
      if (plan.mesocycle.schedule.kind !== "interval" && sessions.some((session) => session.status === "planned" && session.occurrenceId !== current.occurrenceId && session.scheduledDate === input.scheduledDate)) throw new AthriaError("TRAINING_DAY_CONFLICT", "Another planned training day already uses that date.", 409);
      const planEnd = addDays(plan.effectiveStartDate, plan.mesocycle.durationWeeks * 7 - 1);
      updates = [current].map((session) => {
        const scheduledDate = input.scheduledDate;
        if (scheduledDate < plan.effectiveStartDate || scheduledDate > planEnd) throw new AthriaError("MOVE_OUTSIDE_PLAN", "The moved training day must stay within the current plan.", 409);
        const elapsed = dayDifference(plan.effectiveStartDate, scheduledDate); const weekNumber = Math.floor(elapsed / 7) + 1;
        return { ...session, occurrenceId: crypto.randomUUID(), scheduledDate, weekNumber, phaseRefs: phaseRefsForSession(plan, weekNumber, session.components), updatedAt: timestamp };
      });
      const proposed = new Map(updates.map((session) => [session.id, session]));
      const proposedSessions = sessions.map((session) => proposed.get(session.id) ?? session);
      if (!plannedDatesFollowProfile(this.getProfile(), plan, proposedSessions)) throw new AthriaError("PROFILE_TRAINING_RHYTHM", "The moved training day would break your Profile training rhythm.", 409);
      const highDates = [...new Set(proposedSessions.filter((session) => session.status !== "skipped" && session.recoveryDemand === "high").map((session) => session.scheduledDate))].sort();
      const required = this.getProfile().explicitRecoveryDays;
      if (required !== null) for (let index = 1; index < highDates.length; index += 1) if (Math.abs(dayDifference(highDates[index - 1]!, highDates[index]!)) < required) throw new AthriaError("EXPLICIT_RECOVERY_INTERVAL", "The moved training day is too close to another high-recovery-demand session.", 409);
    }
    try { return this.repository.updateCurrentPlannedSessions({ ownerId: this.ownerId, expectedRevision: input.expectedRevision, mode: input.action, sessions: updates, ...((input.action === "skip" || input.action === "move_occurrence") && input.reason ? { reason: input.reason } : {}) }); }
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
    if (this.getProfile().explicitRecoveryDays !== null && sessions.some((session) => session.recoveryDemand === "high")) {
      const otherHighDates = this.repository.listCurrentPlannedSessions(this.ownerId).filter((session) => session.recoveryDemand === "high" && session.status !== "skipped" && session.scheduledDate !== input.scheduledDate).map((session) => session.scheduledDate);
      const closestDays = otherHighDates.length ? Math.min(...otherHighDates.map((date) => Math.abs(dayDifference(date, input.scheduledDate)))) : Infinity;
      if (closestDays < this.getProfile().explicitRecoveryDays!) throw new AthriaError("EXPLICIT_RECOVERY_INTERVAL", "The high-recovery-demand sessions are too close together.", 409);
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

  recordTrainingSession(value: unknown): TrainingSession {
    const input = trainingSessionWriteSchema.parse(value); const id = input.id ?? crypto.randomUUID(); const externalId = input.externalId ?? id;
    const session = trainingSessionSchema.parse({ ...input, id, externalId, ownerId: this.ownerId, source: "manual", status: "completed" });
    this.repository.upsertSessions([session]); return session;
  }

  setTrainingSessionPlanMatch(id: string, value: unknown): TrainingSession {
    const input = z.object({ plannedSessionId: z.string().min(1).nullable(), expectedRevision: z.number().int().min(0), confirmed: z.literal(true) }).strict().parse(value);
    try { return this.repository.setTrainingSessionPlanMatch({ ownerId: this.ownerId, trainingSessionId: id, ...input }); }
    catch (error) {
      const code = error instanceof Error ? error.message : "MATCH_UPDATE_FAILED";
      const messages: Record<string, string> = { NO_CURRENT_PLAN: "There is no current plan.", PLANNED_SESSION_REVISION_CONFLICT: "The plan changed. Refresh and try again.", TRAINING_SESSION_NOT_FOUND: "The workout was not found.", PLANNED_SESSION_NOT_FOUND: "The planned session was not found.", PLANNED_SESSION_SKIPPED: "Restore the skipped session before linking it.", PLAN_WORKOUT_DATE_MISMATCH: "The workout and planned session must be on the same local date." };
      throw new AthriaError(code, messages[code] ?? "The workout-to-plan match could not be updated.", code.endsWith("NOT_FOUND") ? 404 : 409);
    }
  }

  clearTrainingSessionPlanExclusion(id: string, value: unknown): TrainingSession {
    z.object({ confirmed: z.literal(true) }).strict().parse(value);
    try { return this.repository.clearTrainingSessionPlanExclusion(this.ownerId, id); }
    catch (error) { throw new AthriaError(error instanceof Error ? error.message : "MATCH_UPDATE_FAILED", "The workout could not be returned to automatic matching.", 404); }
  }

  updateTrainingSessionType(id: string, value: unknown): TrainingSession {
    const input = z.object({ domain: domainSchema, confirmed: z.literal(true) }).strict().parse(value);
    try { return this.repository.setTrainingSessionTypeOverride(this.ownerId, id, input.domain); }
    catch (error) {
      const code = error instanceof Error ? error.message : "TYPE_UPDATE_FAILED";
      throw new AthriaError(code, code === "TRAINING_SESSION_NOT_FOUND" ? "The workout was not found." : "The workout type could not be updated.", code === "TRAINING_SESSION_NOT_FOUND" ? 404 : 409);
    }
  }

  updateManualTrainingSession(id: string, value: unknown): TrainingSession {
    const input = z.object({ startAt: z.string().datetime({ offset: true }).optional(), durationMinutes: z.number().int().min(1).max(1440).optional(), confirmed: z.literal(true) }).strict().refine((item) => item.startAt !== undefined || item.durationMinutes !== undefined, "Provide a start time or duration.").parse(value);
    try { return this.repository.updateManualTrainingSession({ ownerId: this.ownerId, trainingSessionId: id, ...(input.startAt ? { startAt: input.startAt } : {}), ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}) }); }
    catch (error) {
      const code = error instanceof Error ? error.message : "MANUAL_UPDATE_FAILED";
      throw new AthriaError(code, code === "MANUAL_DATE_CHANGE_REQUIRES_PLAN_MOVE" ? "Move or unlink the planned session before changing the workout date." : "The manual workout details could not be updated.", code === "MANUAL_SOURCE_NOT_FOUND" ? 404 : 409);
    }
  }

  deleteManualTrainingSession(id: string, value: unknown): TrainingSession | null {
    z.object({ confirmed: z.literal(true) }).strict().parse(value);
    try { return this.repository.deleteManualTrainingSession(this.ownerId, id); }
    catch (error) { throw new AthriaError(error instanceof Error ? error.message : "MANUAL_DELETE_FAILED", "The manual workout record could not be removed.", 404); }
  }

  deleteTrainingSession(id: string, value: unknown): { deleted: true } {
    z.object({ confirmed: z.literal(true) }).strict().parse(value);
    try { this.repository.deleteTrainingSession(this.ownerId, id); return { deleted: true }; }
    catch (error) {
      const code = error instanceof Error ? error.message : "TRAINING_SESSION_DELETE_FAILED";
      throw new AthriaError(code, code === "TRAINING_SESSION_NOT_FOUND" ? "The workout was not found." : "The workout could not be deleted.", code === "TRAINING_SESSION_NOT_FOUND" ? 404 : 409);
    }
  }

  listWellness(days = 42) { const since = new Date(this.now().getTime() - days * 86_400_000).toISOString().slice(0, 10); return this.repository.listWellness(this.ownerId, since).map((record) => ({ ...record, snapshotHash: stableHash(record) })); }
  getWellnessDay(day: string) { const record = this.repository.getWellness(this.ownerId, dateSchema.parse(day)); return { record, snapshotHash: record ? stableHash(record) : "new" }; }

  updateWellness(day: string, value: unknown) {
    const input = wellnessPatchSchema.parse(value) as WellnessPatch; const current = this.repository.getWellness(this.ownerId, dateSchema.parse(day));
    const currentHash = current ? stableHash(current) : "new"; if (currentHash !== input.expectedSnapshotHash) throw new AthriaError("INPUT_SNAPSHOT_CHANGED", "Wellness changed. Refresh before applying the confirmed update.", 409);
    const updatedAt = this.now().toISOString(); const fields = { ...(current?.fields ?? {}) } as Record<string, unknown>;
    for (const [key, fieldValue] of Object.entries(input.fields)) if (fieldValue === null) delete fields[key]; else fields[key] = { value: fieldValue, source: input.source, updatedAt };
    return this.repository.saveWellness(wellnessRecordSchema.parse({ ownerId: this.ownerId, day, fields, updatedAt }));
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
    this.repository.recordImportBatch({ ownerId: this.ownerId, source: "hevy", contentHash: preview.contentHash, fileName: preview.fileName, parserVersion: preview.parserVersion, status: preview.errors.length ? "partial" : "committed", data: { counts: preview.counts, errors: preview.errors, unknownColumns: preview.unknownColumns } });
    this.previews.delete(previewToken);
    return counts;
  }

  getHevyImportStatus() {
    const batch = this.repository.latestImportBatch(this.ownerId, "hevy");
    if (!batch) return null;
    const data = batch.data as { counts?: { sessions?: number; sets?: number; rows?: number } };
    return { fileName: batch.fileName, importedAt: batch.createdAt, status: batch.status, counts: data.counts ?? {} };
  }

  getIntervalsSyncStatus() { return this.repository.getConnectionSyncState("intervals", this.ownerId); }

  commitIntervals(payload: Record<"activities" | "events" | "wellness", unknown[] | string>, context: { attemptedAt?: string; rangeStart?: string; rangeEnd?: string } = {}) {
    const normalized = Array.isArray(payload.activities) ? payload.activities.map((item) => normalizeIntervalsActivity(item as Record<string, unknown>, "activities")) : [];
    if (normalized.some((item) => item === null)) throw new AthriaError("INTERVALS_NORMALIZATION_FAILED", "Intervals returned an activity without a valid start time; existing training data was left unchanged.", 502);
    const sessions = normalized.filter((item): item is TrainingSession => item !== null);
    const attemptedAt = context.attemptedAt ?? this.now().toISOString();
    const counts = Array.isArray(payload.activities)
      ? this.repository.replaceSourceSessions({ ownerId: this.ownerId, source: "intervals", sessions, rangeStart: context.rangeStart ?? attemptedAt.slice(0, 10), rangeEnd: context.rangeEnd ?? attemptedAt.slice(0, 10) })
      : { added: 0, updated: 0 };
    const wellnessCount = Array.isArray(payload.wellness) ? this.repository.upsertWellness(this.ownerId, payload.wellness) : 0;
    const errors = Object.fromEntries(Object.entries(payload).filter(([, value]) => typeof value === "string"));
    const activitiesOk = Array.isArray(payload.activities);
    const wellnessOk = Array.isArray(payload.wellness);
    const status: "success" | "partial" | "failed" = activitiesOk && wellnessOk ? "success" : activitiesOk || wellnessOk ? "partial" : "failed";
    const previous = this.getIntervalsSyncStatus();
    const state = this.repository.saveConnectionSyncState({
      source: "intervals", lastAttemptAt: attemptedAt, lastSuccessAt: status === "success" ? attemptedAt : previous?.lastSuccessAt ?? null,
      rangeStart: context.rangeStart ?? attemptedAt.slice(0, 10), rangeEnd: context.rangeEnd ?? attemptedAt.slice(0, 10),
      status, data: { activities: counts, wellnessCount, errors },
    });
    return { ...counts, wellnessCount, errors, sync: state };
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
    const normalizedSessions: Array<{ date: string; session: TrainingSession }> = [];
    const normalizationErrors: Array<{ code: string; message: string }> = [];
    const failedNormalizationDates = new Set<string>();
    for (const record of result.records) {
      try { normalizedSessions.push({ date: String(record.datestr ?? ""), session: normalizeXunjiTraining(record) }); }
      catch (error) { if (/^\d{4}-\d{2}-\d{2}$/.test(String(record.datestr ?? ""))) failedNormalizationDates.add(String(record.datestr)); normalizationErrors.push({ code: "normalization_failed", message: (error instanceof Error ? error.message : String(error)).slice(0, 500) }); }
    }
    const replaceDates = result.successfulDates.filter((date) => !failedNormalizationDates.has(date));
    const replacementSessions = normalizedSessions.filter((item) => replaceDates.includes(item.date));
    const counts = replaceDates.length
      ? this.repository.replaceSourceSessions({ ownerId: this.ownerId, source: "xunji", sessions: replacementSessions.map((item) => item.session), dates: replaceDates, localDates: Object.fromEntries(replacementSessions.map((item) => [item.session.externalId, item.date])) })
      : { added: 0, updated: 0 };
    const errors = [...result.errors, ...normalizationErrors];
    const status = errors.length === 0 ? "success" : result.successfulDates.length > 0 ? "partial" : "failed";
    const previous = this.getXunjiSyncStatus();
    const state = this.repository.saveConnectionSyncState({
      source: "xunji", lastAttemptAt: attemptedAt, lastSuccessAt: result.successfulDates.length ? attemptedAt : previous?.lastSuccessAt ?? null,
      rangeStart: result.rangeStart, rangeEnd: result.rangeEnd, status,
      data: { successfulDays: result.successfulDates.length, failedDays: result.errors.length, records: result.records.length, normalizationFailures: normalizationErrors.length, errors },
    });
    this.repository.recordImportBatch({ ownerId: this.ownerId, source: "xunji", contentHash: stableHash({ rangeStart: result.rangeStart, rangeEnd: result.records.map((record) => record.localid ?? record.start) }), fileName: "Xunji Open API", parserVersion: XUNJI_PARSER_VERSION, status, data: { ...counts, sync: state } });
    return { ...counts, sync: state };
  }

  toolRegistry(): AthriaTool[] {
    const read = (name: string, description: string, inputSchema: z.ZodTypeAny, handler: AthriaTool["handler"]): AthriaTool => ({ name, description, inputSchema, handler, readOnly: true, idempotent: true });
    return [
      read("get_athlete_profile", "Get confirmed local athlete facts, constraints, and the hash required for a confirmed update.", z.object({}), () => ({ ...this.getProfile(), profileHash: this.profileHash() })),
      read("get_training_state", "Get the current state snapshot, metrics, and snapshot hash.", z.object({}), () => this.getTrainingState()),
      read("list_training_sessions", "List normalized training sessions.", z.object({ days: z.number().int().min(1).max(365).default(30) }), (input) => this.listSessions((input as { days: number }).days)),
      read("list_wellness", "List normalized daily wellness and per-field provenance.", z.object({ days: z.number().int().min(1).max(365).default(42) }), (input) => this.listWellness((input as { days: number }).days)),
      read("get_wellness_day", "Get one wellness day and the hash required for a confirmed update; a missing day returns hash 'new'.", z.object({ day: dateSchema }), (input) => this.getWellnessDay((input as { day: string }).day)),
      read("list_xunji_training_sessions", "获取我的训记记录 / List locally synced Xunji training sessions with sync freshness. Credentials are never exposed.", z.object({ days: z.number().int().min(1).max(365).default(30) }), (input) => this.listXunjiSessions((input as { days: number }).days)),
      read("get_xunji_sync_status", "Get the local Athria Devices sync status for 训记/Xunji without exposing its API key.", z.object({}), () => this.getXunjiSyncStatus()),
      read("get_training_summary", "Get domain-separated recent training metrics.", z.object({ days: z.number().int().min(1).max(365).default(7) }), (input) => this.getTrainingSummary((input as { days: number }).days)),
      read("get_current_plan", "Get the user's single editable current mesocycle.", z.object({}), () => this.getCurrentPlan()),
      read("list_session_templates", "List available built-in and local user-owned single-domain training archetypes. Built-ins that were edited or removed are no longer listed. Templates never contain an executable dose.", z.object({}), () => this.listTemplates()),
      read("get_session_template", "Get one stable single-domain training archetype by ID.", z.object({ id: z.string().min(1) }), (input) => this.getTemplate((input as { id: string }).id)),
      read("get_training_taxonomy", "Get the authoritative versioned template vocabularies. Read this before writing a template and use only returned movement and muscle IDs.", z.object({}), () => this.getTrainingTaxonomy()),
      read("calculate_training_metrics", "Calculate deterministic strength and endurance metrics.", z.object({ days: z.number().int().min(1).max(365).default(90) }), (input) => calculateTrainingMetrics(this.listSessions((input as { days: number }).days))),
      read("estimate_1rm", "Estimate 1RM with the versioned Epley formula.", z.object({ load: z.number().positive(), reps: z.number().int().min(1).max(12), unit: z.enum(["kg", "lb"]) }), (input) => { const value = input as { load: number; reps: number; unit: "kg" | "lb" }; return estimateOneRepMax(value.load, value.reps, value.unit); }),
      read("calculate_heart_rate_zones", "Calculate five zones from an explicit maximum heart rate.", z.object({ maxHeartRate: z.number().int().min(80).max(240) }), (input) => calculateHeartRateZones((input as { maxHeartRate: number }).maxHeartRate)),
      read("evaluate_double_progression", "Evaluate a configured double-progression prescription.", z.object({ completedReps: z.array(z.number().int().min(0)).min(1), repMin: z.number().int().min(1), repMax: z.number().int().min(1), currentLoad: z.number().min(0), loadIncrement: z.number().positive(), unit: z.enum(["kg", "lb"]), rpeValues: z.array(z.number().min(0).max(10)).optional(), rpeCeiling: z.number().min(1).max(10).optional() }), (input) => evaluateDoubleProgression(input as Parameters<typeof evaluateDoubleProgression>[0])),
      read("evaluate_rpe_autoregulation", "Evaluate a load adjustment only when RPE is supplied.", z.object({ actualRpe: z.number().min(0).max(10).nullable(), targetRpe: z.number().min(1).max(10), load: z.number().min(0), increment: z.number().positive(), unit: z.enum(["kg", "lb"]) }), (input) => evaluateRpeAutoregulation(input as Parameters<typeof evaluateRpeAutoregulation>[0])),
      read("evaluate_progression", "Evaluate the MVP progression policy.", z.object({ completedReps: z.array(z.number().int().min(0)).min(1), repMin: z.number().int().min(1), repMax: z.number().int().min(1), currentLoad: z.number().min(0), loadIncrement: z.number().positive(), unit: z.enum(["kg", "lb"]) }), (input) => evaluateDoubleProgression(input as Parameters<typeof evaluateDoubleProgression>[0])),
      read("validate_current_plan", "Resolve template-library references and validate a candidate current mesocycle.", currentPlanWriteSchema, (input) => this.validateCurrentPlan(input)),
      read("check_training_constraints", "Return blocker, advisory, and informational results for a candidate current mesocycle.", currentPlanWriteSchema, (input) => this.validateCurrentPlan(input).results),
      read("get_next_training_day", "Get the first unfinished scheduled training day on or after a local date.", z.object({ onOrAfterDate: dateSchema.optional() }).strict(), (input) => this.getNextTrainingDay(input as { onOrAfterDate?: string })),
      read("list_planned_sessions", "List planned sessions across the current plan, optionally filtered by an inclusive scheduledDate window.", z.object({ from: dateSchema.optional(), to: dateSchema.optional() }).strict(), (input) => this.getCalendar(input as { from?: string; to?: string })),
      read("validate_next_training_day_sessions", "Validate one or more sessions for the current next training day without saving them.", nextTrainingDayWriteSchema, (input) => this.validateNextTrainingDaySessions(input)),
      { name: "create_session_template", description: "Create a local reusable single-domain archetype. Submitting a built-in template ID derives a user-owned replacement with that ID and hides the original in the library. Read get_training_taxonomy first. Do not include exercises, sets, reps, distance, duration, load, or recovery demand.", inputSchema: sessionTemplateCreateSchema, readOnly: false, idempotent: true, handler: (input) => this.createTemplate(input) },
      { name: "update_session_template", description: "Update a local archetype. A built-in original cannot be updated directly; derive it first by creating a template with its ID. Template edits never rewrite Weekly Sessions.", inputSchema: sessionTemplateUpdateSchema, readOnly: false, idempotent: false, handler: (input) => this.updateTemplate(input) },
      { name: "delete_session_template", description: "Delete an unreferenced user template, or hide a built-in template (the code-defined original is retained), only after the user explicitly requests deletion.", inputSchema: z.object({ id: z.string().min(1), expectedRevision: z.number().int().positive().optional(), confirmedExplicitRequest: z.literal(true) }), readOnly: false, idempotent: false, handler: (input) => { const value = input as { id: string; expectedRevision?: number }; return this.deleteTemplate(value.id, value.expectedRevision); } },
      { name: "save_current_plan", description: "Validate and directly replace the single current mesocycle. No approval step follows.", inputSchema: currentPlanWriteSchema, readOnly: false, idempotent: false, handler: (input) => { const saved = this.saveCurrentPlan(input); return { revision: saved.plan.revision, impact: saved.impact, blockerSummary: blockerSummaryFor(saved.validation) }; } },
      { name: "save_next_training_day_sessions", description: "After explicit confirmation, append or replace complete executable Session prescriptions on the next training day. A templateRef is optional provenance and never supplies missing fields.", inputSchema: nextTrainingDayWriteSchema, readOnly: false, idempotent: true, handler: (input) => this.saveNextTrainingDaySessions(input) },
      { name: "update_planned_session", description: "Add a manual completed workout, skip, restore, or move the current planned training occurrence after explicit user confirmation.", inputSchema: z.object({ id: z.string().min(1), update: plannedSessionActionSchema }).strict(), readOnly: false, idempotent: false, handler: (input) => { const value = input as { id: string; update: PlannedSessionAction }; return this.updatePlannedSession(value.id, value.update); } },
      { name: "record_training_session", description: "Record an actual completed training session in Training History. Use plannedSessionId when it corresponds to a Current Plan session.", inputSchema: trainingSessionWriteSchema, readOnly: false, idempotent: true, handler: (input) => this.recordTrainingSession(input) },
      { name: "set_training_session_plan_match", description: "After explicit user confirmation, link or re-link a canonical workout to a same-day planned session. Pass null to mark it as intentionally unplanned.", inputSchema: z.object({ id: z.string().min(1), plannedSessionId: z.string().min(1).nullable(), expectedRevision: z.number().int().min(0), confirmed: z.literal(true) }).strict(), readOnly: false, idempotent: true, handler: (input) => { const value = input as { id: string; plannedSessionId: string | null; expectedRevision: number; confirmed: true }; return this.setTrainingSessionPlanMatch(value.id, { plannedSessionId: value.plannedSessionId, expectedRevision: value.expectedRevision, confirmed: value.confirmed }); } },
      { name: "allow_automatic_plan_match", description: "After explicit user confirmation, clear a workout's intentionally-unplanned decision and allow deterministic automatic matching again.", inputSchema: z.object({ id: z.string().min(1), confirmed: z.literal(true) }).strict(), readOnly: false, idempotent: true, handler: (input) => { const value = input as { id: string; confirmed: true }; return this.clearTrainingSessionPlanExclusion(value.id, { confirmed: value.confirmed }); } },
      { name: "update_manual_training_session", description: "After explicit user confirmation, update the exact start time or duration of a canonical workout that contains a manual source.", inputSchema: z.object({ id: z.string().min(1), startAt: z.string().datetime({ offset: true }).optional(), durationMinutes: z.number().int().min(1).max(1440).optional(), confirmed: z.literal(true) }).strict(), readOnly: false, idempotent: false, handler: (input) => { const value = input as { id: string; startAt?: string; durationMinutes?: number; confirmed: true }; return this.updateManualTrainingSession(value.id, { ...(value.startAt ? { startAt: value.startAt } : {}), ...(value.durationMinutes ? { durationMinutes: value.durationMinutes } : {}), confirmed: value.confirmed }); } },
      { name: "remove_manual_training_source", description: "After explicit user confirmation, remove the manual source from a canonical workout. Synced source observations are never deleted.", inputSchema: z.object({ id: z.string().min(1), confirmed: z.literal(true) }).strict(), readOnly: false, idempotent: false, handler: (input) => { const value = input as { id: string; confirmed: true }; return this.deleteManualTrainingSession(value.id, { confirmed: value.confirmed }); } },
      { name: "update_wellness", description: "Directly update one wellness day only after the user explicitly confirms the values.", inputSchema: z.object({ day: dateSchema, update: wellnessPatchSchema }).strict(), readOnly: false, idempotent: false, handler: (input) => { const value = input as { day: string; update: WellnessPatch }; return this.updateWellness(value.day, value.update); } },
      { name: "update_athlete_profile", description: "Directly apply a Profile patch only after the user explicitly confirms it. explicitRecoveryDays is the minimum day gap between high-recovery-demand sessions. injuries record known injuries or diagnoses (the factual why) and constraintNotes record movement-level restrictions (the what): notes may be derived from injuries but must never restate the diagnosis. Both are advisory context only: at most 10 entries of up to 200 characters each, one issue per entry, no duplicates. mesocycleDurationWeeks is the athlete's preferred mesocycle length in weeks (1-8); use it as the default durationWeeks for a new plan unless the user requests a specific length. raceDays records upcoming or past target races as { date (YYYY-MM-DD), sport } entries; use them to shape mesocycle peaking. Advisory only, up to 50 entries.", inputSchema: profileUpdateSchema, readOnly: false, idempotent: false, handler: (input) => this.updateProfile(input) },
    ];
  }
}
