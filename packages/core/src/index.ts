import {
  FORMULA_VERSION,
  RULE_VERSION,
  type AthleteProfile,
  type DataQuality,
  type ExerciseDefinition,
  type PlanDraft,
  type PlanValidation,
  type RuleResult,
  type TrainingSession,
} from "@athria/schemas";

export interface MetricResult<T> {
  value: T;
  unit: string;
  method: string;
  formulaVersion: string;
  timeRange: { start: string | null; end: string | null };
  dataQuality: DataQuality;
  limitations: string[];
}

export interface TrainingMetrics {
  strength: {
    workingSets: MetricResult<number>;
    rawVolume: MetricResult<number>;
    directSetsByMuscle: MetricResult<Record<string, number>>;
    indirectSetsByMuscle: MetricResult<Record<string, number>>;
  };
  endurance: {
    durationMinutes: MetricResult<number>;
    distanceMeters: MetricResult<number>;
    paceSecondsPerKm: MetricResult<number | null>;
    timeInZoneSeconds: MetricResult<Record<string, number>>;
  };
}

const emptyQuality = (sources: string[], missingFields: string[] = []): DataQuality => ({
  completeness: missingFields.length === 0 ? 1 : 0,
  sources,
  missingFields,
  anomalies: [],
});

const rangeOf = (sessions: TrainingSession[]) => ({
  start: sessions.length ? sessions.map((item) => item.startAt).sort()[0] ?? null : null,
  end: sessions.length ? sessions.map((item) => item.endAt).sort().at(-1) ?? null : null,
});

function metric<T>(
  value: T,
  unit: string,
  method: string,
  sessions: TrainingSession[],
  dataQuality: DataQuality,
  limitations: string[] = [],
): MetricResult<T> {
  return { value, unit, method, formulaVersion: FORMULA_VERSION, timeRange: rangeOf(sessions), dataQuality, limitations };
}

export function estimateOneRepMax(load: number, reps: number, unit: "kg" | "lb"): MetricResult<number> {
  if (!Number.isFinite(load) || load <= 0) throw new Error("load must be greater than zero");
  if (!Number.isInteger(reps) || reps < 1 || reps > 12) throw new Error("reps must be an integer from 1 to 12");
  const value = reps === 1 ? load : load * (1 + reps / 30);
  return metric(Number(value.toFixed(2)), unit, "epley", [], emptyQuality(["explicit_input"]), [
    "Estimated 1RM is not a measured maximal lift.",
    "The formula is restricted to sets of 1-12 repetitions.",
  ]);
}

export function calculateHeartRateZones(maxHeartRate: number): MetricResult<Record<string, { min: number; max: number }>> {
  if (!Number.isInteger(maxHeartRate) || maxHeartRate < 80 || maxHeartRate > 240) {
    throw new Error("maxHeartRate must be an explicitly measured integer from 80 to 240");
  }
  const bounds = [0.5, 0.6, 0.7, 0.8, 0.9, 1].map((ratio) => Math.round(maxHeartRate * ratio));
  return metric(
    Object.fromEntries(bounds.slice(0, -1).map((min, index) => [`zone${index + 1}`, { min, max: bounds[index + 1]! - (index < 4 ? 1 : 0) }])),
    "bpm",
    "five_zone_percent_max_hr",
    [],
    emptyQuality(["explicit_max_hr"]),
    ["Zones are descriptive training ranges, not medical thresholds.", "Age-predicted maximum heart rate is not used."],
  );
}

