import * as z from "zod";

export const OWNER_ID = "local-user";
export const FORMULA_VERSION = "0.2.0";
export const RULE_VERSION = "0.2.0";
export const PLAN_SCHEMA_VERSION = "7.0";
export const TAXONOMY_VERSION = "strength-2.0";
export const TEMPLATE_CATALOG_VERSION = "2.0";
export const AI_HARD_CONFIDENCE = 0.9;
export const MAX_PROFILE_NOTE_ENTRIES = 10;
export const MAX_PROFILE_NOTE_LENGTH = 200;

// Kept only as source metadata for imported records. Plans use components.
export const modalitySchema = z.enum(["strength", "endurance", "recovery", "mixed", "unknown"]);
export const domainSchema = z.enum(["strength", "endurance", "sport_skill", "mind_body", "recovery"]);
export const phaseTypeSchema = z.enum(["foundation", "progression", "deload", "peak", "test", "recovery"]);
export const recoveryDemandSchema = z.enum(["low", "normal", "high"]);
export const weightUnitSchema = z.enum(["kg", "lb"]);
export const factSourceSchema = z.enum(["catalog", "structured_source", "exact_alias", "ai_inferred", "user_confirmed", "migration"]);
export const movementPatternIds = ["squat", "hinge", "lunge", "step", "bridge_hip_thrust", "horizontal_push", "vertical_push", "horizontal_pull", "vertical_pull", "shoulder_abduction", "shoulder_external_rotation", "elbow_flexion", "elbow_extension", "knee_extension", "knee_flexion", "hip_abduction", "hip_adduction", "calf_raise", "dorsiflexion", "carry", "rotation", "anti_rotation", "trunk_flexion", "trunk_extension", "lateral_flexion", "anti_extension", "anti_lateral_flexion", "jump", "throw", "locomotion", "olympic_lift", "isolation", "other"] as const;
export const muscleGroupIds = ["chest", "upper_back", "back", "lats", "shoulders", "arms", "biceps", "triceps", "forearms", "quadriceps", "hamstrings", "thighs", "hips", "glutes", "calves", "lower_legs", "core", "spinal_erectors", "hip_flexors", "adductors", "abductors", "full_body", "other", "pectoralis_major_clavicular", "pectoralis_major_sternal", "latissimus_dorsi", "trapezius_upper", "trapezius_middle_lower", "rhomboids", "anterior_deltoid", "lateral_deltoid", "posterior_deltoid", "rotator_cuff", "biceps_brachii", "brachialis", "triceps_brachii", "forearm_flexors", "forearm_extensors", "gluteus_maximus", "gluteus_medius", "gluteus_minimus", "gastrocnemius", "soleus", "tibialis_anterior", "rectus_abdominis", "obliques", "transverse_abdominis"] as const;
export const movementPatternSchema = z.enum(movementPatternIds);
export const muscleGroupSchema = z.enum(muscleGroupIds);
export interface TaxonomyEntry { id: string; label: string; parentId: string | null; selectable: boolean }
const title = (id: string) => id.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
const muscleParents: Record<string, string> = {
  pectoralis_major_clavicular: "chest", pectoralis_major_sternal: "chest", latissimus_dorsi: "back", trapezius_upper: "back", trapezius_middle_lower: "back", rhomboids: "back", spinal_erectors: "back",
  anterior_deltoid: "shoulders", lateral_deltoid: "shoulders", posterior_deltoid: "shoulders", rotator_cuff: "shoulders", biceps_brachii: "arms", brachialis: "arms", triceps_brachii: "arms", forearm_flexors: "arms", forearm_extensors: "arms",
  gluteus_maximus: "glutes", gluteus_medius: "glutes", gluteus_minimus: "glutes", quadriceps: "thighs", hamstrings: "thighs", adductors: "thighs", hip_flexors: "hips", gastrocnemius: "lower_legs", soleus: "lower_legs", tibialis_anterior: "lower_legs",
  rectus_abdominis: "core", obliques: "core", transverse_abdominis: "core",
};
export const muscleTaxonomy: TaxonomyEntry[] = muscleGroupIds.map((id) => ({ id, label: title(id), parentId: muscleParents[id] ?? null, selectable: true }));
export const movementPatternTaxonomy: TaxonomyEntry[] = movementPatternIds.map((id) => ({ id, label: title(id), parentId: null, selectable: true }));
export const equipmentCategories = [
  { id: "strength_resistance", label: "Strength & Resistance", groups: [
    { id: "free_weights", label: "Free Weights", items: [{ id: "dumbbell", label: "Dumbbells" }, { id: "barbell", label: "Barbell" }, { id: "kettlebell", label: "Kettlebell" }] },
    { id: "machines_cable", label: "Machines & Cable", items: [{ id: "cable", label: "Cable Machine" }, { id: "smith_machine", label: "Smith Machine" }, { id: "machine", label: "Fixed Machines" }, { id: "landmine", label: "Landmine" }] },
    { id: "bodyweight_gymnastics", label: "Bodyweight & Gymnastics", items: [{ id: "pull_up_bar", label: "Pull-Up Bar" }, { id: "trx", label: "TRX" }, { id: "bench", label: "Bench" }, { id: "plyo_box", label: "Plyo Box" }] },
    { id: "functional_gear", label: "Functional Gear", items: [{ id: "resistance_band", label: "Resistance Bands" }, { id: "medicine_ball", label: "Medicine Ball" }, { id: "sandbag", label: "Sandbag" }, { id: "sled", label: "Sled / Prowler" }] },
  ] },
  { id: "cardio_endurance", label: "Cardio & Endurance", groups: [
    { id: "indoor_cardio", label: "Indoor Cardio Machines", items: [{ id: "treadmill", label: "Treadmill" }, { id: "exercise_bike", label: "Exercise Bike" }, { id: "rowing_machine", label: "Rowing Machine" }, { id: "elliptical", label: "Elliptical" }, { id: "stepper", label: "Stepper" }, { id: "ski_erg", label: "SkiErg" }, { id: "jump_rope", label: "Jump Rope" }, { id: "battle_rope", label: "Battle Rope" }] },
  ] },
  { id: "mobility_recovery", label: "Mobility, Pilates & Recovery", groups: [
    { id: "mobility_tools", label: "Mobility Tools", items: [{ id: "yoga_mat", label: "Yoga Mat" }, { id: "foam_roller", label: "Foam Roller" }, { id: "massage_ball", label: "Massage Ball" }] },
    { id: "pilates_core", label: "Pilates & Core", items: [{ id: "reformer", label: "Reformer" }, { id: "pilates_ring", label: "Pilates Ring" }, { id: "mini_stability_ball", label: "Mini Stability Ball" }] },
  ] },
  { id: "ball_sport", label: "Ball & Sport-Specific Tools", groups: [
    { id: "ball_sport_tools", label: "Ball & Sport-Specific Tools", items: [{ id: "ball_machine", label: "Ball Machine" }] },
  ] },
] as const;
export const equipmentTypeIds = equipmentCategories.flatMap((category) => category.groups.flatMap((group) => group.items.map((item) => item.id))) as [string, ...string[]];
export const equipmentTypeSchema = z.enum(equipmentTypeIds);

