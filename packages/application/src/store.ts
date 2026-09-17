import type {
  AthleteProfile,
  CurrentPlan,
  PlannedSession,
  SessionTemplate,
  StoredSessionTemplate,
  TrainingSession,
  WellnessRecord,
} from "@athria/schemas";

/**
 * Persistence port for AthriaApplication. Implemented today by the Bun SQLite
 * AthriaRepository and, over time, by the Rust runtime store. The application
 * layer depends only on this interface: it never opens a database connection,
 * never imports bun:sqlite or Drizzle, and never issues SQL.
 *
 * Implementations may throw Error with stable codes that the application maps
 * to AthriaError responses, currently: TEMPLATE_ALREADY_EXISTS,
 * TEMPLATE_NOT_FOUND, REVISION_CONFLICT, PLANNED_SESSION_REVISION_CONFLICT,
 * NO_CURRENT_PLAN, PLAN_WEEK_NOT_FOUND, TRAINING_SESSION_NOT_FOUND,
 * PLANNED_SESSION_NOT_FOUND, PLANNED_SESSION_SKIPPED, PLAN_WORKOUT_DATE_MISMATCH,
 * MANUAL_SOURCE_NOT_FOUND, MANUAL_DATE_CHANGE_REQUIRES_PLAN_MOVE, WRITE_BUSY,
 * COMPLETED_SESSION_CANNOT_BE_REPLACED.
 */
export interface AthriaStore {
  /** Runs work inside one immediate (write) transaction and returns its result. */
  transaction<T>(work: () => T): T;

  getProfile(ownerId: string): AthleteProfile;
  saveProfile(profile: AthleteProfile): AthleteProfile;

  listSessions(ownerId: string, since?: string): TrainingSession[];
  listSessionsBySource(source: string, ownerId: string, since?: string): TrainingSession[];
  upsertSessions(sessions: TrainingSession[]): { added: number; updated: number };
  replaceSourceSessions(input: ReplaceSourceSessionsInput): { added: number; updated: number };
  setTrainingSessionPlanMatch(input: SetTrainingSessionPlanMatchInput): TrainingSession;
  clearTrainingSessionPlanExclusion(ownerId: string, trainingSessionId: string): TrainingSession;
  setTrainingSessionTypeOverride(ownerId: string, trainingSessionId: string, domain: TrainingSession["domains"][number]): TrainingSession;
  updateManualTrainingSession(input: UpdateManualTrainingSessionInput): TrainingSession;
  deleteManualTrainingSession(ownerId: string, trainingSessionId: string): TrainingSession | null;
  deleteTrainingSession(ownerId: string, trainingSessionId: string): void;

  getWellness(ownerId: string, day: string): WellnessRecord | null;
  listWellness(ownerId: string, since?: string): WellnessRecord[];
  saveWellness(record: WellnessRecord): WellnessRecord;
  upsertWellness(ownerId: string, records: unknown[]): number;

  listTemplates(ownerId: string): StoredSessionTemplate[];
  getTemplate(id: string, ownerId: string): StoredSessionTemplate | null;
  createTemplate(template: SessionTemplate, ownerId: string): StoredSessionTemplate;
  updateTemplate(template: SessionTemplate, expectedRevision: number, ownerId: string): StoredSessionTemplate;
  deleteTemplate(id: string, expectedRevision: number, ownerId: string): void;
  listDismissedTemplateIds(ownerId: string): string[];
  dismissTemplate(id: string, ownerId: string): void;

  getCurrentPlan(ownerId: string): CurrentPlan | null;
  saveCurrentPlan(plan: CurrentPlan, expectedRevision: number, deletedSessionIds: string[], updatedSessions: PlannedSession[]): CurrentPlan;
  listCurrentPlannedSessions(ownerId: string, scheduledDate?: string): PlannedSession[];
  scheduleRevision(ownerId: string): number;
  updateCurrentPlannedSessions(input: UpdateCurrentPlannedSessionsInput): { sessions: PlannedSession[]; revision: number };
  saveCurrentPlannedSessions(input: SaveCurrentPlannedSessionsInput): { sessions: PlannedSession[]; revision: number; idempotentReplay: boolean };

  recordImportBatch(input: RecordImportBatchInput): ImportBatchRecord;
  latestImportBatch(ownerId: string, source: string): ImportBatchRecord | null;
  getConnectionSyncState(source: string, ownerId: string): ConnectionSyncState | null;
  saveConnectionSyncState(input: SaveConnectionSyncStateInput): ConnectionSyncState;
}

export interface ReplaceSourceSessionsInput {
  ownerId?: string;
  source: string;
  sessions: TrainingSession[];
  dates?: string[];
  localDates?: Record<string, string>;
  rangeStart?: string;
  rangeEnd?: string;
}

export interface SetTrainingSessionPlanMatchInput {
  ownerId: string;
  trainingSessionId: string;
  plannedSessionId: string | null;
  expectedRevision: number;
}

export interface UpdateManualTrainingSessionInput {
  ownerId: string;
  trainingSessionId: string;
  startAt?: string;
  durationMinutes?: number;
}

export interface UpdateCurrentPlannedSessionsInput {
  ownerId: string;
  expectedRevision: number;
  mode: string;
  sessions: PlannedSession[];
  reason?: { reasonCode: string; note?: string | undefined };
}

export interface SaveCurrentPlannedSessionsInput {
  ownerId: string;
  clientRequestId: string;
  scheduledDate: string;
  expectedRevision: number;
  mode: "append" | "replace";
  sessions: PlannedSession[];
}

export interface RecordImportBatchInput {
  ownerId: string;
  source: string;
  contentHash: string;
  fileName: string;
  parserVersion: string;
  status: string;
  data: unknown;
}

export interface ImportBatchRecord {
  id: string;
  ownerId: string;
  source: string;
  contentHash: string;
  fileName: string;
  parserVersion: string;
  status: string;
  data: unknown;
  createdAt: string;
}

export interface SaveConnectionSyncStateInput {
  ownerId?: string;
  source: string;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  rangeStart: string;
  rangeEnd: string;
  status: "success" | "partial" | "failed";
  data: Record<string, unknown>;
}

export interface ConnectionSyncState {
  ownerId: string;
  source: string;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  rangeStart: string;
  rangeEnd: string;
  status: string;
  data: Record<string, unknown>;
}
