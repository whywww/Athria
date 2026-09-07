import * as z from "zod";

export const OWNER_ID = "local-user";
export const FORMULA_VERSION = "0.1.0";
export const RULE_VERSION = "0.1.0";

export const modalitySchema = z.enum(["strength", "endurance", "recovery", "mixed", "unknown"]);
export const planModalitySchema = z.enum(["strength", "endurance", "recovery", "mixed"]);
export const phaseTypeSchema = z.enum(["foundation", "progression", "deload", "peak", "test", "recovery"]);
export const recoveryDemandSchema = z.enum(["low", "normal", "high"]);
export const severitySchema = z.enum(["hard", "soft", "info"]);
export const weightUnitSchema = z.enum(["kg", "lb"]);

export const athleteProfileSchema = z.object({
  ownerId: z.string().default(OWNER_ID),
  displayName: z.string().min(1).max(100).default("Athlete"),
  timezone: z.string().min(1).default("Asia/Hong_Kong"),
  goals: z.array(z.string()).default(["general_fitness"]),
  priority: z.enum(["strength", "endurance", "balanced"]).default("balanced"),
  weeklyStrengthSessions: z.number().int().min(0).max(7).default(2),
  weeklyEnduranceSessions: z.number().int().min(0).max(7).default(2),
  maxSessionMinutes: z.number().int().min(15).max(240).default(60),
  trainingDays: z.array(z.number().int().min(0).max(6)).max(7).refine((days) => new Set(days).size === days.length, { message: "training days must be unique" }).meta({ uniqueItems: true }).default([]),
  equipment: z.array(z.string()).default(["bodyweight", "dumbbell", "cable", "machine"]),
  excludedExercises: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  explicitRecoveryHours: z.number().int().min(0).max(168).nullable().default(null),
}).strict();

export const trainingPreferenceSchema = z.object({
  ownerId: z.string().default(OWNER_ID),
  preferredExercises: z.array(z.string()).default([]),
  dislikedExercises: z.array(z.string()).default([]),
  preferredSessionMinutes: z.number().int().min(15).max(240).default(60),
  notes: z.string().max(2000).default(""),
}).strict();

export const dataQualitySchema = z.object({
  completeness: z.number().min(0).max(1),
  sources: z.array(z.string()),
  missingFields: z.array(z.string()),
  anomalies: z.array(z.string()),
});

export const metricResultSchema = <T extends z.ZodTypeAny>(value: T) => z.object({
  value,
  unit: z.string(),
  method: z.string(),
  formulaVersion: z.string(),
  timeRange: z.object({ start: z.string().nullable(), end: z.string().nullable() }),
  dataQuality: dataQualitySchema,
  limitations: z.array(z.string()),
});

export const strengthSetSchema = z.object({
  exerciseRaw: z.string().min(1),
  exerciseKey: z.string().nullable().default(null),
  movement: z.string().nullable().default(null),
  primaryMuscles: z.array(z.string()).default([]),
  secondaryMuscles: z.array(z.string()).default([]),
  setIndex: z.number().int().min(0),
  setType: z.string().default("normal"),
  weight: z.number().min(0).nullable().default(null),
  weightUnit: weightUnitSchema.nullable().default(null),
  reps: z.number().int().min(0).nullable().default(null),
  rpe: z.number().min(0).max(10).nullable().default(null),
  leftWeight: z.number().min(0).nullable().optional(),
  rightWeight: z.number().min(0).nullable().optional(),
  durationSeconds: z.number().min(0).nullable().optional(),
  restSeconds: z.number().min(0).nullable().optional(),
  plannedRestSeconds: z.number().min(0).nullable().optional(),
}).strict();

export const enduranceDetailsSchema = z.object({
  distanceMeters: z.number().min(0).nullable().default(null),
  averageHeartRate: z.number().min(0).nullable().default(null),
  maxHeartRate: z.number().min(0).nullable().default(null),
  averagePowerWatts: z.number().min(0).nullable().default(null),
  maxPowerWatts: z.number().min(0).nullable().default(null),
  heartRateZoneSeconds: z.record(z.string(), z.number().min(0)).default({}),
}).strict();