const classifiedFact = <T extends z.ZodTypeAny>(value: T) => z.object({
  value, source: factSourceSchema, confidence: z.number().min(0).max(1), evidence: z.string().max(1000), taxonomyVersion: z.literal(TAXONOMY_VERSION),
  conflicts: z.array(z.object({ source: factSourceSchema, value: z.unknown(), evidence: z.string().min(1).max(1000) }).strict()).max(10).optional(),
}).strict();
export const domainFactSchema = classifiedFact(domainSchema.nullable());
export const movementFactSchema = classifiedFact(movementPatternSchema.nullable());
export const muscleFactSchema = classifiedFact(z.array(muscleGroupSchema));
export const equipmentFactSchema = classifiedFact(z.array(equipmentTypeSchema));
export const impactFactSchema = classifiedFact(z.enum(["low", "moderate", "high"]).nullable());
export const lateralityFactSchema = classifiedFact(z.enum(["bilateral", "unilateral", "alternating"]).nullable());

export const normalizeProfileNote = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();
export const profileNoteListSchema = z.array(z.string().trim().min(1).max(MAX_PROFILE_NOTE_LENGTH)).max(MAX_PROFILE_NOTE_ENTRIES)
  .refine((notes) => new Set(notes.map(normalizeProfileNote)).size === notes.length, { message: "profile notes must not contain duplicate entries" });
const profileWeekdaysSchema = z.array(z.number().int().min(0).max(6)).min(1).max(7)
  .refine((days) => new Set(days).size === days.length, { message: "training rhythm days must be unique" })
  .meta({ uniqueItems: true });
