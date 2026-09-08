import * as z from "zod";

export const OWNER_ID = "local-user";
export const FORMULA_VERSION = "0.2.0";
export const RULE_VERSION = "0.2.0";
export const PLAN_SCHEMA_VERSION = "4.0";
export const TAXONOMY_VERSION = "strength-1.0";
export const AI_HARD_CONFIDENCE = 0.9;

// Kept only as source metadata for imported records. Plans use components.
export const modalitySchema = z.enum(["strength", "endurance", "recovery", "mixed", "unknown"]);
export const domainSchema = z.enum(["strength", "endurance", "sport_skill", "mind_body", "recovery"]);
export const phaseTypeSchema = z.enum(["foundation", "progression", "deload", "peak", "test", "recovery"]);
export const recoveryDemandSchema = z.enum(["low", "normal", "high"]);
export const weightUnitSchema = z.enum(["kg", "lb"]);
export const factSourceSchema = z.enum(["catalog", "structured_source", "exact_alias", "ai_inferred", "user_confirmed", "migration"]);
export const movementPatternSchema = z.enum(["squat", "hinge", "lunge", "horizontal_push", "vertical_push", "horizontal_pull", "vertical_pull", "carry", "rotation", "anti_rotation", "flexion", "extension", "abduction", "adduction", "calf_raise", "isolation", "other"]);
export const muscleGroupSchema = z.enum(["chest", "upper_back", "back", "lats", "shoulders", "biceps", "triceps", "forearms", "quadriceps", "hamstrings", "glutes", "calves", "core", "spinal_erectors", "hip_flexors", "adductors", "abductors", "full_body", "other"]);
export const equipmentTypeSchema = z.enum(["bodyweight", "barbell", "dumbbell", "kettlebell", "cable", "machine", "band", "smith_machine", "trap_bar", "ez_bar", "bench", "pull_up_bar", "rings", "suspension", "medicine_ball", "landmine", "sled", "other"]);

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

export const strengthConstraintSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("exclude_exercise"), canonicalKey: z.string().min(1) }).strict(),
  z.object({ id: z.string().min(1), type: z.literal("prohibit_movement_pattern"), movementPattern: movementPatternSchema }).strict(),
]);
export const athleteProfileSchema = z.object({
  ownerId: z.string().default(OWNER_ID), displayName: z.string().min(1).max(100).default("Athlete"), timezone: z.string().min(1).default("Asia/Hong_Kong"), goals: z.array(z.string()).default(["general_fitness"]),
  priority: z.enum(["strength", "endurance", "balanced"]).default("balanced"), weeklyStrengthSessions: z.number().int().min(0).max(7).default(2), weeklyEnduranceSessions: z.number().int().min(0).max(7).default(2),
  maxSessionMinutes: z.number().int().min(15).max(240).default(60), trainingDays: z.array(z.number().int().min(0).max(6)).max(7).refine((days) => new Set(days).size === days.length, { message: "training days must be unique" }).meta({ uniqueItems: true }).default([]),
  equipment: z.array(equipmentTypeSchema).default(["bodyweight", "dumbbell", "cable", "machine"]), strengthConstraints: z.array(strengthConstraintSchema).default([]), constraintNotes: z.array(z.string()).default([]), explicitRecoveryHours: z.number().int().min(0).max(168).nullable().default(null),
}).strict();
export const trainingPreferenceSchema = z.object({ ownerId: z.string().default(OWNER_ID), preferredExercises: z.array(z.string()).default([]), dislikedExercises: z.array(z.string()).default([]), preferredSessionMinutes: z.number().int().min(15).max(240).default(60), notes: z.string().max(2000).default("") }).strict();

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
  startAt: z.string().datetime({ offset: true }), endAt: z.string().datetime({ offset: true }), durationMinutes: z.number().int().min(0), status: z.enum(["completed", "planned"]).default("completed"), timezone: z.string().nullable().default(null),
  strengthSets: z.array(strengthSetSchema).default([]), endurance: enduranceDetailsSchema.nullable().default(null), missingFields: z.array(z.string()).default([]),
}).strict();

