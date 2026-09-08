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

export interface ExerciseDefinition {
  key: string;
  name: string;
  movement: string;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  equipment: string[];
  unilateral: boolean;
  tags: string[];
}

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
  classification: {
    primaryMovement: ClassificationFact<string | null>;
    primaryMuscles: ClassificationFact<string[]>;
    secondaryMuscles: ClassificationFact<string[]>;
    equipment: ClassificationFact<string[]>;
    impact: ClassificationFact<string | null>;
    laterality: ClassificationFact<string | null>;
  };
}

export interface ClassificationFact<T> { value: T; source: string; confidence: number; evidence: string; taxonomyVersion: string }

export interface PlanComponent {
  id: string;
  name: string;
  domain: { value: "strength" | "endurance" | "sport_skill" | "mind_body" | "recovery" | null; source: string; confidence: number; evidence: string; taxonomyVersion: string };
  prescription: { kind: "strength"; exercises: PlanExercise[] } | { kind: "duration_only"; notes: string };
}

export interface Mesocycle {
  durationWeeks: number;
  schedule:
    | { kind: "fixed_week"; days: Array<{ id: string; dayOfWeek: number; templateIds: string[] }> }
    | { kind: "flexible_week"; targetSessionsPerWeek: number; minSessionsPerWeek: number; maxSessionsPerWeek: number; rotation: Array<{ id: string; templateIds: string[] }> }
    | { kind: "interval"; intervalDays: number; rotation: Array<{ id: string; templateIds: string[] }> };
  phases: Array<{ id: string; phaseType: "foundation" | "progression" | "deload" | "peak" | "test" | "recovery"; name: string; startWeek: number; endWeek: number; focus: string; progression: string[] }>;
  adjustmentRules: Array<{ trigger: string; action: string; rationale: string }>;
}

export interface SessionTemplate { id: string; name: string; intent: string; durationMinutes: number; recoveryDemand: "low" | "normal" | "high"; notes: string; components: PlanComponent[] }
export interface StoredSessionTemplate extends SessionTemplate { ownerId: string; revision: number; createdAt: string; updatedAt: string }
export interface CurrentPlan { planSchemaVersion: "5.0"; ownerId: string; title: string; summary: string; effectiveStartDate: string; mesocycle: Mesocycle; revision: number; sourceAgent: string | null; model: string | null; skillVersion: string | null; inputSnapshotHash: string | null; updatedAt: string }
export interface PlanDraft { planSchemaVersion: "3.0"; id: string; title: string; summary: string; mesocycle: ({ durationWeeks: number; weeklyStructure: Array<{ dayOfWeek: number; templateIds: string[] }>; phases: Mesocycle["phases"]; adjustmentRules: Mesocycle["adjustmentRules"]; sessionTemplates: SessionTemplate[] }) | null; migration?: { reviewRequired: boolean; sourceSchema: string; sourceSessions: unknown[] } | null; updatedAt?: string }
export interface StoredDraft { draft: PlanDraft; validation: PlanValidation }
export interface PlanVersion { id: string; versionNumber: number; plan: PlanDraft; validation: PlanValidation; approvedAt: string; changeReason: string }