export const trainingRhythmSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed_week"), days: profileWeekdaysSchema }).strict(),
  z.object({ kind: z.literal("flexible_week"), targetDaysPerWeek: z.number().int().min(1).max(7), minDaysPerWeek: z.number().int().min(1).max(7), maxDaysPerWeek: z.number().int().min(1).max(7) }).strict()
    .refine((value) => value.minDaysPerWeek <= value.targetDaysPerWeek && value.targetDaysPerWeek <= value.maxDaysPerWeek, { message: "expected minDaysPerWeek <= targetDaysPerWeek <= maxDaysPerWeek" }),
  z.object({ kind: z.literal("interval"), intervalDays: z.number().int().min(1).max(30) }).strict(),
]);
export const genderSchema = z.enum(["female", "male", "non_binary", "prefer_not_to_say"]);
export const birthDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => value <= new Date().toISOString().slice(0, 10), { message: "birth date must not be in the future" });
export const athleteProfileSchema = z.object({
  ownerId: z.string().default(OWNER_ID), preferredName: z.string().trim().min(1).max(100).default("Athlete"), gender: genderSchema.nullable().default(null), heightCm: z.number().min(50).max(250).nullable().default(null), birthDate: birthDateSchema.nullable().default(null), timezone: z.string().min(1).default("Asia/Hong_Kong"), goals: z.array(z.string()).default(["general_fitness"]),
  preference: z.string().trim().max(80).default(""), // keep in sync with apps/desktop/src/view-models.ts:PREFERENCE_MAX_LENGTH
  maxSessionMinutes: z.number().int().min(15).max(240).default(60), trainingRhythm: trainingRhythmSchema.default({ kind: "flexible_week", targetDaysPerWeek: 4, minDaysPerWeek: 3, maxDaysPerWeek: 5 }),
  equipment: z.array(equipmentTypeSchema).default(equipmentTypeIds), injuries: profileNoteListSchema.default([]), constraintNotes: profileNoteListSchema.default([]), explicitRecoveryDays: z.number().int().min(1).max(7).nullable().default(null),
}).strict();
export const dataQualitySchema = z.object({ completeness: z.number().min(0).max(1), sources: z.array(z.string()), missingFields: z.array(z.string()), anomalies: z.array(z.string()) });
export const metricResultSchema = <T extends z.ZodTypeAny>(value: T) => z.object({ value, unit: z.string(), method: z.string(), formulaVersion: z.string(), timeRange: z.object({ start: z.string().nullable(), end: z.string().nullable() }), dataQuality: dataQualitySchema, limitations: z.array(z.string()) });
export const strengthSetSchema = z.object({
  exerciseRaw: z.string().min(1), exerciseKey: z.string().nullable().default(null), movement: z.string().nullable().default(null), primaryMuscles: z.array(z.string()).default([]), secondaryMuscles: z.array(z.string()).default([]),
  setIndex: z.number().int().min(0), setType: z.string().default("normal"), weight: z.number().min(0).nullable().default(null), weightUnit: weightUnitSchema.nullable().default(null), reps: z.number().int().min(0).nullable().default(null), rpe: z.number().min(0).max(10).nullable().default(null),
  leftWeight: z.number().min(0).nullable().optional(), rightWeight: z.number().min(0).nullable().optional(), durationSeconds: z.number().min(0).nullable().optional(), restSeconds: z.number().min(0).nullable().optional(), plannedRestSeconds: z.number().min(0).nullable().optional(),
}).strict();
export const enduranceDetailsSchema = z.object({ distanceMeters: z.number().min(0).nullable().default(null), averageHeartRate: z.number().min(0).nullable().default(null), maxHeartRate: z.number().min(0).nullable().default(null), averagePowerWatts: z.number().min(0).nullable().default(null), maxPowerWatts: z.number().min(0).nullable().default(null), heartRateZoneSeconds: z.record(z.string(), z.number().min(0)).default({}) }).strict();
export const trainingSessionSchema = z.object({
  id: z.string().min(1), ownerId: z.string().default(OWNER_ID), source: z.string().min(1), externalId: z.string().min(1), modality: modalitySchema, domains: z.array(domainSchema).default([]), sport: z.string().nullable().default(null), name: z.string().min(1),
  startAt: z.string().datetime({ offset: true }), endAt: z.string().datetime({ offset: true }), durationMinutes: z.number().int().min(0), status: z.literal("completed").default("completed"), timezone: z.string().nullable().default(null), plannedSessionId: z.string().min(1).nullable().default(null),
  strengthSets: z.array(strengthSetSchema).default([]), endurance: enduranceDetailsSchema.nullable().default(null), missingFields: z.array(z.string()).default([]),
}).strict();
export const trainingSessionWriteSchema = trainingSessionSchema.omit({ ownerId: true, source: true, status: true }).extend({ id: z.string().min(1).optional(), externalId: z.string().min(1).optional() }).strict();

