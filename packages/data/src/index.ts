import { Database, SQLiteError } from "bun:sqlite";
import { and, desc, eq, gte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  MAX_PROFILE_NOTE_ENTRIES,
  MAX_PROFILE_NOTE_LENGTH,
  PLAN_SCHEMA_VERSION,
  TAXONOMY_VERSION,
  TEMPLATE_CATALOG_VERSION,
  athleteProfileSchema,
  currentPlanSchema,
  defaultProfile,
  equipmentTypeIds,
  normalizeProfileNote,
  planDraftSchema,
  plannedSessionSchema,
  planValidationSchema,
  planVersionSchema,
  sessionTemplateSchema,
  storedSessionTemplateSchema,
  trainingSessionSchema,
  wellnessRecordSchema,
  type AthleteProfile,
  type CurrentPlan,
  type PlanDraft,
  type PlanValidation,
  type PlanVersion,
  type PlannedSession,
  type SessionTemplate,
  type StoredSessionTemplate,
  type TrainingSession,
  type WellnessRecord,
} from "@athria/schemas";
import * as schema from "./schema";

interface LegacyExerciseDefinition { key: string; name: string; movement: string; primaryMuscles: string[]; secondaryMuscles: string[]; equipment: string[]; unilateral: boolean }
type ExerciseDefinition = LegacyExerciseDefinition;