export const trainingSessionSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().default(OWNER_ID),
  source: z.string().min(1),
  externalId: z.string().min(1),
  modality: modalitySchema,
  sport: z.string().nullable().default(null),
  name: z.string().min(1),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(0),
  status: z.enum(["completed", "planned"]).default("completed"),
  timezone: z.string().nullable().default(null),
  strengthSets: z.array(strengthSetSchema).default([]),
  endurance: enduranceDetailsSchema.nullable().default(null),
  missingFields: z.array(z.string()).default([]),
}).strict();

export const exerciseDefinitionSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  movement: z.string().min(1),
  primaryMuscles: z.array(z.string()),
  secondaryMuscles: z.array(z.string()).default([]),
  equipment: z.array(z.string()),
  unilateral: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
}).strict();

export const planExerciseSchema = z.object({
  exerciseKey: z.string().min(1),
  name: z.string().min(1),
  sets: z.number().int().min(1).max(12),
  repsMin: z.number().int().min(1).max(100),
  repsMax: z.number().int().min(1).max(100),
  targetRpe: z.number().min(1).max(10).nullable().default(null),
  restSeconds: z.number().int().min(0).max(600).default(90),
  referenceLoad: z.number().min(0).nullable().default(null),
  referenceLoadUnit: weightUnitSchema.nullable().default(null),
  notes: z.string().max(1000).default(""),
}).refine((value) => value.repsMax >= value.repsMin, { message: "repsMax must be >= repsMin" });

export const sessionTemplateSchema = z.object({
  id: z.string().min(1),
  label: z.string().regex(/^[A-Z]$/),
  name: z.string().min(1).max(60),
  modality: planModalitySchema,
  intent: z.string().min(1).max(240),
  durationMinutes: z.number().int().min(1).max(240),
  recoveryDemand: recoveryDemandSchema,
  notes: z.string().max(4000).default(""),
  exercises: z.array(planExerciseSchema).default([]),
}).strict();

export const mesocycleSchema = z.object({
  durationWeeks: z.number().int().min(1).max(52),
  weeklyStructure: z.array(z.object({
    dayOfWeek: z.number().int().min(0).max(6),
    templateIds: z.array(z.string().min(1)).max(26),
  }).strict()).min(1).max(7),
  sessionTemplates: z.array(sessionTemplateSchema).min(1).max(26),
  phases: z.array(z.object({
    id: z.string().min(1),
    phaseType: phaseTypeSchema,
    name: z.string().min(1).max(40),
    startWeek: z.number().int().min(1).max(52),
    endWeek: z.number().int().min(1).max(52),
    focus: z.string().min(1).max(300),
    progression: z.array(z.string().min(1).max(1000)).default([]),
  }).strict()).min(1).max(52),
  adjustmentRules: z.array(z.object({
    trigger: z.string().min(1).max(1000),
    action: z.string().min(1).max(1000),
    rationale: z.string().min(1).max(2000),
  }).strict()).default([]),
}).strict().superRefine((value, context) => {
  value.sessionTemplates.forEach((template, index) => {
    const expected = String.fromCharCode(65 + index);
    if (template.label !== expected) context.addIssue({ code: "custom", path: ["sessionTemplates", index, "label"], message: `template label must be ${expected}` });
  });
});

const planDraftShape = {
  id: z.string().min(1),
  ownerId: z.string().default(OWNER_ID),
  clientRequestId: z.string().min(1),
  title: z.string().min(1).max(200),
  summary: z.string().max(4000).default(""),
  mesocycle: mesocycleSchema.nullable().default(null),
  sourceAgent: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  skillVersion: z.string().nullable().default(null),
  inputSnapshotHash: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
};

export const planDraftSchema = z.object(planDraftShape).strict();
export const agentPlanDraftSchema = z.object({ ...planDraftShape, mesocycle: mesocycleSchema }).strict();

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const exerciseOverrideSchema = z.object({
  exerciseKey: z.string().min(1),
  sets: z.number().int().min(1).max(12).optional(),
  repsMin: z.number().int().min(1).max(100).optional(),
  repsMax: z.number().int().min(1).max(100).optional(),
  targetRpe: z.number().min(1).max(10).nullable().optional(),
  restSeconds: z.number().int().min(0).max(600).optional(),
  referenceLoad: z.number().min(0).nullable().optional(),
  referenceLoadUnit: weightUnitSchema.nullable().optional(),
}).strict().refine((value) => value.repsMin === undefined || value.repsMax === undefined || value.repsMax >= value.repsMin, { message: "repsMax must be >= repsMin" });