export const wellnessSourceSchema = z.enum(["intervals_icu", "user", "llm"]);
export const wellnessFieldSchema = <T extends z.ZodTypeAny>(value: T) => z.object({ value: value.nullable(), source: wellnessSourceSchema, updatedAt: z.string().datetime({ offset: true }) }).strict();
const wellnessFields = {
  restingHeartRateBpm: wellnessFieldSchema(z.number().nonnegative()), hrvRmssdMs: wellnessFieldSchema(z.number().nonnegative()), sleepSeconds: wellnessFieldSchema(z.number().int().nonnegative()), sleepScore: wellnessFieldSchema(z.number().min(0).max(100)), weightKg: wellnessFieldSchema(z.number().positive()),
  fatigue: wellnessFieldSchema(z.number().nonnegative()), soreness: wellnessFieldSchema(z.number().nonnegative()), stress: wellnessFieldSchema(z.number().nonnegative()), mood: wellnessFieldSchema(z.number().nonnegative()), motivation: wellnessFieldSchema(z.number().nonnegative()), readiness: wellnessFieldSchema(z.number().nonnegative()), notes: wellnessFieldSchema(z.string().max(2000)),
};
export const wellnessRecordSchema = z.object({ ownerId: z.string().default(OWNER_ID), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), fields: z.object(wellnessFields).partial().strict(), updatedAt: z.string().datetime({ offset: true }) }).strict();
export const wellnessPatchSchema = z.object({ expectedSnapshotHash: z.string().min(1), confirmed: z.literal(true), source: z.enum(["user", "llm"]), fields: z.record(z.string(), z.unknown().nullable()) }).strict();
export const profileUpdateSchema = z.object({ patch: athleteProfileSchema.partial().omit({ ownerId: true }).strict(), expectedProfileHash: z.string().min(1), confirmed: z.literal(true) }).strict();
export const personalInformationWriteSchema = z.object({ preferredName: z.string().trim().min(1).max(100), gender: genderSchema.nullable(), heightCm: z.number().min(50).max(250).nullable(), birthDate: birthDateSchema.nullable(), weightKg: z.number().min(20).max(500).nullable().optional(), expectedSnapshotHash: z.string().min(1) }).strict();
export const planExerciseSchema = z.object({
  id: z.string().min(1), displayName: z.string().min(1), canonicalKey: z.string().min(1).nullable().default(null),
  classification: z.object({ primaryMovement: movementFactSchema, primaryMuscles: muscleFactSchema, secondaryMuscles: muscleFactSchema, equipment: equipmentFactSchema, impact: impactFactSchema, laterality: lateralityFactSchema }).strict(),
  sets: z.number().int().min(1).max(20), repsMin: z.number().int().min(1).max(100), repsMax: z.number().int().min(1).max(100), targetRpe: z.number().min(1).max(10).nullable().default(null), targetRir: z.number().min(0).max(10).nullable().optional(), restSeconds: z.number().int().min(0).max(600).default(90), referenceLoad: z.number().min(0).nullable().default(null), referenceLoadUnit: weightUnitSchema.nullable().default(null), tempo: z.string().max(40).nullable().optional(), alternatives: z.array(z.string().min(1).max(100)).max(10).optional(), notes: z.string().max(1000).default(""),
}).strict().refine((value) => value.repsMax >= value.repsMin, { message: "repsMax must be >= repsMin" });
export const strengthPrescriptionSchema = z.object({ kind: z.literal("strength"), exercises: z.array(planExerciseSchema).min(1).max(30) }).strict();
export const durationOnlyPrescriptionSchema = z.object({ kind: z.literal("duration_only"), notes: z.string().max(4000).default("") }).strict();
const effortTargetShape = {
  durationSeconds: z.number().int().positive().optional(), distanceMeters: z.number().positive().optional(), pace: z.string().min(1).max(80).optional(), heartRateZone: z.string().min(1).max(40).optional(), powerWatts: z.string().min(1).max(40).optional(), cadence: z.string().min(1).max(40).optional(), rpe: z.string().min(1).max(40).optional(), talkTest: z.string().min(1).max(120).optional(), notes: z.string().max(1000).optional(),
};
export const enduranceStepSchema = z.object({ type: z.literal("step"), name: z.string().min(1).max(100), role: z.enum(["warm_up", "steady", "work", "recovery", "cool_down"]), ...effortTargetShape }).strict();
export const enduranceRepeatSchema = z.object({ type: z.literal("repeat"), name: z.string().min(1).max(100), repetitions: z.number().int().min(1).max(100), work: enduranceStepSchema, recovery: enduranceStepSchema.optional(), notes: z.string().max(1000).optional() }).strict();
export const endurancePrescriptionSchema = z.object({ kind: z.literal("endurance"), segments: z.array(z.discriminatedUnion("type", [enduranceStepSchema, enduranceRepeatSchema])).min(1).max(50) }).strict();
export const sportBlockSchema = z.object({ name: z.string().min(1).max(100), role: z.enum(["preparation", "technical", "tactical", "small_sided_game", "match", "competition", "conditioning", "cool_down"]), durationMinutes: z.number().int().positive().optional(), intensity: z.string().min(1).max(80).optional(), instructions: z.string().max(2000).optional() }).strict();
export const sportPrescriptionSchema = z.object({ kind: z.literal("sport_skill"), sessionType: z.enum(["practice", "match", "competition"]), blocks: z.array(sportBlockSchema).min(1).max(30) }).strict();
export const recoveryBlockSchema = z.object({ name: z.string().min(1).max(100), durationMinutes: z.number().int().positive().optional(), instructions: z.string().max(2000).optional() }).strict();
export const recoveryPrescriptionSchema = z.object({ kind: z.literal("recovery"), blocks: z.array(recoveryBlockSchema).min(1).max(30) }).strict();
export const mindBodyPrescriptionSchema = z.object({ kind: z.literal("mind_body"), blocks: z.array(recoveryBlockSchema).min(1).max(30) }).strict();
export const trainingComponentSchema = z.object({ id: z.string().min(1), name: z.string().min(1).max(100), domain: domainFactSchema, prescription: z.discriminatedUnion("kind", [strengthPrescriptionSchema, endurancePrescriptionSchema, sportPrescriptionSchema, recoveryPrescriptionSchema, mindBodyPrescriptionSchema, durationOnlyPrescriptionSchema]) }).strict().superRefine((value, context) => {
  if (value.prescription.kind === "strength" && value.domain.value !== "strength") context.addIssue({ code: "custom", path: ["domain", "value"], message: "strength prescription requires strength domain" });
  if (value.prescription.kind === "duration_only" && value.domain.value === "strength") context.addIssue({ code: "custom", path: ["prescription", "kind"], message: "strength domain requires strength prescription" });
  if (["endurance", "sport_skill", "recovery", "mind_body"].includes(value.prescription.kind) && value.domain.value !== value.prescription.kind) context.addIssue({ code: "custom", path: ["domain", "value"], message: `${value.prescription.kind} prescription requires matching domain` });
});
export const strengthTemplateVariableSchema = z.enum(["exercise_selection", "sets", "repetitions", "duration", "load", "rpe", "rir", "rest", "tempo", "alternatives"]);
export const enduranceTemplateVariableSchema = z.enum(["repetitions", "duration", "distance", "pace", "heart_rate_zone", "power", "cadence", "rpe", "talk_test", "terrain", "strides", "recovery_mode"]);
export const sportTemplateVariableSchema = z.enum(["drill", "participants", "position", "duration", "intensity", "instructions"]);
export const recoveryTemplateVariableSchema = z.enum(["body_region", "movement", "duration", "intensity", "instructions"]);
export const mindBodyTemplateVariableSchema = z.enum(["technique", "duration", "intensity", "instructions"]);
const templateBase = { id: z.string().min(1), name: z.string().min(1).max(100), intent: z.string().min(1).max(240) };
const nodeShape = <T extends z.ZodEnum, R extends z.ZodEnum>(role: R, variables: T) => ({
  name: z.string().min(1).max(100).optional(), role, optional: z.literal(true).optional(),
  variables: z.array(variables).max(20), optionalVariables: z.array(variables).max(20).optional(),
});
const validateNodeVariables = (value: { variables: readonly unknown[]; optionalVariables?: readonly unknown[] | undefined }, context: z.RefinementCtx) => {
  const optional = value.optionalVariables ?? [];
  if (value.variables.length + optional.length === 0) context.addIssue({ code: "custom", path: ["variables"], message: "a template node needs at least one variable" });
  if (new Set(value.variables).size !== value.variables.length || new Set(optional).size !== optional.length) context.addIssue({ code: "custom", path: ["variables"], message: "template variables must be unique" });
  if (value.variables.some((key) => optional.includes(key))) context.addIssue({ code: "custom", path: ["optionalVariables"], message: "required and optional variables must not overlap" });
};
const strengthTemplateNodeSchema = z.object({
  ...nodeShape(z.enum(["primary", "secondary", "accessory", "trunk"]), strengthTemplateVariableSchema),
  movementPatternIds: z.array(movementPatternSchema).min(1).max(20).optional(), targetMuscleIds: z.array(muscleGroupSchema).min(1).max(30).optional(), matchPolicy: z.literal("all").optional(),
}).strict().superRefine((value, context) => {
  validateNodeVariables(value, context);
  if (!value.movementPatternIds?.length && !value.targetMuscleIds?.length) context.addIssue({ code: "custom", path: ["movementPatternIds"], message: "a strength node needs a movement pattern or target muscle" });
});
const abstractNode = <T extends z.ZodEnum, R extends z.ZodEnum>(role: R, variables: T) => z.object(nodeShape(role, variables)).strict().superRefine(validateNodeVariables);
export const sessionTemplateSchema = z.discriminatedUnion("domain", [
  z.object({ ...templateBase, domain: z.literal("strength"), nodes: z.array(strengthTemplateNodeSchema).min(1).max(30) }).strict(),
  z.object({ ...templateBase, domain: z.literal("endurance"), nodes: z.array(abstractNode(z.enum(["warm_up", "steady", "repeat_work_recovery", "cool_down"]), enduranceTemplateVariableSchema)).min(1).max(30) }).strict(),
  z.object({ ...templateBase, domain: z.literal("sport_skill"), nodes: z.array(abstractNode(z.enum(["preparation", "technical", "tactical", "small_sided_game", "match", "competition", "conditioning", "cool_down"]), sportTemplateVariableSchema)).min(1).max(30) }).strict(),
  z.object({ ...templateBase, domain: z.literal("recovery"), nodes: z.array(abstractNode(z.enum(["down_regulation", "mobility", "easy_movement"]), recoveryTemplateVariableSchema)).min(1).max(30) }).strict(),
  z.object({ ...templateBase, domain: z.literal("mind_body"), nodes: z.array(abstractNode(z.enum(["centering", "practice_flow", "breathing", "down_regulation"]), mindBodyTemplateVariableSchema)).min(1).max(30) }).strict(),
]);
export const scheduleSchema = trainingRhythmSchema;
export const builtinTemplateRefSchema = z.object({ source: z.literal("builtin"), id: z.string().min(1), catalogVersion: z.string().min(1) }).strict();
export const userTemplateRefSchema = z.object({ source: z.literal("user"), id: z.string().min(1), revision: z.number().int().positive() }).strict();
export const templateRefSchema = z.discriminatedUnion("source", [builtinTemplateRefSchema, userTemplateRefSchema]);
export const weeklySessionSchema = z.object({
  id: z.string().min(1), scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), order: z.number().int().min(0).max(50), status: z.enum(["planned", "skipped"]).default("planned"), templateRef: templateRefSchema.nullable().default(null), name: z.string().min(1).max(100), intent: z.string().min(1).max(240), durationMinutes: z.number().int().min(1).max(240), recoveryDemand: recoveryDemandSchema.default("normal"), keySession: z.boolean().default(false), components: z.array(trainingComponentSchema).min(1).max(20), progressionNote: z.string().max(2000).nullable().default(null), schedulingRationale: z.string().max(2000).nullable().default(null), legacySnapshot: z.boolean().default(false),
}).strict();
export const planWeekSchema = z.object({ weekNumber: z.number().int().min(1).max(52), focus: z.string().max(300).nullable().default(null), sessions: z.array(weeklySessionSchema).max(50) }).strict().superRefine((value, context) => {
  const ids = value.sessions.map((session) => session.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["sessions"], message: "session ids must be unique within a week" });
  const orderKeys = value.sessions.map((session) => `${session.scheduledDate}:${session.order}`);
  if (new Set(orderKeys).size !== orderKeys.length) context.addIssue({ code: "custom", path: ["sessions"], message: "session order must be unique within a date" });
});
export const domainPhaseSchema = z.object({ id: z.string().min(1), phaseType: phaseTypeSchema, name: z.string().min(1).max(40), startWeek: z.number().int().min(1).max(52), endWeek: z.number().int().min(1).max(52), focus: z.string().min(1).max(300), progression: z.array(z.string().min(1).max(1000)).default([]) }).strict();
export const domainProgressionSchema = z.object({ domain: domainSchema, phases: z.array(domainPhaseSchema).min(1).max(52) }).strict();
export const mesocycleSchema = z.object({
  durationWeeks: z.number().int().min(1).max(52), schedule: scheduleSchema,
  domainProgressions: z.array(domainProgressionSchema).max(5).default([]),
  weeks: z.array(planWeekSchema).min(1).max(52),
  adjustmentRules: z.array(z.object({ trigger: z.string().min(1).max(1000), action: z.string().min(1).max(1000), rationale: z.string().min(1).max(2000) }).strict()).default([]),
}).strict().superRefine((value, context) => {
  const progressionDomains = value.domainProgressions.map((progression) => progression.domain);
  if (new Set(progressionDomains).size !== progressionDomains.length) context.addIssue({ code: "custom", path: ["domainProgressions"], message: "progression domains must be unique" });
  value.domainProgressions.forEach((progression, progressionIndex) => {
    const phases = [...progression.phases].sort((left, right) => left.startWeek - right.startWeek);
    const phaseIds = phases.map((phase) => phase.id);
    const phasesAreContiguous = new Set(phaseIds).size === phaseIds.length
      && phases[0]?.startWeek === 1
      && phases.at(-1)?.endWeek === value.durationWeeks
      && phases.every((phase, index) => phase.startWeek <= phase.endWeek
        && phase.endWeek <= value.durationWeeks
        && (index === 0 || phase.startWeek === phases[index - 1]!.endWeek + 1));
    if (!phasesAreContiguous) context.addIssue({ code: "custom", path: ["domainProgressions", progressionIndex, "phases"], message: "domain phases must uniquely and contiguously cover the mesocycle" });
  });
  const weekNumbers = value.weeks.map((week) => week.weekNumber);
  if (new Set(weekNumbers).size !== weekNumbers.length) context.addIssue({ code: "custom", path: ["weeks"], message: "week numbers must be unique" });
  if (value.weeks.length !== value.durationWeeks || [...weekNumbers].sort((a, b) => a - b).some((week, index) => week !== index + 1)) context.addIssue({ code: "custom", path: ["weeks"], message: "weeks must cover the complete mesocycle" });
  const sessionDomains = new Set(value.weeks.flatMap((week) => week.sessions.flatMap((session) => session.components.map((component) => component.domain.value).filter((domain): domain is z.infer<typeof domainSchema> => domain !== null))));
  if (sessionDomains.size !== progressionDomains.length || progressionDomains.some((domain) => !sessionDomains.has(domain))) context.addIssue({ code: "custom", path: ["domainProgressions"], message: "domain progressions must exactly match resolved session domains" });
});
export const resolvedMesocycleSchema = mesocycleSchema;
const storedTemplateMetadata = { origin: z.literal("user").default("user"), revision: z.number().int().positive() };
const builtinTemplateMetadata = { origin: z.literal("builtin"), catalogVersion: z.string().min(1) };
export const storedSessionTemplateSchema = z.discriminatedUnion("domain", sessionTemplateSchema.options.map((option) => option.extend(storedTemplateMetadata).strict()) as [z.ZodObject<any>, z.ZodObject<any>, ...z.ZodObject<any>[]]);
export const builtinSessionTemplateSchema = z.discriminatedUnion("domain", sessionTemplateSchema.options.map((option) => option.extend(builtinTemplateMetadata).strict()) as [z.ZodObject<any>, z.ZodObject<any>, ...z.ZodObject<any>[]]);
// Optional, additive Plan Target layer (see UNIFIED_MULTISPORT_MESOCYCLE_DESIGN §5). Absent on legacy plans; every field optional so a plan without `target` still parses.
export const planTargetSchema = z.object({
  primaryGoal: z.object({ label: z.string().min(1).max(200), baseline: z.string().max(200).nullable().optional(), testDate: z.string().max(40).nullable().optional() }).strict().optional(),
  supporting: z.array(z.object({ label: z.string().min(1).max(200), detail: z.string().max(400).optional() }).strict()).max(20).optional(),
  maintenance: z.array(z.object({ label: z.string().min(1).max(200), detail: z.string().max(400).optional() }).strict()).max(20).optional(),
  coordinationStrategy: z.string().max(2000).optional(),
}).strict();
export const currentPlanSchema = z.object({
  planSchemaVersion: z.literal(PLAN_SCHEMA_VERSION), ownerId: z.string().default(OWNER_ID), title: z.string().min(1).max(200), summary: z.string().max(4000).default(""), effectiveStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), mesocycle: mesocycleSchema,
  revision: z.number().int().positive(), sourceAgent: z.string().nullable().default(null), model: z.string().nullable().default(null), skillVersion: z.string().nullable().default(null), inputSnapshotHash: z.string().nullable().default(null), updatedAt: z.string().datetime({ offset: true }),
  target: planTargetSchema.optional(),
}).strict().superRefine((value, context) => {
  const start = new Date(`${value.effectiveStartDate}T12:00:00Z`).getTime();
  const ids = value.mesocycle.weeks.flatMap((week) => week.sessions.map((session) => session.id));
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["mesocycle", "weeks"], message: "session ids must be unique across the mesocycle" });
  for (const week of value.mesocycle.weeks) for (const session of week.sessions) {
    const elapsed = Math.round((new Date(`${session.scheduledDate}T12:00:00Z`).getTime() - start) / 86_400_000);
    if (elapsed < 0 || elapsed >= value.mesocycle.durationWeeks * 7 || Math.floor(elapsed / 7) + 1 !== week.weekNumber) context.addIssue({ code: "custom", path: ["mesocycle", "weeks", week.weekNumber - 1, "sessions"], message: "session date must fall inside its plan week" });
  }
});
export const currentPlanWriteSchema = currentPlanSchema.omit({ revision: true, updatedAt: true }).extend({ expectedRevision: z.number().int().min(0) }).strict();
export const sessionTemplateCreateSchema = z.discriminatedUnion("domain", sessionTemplateSchema.options.map((option) => option.extend({ clientRequestId: z.string().min(1).optional() }).strict()) as [z.ZodObject<any>, z.ZodObject<any>, ...z.ZodObject<any>[]]);
export const sessionTemplateUpdateSchema = z.object({ template: sessionTemplateSchema, expectedRevision: z.number().int().positive() }).strict();
// Read-only legacy contracts used solely by the v3-to-v4 database migration.
const legacySessionTemplateSchema = z.object({ id: z.string().min(1), name: z.string().min(1), intent: z.string().min(1), durationMinutes: z.number().int().positive(), recoveryDemand: recoveryDemandSchema, notes: z.string().default(""), components: z.array(trainingComponentSchema).min(1) }).strict();
const legacyWeeklyStructureSchema = z.array(z.object({ dayOfWeek: z.number().int().min(0).max(6), templateIds: z.array(z.string().min(1)).min(1).max(26) }).strict()).min(1).max(7);
const legacyResolvedMesocycleSchema = z.object({ durationWeeks: z.number().int().min(1).max(52), weeklyStructure: legacyWeeklyStructureSchema, sessionTemplates: z.array(legacySessionTemplateSchema).min(1).max(52), phases: z.array(domainPhaseSchema).min(1).max(52), adjustmentRules: mesocycleSchema.shape.adjustmentRules }).strict();
const legacyMigrationSchema = z.object({ reviewRequired: z.boolean(), sourceSchema: z.string(), sourceSessions: z.array(z.unknown()).default([]) }).strict().nullable().default(null);
const legacyPlanDraftShape = { planSchemaVersion: z.literal("3.0"), id: z.string().min(1), ownerId: z.string().default(OWNER_ID), clientRequestId: z.string().min(1), title: z.string().min(1).max(200), summary: z.string().max(4000).default(""), mesocycle: legacyResolvedMesocycleSchema.nullable().default(null), migration: legacyMigrationSchema, sourceAgent: z.string().nullable().default(null), model: z.string().nullable().default(null), skillVersion: z.string().nullable().default(null), inputSnapshotHash: z.string().min(1), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }) };
export const planDraftSchema = z.object(legacyPlanDraftShape).strict();
export const agentPlanDraftSchema = z.object({ ...legacyPlanDraftShape, mesocycle: resolvedMesocycleSchema, migration: z.null().default(null) }).strict();

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const exerciseOverrideSchema = z.object({ exerciseId: z.string().min(1), sets: z.number().int().min(1).max(20).optional(), repsMin: z.number().int().min(1).max(100).optional(), repsMax: z.number().int().min(1).max(100).optional(), targetRpe: z.number().min(1).max(10).nullable().optional(), restSeconds: z.number().int().min(0).max(600).optional(), referenceLoad: z.number().min(0).nullable().optional(), referenceLoadUnit: weightUnitSchema.nullable().optional() }).strict().refine((value) => value.repsMin === undefined || value.repsMax === undefined || value.repsMax >= value.repsMin, { message: "repsMax must be >= repsMin" });
export const plannedSessionInputSchema = weeklySessionSchema.omit({ scheduledDate: true, order: true }).extend({ notes: z.string().max(4000).default(""), overrideReason: z.string().min(1).max(1000).optional() }).strict();
export const nextTrainingDayWriteSchema = z.object({ clientRequestId: z.string().min(1), scheduledDate: dateSchema, expectedRevision: z.number().int().min(0), mode: z.enum(["append", "replace"]), sessions: z.array(plannedSessionInputSchema).min(1).max(15) }).strict();
export const phaseRefSchema = z.object({ domain: domainSchema, phaseId: z.string().min(1) }).strict();
export const plannedSessionSchema = z.object({ id: z.string().min(1), occurrenceId: z.string().min(1), ownerId: z.string().min(1), planRevision: z.number().int().positive(), scheduledDate: dateSchema, order: z.number().int().min(0).max(50).default(0), weekNumber: z.number().int().min(1).max(52), phaseRefs: z.array(phaseRefSchema).max(5), templateRef: templateRefSchema.nullable().default(null), name: z.string().min(1).max(100), intent: z.string().min(1).max(240), recoveryDemand: recoveryDemandSchema, durationMinutes: z.number().int().min(1).max(240), keySession: z.boolean().default(false), components: z.array(trainingComponentSchema).min(1), progressionNote: z.string().max(2000).nullable().default(null), schedulingRationale: z.string().max(2000).nullable().default(null), exerciseOverrides: z.array(exerciseOverrideSchema).default([]), legacySnapshot: z.boolean().default(false), notes: z.string().max(4000).default(""), overrideReason: z.string().max(1000).nullable().default(null), status: z.enum(["planned", "completed", "skipped"]).default("planned"), completedTrainingSessionId: z.string().nullable().default(null), completedAt: z.string().datetime({ offset: true }).nullable().default(null), completionSource: z.enum(["manual", "import"]).nullable().default(null), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }) }).strict().superRefine((value, context) => {
  const componentDomains = [...new Set(value.components.map((component) => component.domain.value).filter((domain): domain is z.infer<typeof domainSchema> => domain !== null))];
  const refDomains = value.phaseRefs.map((ref) => ref.domain);
  if (new Set(refDomains).size !== refDomains.length || componentDomains.length !== refDomains.length || refDomains.some((domain) => !componentDomains.includes(domain))) context.addIssue({ code: "custom", path: ["phaseRefs"], message: "phase references must exactly match resolved component domains" });
});
export const plannedSessionActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("complete"), expectedRevision: z.number().int().min(0) }).strict(),
  z.object({ action: z.literal("skip"), expectedRevision: z.number().int().min(0) }).strict(),
  z.object({ action: z.literal("move_occurrence"), expectedRevision: z.number().int().min(0), scheduledDate: dateSchema }).strict(),
]);