export function calculateTrainingMetrics(sessions: TrainingSession[]): TrainingMetrics {
  const strength = sessions.filter((item) => item.modality === "strength" || item.modality === "mixed");
  const endurance = sessions.filter((item) => ["endurance", "recovery", "mixed"].includes(item.modality));
  let workingSets = 0;
  let rawVolume = 0;
  const direct: Record<string, number> = {};
  const indirect: Record<string, number> = {};
  for (const session of strength) {
    for (const set of session.strengthSets) {
      if (set.setType === "warmup") continue;
      workingSets += 1;
      if (set.weight !== null && set.reps !== null) rawVolume += set.weight * set.reps;
      for (const muscle of set.primaryMuscles) direct[muscle] = (direct[muscle] ?? 0) + 1;
      for (const muscle of set.secondaryMuscles) indirect[muscle] = (indirect[muscle] ?? 0) + 1;
    }
  }
  const duration = endurance.reduce((sum, item) => sum + item.durationMinutes, 0);
  const distance = endurance.reduce((sum, item) => sum + (item.endurance?.distanceMeters ?? 0), 0);
  const zoneSeconds: Record<string, number> = {};
  for (const session of endurance) {
    for (const [zone, seconds] of Object.entries(session.endurance?.heartRateZoneSeconds ?? {})) {
      zoneSeconds[zone] = (zoneSeconds[zone] ?? 0) + seconds;
    }
  }
  const sourceList = [...new Set(sessions.map((item) => item.source))];
  const volumeMissing = strength.some((item) => item.strengthSets.some((set) => set.weight === null || set.reps === null));
  const distanceMissing = endurance.some((item) => item.endurance?.distanceMeters === null);
  const zonesMissing = endurance.some((item) => !Object.keys(item.endurance?.heartRateZoneSeconds ?? {}).length);
  const sharedLimit = ["Strength and endurance metrics are intentionally not combined into a single load score."];
  return {
    strength: {
      workingSets: metric(workingSets, "sets", "completed_working_sets", strength, emptyQuality(sourceList), sharedLimit),
      rawVolume: metric(Number(rawVolume.toFixed(2)), "load_repetitions", "sum_load_times_reps", strength, emptyQuality(sourceList, volumeMissing ? ["weight_or_reps"] : []), ["Volumes in different weight units must not be compared until normalized."]),
      directSetsByMuscle: metric(direct, "sets", "primary_muscle_set_count", strength, emptyQuality(sourceList), []),
      indirectSetsByMuscle: metric(indirect, "participations", "secondary_muscle_participation_count", strength, emptyQuality(sourceList), ["Indirect participation is not treated as equivalent to a direct set."]),
    },
    endurance: {
      durationMinutes: metric(duration, "min", "sum_duration", endurance, emptyQuality(sourceList), sharedLimit),
      distanceMeters: metric(distance, "m", "sum_distance", endurance, emptyQuality(sourceList, distanceMissing ? ["distanceMeters"] : []), []),
      paceSecondsPerKm: metric(distance > 0 ? Number(((duration * 60 * 1000) / distance).toFixed(2)) : null, "s/km", "elapsed_duration_per_kilometer", endurance, emptyQuality(sourceList, distance > 0 ? [] : ["distanceMeters"]), ["Elapsed pace may include stopped time depending on the source."]),
      timeInZoneSeconds: metric(zoneSeconds, "s", "sum_source_zone_durations", endurance, emptyQuality(sourceList, zonesMissing ? ["heartRateZoneSeconds"] : []), ["Zone totals retain the source method and require a configured heart-rate basis."]),
    },
  };
}

export interface DoubleProgressionInput {
  completedReps: number[];
  repMin: number;
  repMax: number;
  currentLoad: number;
  loadIncrement: number;
  unit: "kg" | "lb";
  rpeValues?: number[];
  rpeCeiling?: number;
}

