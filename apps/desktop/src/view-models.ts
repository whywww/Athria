export const PREFERENCE_MAX_LENGTH = 80;

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
  preferredName: string;
  gender: "female" | "male" | "non_binary" | "prefer_not_to_say" | null;
  heightCm: number | null;
  birthDate: string | null;
  timezone: string;
  goals: string[];
  preference: string;
  maxSessionMinutes: number;
  trainingRhythm:
    | { kind: "fixed_week"; days: number[] }
    | { kind: "flexible_week"; targetDaysPerWeek: number; minDaysPerWeek: number; maxDaysPerWeek: number }
    | { kind: "interval"; intervalDays: number };
  equipment: string[];
  injuries: string[];
  constraintNotes: string[];
  explicitRecoveryDays: number | null;
}

export interface PlanExercise {
  id: string;
  displayName: string;
  canonicalKey: string | null;
  sets: number;
  repsMin: number;
  repsMax: number;
  targetRpe: number | null;
  targetRir?: number | null;
  restSeconds: number;
  referenceLoad: number | null;
  referenceLoadUnit: "kg" | "lb" | null;
  tempo?: string | null;
  alternatives?: string[];
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

export interface EnduranceStep { type: "step"; name: string; role: "warm_up" | "steady" | "work" | "recovery" | "cool_down"; durationSeconds?: number; distanceMeters?: number; pace?: string; heartRateZone?: string; powerWatts?: string; cadence?: string; rpe?: string; talkTest?: string; notes?: string }
export interface EnduranceRepeat { type: "repeat"; name: string; repetitions: number; work: EnduranceStep; recovery?: EnduranceStep; notes?: string }
export interface SportBlock { name: string; role: "preparation" | "technical" | "tactical" | "small_sided_game" | "match" | "competition" | "conditioning" | "cool_down"; durationMinutes?: number; intensity?: string; instructions?: string }
export interface RecoveryBlock { name: string; durationMinutes?: number; instructions?: string }

export interface PlanComponent {
  id: string;
  name: string;
  domain: { value: "strength" | "endurance" | "sport_skill" | "mind_body" | "recovery" | null; source: string; confidence: number; evidence: string; taxonomyVersion: string };
  prescription: { kind: "strength"; exercises: PlanExercise[] }
    | { kind: "endurance"; segments: Array<EnduranceStep | EnduranceRepeat> }
    | { kind: "sport_skill"; sessionType: "practice" | "match" | "competition"; blocks: SportBlock[] }
    | { kind: "recovery" | "mind_body"; blocks: RecoveryBlock[] }
    | { kind: "duration_only"; notes: string };
}

export interface Mesocycle {
  durationWeeks: number;
  schedule: AthleteProfile["trainingRhythm"];
  domainProgressions: Array<{ domain: TemplateComponentDomain; phases: DomainPhase[] }>;
  weeks: Array<{ weekNumber: number; focus: string | null; sessions: Array<{ id: string; scheduledDate: string; order: number; templateRef: TemplateRef | null; name: string; intent: string; durationMinutes: number; recoveryDemand: "low" | "normal" | "high"; keySession: boolean; components: PlanComponent[]; progressionNote: string | null; schedulingRationale: string | null; legacySnapshot: boolean }> }>;
  adjustmentRules: Array<{ trigger: string; action: string; rationale: string }>;
}

export interface PersonalInformation {
  preferredName: string;
  gender: AthleteProfile["gender"];
  heightCm: number | null;
  birthDate: string | null;
  weightKg: number | null;
  weightDate: string | null;
  snapshotHash: string;
}
export interface DomainPhase { id: string; phaseType: "foundation" | "progression" | "deload" | "peak" | "test" | "recovery"; name: string; startWeek: number; endWeek: number; focus: string; progression: string[] }
export interface PhaseRef { domain: TemplateComponentDomain; phaseId: string }

export interface TemplateBlock { name?: string; role: string; optional?: true; variables: string[]; optionalVariables?: string[] }
export interface StrengthTemplateSlot extends TemplateBlock { movementPatternIds?: string[]; targetMuscleIds?: string[]; matchPolicy?: "all" }
export interface SessionTemplate { id: string; name: string; intent: string; domain: TemplateComponentDomain; nodes: Array<TemplateBlock | StrengthTemplateSlot> }
export type StoredSessionTemplate = SessionTemplate & ({ origin: "builtin"; catalogVersion: string } | { origin: "user"; revision: number });
export type TemplateRef = { source: "builtin"; id: string; catalogVersion: string } | { source: "user"; id: string; revision: number };
export interface TaxonomyEntry { id: string; label: string; parentId: string | null; selectable: boolean }
export interface EquipmentItem { id: string; label: string }
export interface EquipmentGroup { id: string; label: string; items: EquipmentItem[] }
export interface EquipmentCategory { id: string; label: string; groups: EquipmentGroup[] }
export interface TrainingTaxonomy { taxonomyVersion: string; templateCatalogVersion: string; equipmentCategories: EquipmentCategory[]; strength: { movementPatterns: TaxonomyEntry[]; muscleGroups: TaxonomyEntry[]; equipment: string[] }; templateVariables: Record<TemplateComponentDomain, string[]> }
// Optional Plan Target layer mirroring planTargetSchema (see UNIFIED_MULTISPORT_MESOCYCLE_DESIGN §5). Absent on legacy plans.
export interface PlanTarget {
  primaryGoal?: { label: string; baseline?: string | null; testDate?: string | null };
  supporting?: Array<{ label: string; detail?: string }>;
  maintenance?: Array<{ label: string; detail?: string }>;
  coordinationStrategy?: string;
}
export interface CurrentPlan { planSchemaVersion: "7.0"; ownerId: string; title: string; summary: string; effectiveStartDate: string; mesocycle: Mesocycle; revision: number; sourceAgent: string | null; model: string | null; skillVersion: string | null; inputSnapshotHash: string | null; updatedAt: string; target?: PlanTarget }

export interface PlannedSession {
  id: string;
  occurrenceId: string;
  weekNumber: number;
  name: string;
  intent: string;
  scheduledDate: string;
  order: number;
  durationMinutes: number;
  templateRef: TemplateRef | null;
  phaseRefs: PhaseRef[];
  recoveryDemand: "low" | "normal" | "high";
  keySession?: boolean;
  progressionNote?: string | null;
  schedulingRationale?: string | null;
  status: "planned" | "completed" | "skipped";
  components: PlanComponent[];
  notes: string;
  legacySnapshot: boolean;
  overrideReason: string | null;
}

// Calendar entry returned by GET /api/plans/calendar (AthriaApplication.getCalendar).
export interface CalendarSession {
  id: string;
  occurrenceId: string;
  revision: number;
  scheduledDate: string;
  order: number;
  weekNumber: number;
  phaseRefs: PhaseRef[];
  templateRef: TemplateRef | null;
  name: string;
  intent: string;
  durationMinutes: number;
  recoveryDemand: "low" | "normal" | "high";
  keySession: boolean;
  progressionNote: string | null;
  schedulingRationale: string | null;
  status: "planned" | "completed" | "skipped";
  components: PlanComponent[];
  legacySnapshot: boolean;
  overrideReason: string | null;
}

export interface ValidationResult { status: "pass" | "fail" | "unknown" | "not_applicable"; enforcement: "blocker" | "advisory" | "info"; reasonCode: string; evidence: Record<string, unknown>; missingFacts: string[]; subjectRefs: string[] }
export interface DataGap { code: string; subjectRef: string; factPath: string; requiredByRuleCodes: string[]; blocking: boolean; resolution: "agent_infer" | "user_confirm" | "add_profile_data" }
export interface PlanValidation { valid: boolean; results: ValidationResult[]; dataGaps: DataGap[]; coverage?: { hardChecksResolved: number; hardChecksTotal: number; movementFactsResolved: number; movementFactsTotal: number; muscleFactsResolved: number; muscleFactsTotal: number; equipmentFactsResolved: number; equipmentFactsTotal: number } }
export interface NextTrainingDay { nextTrainingDay: null | { occurrenceId: string; scheduledDate: string; dayOfWeek: number; weekNumber: number; domainPhases: Array<{ domain: TemplateComponentDomain; phaseId: string; phaseType: DomainPhase["phaseType"]; name: string }>; existingSessions: PlannedSession[]; revision: number; timezone: string }; reasonCode: string | null }

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
export interface BackupPreview {
  path: string;
  manifest: { athriaVersion: string; createdAt: string; secretsIncluded: false };
  counts: { workouts: number; templates: number; plans: number };
}
export const dashboardPages = [
  { id: "Overview", label: "Overview", icon: "⌂", group: "primary" },
  { id: "Training", label: "Training", icon: "›››", group: "primary" },
  { id: "Profile", label: "Profile", icon: "♡", group: "primary" },
  { id: "Plan", label: "Plan", icon: "≡", group: "primary" },
  { id: "Devices", label: "Devices", icon: "⌁", group: "support" },
  { id: "Settings", label: "Settings", icon: "⚙", group: "support" },
  { id: "Help", label: "Help & Support", icon: "?", group: "support" },
] as const;

const friendlyWords: Record<string, string> = {
  general_fitness: "General fitness", build_strength: "Build strength", build_muscle: "Build muscle",
  improve_endurance: "Improve endurance", fat_loss: "Fat loss", bodyweight: "Bodyweight",
  dumbbell: "Dumbbells", barbell: "Barbell", cable: "Cable Machine", machine: "Fixed Machines", trx: "TRX", ski_erg: "SkiErg", sled: "Sled / Prowler", mini_stability_ball: "Mini Stability Ball",
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

export function equipmentGroupState(selected: string[], itemIds: string[]): "none" | "some" | "all" {
  const count = itemIds.filter((id) => selected.includes(id)).length;
  return count === 0 ? "none" : count === itemIds.length ? "all" : "some";
}

export function toggleEquipmentGroup(selected: string[], itemIds: string[]): string[] {
  const group = new Set(itemIds);
  return equipmentGroupState(selected, itemIds) === "all"
    ? selected.filter((id) => !group.has(id))
    : [...selected, ...itemIds.filter((id) => !selected.includes(id))];
}

export function formatTrainingRhythm(rhythm: AthleteProfile["trainingRhythm"]): string {
  if (rhythm.kind === "fixed_week") return `Fixed · ${rhythm.days.map((day) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day]).join(" / ")}`;
  if (rhythm.kind === "flexible_week") return `Flexible · Target ${rhythm.targetDaysPerWeek} days (${rhythm.minDaysPerWeek}–${rhythm.maxDaysPerWeek})`;
  return `Every ${rhythm.intervalDays} ${rhythm.intervalDays === 1 ? "day" : "days"}`;
}

export function validationMessage(result: ValidationResult): string {
  const details = [...Object.values(result.evidence), ...result.missingFacts].filter((value) => value !== null && value !== undefined).map(String).join(", ");
  const label = friendlyLabel(result.reasonCode);
  return details ? `${label}: ${details}` : label;
}

export function deviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// Formats an IANA zone as "Hong Kong (GMT+08:00)"; falls back to the raw zone string when Intl cannot resolve it.
export function formatTimezoneLabel(zone: string): string {
  try {
    const city = (zone.split("/").pop() || zone).replaceAll("_", " ");
    const parts = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts();
    const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    const match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    const offset = match ? `GMT${match[1]}${match[2]!.padStart(2, "0")}:${match[3] ?? "00"}` : name;
    return `${city} (${offset})`;
  } catch {
    return zone;
  }
}

export function timezoneOptions(current: string): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  const supported = intl.supportedValuesOf?.("timeZone") ?? [];
  return [...new Set([deviceTimezone(), current, ...supported])].filter(Boolean).sort();
}

export function isUntouchedDefaultProfile(profile: AthleteProfile): boolean {
  return profile.preferredName === "Athlete" && profile.timezone === "Asia/Hong_Kong" && profile.goals.length === 1 && profile.goals[0] === "general_fitness"
    && profile.trainingRhythm.kind === "flexible_week" && profile.trainingRhythm.targetDaysPerWeek === 4 && profile.trainingRhythm.minDaysPerWeek === 3 && profile.trainingRhythm.maxDaysPerWeek === 5
    && profile.equipment.length === 30 && profile.injuries.length === 0 && profile.constraintNotes.length === 0 && profile.explicitRecoveryDays === null;
}

export function profilePayload(current: AthleteProfile, edits: AthleteProfile = current): AthleteProfile {
  return {
    ...current,
    ownerId: "local-user",
    timezone: edits.timezone,
    goals: edits.goals,
    preference: edits.preference.trim().slice(0, PREFERENCE_MAX_LENGTH),
    maxSessionMinutes: edits.maxSessionMinutes,
    trainingRhythm: edits.trainingRhythm.kind === "fixed_week"
      ? { ...edits.trainingRhythm, days: [...new Set(edits.trainingRhythm.days)].sort((a, b) => a - b) }
      : { ...edits.trainingRhythm },
    equipment: edits.equipment,
  };
}

export type TemplateComponentDomain = NonNullable<PlanComponent["domain"]["value"]>;
export interface CustomExerciseInput { name: string; movement: string; primaryMuscles: string[]; equipment: string[] }

const taxonomyVersion = "strength-2.0";
const classifiedFact = <T,>(value: T, source: "user_confirmed", evidence: string) => ({ value, source, confidence: 1, evidence, taxonomyVersion });

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

export function editableTemplate(value: SessionTemplate): SessionTemplate {
  return structuredClone({ id: value.id, name: value.name, intent: value.intent, domain: value.domain, nodes: value.nodes });
}

export function templateNodeName(node: TemplateBlock): string { return node.name ?? friendlyLabel(node.role); }

export function templateEditorErrors(template: SessionTemplate): string[] {
  const errors: string[] = [];
  if (!template.name.trim()) errors.push("Enter a template name.");
  if (!template.intent.trim()) errors.push("Enter the training goal.");
  const nodes = template.nodes;
  if (!nodes.length) errors.push("Add at least one structure node.");
  nodes.forEach((node, index) => {
    const optionalVariables = node.optionalVariables ?? [];
    if (!node.variables.length && !optionalVariables.length) errors.push(`Node ${index + 1} needs at least one variable.`);
    if (node.variables.some((key) => optionalVariables.includes(key))) errors.push(`Node ${index + 1} has a variable marked both required and optional.`);
    if (template.domain === "strength") {
      const slot = node as StrengthTemplateSlot;
      if (!slot.movementPatternIds?.length && !slot.targetMuscleIds?.length) errors.push(`Node ${index + 1} needs a movement pattern or target muscle.`);
    }
  });
  return errors;
}

export function referencedTemplates(mesocycle: Mesocycle, templates: SessionTemplate[]): { templates: SessionTemplate[]; missingIds: string[] } {
  const byId = new Map(templates.map((item) => [item.id, item])); const ids = [...new Set(mesocycle.weeks.flatMap((week) => week.sessions.map((session) => session.templateRef?.id).filter((id): id is string => Boolean(id))))];
  return { templates: ids.map((id) => byId.get(id)).filter((item): item is SessionTemplate => Boolean(item)), missingIds: ids.filter((id) => !byId.has(id)) };
}
export function resolveSelectedTemplate(referenced: SessionTemplate[], selectedId: string): SessionTemplate | undefined { return referenced.find((item) => item.id === selectedId) ?? referenced[0]; }