export interface PlannedSession {
  id: string;
  occurrenceId: string;
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
export interface NextTrainingDay { nextTrainingDay: null | { occurrenceId: string; scheduledDate: string; dayOfWeek: number; weekNumber: number; phaseId: string; phaseType: string; expectedTemplateIds: string[]; existingSessions: PlannedSession[]; revision: number; timezone: string }; reasonCode: string | null }

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

export type TemplateComponentDomain = NonNullable<PlanComponent["domain"]["value"]>;
export interface CustomExerciseInput { name: string; movement: string; primaryMuscles: string[]; equipment: string[] }

const taxonomyVersion = "strength-1.0";
const classifiedFact = <T,>(value: T, source: "catalog" | "user_confirmed", evidence: string) => ({ value, source, confidence: 1, evidence, taxonomyVersion });

export function catalogExercise(definition: ExerciseDefinition, id: string = crypto.randomUUID()): PlanExercise {
  const evidence = `Exercise catalog: ${definition.key}`;
  return {
    id, displayName: definition.name, canonicalKey: definition.key,
    classification: {
      primaryMovement: classifiedFact(definition.movement, "catalog", evidence),
      primaryMuscles: classifiedFact([...definition.primaryMuscles], "catalog", evidence),
      secondaryMuscles: classifiedFact([...definition.secondaryMuscles], "catalog", evidence),
      equipment: classifiedFact([...definition.equipment], "catalog", evidence),
      impact: classifiedFact(null, "catalog", "Exercise catalog does not specify impact"),
      laterality: classifiedFact(definition.unilateral ? "unilateral" : "bilateral", "catalog", evidence),
    },
    sets: 3, repsMin: 8, repsMax: 12, targetRpe: null, restSeconds: 90,
    referenceLoad: null, referenceLoadUnit: null, notes: "",
  };
}

export function customExercise(input: CustomExerciseInput = { name: "", movement: "", primaryMuscles: [], equipment: [] }, id: string = crypto.randomUUID()): PlanExercise {
  const evidence = "Entered in Dashboard";
  return {
    id, displayName: input.name, canonicalKey: null,
    classification: {
      primaryMovement: classifiedFact(input.movement || null, "user_confirmed", evidence),
      primaryMuscles: classifiedFact([...input.primaryMuscles], "user_confirmed", evidence),
      secondaryMuscles: classifiedFact([], "user_confirmed", evidence),
      equipment: classifiedFact([...input.equipment], "user_confirmed", evidence),
      impact: classifiedFact(null, "user_confirmed", evidence),
      laterality: classifiedFact(null, "user_confirmed", evidence),
    },
    sets: 3, repsMin: 8, repsMax: 12, targetRpe: null, restSeconds: 90,
    referenceLoad: null, referenceLoadUnit: null, notes: "",
  };
}

export function templateComponent(domain: TemplateComponentDomain, id: string = crypto.randomUUID()): PlanComponent {
  const name = friendlyLabel(domain);
  return {
    id, name,
    domain: classifiedFact(domain, "user_confirmed", "Selected in Dashboard"),
    prescription: domain === "strength" ? { kind: "strength", exercises: [] } : { kind: "duration_only", notes: "" },
  };
}

export function editableTemplate(value: SessionTemplate): SessionTemplate {
  return structuredClone({ id: value.id, name: value.name, intent: value.intent, durationMinutes: value.durationMinutes, recoveryDemand: value.recoveryDemand, notes: value.notes, components: value.components });
}

export function templateEditorErrors(template: SessionTemplate): string[] {
  const errors: string[] = [];
  if (!template.name.trim()) errors.push("Enter a template name.");
  if (!template.intent.trim()) errors.push("Enter the training goal.");
  if (!Number.isInteger(template.durationMinutes) || template.durationMinutes < 1 || template.durationMinutes > 240) errors.push("Duration must be between 1 and 240 minutes.");
  if (template.components.length === 0) errors.push("Add at least one component.");
  template.components.forEach((component, componentIndex) => {
    const componentLabel = `Component ${componentIndex + 1}`;
    if (!component.name.trim()) errors.push(`${componentLabel} needs a name.`);
    if (component.prescription.kind === "duration_only") {
      if (!component.prescription.notes.trim()) errors.push(`${componentLabel} needs session instructions.`);
      return;
    }
    if (component.prescription.exercises.length === 0) errors.push(`${componentLabel} needs at least one exercise.`);
    component.prescription.exercises.forEach((exercise, exerciseIndex) => {
      const label = `${componentLabel}, exercise ${exerciseIndex + 1}`;
      if (!exercise.displayName.trim()) errors.push(`${label} needs a name.`);
      if (!Number.isInteger(exercise.sets) || exercise.sets < 1 || exercise.sets > 20) errors.push(`${label} sets must be between 1 and 20.`);
      if (!Number.isInteger(exercise.repsMin) || exercise.repsMin < 1 || exercise.repsMin > 100 || !Number.isInteger(exercise.repsMax) || exercise.repsMax < exercise.repsMin || exercise.repsMax > 100) errors.push(`${label} reps must be between 1 and 100, with max at least min.`);
      if (exercise.targetRpe !== null && (exercise.targetRpe < 1 || exercise.targetRpe > 10)) errors.push(`${label} RPE must be between 1 and 10.`);
      if (!Number.isInteger(exercise.restSeconds) || exercise.restSeconds < 0 || exercise.restSeconds > 600) errors.push(`${label} rest must be between 0 and 600 seconds.`);
      if (exercise.referenceLoad !== null && exercise.referenceLoad < 0) errors.push(`${label} reference load cannot be negative.`);
      if (exercise.canonicalKey === null) {
        if (!exercise.classification.primaryMovement.value) errors.push(`${label} needs a movement pattern.`);
        if (!Array.isArray(exercise.classification.primaryMuscles.value) || exercise.classification.primaryMuscles.value.length === 0) errors.push(`${label} needs a primary muscle.`);
        if (!Array.isArray(exercise.classification.equipment.value) || exercise.classification.equipment.value.length === 0) errors.push(`${label} needs equipment.`);
      }
    });
  });
  return errors;
}

export function pendingPlanDrafts(drafts: StoredDraft[], versions: PlanVersion[]): StoredDraft[] { const approved = new Set(versions.map((version) => version.plan.id)); return drafts.filter((item) => !approved.has(item.draft.id)); }
export function isPlanDraftApproved(draftId: string, versions: PlanVersion[]): boolean { return versions.some((version) => version.plan.id === draftId); }
export function primaryPlanDraft(drafts: StoredDraft[], versions: PlanVersion[]): StoredDraft | null { return pendingPlanDrafts(drafts, versions)[0] ?? drafts[0] ?? null; }

export function referencedTemplates(mesocycle: Mesocycle, templates: SessionTemplate[]): { templates: SessionTemplate[]; missingIds: string[] } {
  const byId = new Map(templates.map((item) => [item.id, item]));
  const resolved: SessionTemplate[] = []; const missingIds: string[] = []; const seen = new Set<string>();
  const slots = mesocycle.schedule.kind === "fixed_week" ? [...mesocycle.schedule.days].sort((a, b) => a.dayOfWeek - b.dayOfWeek) : mesocycle.schedule.rotation;
  for (const slot of slots) {
    for (const id of slot.templateIds) {
      if (seen.has(id)) continue; seen.add(id);
      const template = byId.get(id);
      if (template) resolved.push(template); else missingIds.push(id);
    }
  }
  return { templates: resolved, missingIds };
}
export function resolveSelectedTemplate(referenced: SessionTemplate[], selectedId: string): SessionTemplate | undefined { return referenced.find((item) => item.id === selectedId) ?? referenced[0]; }
