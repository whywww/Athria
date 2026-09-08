export interface Metric<T> {
  value: T;
  unit: string;
  dataQuality: { completeness: number; missingFields: string[]; anomalies: string[] };
}

export interface TrainingSummary {
  periodDays: number;
  sessionCount: number;
  totalDurationMinutes: number;
  byDomain: Record<string, number>;
  metrics: {
    strength: { workingSets: Metric<number> };
    endurance: { distanceMeters: Metric<number> };
  };
}

export interface AthleteProfile {
  ownerId: string;
  displayName: string;
  timezone: string;
  goals: string[];
  priority: "strength" | "endurance" | "balanced";
  weeklyStrengthSessions: number;
  weeklyEnduranceSessions: number;
  maxSessionMinutes: number;
  trainingDays: number[];
  equipment: string[];
  strengthConstraints: Array<{ id: string; type: "exclude_exercise"; canonicalKey: string } | { id: string; type: "prohibit_movement_pattern"; movementPattern: string }>;
  constraintNotes: string[];
  explicitRecoveryHours: number | null;
}

export interface ExerciseDefinition { key: string; name: string; equipment: string[] }

export interface ProfileProposal {
  id: string;
  rationale: string;
  status: string;
  patch: Partial<AthleteProfile>;
}

export interface PlanExercise {
  id: string;
  displayName: string;
  canonicalKey: string | null;
  sets: number;
  repsMin: number;
  repsMax: number;
  targetRpe: number | null;
  restSeconds: number;
  referenceLoad: number | null;
  referenceLoadUnit: "kg" | "lb" | null;
  notes: string;
  classification: Record<string, { value: unknown; source: string; confidence: number; evidence: string; taxonomyVersion: string }>;
}

export interface PlanComponent {
  id: string;
  name: string;
  domain: { value: "strength" | "endurance" | "sport_skill" | "mind_body" | "recovery" | null; source: string; confidence: number; evidence: string; taxonomyVersion: string };
  prescription: { kind: "strength"; exercises: PlanExercise[] } | { kind: "duration_only"; notes: string };
}

export interface Mesocycle {
  durationWeeks: number;
  weeklyStructure: Array<{ dayOfWeek: number; templateIds: string[] }>;
  phases: Array<{ id: string; phaseType: "foundation" | "progression" | "deload" | "peak" | "test" | "recovery"; name: string; startWeek: number; endWeek: number; focus: string; progression: string[] }>;
  adjustmentRules: Array<{ trigger: string; action: string; rationale: string }>;
}

export interface SessionTemplate { id: string; name: string; intent: string; durationMinutes: number; recoveryDemand: "low" | "normal" | "high"; notes: string; components: PlanComponent[] }
export interface StoredSessionTemplate extends SessionTemplate { ownerId: string; revision: number; createdAt: string; updatedAt: string }
export interface CurrentPlan { planSchemaVersion: "4.0"; ownerId: string; title: string; summary: string; effectiveStartDate: string; mesocycle: Mesocycle; revision: number; sourceAgent: string | null; model: string | null; skillVersion: string | null; inputSnapshotHash: string | null; updatedAt: string }
export interface PlanDraft { planSchemaVersion: "3.0"; id: string; title: string; summary: string; mesocycle: (Mesocycle & { sessionTemplates: SessionTemplate[] }) | null; migration?: { reviewRequired: boolean; sourceSchema: string; sourceSessions: unknown[] } | null; updatedAt?: string }
export interface StoredDraft { draft: PlanDraft; validation: PlanValidation }
export interface PlanVersion { id: string; versionNumber: number; plan: PlanDraft; validation: PlanValidation; approvedAt: string; changeReason: string }

export interface PlannedSession {
  id: string;
  name: string;
  intent: string;
  scheduledDate: string;
  durationMinutes: number;
  templateId: string;
  phaseId: string;
  recoveryDemand: "low" | "normal" | "high";
  status: "planned" | "completed" | "skipped";
  components: PlanComponent[];
  notes: string;
}