export function evaluateDoubleProgression(input: DoubleProgressionInput) {
  if (!input.completedReps.length) throw new Error("at least one completed set is required");
  if (input.repMin < 1 || input.repMax < input.repMin) throw new Error("invalid repetition range");
  const reachedTop = input.completedReps.every((reps) => reps >= input.repMax);
  const belowMinimum = input.completedReps.some((reps) => reps < input.repMin);
  const rpeAvailable = input.rpeValues?.length === input.completedReps.length;
  const rpeAcceptable = input.rpeCeiling === undefined || (rpeAvailable && input.rpeValues!.every((rpe) => rpe <= input.rpeCeiling!));
  const action = reachedTop && rpeAcceptable ? "increase" : belowMinimum ? "review" : "hold";
  return {
    action,
    proposedLoad: action === "increase" ? input.currentLoad + input.loadIncrement : input.currentLoad,
    unit: input.unit,
    reasonCode: action === "increase" ? "REP_RANGE_COMPLETE" : belowMinimum ? "BELOW_REP_FLOOR" : rpeAvailable || input.rpeCeiling === undefined ? "REP_RANGE_IN_PROGRESS" : "RPE_DATA_MISSING",
    formulaVersion: FORMULA_VERSION,
    confidenceLimit: rpeAvailable || input.rpeCeiling === undefined ? null : "RPE ceiling could not be evaluated.",
  } as const;
}

