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

  listSessions(ownerId = "local-user", since?: string): TrainingSession[] {
    const condition = since ? and(eq(schema.trainingSessions.ownerId, ownerId), gte(schema.trainingSessions.startAt, since)) : eq(schema.trainingSessions.ownerId, ownerId);
    return this.db.select().from(schema.trainingSessions).where(condition).orderBy(desc(schema.trainingSessions.startAt)).all().map((row) => trainingSessionSchema.parse(parseJson(row.data)));
  }

  listSessionsBySource(source: string, ownerId = "local-user", since?: string): TrainingSession[] {
    const condition = since
      ? and(eq(schema.trainingSessions.ownerId, ownerId), eq(schema.trainingSessions.source, source), gte(schema.trainingSessions.startAt, since))
      : and(eq(schema.trainingSessions.ownerId, ownerId), eq(schema.trainingSessions.source, source));
    return this.db.select().from(schema.trainingSessions).where(condition).orderBy(desc(schema.trainingSessions.startAt)).all().map((row) => trainingSessionSchema.parse(parseJson(row.data)));
  }

  upsertSessions(sessions: TrainingSession[]): { added: number; updated: number } {
    const counts = { added: 0, updated: 0 };
    this.sqlite.transaction(() => {
      for (const value of sessions.map((item) => trainingSessionSchema.parse(item))) {
        const existing = this.db.select({ id: schema.trainingSessions.id }).from(schema.trainingSessions).where(and(eq(schema.trainingSessions.ownerId, value.ownerId), eq(schema.trainingSessions.source, value.source), eq(schema.trainingSessions.externalId, value.externalId))).get();
        if (existing) counts.updated += 1; else counts.added += 1;
        this.db.insert(schema.trainingSessions).values({ id: value.id, ownerId: value.ownerId, source: value.source, externalId: value.externalId, modality: value.modality, startAt: value.startAt, data: value }).onConflictDoUpdate({ target: [schema.trainingSessions.ownerId, schema.trainingSessions.source, schema.trainingSessions.externalId], set: { modality: value.modality, startAt: value.startAt, data: value } }).run();
      }
    })();
    return counts;
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
        const aliases: Record<string, string[]> = { restingHeartRateBpm: ["restingHR", "restingHeartRate"], hrvRmssdMs: ["hrv", "hrvRmssd"], sleepSeconds: ["sleepSecs", "sleepSeconds"], sleepScore: ["sleepScore"], weightKg: ["weight"], fatigue: ["fatigue"], soreness: ["soreness"], stress: ["stress"], mood: ["mood"], motivation: ["motivation"], readiness: ["readiness"] };
        const fields = { ...(existing?.fields ?? {}) } as WellnessRecord["fields"];
        for (const [field, names] of Object.entries(aliases)) {
          const prior = fields[field as keyof typeof fields];
          if (prior && prior.source !== "intervals_icu") continue;
          const raw = names.map((name) => value[name]).find((item) => item !== undefined && item !== null && item !== "");
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

  getCurrentPlan(ownerId = "local-user"): CurrentPlan | null {
    const row = this.db.select().from(schema.currentMesocycles).where(eq(schema.currentMesocycles.ownerId, ownerId)).get();
    return row ? currentPlanSchema.parse(parseJson(row.data)) : null;
  }

  saveCurrentPlan(plan: CurrentPlan, expectedRevision: number, _deletedSessionIds: string[] = [], _updatedSessions: PlannedSession[] = []): CurrentPlan {
    try {
      return this.sqlite.transaction(() => {
        if ((this.getCurrentPlan(plan.ownerId)?.revision ?? 0) !== expectedRevision) throw new Error("REVISION_CONFLICT");
        this.db.insert(schema.currentMesocycles).values({ ownerId: plan.ownerId, data: plan, revision: plan.revision, updatedAt: plan.updatedAt }).onConflictDoUpdate({ target: schema.currentMesocycles.ownerId, set: { data: plan, revision: plan.revision, updatedAt: plan.updatedAt } }).run();
        return plan;
      }).immediate();
    } catch (error) {
      if (error instanceof SQLiteError && error.code?.startsWith("SQLITE_BUSY")) throw new Error("WRITE_BUSY");
      throw error;
    }
  }

  listCurrentPlannedSessions(ownerId = "local-user", scheduledDate?: string): PlannedSession[] {
    const plan = this.getCurrentPlan(ownerId); if (!plan) return [];
    const timestamp = plan.updatedAt;
    const completedByPlanId = new Map<string, TrainingSession>();
    for (const row of this.db.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.ownerId, ownerId)).all()) {
      const training = trainingSessionSchema.parse(parseJson(row.data));
      if (!training.plannedSessionId) continue;
      const previous = completedByPlanId.get(training.plannedSessionId);
      if (!previous || training.startAt > previous.startAt) completedByPlanId.set(training.plannedSessionId, training);
    }
    return plan.mesocycle.weeks.flatMap((week) => week.sessions.map((session) => plannedSessionSchema.parse({
      ...session, occurrenceId: `plan:${session.scheduledDate}`, ownerId, planRevision: plan.revision, weekNumber: week.weekNumber,
      phaseRefs: [...new Set(session.components.map((component) => component.domain.value).filter(Boolean))].map((domain) => ({ domain, phaseId: plan.mesocycle.domainProgressions.find((item) => item.domain === domain)!.phases.find((phase) => week.weekNumber >= phase.startWeek && week.weekNumber <= phase.endWeek)!.id })),
      exerciseOverrides: [], notes: "", overrideReason: null,
      status: completedByPlanId.has(session.id) ? "completed" : session.status,
      completedTrainingSessionId: completedByPlanId.get(session.id)?.id ?? null,
      completedAt: completedByPlanId.get(session.id)?.endAt ?? null,
      completionSource: completedByPlanId.has(session.id) ? (completedByPlanId.get(session.id)?.source === "manual" ? "manual" : "import") : null,
      createdAt: timestamp, updatedAt: timestamp,
    }))).filter((session) => !scheduledDate || session.scheduledDate === scheduledDate).sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || a.order - b.order);
  }

  scheduleRevision(ownerId = "local-user"): number { return this.getCurrentPlan(ownerId)?.revision ?? 0; }

  updateCurrentPlannedSessions(input: { ownerId: string; expectedRevision: number; mode: string; sessions: PlannedSession[] }): { sessions: PlannedSession[]; revision: number } {
    const current = this.getCurrentPlan(input.ownerId); if (!current) throw new Error("NO_CURRENT_PLAN");
    if (current.revision !== input.expectedRevision) throw new Error("PLANNED_SESSION_REVISION_CONFLICT");
    const updates = new Map(input.sessions.map((session) => [session.id, session]));
    const weeks = current.mesocycle.weeks.map((week) => ({ ...week, sessions: week.sessions.filter((session) => !updates.has(session.id)) }));
    for (const session of input.sessions) {
      const week = weeks.find((item) => item.weekNumber === session.weekNumber); if (!week) throw new Error("PLAN_WEEK_NOT_FOUND");
      week.sessions.push({ id: session.id, scheduledDate: session.scheduledDate, order: session.order, status: session.status === "skipped" ? "skipped" : "planned", templateRef: session.templateRef, name: session.name, intent: session.intent, durationMinutes: session.durationMinutes, recoveryDemand: session.recoveryDemand, keySession: session.keySession, components: session.components, progressionNote: session.progressionNote, schedulingRationale: session.schedulingRationale, legacySnapshot: session.legacySnapshot });
    }
    const updatedAt = this.now().toISOString(); const plan = currentPlanSchema.parse({ ...current, mesocycle: { ...current.mesocycle, weeks }, revision: current.revision + 1, updatedAt });
    this.saveCurrentPlan(plan, current.revision);
    return { sessions: input.sessions, revision: plan.revision };
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
    const session = trainingSessionSchema.parse({ ...trainingSessionSchema.parse(parseJson(row.data)), plannedSessionId });
    this.db.update(schema.trainingSessions).set({ data: session }).where(eq(schema.trainingSessions.id, trainingSessionId)).run();
    return session;
  }

  counts(): Record<string, number> {
    const names = ["profiles", "training_sessions", "wellness", "import_batches", "connection_sync_state", "session_templates", "current_mesocycles"];
    return Object.fromEntries(names.map((name) => [name, Number((this.sqlite.query(`SELECT COUNT(*) AS count FROM ${name}`).get() as { count: number }).count)]));
  }

  checkpoint(): void { this.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
}

export { schema };