export const exerciseDefinitionSchema = z.object({ key: z.string().min(1), name: z.string().min(1), movement: z.string().min(1), primaryMuscles: z.array(z.string()), secondaryMuscles: z.array(z.string()).default([]), equipment: z.array(z.string()), unilateral: z.boolean().default(false), tags: z.array(z.string()).default([]) }).strict();
export const planExerciseSchema = z.object({
  id: z.string().min(1), displayName: z.string().min(1), canonicalKey: z.string().min(1).nullable().default(null),
  classification: z.object({ primaryMovement: movementFactSchema, primaryMuscles: muscleFactSchema, secondaryMuscles: muscleFactSchema, equipment: equipmentFactSchema, impact: impactFactSchema, laterality: lateralityFactSchema }).strict(),
  sets: z.number().int().min(1).max(20), repsMin: z.number().int().min(1).max(100), repsMax: z.number().int().min(1).max(100), targetRpe: z.number().min(1).max(10).nullable().default(null), restSeconds: z.number().int().min(0).max(600).default(90), referenceLoad: z.number().min(0).nullable().default(null), referenceLoadUnit: weightUnitSchema.nullable().default(null), notes: z.string().max(1000).default(""),
}).strict().refine((value) => value.repsMax >= value.repsMin, { message: "repsMax must be >= repsMin" });
export const strengthPrescriptionSchema = z.object({ kind: z.literal("strength"), exercises: z.array(planExerciseSchema).min(1).max(30) }).strict();
export const durationOnlyPrescriptionSchema = z.object({ kind: z.literal("duration_only"), notes: z.string().max(4000).default("") }).strict();
export const trainingComponentSchema = z.object({ id: z.string().min(1), name: z.string().min(1).max(100), domain: domainFactSchema, prescription: z.discriminatedUnion("kind", [strengthPrescriptionSchema, durationOnlyPrescriptionSchema]) }).strict().superRefine((value, context) => {
  if (value.prescription.kind === "strength" && value.domain.value !== "strength") context.addIssue({ code: "custom", path: ["domain", "value"], message: "strength prescription requires strength domain" });
  if (value.prescription.kind === "duration_only" && value.domain.value === "strength") context.addIssue({ code: "custom", path: ["prescription", "kind"], message: "strength domain requires strength prescription" });
});
export const sessionTemplateSchema = z.object({ id: z.string().min(1), name: z.string().min(1).max(100), intent: z.string().min(1).max(240), durationMinutes: z.number().int().min(1).max(240), recoveryDemand: recoveryDemandSchema, notes: z.string().max(4000).default(""), components: z.array(trainingComponentSchema).min(1).max(20) }).strict();
export const mesocycleSchema = z.object({
  durationWeeks: z.number().int().min(1).max(52), weeklyStructure: z.array(z.object({ dayOfWeek: z.number().int().min(0).max(6), templateIds: z.array(z.string().min(1)).min(1).max(26) }).strict()).min(1).max(7),
  phases: z.array(z.object({ id: z.string().min(1), phaseType: phaseTypeSchema, name: z.string().min(1).max(40), startWeek: z.number().int().min(1).max(52), endWeek: z.number().int().min(1).max(52), focus: z.string().min(1).max(300), progression: z.array(z.string().min(1).max(1000)).default([]) }).strict()).min(1).max(52),
  adjustmentRules: z.array(z.object({ trigger: z.string().min(1).max(1000), action: z.string().min(1).max(1000), rationale: z.string().min(1).max(2000) }).strict()).default([]),
}).strict();
export const resolvedMesocycleSchema = mesocycleSchema.extend({ sessionTemplates: z.array(sessionTemplateSchema).min(1).max(52) }).strict();
export const storedSessionTemplateSchema = sessionTemplateSchema.extend({ ownerId: z.string().default(OWNER_ID), revision: z.number().int().positive(), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }) }).strict();
export const currentPlanSchema = z.object({
  planSchemaVersion: z.literal(PLAN_SCHEMA_VERSION), ownerId: z.string().default(OWNER_ID), title: z.string().min(1).max(200), summary: z.string().max(4000).default(""), effectiveStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), mesocycle: mesocycleSchema,
  revision: z.number().int().positive(), sourceAgent: z.string().nullable().default(null), model: z.string().nullable().default(null), skillVersion: z.string().nullable().default(null), inputSnapshotHash: z.string().nullable().default(null), updatedAt: z.string().datetime({ offset: true }),
}).strict();
export const currentPlanWriteSchema = currentPlanSchema.omit({ revision: true, updatedAt: true }).extend({ expectedRevision: z.number().int().min(0), futureSessionPolicy: z.enum(["keep", "update"]).optional() }).strict();
export const sessionTemplateCreateSchema = sessionTemplateSchema.extend({ clientRequestId: z.string().min(1).optional() }).strict();
export const sessionTemplateUpdateSchema = z.object({ template: sessionTemplateSchema, expectedRevision: z.number().int().positive(), futureSessionPolicy: z.enum(["keep", "update"]).optional() }).strict();
// Read-only legacy contracts used solely by the v3-to-v4 database migration.
const legacyMigrationSchema = z.object({ reviewRequired: z.boolean(), sourceSchema: z.string(), sourceSessions: z.array(z.unknown()).default([]) }).strict().nullable().default(null);
const legacyPlanDraftShape = { planSchemaVersion: z.literal("3.0"), id: z.string().min(1), ownerId: z.string().default(OWNER_ID), clientRequestId: z.string().min(1), title: z.string().min(1).max(200), summary: z.string().max(4000).default(""), mesocycle: resolvedMesocycleSchema.nullable().default(null), migration: legacyMigrationSchema, sourceAgent: z.string().nullable().default(null), model: z.string().nullable().default(null), skillVersion: z.string().nullable().default(null), inputSnapshotHash: z.string().min(1), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }) };
export const planDraftSchema = z.object(legacyPlanDraftShape).strict();
export const agentPlanDraftSchema = z.object({ ...legacyPlanDraftShape, mesocycle: resolvedMesocycleSchema, migration: z.null().default(null) }).strict();

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const exerciseOverrideSchema = z.object({ exerciseId: z.string().min(1), sets: z.number().int().min(1).max(20).optional(), repsMin: z.number().int().min(1).max(100).optional(), repsMax: z.number().int().min(1).max(100).optional(), targetRpe: z.number().min(1).max(10).nullable().optional(), restSeconds: z.number().int().min(0).max(600).optional(), referenceLoad: z.number().min(0).nullable().optional(), referenceLoadUnit: weightUnitSchema.nullable().optional() }).strict().refine((value) => value.repsMin === undefined || value.repsMax === undefined || value.repsMax >= value.repsMin, { message: "repsMax must be >= repsMin" });
export const plannedSessionInputSchema = z.object({ id: z.string().min(1), templateId: z.string().min(1), notes: z.string().max(4000).default(""), overrideReason: z.string().min(1).max(1000).optional(), exerciseOverrides: z.array(exerciseOverrideSchema).max(30).default([]) }).strict();
export const nextTrainingDayWriteSchema = z.object({ clientRequestId: z.string().min(1), scheduledDate: dateSchema, expectedRevision: z.number().int().min(0), mode: z.enum(["append", "replace"]), sessions: z.array(plannedSessionInputSchema).min(1).max(15) }).strict();
export const plannedSessionSchema = z.object({ id: z.string().min(1), ownerId: z.string().min(1), planRevision: z.number().int().positive(), scheduledDate: dateSchema, weekNumber: z.number().int().min(1).max(52), phaseId: z.string().min(1), templateId: z.string().min(1), name: z.string().min(1).max(100), intent: z.string().min(1).max(240), recoveryDemand: recoveryDemandSchema, durationMinutes: z.number().int().min(1).max(240), components: z.array(trainingComponentSchema).min(1), exerciseOverrides: z.array(exerciseOverrideSchema).default([]), legacySnapshot: z.boolean().default(false), notes: z.string().max(4000).default(""), overrideReason: z.string().max(1000).nullable().default(null), status: z.enum(["planned", "completed", "skipped"]).default("planned"), completedTrainingSessionId: z.string().nullable().default(null), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }) }).strict();