export interface ValidationResult { status: "pass" | "fail" | "unknown" | "not_applicable"; enforcement: "blocker" | "advisory" | "info"; reasonCode: string; evidence: Record<string, unknown>; missingFacts: string[]; subjectRefs: string[] }
export interface DataGap { code: string; subjectRef: string; factPath: string; requiredByRuleCodes: string[]; blocking: boolean; resolution: "agent_infer" | "user_confirm" | "add_profile_data" }
export interface PlanValidation { valid: boolean; results: ValidationResult[]; dataGaps: DataGap[]; coverage?: { hardChecksResolved: number; hardChecksTotal: number; movementFactsResolved: number; movementFactsTotal: number; muscleFactsResolved: number; muscleFactsTotal: number; equipmentFactsResolved: number; equipmentFactsTotal: number } }
export interface NextTrainingDay { nextTrainingDay: null | { scheduledDate: string; dayOfWeek: number; weekNumber: number; phaseId: string; phaseType: string; expectedTemplateIds: string[]; existingSessions: PlannedSession[]; revision: number; timezone: string }; reasonCode: string | null }

export interface ImportPreview { previewToken?: string; fileName?: string; counts?: { sessions?: number; sets?: number; rows?: number }; errors?: string[]; unknownColumns?: string[] }
export interface ImportResult { added?: number; updated?: number; rawCount?: number; wellnessCount?: number; errors?: Record<string, string> }
export interface HevyImportStatus { fileName: string; importedAt: string; status: string; counts: { sessions?: number; sets?: number; rows?: number } }
export interface IntervalsConnectionStatus { configured: boolean; athleteId: string }
export interface XunjiConnectionStatus {
  configured: boolean;
  sync: null | {
    lastAttemptAt: string;
    lastSuccessAt: string | null;
    rangeStart: string;
    rangeEnd: string;
    status: "success" | "partial" | "failed";
    data: { successfulDays?: number; failedDays?: number; records?: number; errors?: Array<{ code: string; message: string }> };
  };
}
export interface DoctorResult { dataDir: string }
export const dashboardPages = [
  { id: "Overview", label: "Overview", icon: "⌂", group: "primary" },
  { id: "Training", label: "Training", icon: "›››", group: "primary" },
  { id: "Profile", label: "Profile", icon: "♡", group: "primary" },
  { id: "Plan", label: "Plan", icon: "≡", group: "primary" },
  { id: "Devices", label: "Devices", icon: "⌁", group: "support" },
  { id: "Settings", label: "Settings", icon: "⚙", group: "support" },
  { id: "Help", label: "Help & Support", icon: "?", group: "support" },
] as const;

const fieldLabels: Record<string, string> = {
  displayName: "Display name", timezone: "Time zone", goals: "Training goals", priority: "Training priority",
  weeklyStrengthSessions: "Strength sessions per week", weeklyEnduranceSessions: "Endurance sessions per week",
  maxSessionMinutes: "Maximum session length", trainingDays: "Training days", equipment: "Available equipment",
  strengthConstraints: "Strength constraints", constraintNotes: "Training limitations",
  explicitRecoveryHours: "Recovery time between hard sessions",
};

const friendlyWords: Record<string, string> = {
  general_fitness: "General fitness", build_strength: "Build strength", build_muscle: "Build muscle",
  improve_endurance: "Improve endurance", fat_loss: "Fat loss", bodyweight: "Bodyweight",
  dumbbell: "Dumbbells", barbell: "Barbell", cable: "Cable machine", machine: "Machines",
  strength: "Strength", endurance: "Endurance", sport_skill: "Sport skill", mind_body: "Mind-body", recovery: "Recovery",
};

export function friendlyLabel(value: string): string {
  return friendlyWords[value] ?? value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60); const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

export function formatDistance(meters: number): string {
  return meters >= 1000 ? `${Number((meters / 1000).toFixed(1))} km` : `${Math.round(meters)} m`;
}

export function formatDateTime(value: string, timezone?: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value));
}