export function evaluateRpeAutoregulation(input: { actualRpe: number | null; targetRpe: number; load: number; increment: number; unit: "kg" | "lb" }) {
  if (input.actualRpe === null) return { action: "insufficient_data", proposedLoad: input.load, reasonCode: "RPE_DATA_MISSING", formulaVersion: FORMULA_VERSION } as const;
  if (input.actualRpe < 0 || input.actualRpe > 10 || input.targetRpe < 1 || input.targetRpe > 10) throw new Error("RPE values must be valid");
  const difference = input.actualRpe - input.targetRpe;
  const action = difference >= 1 ? "decrease" : difference <= -1 ? "increase" : "hold";
  return {
    action,
    proposedLoad: action === "increase" ? input.load + input.increment : action === "decrease" ? Math.max(0, input.load - input.increment) : input.load,
    unit: input.unit,
    reasonCode: action === "increase" ? "RPE_BELOW_TARGET" : action === "decrease" ? "RPE_ABOVE_TARGET" : "RPE_ON_TARGET",
    formulaVersion: FORMULA_VERSION,
  } as const;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function stableHash(value: unknown): string {
  let hash = 2166136261;
  for (const character of canonical(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

const rule = (severity: "hard" | "soft" | "info", reasonCode: string, passed: boolean, sessionIds: string[], evidence: Record<string, unknown>, messageArgs: Record<string, string | number | boolean | null> = {}): RuleResult => ({
  severity, reasonCode, ruleVersion: RULE_VERSION, passed, messageArgs, evidence, sessionIds,
});

export function validatePlan(profile: AthleteProfile, draft: Pick<PlanDraft, "mesocycle">, catalog: ExerciseDefinition[], now = new Date()): PlanValidation {
  const results: RuleResult[] = [];
  const known = new Map(catalog.map((item) => [item.key, item]));
  if (draft.mesocycle) {
    const mesocycle = draft.mesocycle;
    const templateIds = mesocycle.sessionTemplates.map((item) => item.id);
    const templateIdSet = new Set(templateIds);
    const templateLabels = mesocycle.sessionTemplates.map((item) => item.label);
    const phaseIds = mesocycle.phases.map((item) => item.id);
    const phaseIdSet = new Set(phaseIds);
    const weekdays = mesocycle.weeklyStructure.map((item) => item.dayOfWeek);
    const weeklyStructureValid = weekdays.length === 7
      && new Set(weekdays).size === 7
      && mesocycle.weeklyStructure.every((item) => new Set(item.templateIds).size === item.templateIds.length && item.templateIds.every((id) => templateIdSet.has(id)));
    results.push(rule("hard", "MESOCYCLE_TEMPLATE_IDS", templateIds.length === templateIdSet.size && templateLabels.length === new Set(templateLabels).size, [], { templateIds, templateLabels }));
    results.push(rule("hard", "MESOCYCLE_WEEKLY_STRUCTURE", weeklyStructureValid, [], { weekdays, templateIds: mesocycle.weeklyStructure.flatMap((item) => item.templateIds) }));
    const phases = [...mesocycle.phases].sort((a, b) => a.startWeek - b.startWeek);
    const phasesCoverDuration = phaseIds.length === phaseIdSet.size
      && phases[0]?.startWeek === 1
      && phases.at(-1)?.endWeek === mesocycle.durationWeeks
      && phases.every((phase, index) => phase.startWeek <= phase.endWeek
        && phase.endWeek <= mesocycle.durationWeeks
        && (index === 0 || phase.startWeek === phases[index - 1]!.endWeek + 1));
    results.push(rule("hard", "MESOCYCLE_PHASE_PROGRESSION", phasesCoverDuration, [], { durationWeeks: mesocycle.durationWeeks, phases: phases.map(({ id, startWeek, endWeek }) => ({ id, startWeek, endWeek })) }));
    for (const template of mesocycle.sessionTemplates) {
      results.push(rule("hard", "MAX_SESSION_DURATION", template.durationMinutes <= profile.maxSessionMinutes, [template.id], { durationMinutes: template.durationMinutes, maximum: profile.maxSessionMinutes }));
      for (const exercise of template.exercises) {
      const definition = known.get(exercise.exerciseKey);
      const recognized = Boolean(definition);
      results.push(rule("hard", "KNOWN_EXERCISE", recognized, [template.id], { exerciseKey: exercise.exerciseKey }));
      if (definition) {
        const equipmentMatch = definition.equipment.some((item) => profile.equipment.includes(item));
        results.push(rule("hard", "EXERCISE_EQUIPMENT", equipmentMatch, [template.id], { exerciseKey: exercise.exerciseKey, required: definition.equipment, available: profile.equipment }));
        const excluded = profile.excludedExercises.includes(exercise.exerciseKey);
        results.push(rule("hard", "EXERCISE_EXCLUSION", !excluded, [template.id], { exerciseKey: exercise.exerciseKey }));
      }
    }
    }
  }
  const valid = !results.some((item) => item.severity === "hard" && !item.passed);
  return { valid, results, dataGaps: [], validatedAt: now.toISOString(), inputHash: stableHash({ mesocycle: draft.mesocycle ?? null }) };
}

export function findExerciseCandidates(profile: AthleteProfile, catalog: ExerciseDefinition[], query: { movement?: string; muscles?: string[]; equipment?: string[] }) {
  return catalog.map((exercise) => {
    const reasons: string[] = [];
    if (profile.excludedExercises.includes(exercise.key)) reasons.push("excluded_by_profile");
    if (!exercise.equipment.some((item) => profile.equipment.includes(item))) reasons.push("equipment_unavailable");
    if (query.movement && exercise.movement !== query.movement) reasons.push("movement_mismatch");
    if (query.muscles?.length && !query.muscles.some((item) => exercise.primaryMuscles.includes(item))) reasons.push("muscle_mismatch");
    if (query.equipment?.length && !query.equipment.some((item) => exercise.equipment.includes(item))) reasons.push("requested_equipment_mismatch");
    return { exercise, eligible: reasons.length === 0, exclusionReasons: reasons };
  });
}

export function comparePlans(previous: PlanDraft | null, next: PlanDraft) {
  const before = new Map((previous?.mesocycle?.sessionTemplates ?? []).map((item) => [item.id, item]));
  const after = new Map((next.mesocycle?.sessionTemplates ?? []).map((item) => [item.id, item]));
  return {
    addedTemplates: [...after.values()].filter((item) => !before.has(item.id)),
    removedTemplates: [...before.values()].filter((item) => !after.has(item.id)),
    changedTemplates: [...after.values()].filter((item) => before.has(item.id) && stableHash(item) !== stableHash(before.get(item.id))).map((item) => ({ before: before.get(item.id), after: item })),
    phasesChanged: stableHash(previous?.mesocycle?.phases ?? []) !== stableHash(next.mesocycle?.phases ?? []),
    weeklyStructureChanged: stableHash(previous?.mesocycle?.weeklyStructure ?? []) !== stableHash(next.mesocycle?.weeklyStructure ?? []),
  };
}