export const plannedSessionInputSchema = z.object({
  id: z.string().min(1),
  templateId: z.string().min(1),
  notes: z.string().max(4000).default(""),
  overrideReason: z.string().min(1).max(1000).optional(),
  exerciseOverrides: z.array(exerciseOverrideSchema).max(15).default([]),
}).strict();

export const nextTrainingDayWriteSchema = z.object({
  clientRequestId: z.string().min(1),
  planVersionId: z.string().min(1),
  scheduledDate: dateSchema,
  expectedRevision: z.number().int().min(0),
  mode: z.enum(["append", "replace"]),
  sessions: z.array(plannedSessionInputSchema).min(1).max(15),
}).strict();

export const plannedSessionSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  planVersionId: z.string().min(1),
  scheduledDate: dateSchema,
  weekNumber: z.number().int().min(1).max(52),
  phaseId: z.string().min(1),
  templateId: z.string().min(1),
  name: z.string().min(1).max(60),
  modality: planModalitySchema,
  intent: z.string().min(1).max(240),
  recoveryDemand: recoveryDemandSchema,
  durationMinutes: z.number().int().min(1).max(240),
  exercises: z.array(planExerciseSchema),
  notes: z.string().max(4000).default(""),
  overrideReason: z.string().max(1000).nullable().default(null),
  status: z.enum(["planned", "completed", "skipped"]).default("planned"),
  completedTrainingSessionId: z.string().nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const ruleResultSchema = z.object({
  severity: severitySchema,
  reasonCode: z.string(),
  ruleVersion: z.string(),
  passed: z.boolean(),
  messageArgs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  evidence: z.record(z.string(), z.unknown()),
  sessionIds: z.array(z.string()),
});

export const planValidationSchema = z.object({
  valid: z.boolean(),
  results: z.array(ruleResultSchema),
  dataGaps: z.array(z.string()),
  validatedAt: z.string().datetime({ offset: true }),
  inputHash: z.string(),
});

export const planVersionSchema = z.object({
  id: z.string(),
  parentVersionId: z.string().nullable(),
  versionNumber: z.number().int().positive(),
  plan: planDraftSchema,
  validation: planValidationSchema,
  approvedAt: z.string().datetime({ offset: true }),
  approvedBy: z.string(),
  changeReason: z.string(),
});

export type AthleteProfile = z.infer<typeof athleteProfileSchema>;
export type TrainingPreference = z.infer<typeof trainingPreferenceSchema>;
export type TrainingSession = z.infer<typeof trainingSessionSchema>;
export type ExerciseDefinition = z.infer<typeof exerciseDefinitionSchema>;
export type Mesocycle = z.infer<typeof mesocycleSchema>;
export type PlanDraft = z.infer<typeof planDraftSchema>;
export type PlannedSession = z.infer<typeof plannedSessionSchema>;
export type NextTrainingDayWrite = z.infer<typeof nextTrainingDayWriteSchema>;
export type PlanValidation = z.infer<typeof planValidationSchema>;
export type PlanVersion = z.infer<typeof planVersionSchema>;
export type RuleResult = z.infer<typeof ruleResultSchema>;
export type DataQuality = z.infer<typeof dataQualitySchema>;

export function defaultProfile(): AthleteProfile {
  return athleteProfileSchema.parse({});
}

export function defaultPreference(): TrainingPreference {
  return trainingPreferenceSchema.parse({});
}

export const jsonSchemas = {
  athleteProfile: z.toJSONSchema(athleteProfileSchema),
  trainingPreference: z.toJSONSchema(trainingPreferenceSchema),
  trainingSession: z.toJSONSchema(trainingSessionSchema),
  planDraft: z.toJSONSchema(planDraftSchema),
  planValidation: z.toJSONSchema(planValidationSchema),
  planVersion: z.toJSONSchema(planVersionSchema),
};