export const ruleResultSchema = z.object({ status: z.enum(["pass", "fail", "unknown", "not_applicable"]), enforcement: z.enum(["blocker", "advisory", "info"]), reasonCode: z.string(), rulePackId: z.string(), ruleVersion: z.string(), subjectRefs: z.array(z.string()), evidence: z.record(z.string(), z.unknown()), missingFacts: z.array(z.string()), confidenceLimit: z.object({ required: z.number().min(0).max(1).nullable(), observed: z.number().min(0).max(1).nullable() }).nullable() });
export const dataGapSchema = z.object({ code: z.string(), subjectRef: z.string(), factPath: z.string(), requiredByRuleCodes: z.array(z.string()), blocking: z.boolean(), resolution: z.enum(["agent_infer", "user_confirm", "add_profile_data"]) }).strict();
export const validationCoverageSchema = z.object({ hardChecksResolved: z.number().int().min(0), hardChecksTotal: z.number().int().min(0), movementFactsResolved: z.number().int().min(0), movementFactsTotal: z.number().int().min(0), muscleFactsResolved: z.number().int().min(0), muscleFactsTotal: z.number().int().min(0), equipmentFactsResolved: z.number().int().min(0), equipmentFactsTotal: z.number().int().min(0) }).strict();
export const planValidationSchema = z.object({ valid: z.boolean(), results: z.array(ruleResultSchema), dataGaps: z.array(dataGapSchema), validatedAt: z.string().datetime({ offset: true }), inputHash: z.string(), coverage: validationCoverageSchema });
export const planVersionSchema = z.object({ id: z.string(), parentVersionId: z.string().nullable(), versionNumber: z.number().int().positive(), plan: planDraftSchema, validation: planValidationSchema, approvedAt: z.string().datetime({ offset: true }), approvedBy: z.string(), changeReason: z.string() });
export type AthleteProfile = z.infer<typeof athleteProfileSchema>;
export type TrainingPreference = z.infer<typeof trainingPreferenceSchema>;
export type TrainingSession = z.infer<typeof trainingSessionSchema>;
export type ExerciseDefinition = z.infer<typeof exerciseDefinitionSchema>;
export type Mesocycle = z.infer<typeof mesocycleSchema>;
export type ResolvedMesocycle = z.infer<typeof resolvedMesocycleSchema>;
export type SessionTemplate = z.infer<typeof sessionTemplateSchema>;
export type StoredSessionTemplate = z.infer<typeof storedSessionTemplateSchema>;
export type CurrentPlan = z.infer<typeof currentPlanSchema>;
export type CurrentPlanWrite = z.infer<typeof currentPlanWriteSchema>;
export type PlanDraft = z.infer<typeof planDraftSchema>;
export type PlannedSession = z.infer<typeof plannedSessionSchema>;
export type NextTrainingDayWrite = z.infer<typeof nextTrainingDayWriteSchema>;
export type PlanValidation = z.infer<typeof planValidationSchema>;
export type PlanVersion = z.infer<typeof planVersionSchema>;
export type RuleResult = z.infer<typeof ruleResultSchema>;
export type DataQuality = z.infer<typeof dataQualitySchema>;
export function defaultProfile(): AthleteProfile { return athleteProfileSchema.parse({}); }
export function defaultPreference(): TrainingPreference { return trainingPreferenceSchema.parse({}); }
export const jsonSchemas = { athleteProfile: z.toJSONSchema(athleteProfileSchema), trainingPreference: z.toJSONSchema(trainingPreferenceSchema), trainingSession: z.toJSONSchema(trainingSessionSchema), sessionTemplate: z.toJSONSchema(sessionTemplateSchema), currentPlan: z.toJSONSchema(currentPlanSchema), planValidation: z.toJSONSchema(planValidationSchema) };