export const ruleResultSchema = z.object({ status: z.enum(["pass", "fail", "unknown", "not_applicable"]), enforcement: z.enum(["blocker", "advisory", "info"]), reasonCode: z.string(), rulePackId: z.string(), ruleVersion: z.string(), subjectRefs: z.array(z.string()), evidence: z.record(z.string(), z.unknown()), missingFacts: z.array(z.string()), confidenceLimit: z.object({ required: z.number().min(0).max(1).nullable(), observed: z.number().min(0).max(1).nullable() }).nullable() });
export const dataGapSchema = z.object({ code: z.string(), subjectRef: z.string(), factPath: z.string(), requiredByRuleCodes: z.array(z.string()), blocking: z.boolean(), resolution: z.enum(["agent_infer", "user_confirm", "add_profile_data"]) }).strict();
export const validationCoverageSchema = z.object({ hardChecksResolved: z.number().int().min(0), hardChecksTotal: z.number().int().min(0), movementFactsResolved: z.number().int().min(0), movementFactsTotal: z.number().int().min(0), muscleFactsResolved: z.number().int().min(0), muscleFactsTotal: z.number().int().min(0), equipmentFactsResolved: z.number().int().min(0), equipmentFactsTotal: z.number().int().min(0) }).strict();
export const planValidationSchema = z.object({ valid: z.boolean(), results: z.array(ruleResultSchema), dataGaps: z.array(dataGapSchema), validatedAt: z.string().datetime({ offset: true }), inputHash: z.string(), coverage: validationCoverageSchema });
export const planVersionSchema = z.object({ id: z.string(), parentVersionId: z.string().nullable(), versionNumber: z.number().int().positive(), plan: planDraftSchema, validation: planValidationSchema, approvedAt: z.string().datetime({ offset: true }), approvedBy: z.string(), changeReason: z.string() });
export type AthleteProfile = z.infer<typeof athleteProfileSchema>;
export type TrainingSession = z.infer<typeof trainingSessionSchema>;
export type TrainingSessionWrite = z.infer<typeof trainingSessionWriteSchema>;
export type WellnessRecord = z.infer<typeof wellnessRecordSchema>;
export type WellnessPatch = z.infer<typeof wellnessPatchSchema>;
export type PersonalInformationWrite = z.infer<typeof personalInformationWriteSchema>;
export type Mesocycle = z.infer<typeof mesocycleSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type PlanWeek = z.infer<typeof planWeekSchema>;
export type WeeklySession = z.infer<typeof weeklySessionSchema>;
export type DomainProgression = z.infer<typeof domainProgressionSchema>;
export type PhaseRef = z.infer<typeof phaseRefSchema>;
export type ResolvedMesocycle = z.infer<typeof resolvedMesocycleSchema>;
export type SessionTemplate = z.infer<typeof sessionTemplateSchema>;
export type StoredSessionTemplate = SessionTemplate & { origin: "user"; revision: number };
export type BuiltinSessionTemplate = SessionTemplate & { origin: "builtin"; catalogVersion: string };
export type TemplateRef = z.infer<typeof templateRefSchema>;
export type PlanTarget = z.infer<typeof planTargetSchema>;
export type CurrentPlan = z.infer<typeof currentPlanSchema>;
export type CurrentPlanWrite = z.infer<typeof currentPlanWriteSchema>;
export type PlanDraft = z.infer<typeof planDraftSchema>;
export type PlannedSession = z.infer<typeof plannedSessionSchema>;
export type NextTrainingDayWrite = z.infer<typeof nextTrainingDayWriteSchema>;
export type PlannedSessionAction = z.infer<typeof plannedSessionActionSchema>;
export type PlanValidation = z.infer<typeof planValidationSchema>;
export type PlanVersion = z.infer<typeof planVersionSchema>;
export type RuleResult = z.infer<typeof ruleResultSchema>;
export type DataQuality = z.infer<typeof dataQualitySchema>;
export function defaultProfile(): AthleteProfile { return athleteProfileSchema.parse({}); }
export const jsonSchemas = { athleteProfile: z.toJSONSchema(athleteProfileSchema), personalInformation: z.toJSONSchema(personalInformationWriteSchema), trainingSession: z.toJSONSchema(trainingSessionSchema), wellness: z.toJSONSchema(wellnessRecordSchema), sessionTemplate: z.toJSONSchema(sessionTemplateSchema), currentPlan: z.toJSONSchema(currentPlanSchema), planValidation: z.toJSONSchema(planValidationSchema) };