export function formatProposalValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (Array.isArray(value)) {
    if (!value.length) return "None";
    return value.map((item) => friendlyLabel(String(item))).join(", ");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return friendlyLabel(String(value));
}

export function proposalChanges(profile: AthleteProfile, patch: Partial<AthleteProfile>) {
  return Object.entries(patch)
    .filter(([key]) => key !== "ownerId" && key in fieldLabels)
    .map(([key, value]) => {
      const format = (entry: unknown) => key === "trainingDays" && Array.isArray(entry)
        ? (entry.length ? [...entry].sort().map((day) => ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][Number(day)]).join(", ") : "Flexible days")
        : formatProposalValue(entry);
      return { label: fieldLabels[key]!, before: format(profile[key as keyof AthleteProfile]), after: format(value) };
    });
}

export function validationMessage(result: ValidationResult): string {
  const details = [...Object.values(result.evidence), ...result.missingFacts].filter((value) => value !== null && value !== undefined).map(String).join(", ");
  const label = friendlyLabel(result.reasonCode);
  return details ? `${label}: ${details}` : label;
}

export function deviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function timezoneOptions(current: string): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  const supported = intl.supportedValuesOf?.("timeZone") ?? [];
  return [...new Set([deviceTimezone(), current, ...supported])].filter(Boolean).sort();
}

export function isUntouchedDefaultProfile(profile: AthleteProfile): boolean {
  return profile.displayName === "Athlete" && profile.timezone === "Asia/Hong_Kong" && profile.goals.length === 1 && profile.goals[0] === "general_fitness"
    && profile.weeklyStrengthSessions === 2 && profile.weeklyEnduranceSessions === 2 && profile.trainingDays.length === 0
    && profile.equipment.join("|") === "bodyweight|dumbbell|cable|machine" && profile.constraintNotes.length === 0 && profile.strengthConstraints.length === 0;
}

export function profilePayload(current: AthleteProfile, edits: AthleteProfile = current): AthleteProfile {
  return {
    ...current,
    ownerId: "local-user",
    timezone: edits.timezone,
    goals: edits.goals,
    priority: edits.priority,
    weeklyStrengthSessions: edits.weeklyStrengthSessions,
    weeklyEnduranceSessions: edits.weeklyEnduranceSessions,
    maxSessionMinutes: edits.maxSessionMinutes,
    trainingDays: [...new Set(edits.trainingDays)].sort((a, b) => a - b),
    equipment: edits.equipment,
  };
}

export function pendingPlanDrafts(drafts: StoredDraft[], versions: PlanVersion[]): StoredDraft[] { const approved = new Set(versions.map((version) => version.plan.id)); return drafts.filter((item) => !approved.has(item.draft.id)); }
export function isPlanDraftApproved(draftId: string, versions: PlanVersion[]): boolean { return versions.some((version) => version.plan.id === draftId); }
export function primaryPlanDraft(drafts: StoredDraft[], versions: PlanVersion[]): StoredDraft | null { return pendingPlanDrafts(drafts, versions)[0] ?? drafts[0] ?? null; }

export function referencedTemplates(mesocycle: Mesocycle, templates: SessionTemplate[]): { templates: SessionTemplate[]; missingIds: string[] } {
  const byId = new Map(templates.map((item) => [item.id, item]));
  const resolved: SessionTemplate[] = []; const missingIds: string[] = []; const seen = new Set<string>();
  for (const day of [...mesocycle.weeklyStructure].sort((a, b) => a.dayOfWeek - b.dayOfWeek)) {
    for (const id of day.templateIds) {
      if (seen.has(id)) continue; seen.add(id);
      const template = byId.get(id);
      if (template) resolved.push(template); else missingIds.push(id);
    }
  }
  return { templates: resolved, missingIds };
}
export function resolveSelectedTemplate(referenced: SessionTemplate[], selectedId: string): SessionTemplate | undefined { return referenced.find((item) => item.id === selectedId) ?? referenced[0]; }