export const INITIAL_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS profiles (owner_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preferences (owner_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exercises (key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS training_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL, modality TEXT NOT NULL, start_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_owner_source_external ON training_sessions(owner_id, source, external_id);
CREATE INDEX IF NOT EXISTS sessions_owner_start ON training_sessions(owner_id, start_at);
CREATE TABLE IF NOT EXISTS wellness_daily (owner_id TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS wellness_owner_day ON wellness_daily(owner_id, day);
CREATE TABLE IF NOT EXISTS import_batches (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source TEXT NOT NULL, content_hash TEXT NOT NULL, file_name TEXT NOT NULL, parser_version TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS imports_owner_source_hash ON import_batches(owner_id, source, content_hash);
CREATE TABLE IF NOT EXISTS raw_records (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source TEXT NOT NULL, external_key TEXT NOT NULL, content_hash TEXT NOT NULL, payload TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS raw_owner_source_key ON raw_records(owner_id, source, external_key);
CREATE TABLE IF NOT EXISTS plan_drafts (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_request_id TEXT NOT NULL, data TEXT NOT NULL, validation TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS drafts_owner_request ON plan_drafts(owner_id, client_request_id);
CREATE TABLE IF NOT EXISTS plan_versions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, parent_version_id TEXT, version_number INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS versions_owner_number ON plan_versions(owner_id, version_number);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, snapshot_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profile_update_proposals (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_request_id TEXT NOT NULL, patch TEXT NOT NULL, rationale TEXT NOT NULL, base_snapshot_hash TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS profile_updates_owner_request ON profile_update_proposals(owner_id, client_request_id);
CREATE TABLE IF NOT EXISTS athria_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
INSERT OR IGNORE INTO athria_migrations(version, applied_at) VALUES (1, CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS connection_sync_state (owner_id TEXT NOT NULL, source TEXT NOT NULL, last_attempt_at TEXT NOT NULL, last_success_at TEXT, range_start TEXT NOT NULL, range_end TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS connection_sync_owner_source ON connection_sync_state(owner_id, source);
INSERT OR IGNORE INTO athria_migrations(version, applied_at) VALUES (2, CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plan_activations (plan_version_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, effective_start_date TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS planned_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, plan_version_id TEXT NOT NULL, scheduled_date TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS planned_sessions_owner_plan_date ON planned_sessions(owner_id, plan_version_id, scheduled_date);
CREATE TABLE IF NOT EXISTS planned_session_changes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_request_id TEXT NOT NULL, plan_version_id TEXT NOT NULL, scheduled_date TEXT NOT NULL, mode TEXT NOT NULL, before_data TEXT NOT NULL, after_data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS planned_changes_owner_request ON planned_session_changes(owner_id, client_request_id);
INSERT OR IGNORE INTO athria_migrations(version, applied_at) VALUES (3, CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plan_schema_migration_backups (table_name TEXT NOT NULL, row_id TEXT NOT NULL, data TEXT NOT NULL, validation TEXT, migrated_at TEXT NOT NULL, PRIMARY KEY(table_name, row_id));
`;

const parseJson = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) : value;
const equipment = new Set<string>(equipmentTypeIds);
const equipmentAliases: Record<string, string> = { band: "resistance_band", suspension: "trx" };
const migratedEquipment = (values: unknown): string[] => Array.isArray(values)
  ? [...new Set(values.map(String).map((item) => equipmentAliases[item] ?? item).filter((item) => equipment.has(item)))]
  : [];

function migrateEquipmentFacts(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(migrateEquipmentFacts); return; }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.equipment)) record.equipment = migratedEquipment(record.equipment);
  if (typeof record.equipment === "object" && record.equipment !== null) {
    const equipmentFact = record.equipment as Record<string, unknown>;
    if (Array.isArray(equipmentFact.value)) equipmentFact.value = migratedEquipment(equipmentFact.value);
  }
  Object.values(record).forEach(migrateEquipmentFacts);
}

const legacyRecoveryDays = (hours: unknown): number | null => {
  const value = Number(hours);
  return Number.isFinite(value) && value > 0 ? Math.min(7, Math.max(1, Math.ceil(value / 24))) : null;
};

function sanitizeProfileNotes(notes: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of notes) {
    if (typeof raw !== "string") continue;
    const note = raw.trim().slice(0, MAX_PROFILE_NOTE_LENGTH);
    const key = normalizeProfileNote(note);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(note);
    if (result.length === MAX_PROFILE_NOTE_ENTRIES) break;
  }
  return result;
}

// Legacy on-disk profiles predate the day-based recovery field, the id-less
// constraints, and the free-text injuries/constraintNotes model. Every
// migration that parses an existing profile must normalize first, otherwise
// the strict athleteProfileSchema rejects the legacy keys.
function migrateLegacyProfileFields(raw: Record<string, unknown>): Record<string, unknown> {
  const profile: Record<string, unknown> = { ...raw };
  profile.preferredName ??= typeof profile.displayName === "string" && profile.displayName.trim() ? profile.displayName : "Athlete";
  profile.gender ??= null;
  profile.heightCm ??= null;
  profile.birthDate ??= null;
  delete profile.displayName;
  profile.equipment = migratedEquipment(profile.equipment);
  if ("explicitRecoveryHours" in profile) {
    profile.explicitRecoveryDays = legacyRecoveryDays(profile.explicitRecoveryHours);
    delete profile.explicitRecoveryHours;
  }
  if (Array.isArray(profile.strengthConstraints)) {
    const converted = profile.strengthConstraints.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const constraint = item as Record<string, unknown>;
      const key = constraint.type === "exclude_exercise" ? constraint.canonicalKey : constraint.movementPattern;
      return typeof key === "string" && key.trim() ? [`Avoid ${key.trim().replace(/_/g, " ")}`] : [];
    });
    const existing = Array.isArray(profile.constraintNotes) ? profile.constraintNotes as unknown[] : [];
    profile.constraintNotes = sanitizeProfileNotes([...existing, ...converted]);
    delete profile.strengthConstraints;
  } else if (Array.isArray(profile.constraintNotes)) {
    profile.constraintNotes = sanitizeProfileNotes(profile.constraintNotes);
  }
  if (Array.isArray(profile.injuries)) profile.injuries = sanitizeProfileNotes(profile.injuries);
  if ("raceDays" in profile && !Array.isArray(profile.raceDays)) delete profile.raceDays;
  return profile;
}

function inferPhaseType(name: string): "foundation" | "progression" | "deload" | "peak" | "test" | "recovery" {
  const value = name.toLowerCase();
  if (/deload|减量/.test(value)) return "deload";
  if (/peak|巅峰/.test(value)) return "peak";
  if (/test|测试/.test(value)) return "test";
  if (/recovery|恢复/.test(value)) return "recovery";
  if (/base|baseline|基础|基线/.test(value)) return "foundation";
  return "progression";
}

const movements = new Set(["squat", "hinge", "lunge", "horizontal_push", "vertical_push", "horizontal_pull", "vertical_pull", "carry", "rotation", "anti_rotation", "flexion", "extension", "abduction", "adduction", "calf_raise", "isolation", "other"]);
const muscles = new Set(["chest", "upper_back", "back", "lats", "shoulders", "biceps", "triceps", "forearms", "quadriceps", "hamstrings", "glutes", "calves", "core", "spinal_erectors", "hip_flexors", "adductors", "abductors", "full_body", "other"]);
const fact = (value: unknown, known: boolean, evidence: string) => ({ value, source: known ? "catalog" : "migration", confidence: known ? 1 : 0, evidence, taxonomyVersion: TAXONOMY_VERSION });
const normalizedList = (values: unknown, allowed: Set<string>) => Array.isArray(values) ? values.map(String).filter((item) => allowed.has(item)) : [];

function migrateExercise(value: Record<string, unknown>, catalog: Map<string, ExerciseDefinition>) {
  const canonicalKey = String(value.canonicalKey ?? value.exerciseKey ?? "") || null;
  const definition = canonicalKey ? catalog.get(canonicalKey) : undefined;
  const source = definition ? `Catalog ${definition.key}` : "Legacy plan did not contain a trusted classification";
  return {
    id: String(value.id ?? value.exerciseKey ?? crypto.randomUUID()), displayName: String(value.displayName ?? value.name ?? canonicalKey ?? "Migrated exercise"), canonicalKey,
    classification: {
      primaryMovement: fact(definition && movements.has(definition.movement) ? definition.movement : null, Boolean(definition), source),
      primaryMuscles: fact(definition ? normalizedList(definition.primaryMuscles, muscles) : [], Boolean(definition), source),
      secondaryMuscles: fact(definition ? normalizedList(definition.secondaryMuscles, muscles) : [], Boolean(definition), source),
      equipment: fact(definition ? normalizedList(definition.equipment, equipment) : [], Boolean(definition), source),
      impact: fact(null, false, "Legacy plan did not record impact"), laterality: fact(definition ? (definition.unilateral ? "unilateral" : "bilateral") : null, Boolean(definition), source),
    },
    sets: Number(value.sets ?? 1), repsMin: Number(value.repsMin ?? 1), repsMax: Number(value.repsMax ?? value.repsMin ?? 1), targetRpe: value.targetRpe ?? null, restSeconds: Number(value.restSeconds ?? 90), referenceLoad: value.referenceLoad ?? null, referenceLoadUnit: value.referenceLoadUnit ?? null, notes: String(value.notes ?? ""),
  };
}

function migrateTemplate(value: Record<string, unknown>, catalog: Map<string, ExerciseDefinition>) {
  if (Array.isArray(value.components)) return value;
  const id = String(value.id ?? crypto.randomUUID());
  const modality = String(value.modality ?? "unknown");
  const oldExercises = Array.isArray(value.exercises) ? value.exercises as Array<Record<string, unknown>> : [];
  const hasEndurance = value.endurance != null || value.enduranceDetails != null;
  const components: unknown[] = [];
  if (oldExercises.length) components.push({ id: `${id}-strength`, name: "Strength", domain: fact("strength", true, "Migrated from legacy strength exercises"), prescription: { kind: "strength", exercises: oldExercises.map((exercise) => migrateExercise(exercise, catalog)) } });
  if (hasEndurance || modality === "endurance") components.push({ id: `${id}-endurance`, name: "Endurance", domain: fact("endurance", true, hasEndurance ? "Migrated from structured endurance details" : "Migrated from legacy endurance modality"), prescription: { kind: "duration_only", notes: String(value.notes ?? value.intent ?? "") } });
  if (modality === "recovery") components.push({ id: `${id}-recovery`, name: "Recovery", domain: fact("recovery", true, "Migrated from legacy recovery modality"), prescription: { kind: "duration_only", notes: String(value.notes ?? value.intent ?? "") } });
  const needsUnclassified = components.length === 0 || (modality === "mixed" && !hasEndurance && String(value.notes ?? value.intent ?? "").trim().length > 0);
  if (needsUnclassified) components.push({ id: `${id}-unclassified`, name: "Unclassified component", domain: fact(null, false, `Legacy ${modality} content could not be assigned reliably`), prescription: { kind: "duration_only", notes: String(value.notes ?? value.intent ?? "") } });
  return { id, name: String(value.name ?? "Migrated session"), intent: String(value.intent ?? "Migrated training"), durationMinutes: Number(value.durationMinutes ?? 1), recoveryDemand: value.recoveryDemand ?? (value.hard ? "high" : "normal"), notes: String(value.notes ?? ""), components };
}

function localWeekday(startAt: string, timezone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(new Date(startAt));
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday);
}

function localDate(startAt: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(startAt));
}

function localNoon(date: string, timeZone: string): Date {
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
}

const RECONCILIATION_VERSION = "workout-reconciliation-v1";
type SourceObservation = { id: string; canonicalId: string; session: TrainingSession; createdAt: string };

const normalizedToken = (value: string | null | undefined): string => String(value ?? "").toLowerCase().replace(/running/g, "run").replace(/cycling|biking/g, "ride").replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
const normalizedExercise = (value: string | null | undefined): string => normalizedToken(value).replace(/dumbbell|barbell|machine|cable/g, "");
const ratioScore = (left: number, right: number, bands: Array<[number, number]>): number => {
  if (left <= 0 || right <= 0) return 0;
  const difference = Math.abs(left - right) / Math.max(left, right);
  return bands.find(([limit]) => difference <= limit)?.[1] ?? 0;
};
const jaccard = (left: Set<string>, right: Set<string>): number => {
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((item) => right.has(item)).length;
  return intersection / (left.size + right.size - intersection);
};

function inferredDomains(session: TrainingSession): Set<string> {
  if (session.domains.length) return new Set(session.domains);
  const domains = new Set<string>();
  if (session.modality === "strength" || session.strengthSets.length) domains.add("strength");
  if (session.modality === "endurance") domains.add("endurance");
  if (session.modality === "mixed") { domains.add("strength"); domains.add("endurance"); }
  if (session.modality === "recovery") domains.add("recovery");
  return domains;
}

function duplicateScore(left: TrainingSession, right: TrainingSession): number | null {
  if (left.source === right.source) return null;
  const leftStart = Date.parse(left.startAt); const rightStart = Date.parse(right.startAt);
  const leftEnd = Date.parse(left.endAt); const rightEnd = Date.parse(right.endAt);
  const startDifference = Math.abs(leftStart - rightStart) / 60_000;
  const overlap = Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
  const shorter = Math.min(Math.max(0, leftEnd - leftStart), Math.max(0, rightEnd - rightStart));
  const overlapRatio = shorter > 0 ? overlap / shorter : 0;
  const dateOnly = left.timePrecision === "date_only" || right.timePrecision === "date_only";
  if (dateOnly) {
    const timezone = left.timezone ?? right.timezone ?? "UTC";
    if (localDate(left.startAt, timezone) !== localDate(right.startAt, timezone)) return null;
  } else if (startDifference > 30 && overlapRatio < 0.5) return null;
  const incompatible = left.modality !== "unknown" && right.modality !== "unknown" && left.modality !== right.modality && left.modality !== "mixed" && right.modality !== "mixed";
  if (incompatible) return null;
  const leftSport = normalizedToken(left.sport); const rightSport = normalizedToken(right.sport);
  if (left.modality === "endurance" && right.modality === "endurance" && leftSport && rightSport && leftSport !== rightSport) return null;

  const startScore = startDifference <= 2 ? 45 : startDifference <= 5 ? 40 : startDifference <= 10 ? 34 : startDifference <= 20 ? 24 : 15;
  const timeScore = dateOnly ? 45 : Math.max(startScore, Math.round(overlapRatio * 45));
  const modalityScore = left.modality === right.modality ? 20 : left.modality === "mixed" || right.modality === "mixed" ? 14 : 5;
  const durationScore = ratioScore(left.durationMinutes, right.durationMinutes, [[0.05, 15], [0.1, 12], [0.2, 8], [0.35, 4]]);
  let contentScore = 0;
  if (left.strengthSets.length && right.strengthSets.length) {
    const exercises = (session: TrainingSession) => new Set(session.strengthSets.map((set) => normalizedExercise(set.exerciseKey ?? set.exerciseRaw)).filter(Boolean));
    contentScore = Math.round(jaccard(exercises(left), exercises(right)) * 20);
  } else if (left.modality === "endurance" && right.modality === "endurance") {
    if (leftSport && leftSport === rightSport) contentScore += 10;
    const leftDistance = left.endurance?.distanceMeters ?? 0; const rightDistance = right.endurance?.distanceMeters ?? 0;
    contentScore += ratioScore(leftDistance, rightDistance, [[0.05, 10], [0.1, 8], [0.2, 4]]);
  } else if (normalizedToken(left.name) && normalizedToken(left.name) === normalizedToken(right.name)) contentScore = 5;
  return timeScore + modalityScore + durationScore + contentScore;
}

function informationScore(session: TrainingSession): number {
  const enduranceFields = session.endurance ? Object.entries(session.endurance).filter(([key, value]) => key !== "heartRateZoneSeconds" && value !== null).length : 0;
  return (session.source === "manual" ? -100 : 0) + session.strengthSets.length * 3 + enduranceFields * 2 + (session.durationMinutes > 0 ? 5 : 0) + (session.modality !== "unknown" ? 3 : 0) - session.missingFields.length;
}

function clusterObservations(observations: SourceObservation[]): SourceObservation[][] {
  const ambiguous = new Set<string>();
  for (const observation of observations) {
    const bySource = new Map<string, Array<{ id: string; score: number }>>();
    for (const candidate of observations) {
      if (candidate.id === observation.id || candidate.session.source === observation.session.source) continue;
      const score = duplicateScore(observation.session, candidate.session);
      if (score !== null && score >= 75) bySource.set(candidate.session.source, [...(bySource.get(candidate.session.source) ?? []), { id: candidate.id, score }]);
    }
    for (const candidates of bySource.values()) {
      candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      if (candidates[1] && candidates[0]!.score - candidates[1].score < 10) for (const candidate of candidates.filter((item) => candidates[0]!.score - item.score < 10)) ambiguous.add(`${observation.id}|${candidate.id}`);
    }
  }
  const clusters = observations.sort((a, b) => `${a.session.source}:${a.session.externalId}`.localeCompare(`${b.session.source}:${b.session.externalId}`)).map((item) => [item]);
  while (true) {
    const candidates: Array<{ left: number; right: number; score: number }> = [];
    for (let left = 0; left < clusters.length; left += 1) for (let right = left + 1; right < clusters.length; right += 1) {
      const sources = new Set(clusters[left]!.map((item) => item.session.source));
      if (clusters[right]!.some((item) => sources.has(item.session.source))) continue;
      const scores = clusters[left]!.flatMap((a) => clusters[right]!.map((b) => ambiguous.has(`${a.id}|${b.id}`) || ambiguous.has(`${b.id}|${a.id}`) ? null : duplicateScore(a.session, b.session)));
      if (scores.some((score) => score === null || score < 75)) continue;
      candidates.push({ left, right, score: Math.min(...scores as number[]) });
    }
    candidates.sort((a, b) => b.score - a.score || clusters[a.left]![0]!.id.localeCompare(clusters[b.left]![0]!.id));
    const best = candidates[0]; if (!best) break;
    clusters[best.left] = [...clusters[best.left]!, ...clusters[best.right]!]; clusters.splice(best.right, 1);
  }
  return clusters;
}

function plannedContentScore(plan: CurrentPlan["mesocycle"]["weeks"][number]["sessions"][number], actual: TrainingSession): number {
  const plannedExercises = new Set(plan.components.flatMap((component) => component.prescription.kind === "strength" ? component.prescription.exercises.map((exercise) => normalizedExercise(exercise.canonicalKey ?? exercise.displayName)).filter(Boolean) : []));
  const actualExercises = new Set(actual.strengthSets.map((set) => normalizedExercise(set.exerciseKey ?? set.exerciseRaw)).filter(Boolean));
  if (plannedExercises.size && actualExercises.size) return Math.round(jaccard(plannedExercises, actualExercises) * 20);
  return normalizedToken(plan.name) && normalizedToken(plan.name) === normalizedToken(actual.name) ? 5 : 0;
}

function planMatchScore(plan: CurrentPlan["mesocycle"]["weeks"][number]["sessions"][number], actual: TrainingSession, timezone: string): number | null {
  if (localDate(actual.startAt, actual.timezone ?? timezone) !== plan.scheduledDate) return null;
  const plannedDomains = new Set(plan.components.map((component) => component.domain.value).filter(Boolean));
  const actualDomains = inferredDomains(actual);
  const overlap = [...plannedDomains].filter((domain) => actualDomains.has(String(domain)));
  if (!overlap.length) return null;
  const domainScore = plannedDomains.size === 1 && actualDomains.size === 1 ? 30 : 20;
  const durationScore = ratioScore(plan.durationMinutes, actual.durationMinutes, [[0.1, 15], [0.2, 12], [0.35, 8], [0.5, 4]]);
  return 35 + domainScore + durationScore + plannedContentScore(plan, actual);
}

function legacySessionSignature(session: Record<string, unknown>): string {
  return JSON.stringify({ modality: session.modality ?? null, name: session.name ?? null, durationMinutes: session.durationMinutes ?? null, exercises: session.exercises ?? [], endurance: session.endurance ?? session.enduranceDetails ?? null });
}

function migrateDraft(value: unknown, catalog: Map<string, ExerciseDefinition>, timezone: string): unknown {
  if (!value || typeof value !== "object") return value;
  const draft = structuredClone(value) as Record<string, unknown>;
  if (draft.planSchemaVersion === "3.0") return draft;
  const mesocycle = draft.mesocycle as Record<string, unknown> | null | undefined;
  let reviewRequired = false;
  let sourceSessions: unknown[] = [];
  if (mesocycle) {
    const templates = ((mesocycle.sessionTemplates as Array<Record<string, unknown>> | undefined) ?? []).map((template) => migrateTemplate(template, catalog));
    reviewRequired = templates.some((template) => (template as { components: Array<{ domain: { value: unknown } }> }).components.some((component) => component.domain.value === null));
    mesocycle.weeklyStructure = ((mesocycle.weeklyStructure as Array<Record<string, unknown>> | undefined) ?? []).map((day) => ({ dayOfWeek: day.dayOfWeek, templateIds: Array.isArray(day.templateIds) ? day.templateIds : day.templateId == null ? [] : [day.templateId] })).filter((day) => day.templateIds.length);
    mesocycle.sessionTemplates = templates;
    mesocycle.phases = ((mesocycle.phases as Array<Record<string, unknown>> | undefined) ?? []).map((phase) => ({ ...phase, phaseType: phase.phaseType ?? inferPhaseType(String(phase.name ?? "")) }));
    if (!(mesocycle.weeklyStructure as unknown[]).length) { draft.mesocycle = null; reviewRequired = true; }
  } else if (Array.isArray(draft.sessions) && draft.sessions.length) {
    sourceSessions = structuredClone(draft.sessions);
    const sessions = draft.sessions as Array<Record<string, unknown>>;
    const ordered = [...sessions].sort((left, right) => String(left.startAt).localeCompare(String(right.startAt)));
    const ordinalByDate = new Map<string, number>();
    const templatesBySignature = new Map<string, ReturnType<typeof migrateTemplate>>();
    const templateMeta = new Map<string, { day: number; ordinal: number }>();
    for (const [index, session] of ordered.entries()) {
      const date = localDate(String(session.startAt), timezone);
      const ordinal = ordinalByDate.get(date) ?? 0;
      ordinalByDate.set(date, ordinal + 1);
      const day = localWeekday(String(session.startAt), timezone);
      const signature = `${legacySessionSignature(session)}|${day}|${ordinal}`;
      if (!templatesBySignature.has(signature)) {
        const template = migrateTemplate({ ...session, id: `migrated-${day}-${ordinal}-${index}` }, catalog);
        templatesBySignature.set(signature, template);
        templateMeta.set((template as { id: string }).id, { day, ordinal });
      }
    }
    const templates = [...templatesBySignature.values()];
    const byDay = new Map<number, Array<{ id: string; ordinal: number }>>();
    for (const template of templates) { const id = (template as { id: string }).id; const meta = templateMeta.get(id)!; byDay.set(meta.day, [...(byDay.get(meta.day) ?? []), { id, ordinal: meta.ordinal }]); }
    const dates = ordered.map((session) => localDate(String(session.startAt), timezone)).sort();
    const spanDays = Math.floor((Date.parse(`${dates.at(-1)}T00:00:00Z`) - Date.parse(`${dates[0]}T00:00:00Z`)) / 86_400_000) + 1;
    const durationWeeks = Math.min(52, Math.max(1, Math.ceil(spanDays / 7)));
    draft.mesocycle = { durationWeeks, weeklyStructure: [...byDay].sort(([a], [b]) => a - b).map(([dayOfWeek, entries]) => ({ dayOfWeek, templateIds: entries.sort((a, b) => a.ordinal - b.ordinal).map((entry) => entry.id) })), sessionTemplates: templates, phases: [{ id: "migration-review", phaseType: "foundation", name: "Migration review", startWeek: 1, endWeek: durationWeeks, focus: "Review the schedule inferred from dated legacy sessions", progression: [] }], adjustmentRules: [] };
    reviewRequired = true;
  }
  delete draft.sessions;
  draft.planSchemaVersion = "3.0";
  draft.migration = { reviewRequired, sourceSchema: "legacy", sourceSessions };
  return draft;
}

const emptyCoverage = { hardChecksResolved: 0, hardChecksTotal: 0, movementFactsResolved: 0, movementFactsTotal: 0, muscleFactsResolved: 0, muscleFactsTotal: 0, equipmentFactsResolved: 0, equipmentFactsTotal: 0 };
function migrateValidation(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const validation = structuredClone(value) as Record<string, unknown>;
  if (validation.coverage) return validation;
  validation.results = ((validation.results as Array<Record<string, unknown>> | undefined) ?? []).map((result) => ({ status: result.passed === false ? "fail" : "pass", enforcement: result.severity === "hard" ? "blocker" : result.severity === "soft" ? "advisory" : "info", reasonCode: String(result.reasonCode ?? "LEGACY_RULE"), rulePackId: "legacy", ruleVersion: String(result.ruleVersion ?? "legacy"), subjectRefs: result.sessionIds ?? [], evidence: result.evidence ?? {}, missingFacts: [], confidenceLimit: null }));
  validation.dataGaps = ((validation.dataGaps as unknown[] | undefined) ?? []).map((gap) => ({ code: "LEGACY_DATA_GAP", subjectRef: "plan", factPath: String(gap), requiredByRuleCodes: [], blocking: false, resolution: "agent_infer" }));
  validation.coverage = emptyCoverage;
  return validation;
}

function migratePlannedSession(value: unknown, catalog: Map<string, ExerciseDefinition>): unknown {
  if (!value || typeof value !== "object") return value;
  const session = structuredClone(value) as Record<string, unknown>;
  if (!Array.isArray(session.components)) {
    const template = migrateTemplate(session, catalog) as { components: unknown[] };
    delete session.modality; delete session.exercises;
    session.components = template.components;
  }
  delete session.planVersionId;
  session.planRevision ??= 1;
  session.occurrenceId ??= `legacy-${String(session.id ?? crypto.randomUUID())}`;
  session.exerciseOverrides ??= [];
  session.legacySnapshot ??= true;
  session.completedAt ??= null;
  session.completionSource ??= session.completedTrainingSessionId ? "import" : null;
  return session;
}

function migrateCurrentMesocycle(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const mesocycle = structuredClone(value) as Record<string, unknown>;
  if (!mesocycle.schedule && Array.isArray(mesocycle.weeklyStructure)) {
    mesocycle.schedule = { kind: "fixed_week", days: (mesocycle.weeklyStructure as Array<Record<string, unknown>>).map((day, index) => ({ id: String(day.id ?? `weekday-${day.dayOfWeek ?? index}`), dayOfWeek: day.dayOfWeek, templateIds: day.templateIds })) };
  }
  delete mesocycle.weeklyStructure;
  return mesocycle;
}

type TemplateRow = { id: string; ownerId: string; data: unknown; revision: number; createdAt: string; updatedAt: string };

function templateData(template: SessionTemplate) {
  const { id: _id, ...data } = sessionTemplateSchema.parse(template);
  return data;
}

function storedTemplate(row: TemplateRow): StoredSessionTemplate {
  return storedSessionTemplateSchema.parse({ id: row.id, ...(parseJson(row.data) as Record<string, unknown>), origin: "user", revision: row.revision }) as StoredSessionTemplate;
}

function migrateTemplateNode(value: Record<string, unknown>) {
  const variables: string[] = [];
  const optionalVariables: string[] = [];
  for (const item of (Array.isArray(value.variables) ? value.variables : []) as Array<Record<string, unknown>>) {
    const key = String(item.key ?? "");
    if (key) (item.required === false ? optionalVariables : variables).push(key);
  }
  const node: Record<string, unknown> = { role: value.role, variables };
  if (typeof value.name === "string" && value.name.trim()) node.name = value.name;
  if (value.required === false) node.optional = true;
  if (optionalVariables.length) node.optionalVariables = optionalVariables;
  if (Array.isArray(value.movementPatternIds) && value.movementPatternIds.length) node.movementPatternIds = value.movementPatternIds;
  if (Array.isArray(value.targetMuscleIds) && value.targetMuscleIds.length) node.targetMuscleIds = value.targetMuscleIds;
  if (value.matchPolicy === "all") node.matchPolicy = "all";
  return node;
}

function migrateSessionTemplate(value: Record<string, unknown>, id: string): SessionTemplate {
  if (Array.isArray(value.nodes)) return sessionTemplateSchema.parse({ id, name: value.name, intent: value.intent, domain: value.domain, nodes: value.nodes });
  const structure = value.structure as Record<string, unknown> | undefined;
  const nodes = (structure?.slots ?? structure?.blocks) as Array<Record<string, unknown>> | undefined;
  return sessionTemplateSchema.parse({ id, name: value.name, intent: value.intent, domain: value.domain, nodes: (nodes ?? []).map(migrateTemplateNode) });
}

const legacyBuiltinTemplateIds = new Set(["builtin.easy-run", "builtin.intervals", "builtin.long-run", "builtin.lower-strength-a", "builtin.upper-strength-a", "builtin.basketball-practice", "builtin.mobility-reset", "builtin.mind-body-reset"]);
function migrateBuiltinTemplateRefs(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(migrateBuiltinTemplateRefs); return; }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (record.source === "builtin" && record.catalogVersion === "1.0" && legacyBuiltinTemplateIds.has(String(record.id))) record.catalogVersion = TEMPLATE_CATALOG_VERSION;
  Object.values(record).forEach(migrateBuiltinTemplateRefs);
}

export class AthriaRepository {
  readonly sqlite: Database;
  readonly db: ReturnType<typeof drizzle<typeof schema>>;

  constructor(path: string, private readonly now: () => Date = () => new Date()) {
    this.sqlite = new Database(path, { create: true });
    this.sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const hasMigrationTable = Boolean(this.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'athria_migrations'").get());
    // Migration 5 introduced the current-plan tables. Once it is present we must
    // not replay the legacy bootstrap SQL, even when migration 6 is still pending.
    const isCurrentSchema = hasMigrationTable && Boolean(this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 5").get());
    if (!isCurrentSchema) this.sqlite.exec(INITIAL_MIGRATION_SQL);
    this.db = drizzle({ client: this.sqlite, schema });
    try {
      this.migrateProfileTrainingRhythmV7();
      this.migratePlanningSchemaV7Reset();
      this.migrateDomainProgressionV7Reset();
      this.migrateProfilePreferenceV10();
      this.migrateSessionTemplatesV11();
      this.migrateSimplifiedStorageV12();
      this.migrateProfileConstraintsV13();
      this.migrateProfileNotesV14();
      this.migratePlanTargetV15();
      this.migrateEquipmentCatalogV16();
      this.migratePersonalInformationV17();
      this.migrateWorkoutReconciliationV18();
      this.migratePlanReconciliationUxV19();
      this.migrateTrainingSessionTypeOverridesV20();
      this.migrateTemplateDismissalsV21();
      this.migrateProfileRaceDaysV22();
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
  }

  private migratePlanSchemaV3(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 4").get()) return;
    const catalog = new Map(this.sqlite.query("SELECT key, data FROM exercises").all().map((row) => [String((row as { key: unknown }).key), parseJson((row as { data: unknown }).data) as ExerciseDefinition]));
    const profiles = new Map(this.sqlite.query("SELECT owner_id, data FROM profiles").all().map((row) => [String((row as { owner_id: unknown }).owner_id), parseJson((row as { data: unknown }).data) as Record<string, unknown>]));
    this.sqlite.transaction(() => {
      for (const [ownerId, profile] of profiles) {
        const migrated: Record<string, unknown> = { ...profile, strengthConstraints: [
          ...((profile.strengthConstraints as unknown[] | undefined) ?? []),
          ...((profile.excludedExercises as string[] | undefined) ?? []).map((canonicalKey) => ({ type: "exclude_exercise", canonicalKey })),
        ], constraintNotes: profile.constraintNotes ?? profile.constraints ?? [], equipment: migratedEquipment(profile.equipment ?? []) };
        const trainingDays = Array.isArray(migrated.trainingDays) ? migrated.trainingDays : [];
        migrated.trainingRhythm = trainingDays.length ? { kind: "fixed_week", days: [...new Set(trainingDays)].sort() } : { kind: "flexible_week", targetDaysPerWeek: 4, minDaysPerWeek: 3, maxDaysPerWeek: 5 };
        delete migrated.weeklyStrengthSessions; delete migrated.weeklyEnduranceSessions; delete migrated.trainingDays;
        delete migrated.excludedExercises; delete migrated.constraints; delete migrated.availability; delete migrated.maxHeartRate;
        this.sqlite.query("UPDATE profiles SET data = ? WHERE owner_id = ?").run(JSON.stringify(athleteProfileSchema.parse(migrateLegacyProfileFields(migrated))), ownerId);
      }
      for (const row of this.sqlite.query("SELECT id, owner_id, data, validation FROM plan_drafts").all() as Array<{ id: string; owner_id: string; data: string; validation: string }>) {
        this.sqlite.query("INSERT INTO plan_schema_migration_backups(table_name,row_id,data,validation,migrated_at) VALUES ('plan_drafts',?,?,?,CURRENT_TIMESTAMP)").run(row.id, row.data, row.validation);
        const timezone = String(profiles.get(row.owner_id)?.timezone ?? "UTC");
        const draft = planDraftSchema.parse(migrateDraft(parseJson(row.data), catalog, timezone));
        const validation = planValidationSchema.parse(migrateValidation(parseJson(row.validation)));
        this.sqlite.query("UPDATE plan_drafts SET data = ?, validation = ? WHERE id = ?").run(JSON.stringify(draft), JSON.stringify(validation), row.id);
      }
      for (const row of this.sqlite.query("SELECT id, owner_id, data FROM plan_versions").all() as Array<{ id: string; owner_id: string; data: string }>) {
        this.sqlite.query("INSERT INTO plan_schema_migration_backups(table_name,row_id,data,validation,migrated_at) VALUES ('plan_versions',?,?,NULL,CURRENT_TIMESTAMP)").run(row.id, row.data);
        const version = parseJson(row.data) as Record<string, unknown>;
        version.plan = migrateDraft(version.plan, catalog, String(profiles.get(row.owner_id)?.timezone ?? "UTC")); version.validation = migrateValidation(version.validation);
        this.sqlite.query("UPDATE plan_versions SET data = ? WHERE id = ?").run(JSON.stringify(planVersionSchema.parse(version)), row.id);
      }
      for (const row of this.sqlite.query("SELECT id, data FROM planned_sessions").all() as Array<{ id: string; data: string }>) {
        this.sqlite.query("INSERT INTO plan_schema_migration_backups(table_name,row_id,data,validation,migrated_at) VALUES ('planned_sessions',?,?,NULL,CURRENT_TIMESTAMP)").run(row.id, row.data);
        const session = plannedSessionSchema.parse(migratePlannedSession(parseJson(row.data), catalog));
        this.sqlite.query("UPDATE planned_sessions SET data = ? WHERE id = ?").run(JSON.stringify(session), row.id);
      }
      for (const row of this.sqlite.query("SELECT id, before_data, after_data FROM planned_session_changes").all() as Array<{ id: string; before_data: string; after_data: string }>) {
        this.sqlite.query("INSERT INTO plan_schema_migration_backups(table_name,row_id,data,validation,migrated_at) VALUES ('planned_session_changes',?,?,NULL,CURRENT_TIMESTAMP)").run(row.id, JSON.stringify({ beforeData: row.before_data, afterData: row.after_data }));
        const before = (parseJson(row.before_data) as unknown[]).map((item) => plannedSessionSchema.parse(migratePlannedSession(item, catalog)));
        const after = (parseJson(row.after_data) as unknown[]).map((item) => plannedSessionSchema.parse(migratePlannedSession(item, catalog)));
        this.sqlite.query("UPDATE planned_session_changes SET before_data = ?, after_data = ? WHERE id = ?").run(JSON.stringify(before), JSON.stringify(after), row.id);
      }
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (4, CURRENT_TIMESTAMP)").run();
    })();
  }

  private migratePlanSchemaV4(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 5").get()) return;
    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        CREATE TABLE session_templates (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX templates_owner_id ON session_templates(owner_id, id);
        CREATE TABLE current_mesocycles (owner_id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
      `);
      const profiles = new Map(this.sqlite.query("SELECT owner_id, data FROM profiles").all().map((row) => [String((row as { owner_id: unknown }).owner_id), parseJson((row as { data: unknown }).data) as AthleteProfile]));
      const seen = new Set<string>();
      for (const row of this.sqlite.query("SELECT id, owner_id, data FROM plan_versions ORDER BY owner_id, version_number DESC").all() as Array<{ id: string; owner_id: string; data: string }>) {
        if (seen.has(row.owner_id)) continue;
        seen.add(row.owner_id);
        const version = planVersionSchema.parse(parseJson(row.data));
        if (!version.plan.mesocycle) continue;
        const timestamp = version.approvedAt;
        for (const template of version.plan.mesocycle.sessionTemplates) {
          const stored = storedSessionTemplateSchema.parse({ ...template, ownerId: row.owner_id, revision: 1, createdAt: timestamp, updatedAt: timestamp }) as StoredSessionTemplate;
          this.sqlite.query("INSERT OR REPLACE INTO session_templates(id,owner_id,data,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(stored.id, row.owner_id, JSON.stringify(stored), 1, timestamp, timestamp);
        }
        const activation = this.sqlite.query("SELECT effective_start_date FROM plan_activations WHERE plan_version_id = ?").get(row.id) as { effective_start_date: string } | null;
        const profile = profiles.get(row.owner_id);
        const effectiveStartDate = activation?.effective_start_date ?? localDate(this.now().toISOString(), profile?.timezone ?? "UTC");
        const { sessionTemplates: _templates, ...legacyMesocycle } = version.plan.mesocycle;
        const mesocycle = migrateCurrentMesocycle(legacyMesocycle);
        const current = currentPlanSchema.parse({ planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: row.owner_id, title: version.plan.title, summary: version.plan.summary, effectiveStartDate, mesocycle, revision: 1, sourceAgent: version.plan.sourceAgent, model: version.plan.model, skillVersion: version.plan.skillVersion, inputSnapshotHash: version.plan.inputSnapshotHash, updatedAt: timestamp });
        this.sqlite.query("INSERT INTO current_mesocycles(owner_id,data,revision,updated_at) VALUES (?,?,1,?)").run(row.owner_id, JSON.stringify(current), timestamp);
      }
      for (const row of this.sqlite.query("SELECT id, owner_id, data, updated_at FROM plan_drafts ORDER BY owner_id, updated_at DESC").all() as Array<{ id: string; owner_id: string; data: string; updated_at: string }>) {
        if (seen.has(row.owner_id)) continue;
        seen.add(row.owner_id);
        const draft = planDraftSchema.parse(parseJson(row.data));
        if (!draft.mesocycle) continue;
        const timestamp = row.updated_at || draft.updatedAt;
        for (const template of draft.mesocycle.sessionTemplates) {
          const stored = storedSessionTemplateSchema.parse({ ...template, ownerId: row.owner_id, revision: 1, createdAt: timestamp, updatedAt: timestamp }) as StoredSessionTemplate;
          this.sqlite.query("INSERT OR REPLACE INTO session_templates(id,owner_id,data,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(stored.id, row.owner_id, JSON.stringify(stored), 1, timestamp, timestamp);
        }
        const profile = profiles.get(row.owner_id);
        const effectiveStartDate = localDate(this.now().toISOString(), profile?.timezone ?? "UTC");
        const { sessionTemplates: _templates, ...legacyMesocycle } = draft.mesocycle;
        const mesocycle = migrateCurrentMesocycle(legacyMesocycle);
        const current = currentPlanSchema.parse({ planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: row.owner_id, title: draft.title, summary: draft.summary, effectiveStartDate, mesocycle, revision: 1, sourceAgent: draft.sourceAgent, model: draft.model, skillVersion: draft.skillVersion, inputSnapshotHash: draft.inputSnapshotHash, updatedAt: timestamp });
        this.sqlite.query("INSERT INTO current_mesocycles(owner_id,data,revision,updated_at) VALUES (?,?,1,?)").run(row.owner_id, JSON.stringify(current), timestamp);
      }
      this.sqlite.exec(`
        CREATE TABLE planned_sessions_v5 (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, plan_version_id TEXT, scheduled_date TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX planned_sessions_owner_date ON planned_sessions_v5(owner_id, scheduled_date);
      `);
      for (const row of this.sqlite.query("SELECT id, owner_id, scheduled_date, status, data FROM planned_sessions").all() as Array<{ id: string; owner_id: string; scheduled_date: string; status: string; data: string }>) {
        const session = plannedSessionSchema.parse(migratePlannedSession(parseJson(row.data), new Map()));
        this.sqlite.query("INSERT INTO planned_sessions_v5 VALUES (?,?,?,?,?,?)").run(row.id, row.owner_id, null, row.scheduled_date, row.status, JSON.stringify(session));
      }
      this.sqlite.exec(`
        DROP TABLE planned_sessions;
        ALTER TABLE planned_sessions_v5 RENAME TO planned_sessions;
        CREATE TABLE planned_session_changes_v5 (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_request_id TEXT NOT NULL, plan_version_id TEXT, scheduled_date TEXT NOT NULL, mode TEXT NOT NULL, before_data TEXT NOT NULL, after_data TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE UNIQUE INDEX planned_changes_owner_request_v5 ON planned_session_changes_v5(owner_id, client_request_id);
      `);
      for (const row of this.sqlite.query("SELECT id, owner_id, client_request_id, scheduled_date, mode, before_data, after_data, created_at FROM planned_session_changes").all() as Array<{ id: string; owner_id: string; client_request_id: string; scheduled_date: string; mode: string; before_data: string; after_data: string; created_at: string }>) {
        this.sqlite.query("INSERT INTO planned_session_changes_v5 VALUES (?,?,?,?,?,?,?,?,?)").run(row.id, row.owner_id, row.client_request_id, null, row.scheduled_date, row.mode, row.before_data, row.after_data, row.created_at);
      }
      this.sqlite.exec(`
        DROP TABLE planned_session_changes;
        ALTER TABLE planned_session_changes_v5 RENAME TO planned_session_changes;
        DELETE FROM approvals WHERE subject_type = 'plan_draft';
        DROP TABLE plan_activations;
        DROP TABLE plan_drafts;
        DROP TABLE plan_versions;
        DROP TABLE plan_schema_migration_backups;
        INSERT INTO athria_migrations(version, applied_at) VALUES (5, CURRENT_TIMESTAMP);
      `);
    })();
  }

  private migrateTrainingRhythmV5(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 6").get()) return;
    this.sqlite.transaction(() => {
      for (const row of this.sqlite.query("SELECT owner_id, data FROM current_mesocycles").all() as Array<{ owner_id: string; data: string }>) {
        const value = parseJson(row.data) as Record<string, unknown>;
        value.planSchemaVersion = PLAN_SCHEMA_VERSION;
        value.mesocycle = migrateCurrentMesocycle(value.mesocycle);
        const current = currentPlanSchema.parse(value);
        this.sqlite.query("UPDATE current_mesocycles SET data = ? WHERE owner_id = ?").run(JSON.stringify(current), row.owner_id);
      }
      for (const row of this.sqlite.query("SELECT id, data FROM planned_sessions").all() as Array<{ id: string; data: string }>) {
        const session = plannedSessionSchema.parse(migratePlannedSession(parseJson(row.data), new Map()));
        this.sqlite.query("UPDATE planned_sessions SET data = ? WHERE id = ?").run(JSON.stringify(session), row.id);
      }
      for (const row of this.sqlite.query("SELECT id, before_data, after_data FROM planned_session_changes").all() as Array<{ id: string; before_data: string; after_data: string }>) {
        const before = (parseJson(row.before_data) as unknown[]).map((item) => plannedSessionSchema.parse(migratePlannedSession(item, new Map())));
        const after = (parseJson(row.after_data) as unknown[]).map((item) => plannedSessionSchema.parse(migratePlannedSession(item, new Map())));
        this.sqlite.query("UPDATE planned_session_changes SET before_data = ?, after_data = ? WHERE id = ?").run(JSON.stringify(before), JSON.stringify(after), row.id);
      }
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (6, CURRENT_TIMESTAMP)").run();
    })();
  }

  private migrateProfileTrainingRhythmV7(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 7").get()) return;
    this.sqlite.transaction(() => {
      for (const row of this.sqlite.query("SELECT owner_id, data FROM profiles").all() as Array<{ owner_id: string; data: string }>) {
        const legacy = parseJson(row.data) as Record<string, unknown>;
        const trainingDays = Array.isArray(legacy.trainingDays) ? legacy.trainingDays : [];
        const migrated: Record<string, unknown> = {
          ...legacy,
          trainingRhythm: legacy.trainingRhythm ?? (trainingDays.length
            ? { kind: "fixed_week", days: [...new Set(trainingDays)].sort() }
            : { kind: "flexible_week", targetDaysPerWeek: 4, minDaysPerWeek: 3, maxDaysPerWeek: 5 }),
        };
        delete migrated.trainingDays;
        delete migrated.weeklyStrengthSessions;
        delete migrated.weeklyEnduranceSessions;
        delete migrated.priority;
        migrated.preference ??= "";
        this.sqlite.query("UPDATE profiles SET data = ? WHERE owner_id = ?").run(JSON.stringify(athleteProfileSchema.parse(migrateLegacyProfileFields(migrated))), row.owner_id);
      }
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (7, CURRENT_TIMESTAMP)").run();
    })();
  }

  private migratePlanningSchemaV7Reset(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 8").get()) return;
    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS planning_v7_reset_backups (
          table_name TEXT NOT NULL,
          row_id TEXT NOT NULL,
          data TEXT NOT NULL,
          backed_up_at TEXT NOT NULL,
          PRIMARY KEY(table_name, row_id)
        );
        CREATE TABLE IF NOT EXISTS session_templates (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS templates_owner_id ON session_templates(owner_id, id);
        CREATE TABLE IF NOT EXISTS current_mesocycles (owner_id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS planned_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, plan_version_id TEXT, scheduled_date TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS planned_sessions_owner_date ON planned_sessions(owner_id, scheduled_date);
        CREATE TABLE IF NOT EXISTS planned_session_changes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_request_id TEXT NOT NULL, plan_version_id TEXT, scheduled_date TEXT NOT NULL, mode TEXT NOT NULL, before_data TEXT NOT NULL, after_data TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS planned_changes_owner_request_v7 ON planned_session_changes(owner_id, client_request_id);
      `);
      const backup = (table: string, idColumn: string, dataExpression: string) => {
        if (!this.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) return;
        this.sqlite.exec(`INSERT OR IGNORE INTO planning_v7_reset_backups(table_name,row_id,data,backed_up_at) SELECT '${table}', CAST(${idColumn} AS TEXT), ${dataExpression}, CURRENT_TIMESTAMP FROM ${table}`);
      };
      backup("session_templates", "id", "data");
      backup("current_mesocycles", "owner_id", "data");
      backup("planned_sessions", "id", "data");
      backup("planned_session_changes", "id", "json_object('beforeData',before_data,'afterData',after_data)");
      this.sqlite.exec(`
        DELETE FROM session_templates;
        DELETE FROM current_mesocycles;
        DROP TABLE planned_sessions;
        DROP TABLE planned_session_changes;
        CREATE TABLE planned_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, plan_version_id TEXT, scheduled_date TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX planned_sessions_owner_date ON planned_sessions(owner_id, scheduled_date);
        CREATE TABLE planned_session_changes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_request_id TEXT NOT NULL, plan_version_id TEXT, scheduled_date TEXT NOT NULL, mode TEXT NOT NULL, before_data TEXT NOT NULL, after_data TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE UNIQUE INDEX planned_changes_owner_request_v7 ON planned_session_changes(owner_id, client_request_id);
        DROP TABLE IF EXISTS plan_activations;
        DROP TABLE IF EXISTS plan_drafts;
        DROP TABLE IF EXISTS plan_versions;
        INSERT OR IGNORE INTO athria_migrations(version, applied_at) VALUES (4, CURRENT_TIMESTAMP);
        INSERT OR IGNORE INTO athria_migrations(version, applied_at) VALUES (5, CURRENT_TIMESTAMP);
        INSERT OR IGNORE INTO athria_migrations(version, applied_at) VALUES (6, CURRENT_TIMESTAMP);
        INSERT OR IGNORE INTO athria_migrations(version, applied_at) VALUES (8, CURRENT_TIMESTAMP);
      `);
    })();
  }

  private migrateDomainProgressionV7Reset(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 9").get()) return;
    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS domain_progression_v7_reset_backups (
          table_name TEXT NOT NULL,
          row_id TEXT NOT NULL,
          data TEXT NOT NULL,
          backed_up_at TEXT NOT NULL,
          PRIMARY KEY(table_name, row_id)
        );
        INSERT OR IGNORE INTO domain_progression_v7_reset_backups(table_name,row_id,data,backed_up_at)
          SELECT 'current_mesocycles', owner_id, data, CURRENT_TIMESTAMP FROM current_mesocycles;
        INSERT OR IGNORE INTO domain_progression_v7_reset_backups(table_name,row_id,data,backed_up_at)
          SELECT 'planned_sessions', id, data, CURRENT_TIMESTAMP FROM planned_sessions;
        INSERT OR IGNORE INTO domain_progression_v7_reset_backups(table_name,row_id,data,backed_up_at)
          SELECT 'planned_session_changes', id, json_object('beforeData',before_data,'afterData',after_data), CURRENT_TIMESTAMP FROM planned_session_changes;
        DELETE FROM current_mesocycles;
        DELETE FROM planned_sessions;
        DELETE FROM planned_session_changes;
        INSERT INTO athria_migrations(version, applied_at) VALUES (9, CURRENT_TIMESTAMP);
      `);
    })();
  }

  private migrateProfilePreferenceV10(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 10").get()) return;
    this.sqlite.transaction(() => {
      for (const row of this.sqlite.query("SELECT owner_id, data FROM profiles").all() as Array<{ owner_id: string; data: string }>) {
        const legacy = parseJson(row.data) as Record<string, unknown>;
        delete legacy.priority;
        legacy.preference ??= "";
        this.sqlite.query("UPDATE profiles SET data = ? WHERE owner_id = ?").run(JSON.stringify(athleteProfileSchema.parse(migrateLegacyProfileFields(legacy))), row.owner_id);
      }
      for (const row of this.sqlite.query("SELECT id, patch FROM profile_update_proposals WHERE status = 'pending'").all() as Array<{ id: string; patch: string }>) {
        const patch = parseJson(row.patch) as Record<string, unknown>;
        for (const key of ["priority", "trainingDays", "weeklyStrengthSessions", "weeklyEnduranceSessions"]) delete patch[key];
        this.sqlite.query("UPDATE profile_update_proposals SET patch = ? WHERE id = ?").run(JSON.stringify(patch), row.id);
      }
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (10, CURRENT_TIMESTAMP)").run();
    })();
  }

  private migrateSessionTemplatesV11(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 11").get()) return;
    this.sqlite.transaction(() => {
      for (const row of this.sqlite.query("SELECT id, data FROM session_templates").all() as Array<{ id: string; data: string }>) {
        const template = migrateSessionTemplate(parseJson(row.data) as Record<string, unknown>, row.id);
        this.sqlite.query("UPDATE session_templates SET data = ? WHERE id = ?").run(JSON.stringify(templateData(template)), row.id);
      }
      for (const row of this.sqlite.query("SELECT owner_id, data FROM current_mesocycles").all() as Array<{ owner_id: string; data: string }>) {
        const value = parseJson(row.data);
        migrateBuiltinTemplateRefs(value);
        migrateEquipmentFacts(value);
        this.sqlite.query("UPDATE current_mesocycles SET data = ? WHERE owner_id = ?").run(JSON.stringify(currentPlanSchema.parse(value)), row.owner_id);
      }
      if (this.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='planned_sessions'").get()) for (const row of this.sqlite.query("SELECT id, data FROM planned_sessions").all() as Array<{ id: string; data: string }>) {
        const value = parseJson(row.data); migrateBuiltinTemplateRefs(value); migrateEquipmentFacts(value);
        this.sqlite.query("UPDATE planned_sessions SET data = ? WHERE id = ?").run(JSON.stringify(plannedSessionSchema.parse(value)), row.id);
      }
      if (this.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='planned_session_changes'").get()) for (const row of this.sqlite.query("SELECT id, before_data, after_data FROM planned_session_changes").all() as Array<{ id: string; before_data: string; after_data: string }>) {
        const before = parseJson(row.before_data); const after = parseJson(row.after_data); migrateBuiltinTemplateRefs(before); migrateBuiltinTemplateRefs(after);
        this.sqlite.query("UPDATE planned_session_changes SET before_data = ?, after_data = ? WHERE id = ?").run(JSON.stringify(before), JSON.stringify(after), row.id);
      }
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (11, CURRENT_TIMESTAMP)").run();
    })();
  }

  private migrateSimplifiedStorageV12(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 12").get()) return;
    const tableExists = (name: string) => Boolean(this.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
    this.sqlite.transaction(() => {
      if (tableExists("preferences")) {
        for (const row of this.sqlite.query("SELECT owner_id, data FROM preferences").all() as Array<{ owner_id: string; data: string }>) {
          const preference = parseJson(row.data) as Record<string, unknown>;
          const profileRow = this.sqlite.query("SELECT data FROM profiles WHERE owner_id=?").get(row.owner_id) as { data: string } | null;
          if (!profileRow) continue;
          const profile = parseJson(profileRow.data) as Record<string, unknown>;
          if (!("maxSessionMinutes" in profile) && Number.isFinite(Number(preference.preferredSessionMinutes))) profile.maxSessionMinutes = Number(preference.preferredSessionMinutes);
          const notes = typeof preference.notes === "string" ? preference.notes.trim() : "";
          if (!String(profile.preference ?? "").trim() && notes.length <= 80) profile.preference = notes;
          const constraints = Array.isArray(profile.strengthConstraints) ? profile.strengthConstraints as Array<Record<string, unknown>> : [];
          const existing = new Set(constraints.filter((item) => item.type === "exclude_exercise").map((item) => String(item.canonicalKey)));
          for (const key of Array.isArray(preference.dislikedExercises) ? preference.dislikedExercises.map(String) : []) if (key && !existing.has(key)) constraints.push({ type: "exclude_exercise", canonicalKey: key });
          profile.strengthConstraints = constraints;
          this.sqlite.query("UPDATE profiles SET data=? WHERE owner_id=?").run(JSON.stringify(athleteProfileSchema.parse(migrateLegacyProfileFields(profile))), row.owner_id);
        }
      }
      if (tableExists("planned_sessions")) {
        for (const row of this.sqlite.query("SELECT owner_id, data FROM current_mesocycles").all() as Array<{ owner_id: string; data: string }>) {
          const rawPlan = parseJson(row.data); migrateEquipmentFacts(rawPlan); const plan = currentPlanSchema.parse(rawPlan);
          const snapshots = this.sqlite.query("SELECT data FROM planned_sessions WHERE owner_id=?").all(row.owner_id).map((item) => { const value = parseJson((item as { data: string }).data); migrateEquipmentFacts(value); return plannedSessionSchema.parse(value); });
          const byId = new Map(snapshots.map((item) => [item.id, item]));
          const known = new Set(plan.mesocycle.weeks.flatMap((week) => week.sessions.map((session) => session.id)));
          const weeks = plan.mesocycle.weeks.map((week) => ({ ...week, sessions: week.sessions.map((session) => {
            const snapshot = byId.get(session.id); if (!snapshot) return session;
            return { ...session, scheduledDate: snapshot.scheduledDate, order: snapshot.order, status: snapshot.status === "skipped" ? "skipped" as const : "planned" as const, templateRef: snapshot.templateRef, name: snapshot.name, intent: snapshot.intent, durationMinutes: snapshot.durationMinutes, recoveryDemand: snapshot.recoveryDemand, keySession: snapshot.keySession, components: snapshot.components, progressionNote: snapshot.progressionNote, schedulingRationale: snapshot.schedulingRationale, legacySnapshot: snapshot.legacySnapshot };
          }) }));
          for (const snapshot of snapshots.filter((item) => !known.has(item.id))) {
            const week = weeks.find((item) => item.weekNumber === snapshot.weekNumber); if (!week) continue;
            week.sessions.push({ id: snapshot.id, scheduledDate: snapshot.scheduledDate, order: snapshot.order, status: snapshot.status === "skipped" ? "skipped" : "planned", templateRef: snapshot.templateRef, name: snapshot.name, intent: snapshot.intent, durationMinutes: snapshot.durationMinutes, recoveryDemand: snapshot.recoveryDemand, keySession: snapshot.keySession, components: snapshot.components, progressionNote: snapshot.progressionNote, schedulingRationale: snapshot.schedulingRationale, legacySnapshot: snapshot.legacySnapshot });
          }
          const migrated = currentPlanSchema.parse({ ...plan, mesocycle: { ...plan.mesocycle, weeks } });
          this.sqlite.query("UPDATE current_mesocycles SET data=? WHERE owner_id=?").run(JSON.stringify(migrated), row.owner_id);
          for (const snapshot of snapshots) if (snapshot.completedTrainingSessionId) {
            const training = this.sqlite.query("SELECT data FROM training_sessions WHERE id=? AND owner_id=?").get(snapshot.completedTrainingSessionId, row.owner_id) as { data: string } | null;
            if (training) this.sqlite.query("UPDATE training_sessions SET data=? WHERE id=?").run(JSON.stringify(trainingSessionSchema.parse({ ...(parseJson(training.data) as object), status: "completed", plannedSessionId: snapshot.id })), snapshot.completedTrainingSessionId);
          }
        }
      }
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS wellness (owner_id TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS wellness_owner_day_v12 ON wellness(owner_id, day);
      `);
      if (tableExists("wellness_daily")) {
        for (const row of this.sqlite.query("SELECT owner_id, day, data FROM wellness_daily").all() as Array<{ owner_id: string; day: string; data: string }>) {
          const value = parseJson(row.data) as Record<string, unknown>; const updatedAt = this.now().toISOString(); const fields: Record<string, unknown> = {};
          const aliases: Record<string, string[]> = { restingHeartRateBpm: ["restingHR", "restingHeartRate"], hrvRmssdMs: ["hrv", "hrvRmssd"], sleepSeconds: ["sleepSecs", "sleepSeconds"], sleepScore: ["sleepScore"], weightKg: ["weight"], fatigue: ["fatigue"], soreness: ["soreness"], stress: ["stress"], mood: ["mood"], motivation: ["motivation"], readiness: ["readiness"] };
          for (const [field, names] of Object.entries(aliases)) { const raw = names.map((name) => value[name]).find((item) => item !== undefined && item !== null && item !== ""); const number = Number(raw); if (raw !== undefined && Number.isFinite(number)) fields[field] = { value: number, source: "intervals_icu", updatedAt }; }
          const record = wellnessRecordSchema.parse({ ownerId: row.owner_id, day: row.day, fields, updatedAt });
          this.sqlite.query("INSERT INTO wellness VALUES (?,?,?,?) ON CONFLICT(owner_id,day) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at").run(row.owner_id, row.day, JSON.stringify(record), updatedAt);
        }
      }
      this.sqlite.exec(`
        DROP TABLE IF EXISTS preferences; DROP TABLE IF EXISTS exercises; DROP TABLE IF EXISTS planned_sessions; DROP TABLE IF EXISTS planned_session_changes;
        DROP TABLE IF EXISTS raw_records; DROP TABLE IF EXISTS profile_update_proposals; DROP TABLE IF EXISTS approvals; DROP TABLE IF EXISTS plan_drafts;
        DROP TABLE IF EXISTS plan_versions; DROP TABLE IF EXISTS plan_activations; DROP TABLE IF EXISTS plan_schema_migration_backups;
        DROP TABLE IF EXISTS planning_v7_reset_backups; DROP TABLE IF EXISTS domain_progression_v7_reset_backups; DROP TABLE IF EXISTS wellness_daily;
        INSERT INTO athria_migrations(version, applied_at) VALUES (12, CURRENT_TIMESTAMP);
      `);
    })();
  }

  private migrateProfileConstraintsV13(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 13").get()) return;
    this.sqlite.transaction(() => {
      for (const row of this.sqlite.query("SELECT owner_id, data FROM profiles").all() as Array<{ owner_id: string; data: string }>) {
        const profile = migrateLegacyProfileFields(parseJson(row.data) as Record<string, unknown>);
        this.sqlite.query("UPDATE profiles SET data = ? WHERE owner_id = ?").run(JSON.stringify(athleteProfileSchema.parse(profile)), row.owner_id);
      }
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (13, CURRENT_TIMESTAMP)").run();
    })();
  }

  private migrateProfileNotesV14(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 14").get()) return;
    this.sqlite.transaction(() => {
      for (const row of this.sqlite.query("SELECT owner_id, data FROM profiles").all() as Array<{ owner_id: string; data: string }>) {
        const profile = migrateLegacyProfileFields(parseJson(row.data) as Record<string, unknown>);
        this.sqlite.query("UPDATE profiles SET data = ? WHERE owner_id = ?").run(JSON.stringify(athleteProfileSchema.parse(profile)), row.owner_id);
      }
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (14, CURRENT_TIMESTAMP)").run();
    })();
  }

  // Plan targets no longer carry the free-text `constraints` chips; strip the
  // legacy key so the strict currentPlanSchema keeps parsing stored plans.
  private migratePlanTargetV15(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 15").get()) return;
    this.sqlite.transaction(() => {
      for (const row of this.sqlite.query("SELECT owner_id, data FROM current_mesocycles").all() as Array<{ owner_id: string; data: string }>) {
        const plan = parseJson(row.data) as Record<string, unknown>;
        migrateEquipmentFacts(plan);
        const target = plan.target;
        if (typeof target !== "object" || target === null || !("constraints" in (target as Record<string, unknown>))) continue;
        delete (target as Record<string, unknown>).constraints;
        this.sqlite.query("UPDATE current_mesocycles SET data = ? WHERE owner_id = ?").run(JSON.stringify(currentPlanSchema.parse(plan)), row.owner_id);
      }
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (15, CURRENT_TIMESTAMP)").run();
    })();
  }

  private migrateEquipmentCatalogV16(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 16").get()) return;
    this.sqlite.transaction(() => {
      for (const row of this.sqlite.query("SELECT owner_id, data FROM profiles").all() as Array<{ owner_id: string; data: string }>) {
        const profile = migrateLegacyProfileFields(parseJson(row.data) as Record<string, unknown>);
        this.sqlite.query("UPDATE profiles SET data = ? WHERE owner_id = ?").run(JSON.stringify(athleteProfileSchema.parse(profile)), row.owner_id);
      }
      for (const row of this.sqlite.query("SELECT owner_id, data FROM current_mesocycles").all() as Array<{ owner_id: string; data: string }>) {
        const plan = parseJson(row.data);
        migrateEquipmentFacts(plan);
        this.sqlite.query("UPDATE current_mesocycles SET data = ? WHERE owner_id = ?").run(JSON.stringify(currentPlanSchema.parse(plan)), row.owner_id);
      }
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (16, CURRENT_TIMESTAMP)").run();
    })();
  }

  private migratePersonalInformationV17(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 17").get()) return;
    this.sqlite.transaction(() => {
      for (const row of this.sqlite.query("SELECT owner_id, data FROM profiles").all() as Array<{ owner_id: string; data: string }>) {
        const profile = migrateLegacyProfileFields(parseJson(row.data) as Record<string, unknown>);
        this.sqlite.query("UPDATE profiles SET data = ? WHERE owner_id = ?").run(JSON.stringify(athleteProfileSchema.parse(profile)), row.owner_id);
      }
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (17, CURRENT_TIMESTAMP)").run();
    })();
  }

  private migrateWorkoutReconciliationV18(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 18").get()) return;
    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        CREATE TABLE training_session_sources (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, training_session_id TEXT NOT NULL,
          source TEXT NOT NULL, external_id TEXT NOT NULL, local_date TEXT NOT NULL,
          start_at TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX session_sources_owner_source_external ON training_session_sources(owner_id,source,external_id);
        CREATE INDEX session_sources_owner_date ON training_session_sources(owner_id,local_date);
        CREATE INDEX session_sources_canonical ON training_session_sources(training_session_id);
        CREATE TABLE plan_workout_matches (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, planned_session_id TEXT NOT NULL,
          training_session_id TEXT NOT NULL, method TEXT NOT NULL, confidence INTEGER NOT NULL,
          algorithm_version TEXT NOT NULL, evidence TEXT NOT NULL, matched_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX plan_matches_owner_plan ON plan_workout_matches(owner_id,planned_session_id);
        CREATE UNIQUE INDEX plan_matches_owner_workout ON plan_workout_matches(owner_id,training_session_id);
      `);
      const rows = this.sqlite.query("SELECT id,owner_id,source,external_id,start_at,data FROM training_sessions ORDER BY owner_id,source,start_at,id").all() as Array<{ id: string; owner_id: string; source: string; external_id: string; start_at: string; data: string }>;
      const parsed = rows.map((row) => ({ row, session: trainingSessionSchema.parse(parseJson(row.data)) }));
      const superseded = new Set<string>();
      for (const item of parsed) {
        if (item.session.durationMinutes > 0 || item.session.modality !== "unknown") continue;
        const replacement = parsed.find((candidate) => candidate.row.id !== item.row.id && candidate.row.owner_id === item.row.owner_id && candidate.row.source === item.row.source && candidate.session.startAt === item.session.startAt && (candidate.session.durationMinutes > 0 || candidate.session.modality !== "unknown"));
        if (replacement) superseded.add(item.row.id);
      }
      const timestamp = this.now().toISOString();
      for (const { row, session } of parsed.filter((item) => !superseded.has(item.row.id))) {
        const timezone = session.timezone ?? this.getProfile(row.owner_id).timezone;
        this.sqlite.query("INSERT INTO training_session_sources(id,owner_id,training_session_id,source,external_id,local_date,start_at,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(`source:${row.id}`, row.owner_id, row.id, row.source, row.external_id, localDate(row.start_at, timezone), row.start_at, row.data, timestamp, timestamp);
        if (session.plannedSessionId) this.insertPlanMatch(row.owner_id, session.plannedSessionId, row.id, session.source === "manual" ? "manual" : "auto", session.source === "manual" ? 100 : 80, { migrated: true });
      }
      for (const ownerId of [...new Set(parsed.map((item) => item.row.owner_id))]) this.rebuildCanonicalSessions(ownerId);
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (18, CURRENT_TIMESTAMP)").run();
    })();
  }

  private migratePlanReconciliationUxV19(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 19").get()) return;
    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        CREATE TABLE planned_session_events (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, planned_session_id TEXT NOT NULL,
          action TEXT NOT NULL, from_date TEXT, to_date TEXT, reason_code TEXT, reason_note TEXT,
          revision_before INTEGER NOT NULL, revision_after INTEGER NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX planned_session_events_owner_session ON planned_session_events(owner_id,planned_session_id);
        CREATE TABLE workout_plan_exclusions (
          owner_id TEXT NOT NULL, training_session_id TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX workout_plan_exclusions_owner_workout ON workout_plan_exclusions(owner_id,training_session_id);
      `);
      const matches = this.sqlite.query("SELECT owner_id,planned_session_id,training_session_id FROM plan_workout_matches WHERE method='manual'").all() as Array<{ owner_id: string; planned_session_id: string; training_session_id: string }>;
      for (const match of matches) {
        const plan = this.getCurrentPlan(match.owner_id);
        const planned = plan?.mesocycle.weeks.flatMap((week) => week.sessions).find((session) => session.id === match.planned_session_id);
        if (!planned) continue;
        const rows = this.sqlite.query("SELECT id,data FROM training_session_sources WHERE owner_id=? AND training_session_id=? AND source='manual'").all(match.owner_id, match.training_session_id) as Array<{ id: string; data: string }>;
        for (const row of rows) {
          const session = trainingSessionSchema.parse(parseJson(row.data));
          const placeholder = session.durationMinutes === planned.durationMinutes && session.strengthSets.length === 0 && session.endurance === null && session.missingFields.includes("exercise details");
          if (!placeholder) continue;
          const startAt = localNoon(planned.scheduledDate, session.timezone ?? this.getProfile(match.owner_id).timezone); const endAt = new Date(startAt.getTime() + session.durationMinutes * 60_000);
          const migrated = trainingSessionSchema.parse({ ...session, startAt: startAt.toISOString(), endAt: endAt.toISOString(), timePrecision: "date_only", missingFields: [...new Set([...session.missingFields, "actual start time"])] });
          this.sqlite.query("UPDATE training_session_sources SET local_date=?,start_at=?,data=?,updated_at=? WHERE id=?").run(planned.scheduledDate, migrated.startAt, JSON.stringify(migrated), this.now().toISOString(), row.id);
        }
      }
      for (const ownerId of [...new Set(matches.map((match) => match.owner_id))]) this.rebuildCanonicalSessions(ownerId);
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (19, CURRENT_TIMESTAMP)").run();
    })();
  }

  private migrateTrainingSessionTypeOverridesV20(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 20").get()) return;
    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        CREATE TABLE training_session_type_overrides (
          owner_id TEXT NOT NULL, training_session_id TEXT NOT NULL,
          domain TEXT NOT NULL CHECK(domain IN ('strength','endurance','sport_skill','mind_body','recovery')),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(owner_id, training_session_id)
        );
        CREATE INDEX training_session_type_overrides_owner ON training_session_type_overrides(owner_id);
      `);
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (20, CURRENT_TIMESTAMP)").run();
    })();
  }

  // Built-in templates stay in code; dismissing one hides it from the library
  // without deleting the immutable original that plan references still resolve.
  private migrateTemplateDismissalsV21(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 21").get()) return;
    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        CREATE TABLE template_dismissals (
          owner_id TEXT NOT NULL, template_id TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX template_dismissals_owner_template ON template_dismissals(owner_id, template_id);
      `);
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (21, CURRENT_TIMESTAMP)").run();
    })();
  }

  // Profiles gain optional race-day targets; stored rows predating the field
  // default to an empty list via the schema default.
  private migrateProfileRaceDaysV22(): void {
    if (this.sqlite.query("SELECT version FROM athria_migrations WHERE version = 22").get()) return;
    this.sqlite.transaction(() => {
      for (const row of this.sqlite.query("SELECT owner_id, data FROM profiles").all() as Array<{ owner_id: string; data: string }>) {
        const profile = migrateLegacyProfileFields(parseJson(row.data) as Record<string, unknown>);
        this.sqlite.query("UPDATE profiles SET data = ? WHERE owner_id = ?").run(JSON.stringify(athleteProfileSchema.parse(profile)), row.owner_id);
      }
      this.sqlite.query("INSERT INTO athria_migrations(version, applied_at) VALUES (22, CURRENT_TIMESTAMP)").run();
    })();
  }

  close(): void { this.sqlite.close(); }

  getProfile(ownerId = "local-user"): AthleteProfile {
    const row = this.db.select().from(schema.profiles).where(eq(schema.profiles.ownerId, ownerId)).get();
    if (!row) return defaultProfile();
    return athleteProfileSchema.parse(parseJson(row.data));
  }

  saveProfile(profile: AthleteProfile): AthleteProfile {
    const parsed = athleteProfileSchema.parse(profile);
    const updatedAt = this.now().toISOString();
    this.db.insert(schema.profiles).values({ ownerId: parsed.ownerId, data: parsed, updatedAt }).onConflictDoUpdate({ target: schema.profiles.ownerId, set: { data: parsed, updatedAt } }).run();
    return parsed;
  }

  private matchDetails(ownerId: string): Map<string, { plannedSessionId: string; method: "auto" | "manual" }> {
    const rows = this.sqlite.query("SELECT training_session_id,planned_session_id,method FROM plan_workout_matches WHERE owner_id=?").all(ownerId) as Array<{ training_session_id: string; planned_session_id: string; method: "auto" | "manual" }>;
    return new Map(rows.map((row) => [row.training_session_id, { plannedSessionId: row.planned_session_id, method: row.method }]));
  }

  private sourceSummaries(ownerId: string): Map<string, Array<{ source: string; externalId: string }>> {
    const rows = this.sqlite.query("SELECT training_session_id,source,external_id FROM training_session_sources WHERE owner_id=? ORDER BY source,external_id").all(ownerId) as Array<{ training_session_id: string; source: string; external_id: string }>;
    const summaries = new Map<string, Array<{ source: string; externalId: string }>>();
    for (const row of rows) summaries.set(row.training_session_id, [...(summaries.get(row.training_session_id) ?? []), { source: row.source, externalId: row.external_id }]);
    return summaries;
  }

  private typeOverrides(ownerId: string): Map<string, TrainingSession["domains"][number]> {
    const rows = this.sqlite.query("SELECT training_session_id,domain FROM training_session_type_overrides WHERE owner_id=?").all(ownerId) as Array<{ training_session_id: string; domain: TrainingSession["domains"][number] }>;
    return new Map(rows.map((row) => [row.training_session_id, row.domain]));
  }

  private withDerivedMatch(session: TrainingSession, matches: Map<string, { plannedSessionId: string; method: "auto" | "manual" }>, sources: Map<string, Array<{ source: string; externalId: string }>>, excluded = new Set<string>(), overrides = new Map<string, TrainingSession["domains"][number]>()): TrainingSession {
    const match = matches.get(session.id) ?? null;
    const domain = overrides.get(session.id);
    return trainingSessionSchema.parse({ ...session, domains: domain ? [domain] : session.domains, missingFields: domain ? session.missingFields.filter((field) => field !== "domains") : session.missingFields, plannedSessionId: match?.plannedSessionId ?? null, planMatch: match, sources: sources.get(session.id) ?? [{ source: session.source, externalId: session.externalId }], isPlanMatchExcluded: excluded.has(session.id) });
  }

  private insertPlanMatch(ownerId: string, plannedSessionId: string, trainingSessionId: string, method: "manual" | "auto", confidence: number, evidence: Record<string, unknown>): void {
    const existingPlan = this.sqlite.query("SELECT method,training_session_id FROM plan_workout_matches WHERE owner_id=? AND planned_session_id=?").get(ownerId, plannedSessionId) as { method: string; training_session_id: string } | null;
    const existingWorkout = this.sqlite.query("SELECT method,planned_session_id FROM plan_workout_matches WHERE owner_id=? AND training_session_id=?").get(ownerId, trainingSessionId) as { method: string; planned_session_id: string } | null;
    if (method === "auto" && (existingPlan || existingWorkout)) return;
    if (method === "manual" && existingPlan?.training_session_id === trainingSessionId && existingWorkout?.planned_session_id === plannedSessionId) return;
    if (method === "manual") this.sqlite.query("DELETE FROM plan_workout_matches WHERE owner_id=? AND (planned_session_id=? OR training_session_id=?)").run(ownerId, plannedSessionId, trainingSessionId);
    this.sqlite.query("INSERT INTO plan_workout_matches(id,owner_id,planned_session_id,training_session_id,method,confidence,algorithm_version,evidence,matched_at) VALUES (?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), ownerId, plannedSessionId, trainingSessionId, method, Math.round(confidence), RECONCILIATION_VERSION, JSON.stringify(evidence), this.now().toISOString());
  }

  private rebuildCanonicalSessions(ownerId: string): void {
    const rows = this.sqlite.query("SELECT id,training_session_id,data,created_at FROM training_session_sources WHERE owner_id=?").all(ownerId) as Array<{ id: string; training_session_id: string; data: string; created_at: string }>;
    const observations: SourceObservation[] = rows.map((row) => ({ id: row.id, canonicalId: row.training_session_id, session: trainingSessionSchema.parse(parseJson(row.data)), createdAt: row.created_at }));
    const existingRows = this.sqlite.query("SELECT id,data FROM training_sessions WHERE owner_id=?").all(ownerId) as Array<{ id: string; data: string }>;
    const existing = new Map(existingRows.map((row) => [row.id, trainingSessionSchema.parse(parseJson(row.data))]));
    const linked = new Set((this.sqlite.query("SELECT training_session_id FROM plan_workout_matches WHERE owner_id=?").all(ownerId) as Array<{ training_session_id: string }>).map((row) => row.training_session_id));
    const hasExclusions = Boolean(this.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='workout_plan_exclusions'").get());
    const excluded = new Set(hasExclusions ? (this.sqlite.query("SELECT training_session_id FROM workout_plan_exclusions WHERE owner_id=?").all(ownerId) as Array<{ training_session_id: string }>).map((row) => row.training_session_id) : []);
    const hasTypeOverrides = Boolean(this.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='training_session_type_overrides'").get());
    const overrideIds = new Set(hasTypeOverrides ? [...this.typeOverrides(ownerId).keys()] : []);
    const protectedIds = new Set([...linked, ...excluded, ...overrideIds]);
    const usedIds = new Set<string>();
    const canonical: TrainingSession[] = [];
    const assignments = new Map<string, string>();
    for (const cluster of clusterObservations(observations)) {
      const memberIds = [...new Set(cluster.map((item) => item.canonicalId))];
      let id = memberIds.find((candidate) => protectedIds.has(candidate) && !usedIds.has(candidate)) ?? memberIds.find((candidate) => existing.has(candidate) && !usedIds.has(candidate));
      if (!id) {
        const representative = [...cluster].sort((a, b) => informationScore(b.session) - informationScore(a.session) || a.id.localeCompare(b.id))[0]!.session;
        const reusable = [...existing].filter(([candidate]) => !usedIds.has(candidate)).map(([candidate, session]) => ({ candidate, score: duplicateScore({ ...representative, source: `incoming:${representative.source}` }, session) ?? -1 })).sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))[0];
        id = reusable && reusable.score >= 75 ? reusable.candidate : memberIds.find((candidate) => !usedIds.has(candidate)) ?? crypto.randomUUID();
      }
      usedIds.add(id);
      const representative = [...cluster].sort((a, b) => informationScore(b.session) - informationScore(a.session) || a.id.localeCompare(b.id))[0]!.session;
      canonical.push(trainingSessionSchema.parse({ ...representative, id, ownerId, plannedSessionId: null }));
      for (const observation of cluster) assignments.set(observation.id, id);
      if (memberIds.some((candidate) => excluded.has(candidate))) excluded.add(id);
    }
    this.sqlite.query("DELETE FROM training_sessions WHERE owner_id=?").run(ownerId);
    for (const session of canonical) this.sqlite.query("INSERT INTO training_sessions(id,owner_id,source,external_id,modality,start_at,data) VALUES (?,?,?,?,?,?,?)").run(session.id, ownerId, session.source, session.externalId, session.modality, session.startAt, JSON.stringify(session));
    for (const [sourceId, canonicalId] of assignments) this.sqlite.query("UPDATE training_session_sources SET training_session_id=? WHERE id=?").run(canonicalId, sourceId);
    this.sqlite.query("DELETE FROM plan_workout_matches WHERE owner_id=? AND training_session_id NOT IN (SELECT id FROM training_sessions WHERE owner_id=?)").run(ownerId, ownerId);
    if (hasTypeOverrides) this.sqlite.query("DELETE FROM training_session_type_overrides WHERE owner_id=? AND training_session_id NOT IN (SELECT id FROM training_sessions WHERE owner_id=?)").run(ownerId, ownerId);
    if (hasExclusions) {
      this.sqlite.query("DELETE FROM workout_plan_exclusions WHERE owner_id=?").run(ownerId);
      for (const trainingSessionId of [...excluded].filter((id) => usedIds.has(id))) this.sqlite.query("INSERT INTO workout_plan_exclusions(owner_id,training_session_id,created_at) VALUES (?,?,?)").run(ownerId, trainingSessionId, this.now().toISOString());
    }
  }

  private reconcilePlanMatches(ownerId: string): void {
    const plan = this.getCurrentPlan(ownerId);
    if (!plan) return;
    const planned = plan.mesocycle.weeks.flatMap((week) => week.sessions).filter((session) => session.status !== "skipped");
    const plannedIds = new Set(planned.map((session) => session.id));
    this.sqlite.query("DELETE FROM plan_workout_matches WHERE owner_id=? AND method='auto'").run(ownerId);
    const manual = this.sqlite.query("SELECT planned_session_id,training_session_id FROM plan_workout_matches WHERE owner_id=? AND method='manual'").all(ownerId) as Array<{ planned_session_id: string; training_session_id: string }>;
    for (const row of manual) if (!plannedIds.has(row.planned_session_id)) this.sqlite.query("DELETE FROM plan_workout_matches WHERE owner_id=? AND planned_session_id=?").run(ownerId, row.planned_session_id);
    const occupiedPlans = new Set(manual.map((row) => row.planned_session_id)); const occupiedWorkouts = new Set(manual.map((row) => row.training_session_id));
    const excluded = new Set((this.sqlite.query("SELECT training_session_id FROM workout_plan_exclusions WHERE owner_id=?").all(ownerId) as Array<{ training_session_id: string }>).map((row) => row.training_session_id));
    const workouts = this.listSessions(ownerId).filter((session) => !occupiedWorkouts.has(session.id) && !excluded.has(session.id));
    const candidates = planned.filter((session) => !occupiedPlans.has(session.id)).flatMap((session) => workouts.map((workout) => ({ session, workout, score: planMatchScore(session, workout, this.getProfile(ownerId).timezone) })).filter((item) => item.score !== null && item.score >= 70)) as Array<{ session: typeof planned[number]; workout: TrainingSession; score: number }>;
    candidates.sort((a, b) => b.score - a.score || a.session.id.localeCompare(b.session.id) || a.workout.id.localeCompare(b.workout.id));
    const usedPlans = new Set<string>(); const usedWorkouts = new Set<string>();
    for (const candidate of candidates) {
      const planAlternative = candidates.filter((item) => item.session.id === candidate.session.id && item.workout.id !== candidate.workout.id)[0]?.score ?? -Infinity;
      const workoutAlternative = candidates.filter((item) => item.workout.id === candidate.workout.id && item.session.id !== candidate.session.id)[0]?.score ?? -Infinity;
      if (candidate.score - planAlternative < 10 || candidate.score - workoutAlternative < 10 || usedPlans.has(candidate.session.id) || usedWorkouts.has(candidate.workout.id)) continue;
      this.insertPlanMatch(ownerId, candidate.session.id, candidate.workout.id, "auto", candidate.score, { scheduledDate: candidate.session.scheduledDate, score: candidate.score });
      usedPlans.add(candidate.session.id); usedWorkouts.add(candidate.workout.id);
    }
  }

  listSessions(ownerId = "local-user", since?: string): TrainingSession[] {
    const condition = since ? and(eq(schema.trainingSessions.ownerId, ownerId), gte(schema.trainingSessions.startAt, since)) : eq(schema.trainingSessions.ownerId, ownerId);
    const matches = this.matchDetails(ownerId); const sources = this.sourceSummaries(ownerId);
    const excluded = new Set((this.sqlite.query("SELECT training_session_id FROM workout_plan_exclusions WHERE owner_id=?").all(ownerId) as Array<{ training_session_id: string }>).map((row) => row.training_session_id));
    const overrides = this.typeOverrides(ownerId);
    return this.db.select().from(schema.trainingSessions).where(condition).orderBy(desc(schema.trainingSessions.startAt)).all().map((row) => this.withDerivedMatch(trainingSessionSchema.parse(parseJson(row.data)), matches, sources, excluded, overrides));
  }

  listSessionsBySource(source: string, ownerId = "local-user", since?: string): TrainingSession[] {
    const rows = this.sqlite.query(`SELECT data,training_session_id FROM training_session_sources WHERE owner_id=? AND source=? ${since ? "AND start_at>=?" : ""} ORDER BY start_at DESC`).all(...(since ? [ownerId, source, since] : [ownerId, source])) as Array<{ data: string; training_session_id: string }>;
    const matches = this.matchDetails(ownerId);
    return rows.map((row) => { const session = trainingSessionSchema.parse(parseJson(row.data)); const match = matches.get(row.training_session_id) ?? null; return trainingSessionSchema.parse({ ...session, plannedSessionId: match?.plannedSessionId ?? null, planMatch: match, sources: [{ source: session.source, externalId: session.externalId }] }); });
  }

  upsertSessions(sessions: TrainingSession[]): { added: number; updated: number } {
    const counts = { added: 0, updated: 0 };
    this.sqlite.transaction(() => {
      for (const value of sessions.map((item) => trainingSessionSchema.parse(item))) {
        const existing = this.sqlite.query("SELECT id,created_at FROM training_session_sources WHERE owner_id=? AND source=? AND external_id=?").get(value.ownerId, value.source, value.externalId) as { id: string; created_at: string } | null;
        if (existing) counts.updated += 1; else counts.added += 1;
        const timezone = value.timezone ?? this.getProfile(value.ownerId).timezone; const timestamp = this.now().toISOString();
        this.sqlite.query("INSERT INTO training_session_sources(id,owner_id,training_session_id,source,external_id,local_date,start_at,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,source,external_id) DO UPDATE SET local_date=excluded.local_date,start_at=excluded.start_at,data=excluded.data,updated_at=excluded.updated_at").run(existing?.id ?? crypto.randomUUID(), value.ownerId, existing ? (this.sqlite.query("SELECT training_session_id FROM training_session_sources WHERE id=?").get(existing.id) as { training_session_id: string }).training_session_id : value.id, value.source, value.externalId, localDate(value.startAt, timezone), value.startAt, JSON.stringify({ ...value, plannedSessionId: null }), existing?.created_at ?? timestamp, timestamp);
      }
      for (const ownerId of [...new Set(sessions.map((session) => session.ownerId))]) {
        this.rebuildCanonicalSessions(ownerId);
        for (const value of sessions.filter((session) => session.ownerId === ownerId && session.plannedSessionId)) {
          const source = this.sqlite.query("SELECT training_session_id FROM training_session_sources WHERE owner_id=? AND source=? AND external_id=?").get(ownerId, value.source, value.externalId) as { training_session_id: string };
          this.insertPlanMatch(ownerId, value.plannedSessionId!, source.training_session_id, value.source === "manual" ? "manual" : "auto", value.source === "manual" ? 100 : 80, { explicitSourceLink: true });
        }
        this.reconcilePlanMatches(ownerId);
      }
    })();
    return counts;
  }

  replaceSourceSessions(input: { ownerId?: string; source: string; sessions: TrainingSession[]; dates?: string[]; localDates?: Record<string, string>; rangeStart?: string; rangeEnd?: string }): { added: number; updated: number } {
    const ownerId = input.ownerId ?? "local-user"; const parsed = input.sessions.map((session) => trainingSessionSchema.parse({ ...session, ownerId, source: input.source }));
    return this.sqlite.transaction(() => {
      const existingIds = new Set((this.sqlite.query(`SELECT external_id FROM training_session_sources WHERE owner_id=? AND source=? ${input.dates ? `AND local_date IN (${input.dates.map(() => "?").join(",")})` : "AND local_date>=? AND local_date<=?"}`).all(ownerId, input.source, ...(input.dates ?? [input.rangeStart!, input.rangeEnd!])) as Array<{ external_id: string }>).map((row) => row.external_id));
      if (input.dates) this.sqlite.query(`DELETE FROM training_session_sources WHERE owner_id=? AND source=? AND local_date IN (${input.dates.map(() => "?").join(",")})`).run(ownerId, input.source, ...input.dates);
      else this.sqlite.query("DELETE FROM training_session_sources WHERE owner_id=? AND source=? AND local_date>=? AND local_date<=?").run(ownerId, input.source, input.rangeStart!, input.rangeEnd!);
      const timestamp = this.now().toISOString();
      for (const value of parsed) {
        const timezone = value.timezone ?? this.getProfile(ownerId).timezone;
        this.sqlite.query("INSERT INTO training_session_sources(id,owner_id,training_session_id,source,external_id,local_date,start_at,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), ownerId, value.id, value.source, value.externalId, input.localDates?.[value.externalId] ?? localDate(value.startAt, timezone), value.startAt, JSON.stringify({ ...value, plannedSessionId: null }), timestamp, timestamp);
      }
      this.rebuildCanonicalSessions(ownerId); this.reconcilePlanMatches(ownerId);
      return { added: parsed.filter((session) => !existingIds.has(session.externalId)).length, updated: parsed.filter((session) => existingIds.has(session.externalId)).length };
    })();
  }

  recordImportBatch(input: { ownerId: string; source: string; contentHash: string; fileName: string; parserVersion: string; status: string; data: unknown }) {
    const existing = this.db.select().from(schema.importBatches).where(and(eq(schema.importBatches.ownerId, input.ownerId), eq(schema.importBatches.source, input.source), eq(schema.importBatches.contentHash, input.contentHash))).get();
    if (existing) return existing;
    const row = { id: crypto.randomUUID(), ...input, createdAt: this.now().toISOString() };
    this.db.insert(schema.importBatches).values(row).run();
    return row;
  }

  latestImportBatch(ownerId = "local-user", source = "hevy") {
    return this.db.select().from(schema.importBatches).where(and(eq(schema.importBatches.ownerId, ownerId), eq(schema.importBatches.source, source))).orderBy(desc(schema.importBatches.createdAt)).get() ?? null;
  }

  getConnectionSyncState(source: string, ownerId = "local-user") {
    const row = this.db.select().from(schema.connectionSyncState).where(and(eq(schema.connectionSyncState.ownerId, ownerId), eq(schema.connectionSyncState.source, source))).get();
    return row ? { ...row, data: parseJson(row.data) as Record<string, unknown> } : null;
  }

  saveConnectionSyncState(input: { ownerId?: string; source: string; lastAttemptAt: string; lastSuccessAt: string | null; rangeStart: string; rangeEnd: string; status: "success" | "partial" | "failed"; data: Record<string, unknown> }) {
    const value = { ownerId: input.ownerId ?? "local-user", ...input };
    this.db.insert(schema.connectionSyncState).values(value).onConflictDoUpdate({
      target: [schema.connectionSyncState.ownerId, schema.connectionSyncState.source],
      set: { lastAttemptAt: value.lastAttemptAt, lastSuccessAt: value.lastSuccessAt, rangeStart: value.rangeStart, rangeEnd: value.rangeEnd, status: value.status, data: value.data },
    }).run();
    return this.getConnectionSyncState(value.source, value.ownerId)!;
  }

  upsertWellness(ownerId: string, records: unknown[]): number {
    let stored = 0;
    this.sqlite.transaction(() => {
      for (const payload of records) {
        if (typeof payload !== "object" || payload === null) continue;
        const value = payload as Record<string, unknown>;
        const day = String(value.id ?? value.day ?? value.date ?? "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        const existing = this.getWellness(ownerId, day);
        const updatedAt = this.now().toISOString();
        const aliases: Record<string, string[]> = { restingHeartRateBpm: ["restingHR", "restingHeartRate"], hrvRmssdMs: ["hrv", "hrvRmssd"], hrvSdnnMs: ["hrvSDNN", "hrvSdnn"], sleepSeconds: ["sleepSecs", "sleepSeconds"], sleepScore: ["sleepScore"], sleepQuality: ["sleepQuality"], avgSleepingHeartRateBpm: ["avgSleepingHR"], weightKg: ["weight"], bodyFatPercent: ["bodyFat"], vo2maxMlKgMin: ["vo2max"], spo2Percent: ["spO2"], stepsCount: ["steps"], respirationRpm: ["respiration"], fatigue: ["fatigue"], soreness: ["soreness"], stress: ["stress"], mood: ["mood"], motivation: ["motivation"], readiness: ["readiness"], injuryScore: ["injury"], eftpWatts: ["eftpWatts"], wPrimeJoules: ["wPrimeJoules"], pMaxWatts: ["pMaxWatts"] };
        const sportInfo = Array.isArray(value.sportInfo) ? value.sportInfo.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
        const power = sportInfo.find((item) => item.type === "Ride") ?? sportInfo.find((item) => ["eftp", "wPrime", "pMax"].some((key) => item[key] !== undefined && item[key] !== null));
        const extended = power ? { ...value, eftpWatts: power.eftp, wPrimeJoules: power.wPrime, pMaxWatts: power.pMax } : value;
        const fields = { ...(existing?.fields ?? {}) } as WellnessRecord["fields"];
        for (const [field, names] of Object.entries(aliases)) {
          const prior = fields[field as keyof typeof fields];
          if (prior && prior.source !== "intervals_icu") continue;
          const raw = names.map((name) => extended[name]).find((item) => item !== undefined && item !== null && item !== "");
          const number = Number(raw); if (raw !== undefined && Number.isFinite(number)) (fields as Record<string, unknown>)[field] = { value: number, source: "intervals_icu", updatedAt };
        }
        const record = wellnessRecordSchema.parse({ ownerId, day, fields, updatedAt });
        this.db.insert(schema.wellness).values({ ownerId, day, data: record, updatedAt }).onConflictDoUpdate({ target: [schema.wellness.ownerId, schema.wellness.day], set: { data: record, updatedAt } }).run();
        stored += 1;
      }
    })();
    return stored;
  }

  getWellness(ownerId: string, day: string): WellnessRecord | null {
    const row = this.db.select().from(schema.wellness).where(and(eq(schema.wellness.ownerId, ownerId), eq(schema.wellness.day, day))).get();
    return row ? wellnessRecordSchema.parse(parseJson(row.data)) : null;
  }

  listWellness(ownerId = "local-user", since?: string): WellnessRecord[] {
    const rows = this.db.select().from(schema.wellness).where(eq(schema.wellness.ownerId, ownerId)).orderBy(desc(schema.wellness.day)).all();
    return rows.filter((row) => !since || row.day >= since).map((row) => wellnessRecordSchema.parse(parseJson(row.data)));
  }

  saveWellness(record: WellnessRecord): WellnessRecord {
    const parsed = wellnessRecordSchema.parse(record);
    this.db.insert(schema.wellness).values({ ownerId: parsed.ownerId, day: parsed.day, data: parsed, updatedAt: parsed.updatedAt }).onConflictDoUpdate({ target: [schema.wellness.ownerId, schema.wellness.day], set: { data: parsed, updatedAt: parsed.updatedAt } }).run();
    return parsed;
  }

  listTemplates(ownerId = "local-user"): StoredSessionTemplate[] {
    return this.db.select().from(schema.sessionTemplates).where(eq(schema.sessionTemplates.ownerId, ownerId)).orderBy(desc(schema.sessionTemplates.updatedAt)).all().map(storedTemplate);
  }

  getTemplate(id: string, ownerId = "local-user"): StoredSessionTemplate | null {
    const row = this.db.select().from(schema.sessionTemplates).where(and(eq(schema.sessionTemplates.id, id), eq(schema.sessionTemplates.ownerId, ownerId))).get();
    return row ? storedTemplate(row) : null;
  }

  createTemplate(template: SessionTemplate, ownerId = "local-user"): StoredSessionTemplate {
    if (this.getTemplate(template.id, ownerId)) throw new Error("TEMPLATE_ALREADY_EXISTS");
    const now = this.now().toISOString();
    const parsed = sessionTemplateSchema.parse(template);
    const stored = storedSessionTemplateSchema.parse({ ...parsed, origin: "user", revision: 1 }) as StoredSessionTemplate;
    this.db.insert(schema.sessionTemplates).values({ id: stored.id, ownerId, data: templateData(parsed), revision: stored.revision, createdAt: now, updatedAt: now }).run();
    return stored;
  }

  updateTemplate(template: SessionTemplate, expectedRevision: number, ownerId = "local-user"): StoredSessionTemplate {
    return this.sqlite.transaction(() => {
      const current = this.getTemplate(template.id, ownerId);
      if (!current) throw new Error("TEMPLATE_NOT_FOUND");
      if (current.revision !== expectedRevision) throw new Error("REVISION_CONFLICT");
      const now = this.now().toISOString();
      const parsed = sessionTemplateSchema.parse(template);
      const stored = storedSessionTemplateSchema.parse({ ...parsed, origin: "user", revision: current.revision + 1 }) as StoredSessionTemplate;
      this.db.update(schema.sessionTemplates).set({ data: templateData(parsed), revision: stored.revision, updatedAt: now }).where(and(eq(schema.sessionTemplates.id, stored.id), eq(schema.sessionTemplates.ownerId, ownerId))).run();
      return stored;
    })();
  }

  deleteTemplate(id: string, expectedRevision: number, ownerId = "local-user"): void {
    const current = this.getTemplate(id, ownerId);
    if (!current) throw new Error("TEMPLATE_NOT_FOUND");
    if (current.revision !== expectedRevision) throw new Error("REVISION_CONFLICT");
    this.db.delete(schema.sessionTemplates).where(and(eq(schema.sessionTemplates.id, id), eq(schema.sessionTemplates.ownerId, ownerId))).run();
  }

  listDismissedTemplateIds(ownerId = "local-user"): string[] {
    return this.db.select().from(schema.templateDismissals).where(eq(schema.templateDismissals.ownerId, ownerId)).all().map((row) => row.templateId);
  }

  dismissTemplate(id: string, ownerId = "local-user"): void {
    this.db.insert(schema.templateDismissals).values({ ownerId, templateId: id, createdAt: this.now().toISOString() }).onConflictDoNothing().run();
  }

  getCurrentPlan(ownerId = "local-user"): CurrentPlan | null {
    const row = this.db.select().from(schema.currentMesocycles).where(eq(schema.currentMesocycles.ownerId, ownerId)).get();
    return row ? currentPlanSchema.parse(parseJson(row.data)) : null;
  }

  saveCurrentPlan(plan: CurrentPlan, expectedRevision: number, _deletedSessionIds: string[] = [], _updatedSessions: PlannedSession[] = []): CurrentPlan {
    try {
      const saved = this.sqlite.transaction(() => {
        if ((this.getCurrentPlan(plan.ownerId)?.revision ?? 0) !== expectedRevision) throw new Error("REVISION_CONFLICT");
        this.db.insert(schema.currentMesocycles).values({ ownerId: plan.ownerId, data: plan, revision: plan.revision, updatedAt: plan.updatedAt }).onConflictDoUpdate({ target: schema.currentMesocycles.ownerId, set: { data: plan, revision: plan.revision, updatedAt: plan.updatedAt } }).run();
        return plan;
      }).immediate();
      this.reconcilePlanMatches(plan.ownerId);
      return saved;
    } catch (error) {
      if (error instanceof SQLiteError && error.code?.startsWith("SQLITE_BUSY")) throw new Error("WRITE_BUSY");
      throw error;
    }
  }

  listCurrentPlannedSessions(ownerId = "local-user", scheduledDate?: string): PlannedSession[] {
    const plan = this.getCurrentPlan(ownerId); if (!plan) return [];
    const timestamp = plan.updatedAt;
    const completedByPlanId = new Map<string, { workout: TrainingSession; method: "auto" | "manual" }>();
    const matches = this.sqlite.query("SELECT planned_session_id,training_session_id,method FROM plan_workout_matches WHERE owner_id=?").all(ownerId) as Array<{ planned_session_id: string; training_session_id: string; method: "auto" | "manual" }>;
    for (const match of matches) {
      const row = this.sqlite.query("SELECT data FROM training_sessions WHERE owner_id=? AND id=?").get(ownerId, match.training_session_id) as { data: string } | null;
      if (row) completedByPlanId.set(match.planned_session_id, { workout: trainingSessionSchema.parse(parseJson(row.data)), method: match.method });
    }
    const sources = this.sourceSummaries(ownerId);
    const today = localDate(this.now().toISOString(), this.getProfile(ownerId).timezone);
    return plan.mesocycle.weeks.flatMap((week) => week.sessions.map((session) => plannedSessionSchema.parse({
      ...session, occurrenceId: `plan:${session.scheduledDate}`, ownerId, planRevision: plan.revision, weekNumber: week.weekNumber,
      phaseRefs: [...new Set(session.components.map((component) => component.domain.value).filter(Boolean))].map((domain) => ({ domain, phaseId: plan.mesocycle.domainProgressions.find((item) => item.domain === domain)!.phases.find((phase) => week.weekNumber >= phase.startWeek && week.weekNumber <= phase.endWeek)!.id })),
      exerciseOverrides: [], notes: "", overrideReason: null,
      status: completedByPlanId.has(session.id) ? "completed" : session.status,
      displayState: completedByPlanId.has(session.id) ? "completed" : session.status === "skipped" ? "skipped" : session.scheduledDate < today ? "unrecorded" : "scheduled",
      completedTrainingSessionId: completedByPlanId.get(session.id)?.workout.id ?? null,
      completedAt: completedByPlanId.get(session.id)?.workout.endAt ?? null,
      completionSource: completedByPlanId.has(session.id) ? ((sources.get(completedByPlanId.get(session.id)!.workout.id) ?? []).some((source) => source.source !== "manual") ? "import" : "manual") : null,
      match: completedByPlanId.has(session.id) ? { plannedSessionId: session.id, method: completedByPlanId.get(session.id)!.method } : null,
      createdAt: timestamp, updatedAt: timestamp,
    }))).filter((session) => !scheduledDate || session.scheduledDate === scheduledDate).sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || a.order - b.order);
  }

  scheduleRevision(ownerId = "local-user"): number { return this.getCurrentPlan(ownerId)?.revision ?? 0; }

  updateCurrentPlannedSessions(input: { ownerId: string; expectedRevision: number; mode: string; sessions: PlannedSession[]; reason?: { reasonCode: string; note?: string | undefined } }): { sessions: PlannedSession[]; revision: number } {
    const result = this.sqlite.transaction(() => {
      const current = this.getCurrentPlan(input.ownerId); if (!current) throw new Error("NO_CURRENT_PLAN");
      if (current.revision !== input.expectedRevision) throw new Error("PLANNED_SESSION_REVISION_CONFLICT");
      const previous = new Map(current.mesocycle.weeks.flatMap((week) => week.sessions).map((session) => [session.id, session]));
      const updates = new Map(input.sessions.map((session) => [session.id, session]));
      const weeks = current.mesocycle.weeks.map((week) => ({ ...week, sessions: week.sessions.filter((session) => !updates.has(session.id)) }));
      for (const session of input.sessions) {
        const week = weeks.find((item) => item.weekNumber === session.weekNumber); if (!week) throw new Error("PLAN_WEEK_NOT_FOUND");
        week.sessions.push({ id: session.id, scheduledDate: session.scheduledDate, order: session.order, status: session.status === "skipped" ? "skipped" : "planned", templateRef: session.templateRef, name: session.name, intent: session.intent, durationMinutes: session.durationMinutes, recoveryDemand: session.recoveryDemand, keySession: session.keySession, components: session.components, progressionNote: session.progressionNote, schedulingRationale: session.schedulingRationale, legacySnapshot: session.legacySnapshot });
      }
      const updatedAt = this.now().toISOString(); const plan = currentPlanSchema.parse({ ...current, mesocycle: { ...current.mesocycle, weeks }, revision: current.revision + 1, updatedAt });
      this.db.insert(schema.currentMesocycles).values({ ownerId: plan.ownerId, data: plan, revision: plan.revision, updatedAt: plan.updatedAt }).onConflictDoUpdate({ target: schema.currentMesocycles.ownerId, set: { data: plan, revision: plan.revision, updatedAt: plan.updatedAt } }).run();
      for (const session of input.sessions) {
        const before = previous.get(session.id);
        this.sqlite.query("INSERT INTO planned_session_events(id,owner_id,planned_session_id,action,from_date,to_date,reason_code,reason_note,revision_before,revision_after,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), input.ownerId, session.id, input.mode, before?.scheduledDate ?? null, session.scheduledDate, input.reason?.reasonCode ?? null, input.reason?.note ?? null, current.revision, plan.revision, updatedAt);
      }
      return { sessions: input.sessions, revision: plan.revision };
    }).immediate();
    this.reconcilePlanMatches(input.ownerId);
    return result;
  }

  saveCurrentPlannedSessions(input: { ownerId: string; clientRequestId: string; scheduledDate: string; expectedRevision: number; mode: "append" | "replace"; sessions: PlannedSession[] }) {
    const current = this.getCurrentPlan(input.ownerId); if (!current) throw new Error("NO_CURRENT_PLAN");
    if (current.revision !== input.expectedRevision) throw new Error("PLANNED_SESSION_REVISION_CONFLICT");
    const targetWeek = input.sessions[0]?.weekNumber; if (!targetWeek) throw new Error("PLAN_WEEK_NOT_FOUND");
    const weeks = current.mesocycle.weeks.map((week) => ({ ...week, sessions: week.weekNumber === targetWeek ? [...(input.mode === "replace" ? week.sessions.filter((session) => session.scheduledDate !== input.scheduledDate) : week.sessions), ...input.sessions.map((session) => ({ id: session.id, scheduledDate: session.scheduledDate, order: session.order, status: "planned" as const, templateRef: session.templateRef, name: session.name, intent: session.intent, durationMinutes: session.durationMinutes, recoveryDemand: session.recoveryDemand, keySession: session.keySession, components: session.components, progressionNote: session.progressionNote, schedulingRationale: session.schedulingRationale, legacySnapshot: session.legacySnapshot }))] : week.sessions }));
    const updatedAt = this.now().toISOString(); const plan = currentPlanSchema.parse({ ...current, mesocycle: { ...current.mesocycle, weeks }, revision: current.revision + 1, updatedAt });
    this.saveCurrentPlan(plan, current.revision);
    return { sessions: this.listCurrentPlannedSessions(input.ownerId, input.scheduledDate), revision: plan.revision, idempotentReplay: false };
  }

  linkTrainingSession(trainingSessionId: string, plannedSessionId: string, ownerId = "local-user"): TrainingSession | null {
    const row = this.db.select().from(schema.trainingSessions).where(and(eq(schema.trainingSessions.id, trainingSessionId), eq(schema.trainingSessions.ownerId, ownerId))).get();
    if (!row) return null;
    this.insertPlanMatch(ownerId, plannedSessionId, trainingSessionId, "auto", 80, { legacyLinkCall: true });
    return this.withDerivedMatch(trainingSessionSchema.parse(parseJson(row.data)), this.matchDetails(ownerId), this.sourceSummaries(ownerId));
  }

  setTrainingSessionPlanMatch(input: { ownerId: string; trainingSessionId: string; plannedSessionId: string | null; expectedRevision: number }): TrainingSession {
    return this.sqlite.transaction(() => {
      const plan = this.getCurrentPlan(input.ownerId);
      if ((plan?.revision ?? 0) !== input.expectedRevision) throw new Error("PLANNED_SESSION_REVISION_CONFLICT");
      const workout = this.sqlite.query("SELECT data FROM training_sessions WHERE owner_id=? AND id=?").get(input.ownerId, input.trainingSessionId) as { data: string } | null;
      if (!workout) throw new Error("TRAINING_SESSION_NOT_FOUND");
      this.sqlite.query("DELETE FROM plan_workout_matches WHERE owner_id=? AND training_session_id=?").run(input.ownerId, input.trainingSessionId);
      if (input.plannedSessionId === null) {
        this.sqlite.query("INSERT INTO workout_plan_exclusions(owner_id,training_session_id,created_at) VALUES (?,?,?) ON CONFLICT(owner_id,training_session_id) DO UPDATE SET created_at=excluded.created_at").run(input.ownerId, input.trainingSessionId, this.now().toISOString());
      } else {
        if (!plan) throw new Error("NO_CURRENT_PLAN");
        const planned = plan.mesocycle.weeks.flatMap((week) => week.sessions).find((session) => session.id === input.plannedSessionId);
        if (!planned) throw new Error("PLANNED_SESSION_NOT_FOUND");
        if (planned.status === "skipped") throw new Error("PLANNED_SESSION_SKIPPED");
        const actual = trainingSessionSchema.parse(parseJson(workout.data));
        if (localDate(actual.startAt, actual.timezone ?? this.getProfile(input.ownerId).timezone) !== planned.scheduledDate) throw new Error("PLAN_WORKOUT_DATE_MISMATCH");
        this.sqlite.query("DELETE FROM workout_plan_exclusions WHERE owner_id=? AND training_session_id=?").run(input.ownerId, input.trainingSessionId);
        this.insertPlanMatch(input.ownerId, planned.id, input.trainingSessionId, "manual", 100, { userConfirmed: true });
      }
      this.reconcilePlanMatches(input.ownerId);
      return this.listSessions(input.ownerId).find((session) => session.id === input.trainingSessionId)!;
    })();
  }

  clearTrainingSessionPlanExclusion(ownerId: string, trainingSessionId: string): TrainingSession {
    this.sqlite.query("DELETE FROM workout_plan_exclusions WHERE owner_id=? AND training_session_id=?").run(ownerId, trainingSessionId);
    this.reconcilePlanMatches(ownerId);
    const session = this.listSessions(ownerId).find((item) => item.id === trainingSessionId);
    if (!session) throw new Error("TRAINING_SESSION_NOT_FOUND");
    return session;
  }

  updateManualTrainingSession(input: { ownerId: string; trainingSessionId: string; startAt?: string; durationMinutes?: number }): TrainingSession {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.query("SELECT id,local_date,data FROM training_session_sources WHERE owner_id=? AND training_session_id=? AND source='manual'").get(input.ownerId, input.trainingSessionId) as { id: string; local_date: string; data: string } | null;
      if (!row) throw new Error("MANUAL_SOURCE_NOT_FOUND");
      const current = trainingSessionSchema.parse(parseJson(row.data));
      const startAt = input.startAt ?? current.startAt;
      const timezone = current.timezone ?? this.getProfile(input.ownerId).timezone;
      if (localDate(startAt, timezone) !== row.local_date) throw new Error("MANUAL_DATE_CHANGE_REQUIRES_PLAN_MOVE");
      const durationMinutes = input.durationMinutes ?? current.durationMinutes;
      const updated = trainingSessionSchema.parse({ ...current, startAt, endAt: new Date(Date.parse(startAt) + durationMinutes * 60_000).toISOString(), durationMinutes, timePrecision: input.startAt ? "exact" : current.timePrecision, missingFields: input.startAt ? current.missingFields.filter((field) => field !== "actual start time") : current.missingFields });
      this.sqlite.query("UPDATE training_session_sources SET start_at=?,data=?,updated_at=? WHERE id=?").run(startAt, JSON.stringify(updated), this.now().toISOString(), row.id);
      this.rebuildCanonicalSessions(input.ownerId); this.reconcilePlanMatches(input.ownerId);
      return this.listSessions(input.ownerId).find((session) => session.id === input.trainingSessionId)!;
    })();
  }

  setTrainingSessionTypeOverride(ownerId: string, trainingSessionId: string, domain: TrainingSession["domains"][number]): TrainingSession {
    const exists = this.sqlite.query("SELECT id FROM training_sessions WHERE owner_id=? AND id=?").get(ownerId, trainingSessionId);
    if (!exists) throw new Error("TRAINING_SESSION_NOT_FOUND");
    this.sqlite.query("INSERT INTO training_session_type_overrides(owner_id,training_session_id,domain,updated_at) VALUES (?,?,?,?) ON CONFLICT(owner_id,training_session_id) DO UPDATE SET domain=excluded.domain,updated_at=excluded.updated_at").run(ownerId, trainingSessionId, domain, this.now().toISOString());
    this.reconcilePlanMatches(ownerId);
    return this.listSessions(ownerId).find((session) => session.id === trainingSessionId)!;
  }

  deleteManualTrainingSession(ownerId: string, trainingSessionId: string): TrainingSession | null {
    return this.sqlite.transaction(() => {
      const result = this.sqlite.query("DELETE FROM training_session_sources WHERE owner_id=? AND training_session_id=? AND source='manual'").run(ownerId, trainingSessionId);
      if (!result.changes) throw new Error("MANUAL_SOURCE_NOT_FOUND");
      this.rebuildCanonicalSessions(ownerId); this.reconcilePlanMatches(ownerId);
      return this.listSessions(ownerId).find((session) => session.id === trainingSessionId) ?? null;
    })();
  }

  deleteTrainingSession(ownerId: string, trainingSessionId: string): void {
    this.sqlite.transaction(() => {
      const exists = this.sqlite.query("SELECT id FROM training_sessions WHERE owner_id=? AND id=?").get(ownerId, trainingSessionId);
      if (!exists) throw new Error("TRAINING_SESSION_NOT_FOUND");
      this.sqlite.query("DELETE FROM training_session_sources WHERE owner_id=? AND training_session_id=?").run(ownerId, trainingSessionId);
      this.sqlite.query("DELETE FROM plan_workout_matches WHERE owner_id=? AND training_session_id=?").run(ownerId, trainingSessionId);
      this.sqlite.query("DELETE FROM workout_plan_exclusions WHERE owner_id=? AND training_session_id=?").run(ownerId, trainingSessionId);
      this.sqlite.query("DELETE FROM training_session_type_overrides WHERE owner_id=? AND training_session_id=?").run(ownerId, trainingSessionId);
      this.sqlite.query("DELETE FROM training_sessions WHERE owner_id=? AND id=?").run(ownerId, trainingSessionId);
      this.rebuildCanonicalSessions(ownerId); this.reconcilePlanMatches(ownerId);
    })();
  }

  counts(): Record<string, number> {
    const names = ["profiles", "training_sessions", "training_session_sources", "training_session_type_overrides", "plan_workout_matches", "workout_plan_exclusions", "planned_session_events", "wellness", "import_batches", "connection_sync_state", "session_templates", "template_dismissals", "current_mesocycles"];
    return Object.fromEntries(names.map((name) => [name, Number((this.sqlite.query(`SELECT COUNT(*) AS count FROM ${name}`).get() as { count: number }).count)]));
  }

  checkpoint(): void { this.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
}

export { schema };
