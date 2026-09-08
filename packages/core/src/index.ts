import {
  AI_HARD_CONFIDENCE,
  FORMULA_VERSION,
  RULE_VERSION,
  TAXONOMY_VERSION,
  type AthleteProfile,
  type DataQuality,
  type ExerciseDefinition,
  type ResolvedMesocycle,
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
  const domains = (item: TrainingSession) => item.domains.length ? item.domains : [
    ...(item.strengthSets.length ? ["strength" as const] : []),
    ...(item.endurance ? ["endurance" as const] : []),
  ];
  const strength = sessions.filter((item) => domains(item).includes("strength"));
  const endurance = sessions.filter((item) => domains(item).includes("endurance") || domains(item).includes("recovery"));
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

type RuleStatus = RuleResult["status"];
type Enforcement = RuleResult["enforcement"];
const rule = (enforcement: Enforcement, reasonCode: string, status: RuleStatus, subjectRefs: string[], evidence: Record<string, unknown> = {}, missingFacts: string[] = [], confidenceLimit: RuleResult["confidenceLimit"] = null, rulePackId = "structure"): RuleResult => ({
  enforcement, reasonCode, status, rulePackId, ruleVersion: RULE_VERSION, subjectRefs, evidence, missingFacts, confidenceLimit,
});

const factTrustedForBlocker = (fact: { source: string; confidence: number; evidence: string; value: unknown; conflicts?: unknown[] | undefined }): boolean =>
  fact.value !== null && fact.value !== undefined
  && (fact.source === "user_confirmed" || !fact.conflicts?.length)
  && (fact.source !== "ai_inferred" || (fact.confidence >= AI_HARD_CONFIDENCE && fact.evidence.trim().length > 0));

const sameValues = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

function ratioStatus(left: number, right: number): RuleStatus {
  if (left === 0 && right === 0) return "not_applicable";
  if ((left === 0 && right >= 4) || (right === 0 && left >= 4)) return "fail";
  if (left === 0 || right === 0) return "pass";
  const ratio = left / right;
  return ratio > 2 || ratio < 0.5 ? "fail" : "pass";
}

export function validatePlan(profile: AthleteProfile, draft: { mesocycle: ResolvedMesocycle | null }, catalog: ExerciseDefinition[], now = new Date()): PlanValidation {
  const results: RuleResult[] = [];
  const dataGaps: PlanValidation["dataGaps"] = [];
  const known = new Map(catalog.map((item) => [item.key, item]));
  let movementFactsTotal = 0; let movementFactsResolved = 0; let muscleFactsTotal = 0; let muscleFactsResolved = 0; let equipmentFactsTotal = 0; let equipmentFactsResolved = 0;
  if (draft.mesocycle) {
    const mesocycle = draft.mesocycle;
    const templateIds = mesocycle.sessionTemplates.map((item) => item.id);
    const templateIdSet = new Set(templateIds);
    const phaseIds = mesocycle.phases.map((item) => item.id);
    const phaseIdSet = new Set(phaseIds);
    const weekdays = mesocycle.weeklyStructure.map((item) => item.dayOfWeek);
    const weeklyStructureValid = new Set(weekdays).size === weekdays.length
      && mesocycle.weeklyStructure.every((item) => new Set(item.templateIds).size === item.templateIds.length && item.templateIds.every((id) => templateIdSet.has(id)));
    const componentIds = mesocycle.sessionTemplates.flatMap((item) => item.components.map((component) => component.id));
    const exerciseIds = mesocycle.sessionTemplates.flatMap((item) => item.components.flatMap((component) => component.prescription.kind === "strength" ? component.prescription.exercises.map((exercise) => exercise.id) : []));
    const uniqueWithinTemplate = (ids: string[]) => ids.length === new Set(ids).size;
    const componentIdsUnique = mesocycle.sessionTemplates.every((item) => uniqueWithinTemplate(item.components.map((component) => component.id)));
    const exerciseIdsUnique = mesocycle.sessionTemplates.every((item) => uniqueWithinTemplate(item.components.flatMap((component) => component.prescription.kind === "strength" ? component.prescription.exercises.map((exercise) => exercise.id) : [])));
    results.push(rule("blocker", "MESOCYCLE_TEMPLATE_IDS", templateIds.length === templateIdSet.size ? "pass" : "fail", [], { templateIds }));
    results.push(rule("blocker", "COMPONENT_IDS", componentIdsUnique ? "pass" : "fail", [], { componentIds }));
    results.push(rule("blocker", "EXERCISE_IDS", exerciseIdsUnique ? "pass" : "fail", [], { exerciseIds }));
    results.push(rule("blocker", "MESOCYCLE_WEEKLY_STRUCTURE", weeklyStructureValid ? "pass" : "fail", [], { weekdays, templateIds: mesocycle.weeklyStructure.flatMap((item) => item.templateIds) }));
    const phases = [...mesocycle.phases].sort((a, b) => a.startWeek - b.startWeek);
    const phasesCoverDuration = phaseIds.length === phaseIdSet.size
      && phases[0]?.startWeek === 1
      && phases.at(-1)?.endWeek === mesocycle.durationWeeks
      && phases.every((phase, index) => phase.startWeek <= phase.endWeek
        && phase.endWeek <= mesocycle.durationWeeks
        && (index === 0 || phase.startWeek === phases[index - 1]!.endWeek + 1));
    results.push(rule("blocker", "MESOCYCLE_PHASE_PROGRESSION", phasesCoverDuration ? "pass" : "fail", [], { durationWeeks: mesocycle.durationWeeks, phases: phases.map(({ id, startWeek, endWeek }) => ({ id, startWeek, endWeek })) }));
    const scheduled = new Map<string, number>();
    for (const day of mesocycle.weeklyStructure) for (const id of day.templateIds) scheduled.set(id, (scheduled.get(id) ?? 0) + 1);
    const directByMuscle: Record<string, number> = {}; const indirectByMuscle: Record<string, number> = {}; const setsByPattern: Record<string, number> = {};
    let strengthFrequency = 0;
    for (const template of mesocycle.sessionTemplates) {
      const occurrences = scheduled.get(template.id) ?? 0;
      const onAllowedDays = profile.trainingDays.length === 0 || mesocycle.weeklyStructure.filter((day) => day.templateIds.includes(template.id)).every((day) => profile.trainingDays.includes(day.dayOfWeek));
      results.push(rule("blocker", "MAX_SESSION_DURATION", template.durationMinutes <= profile.maxSessionMinutes ? "pass" : "fail", [template.id], { durationMinutes: template.durationMinutes, maximum: profile.maxSessionMinutes }));
      results.push(rule("blocker", "TRAINING_DAYS", onAllowedDays ? "pass" : "fail", [template.id], { allowed: profile.trainingDays }));
      if (template.components.some((component) => component.domain.value === "strength")) strengthFrequency += occurrences;
      for (const component of template.components) {
        const prescriptionConsistent = (component.prescription.kind === "strength" && component.domain.value === "strength")
          || (component.prescription.kind === "duration_only" && component.domain.value !== "strength");
        results.push(rule("blocker", "COMPONENT_PRESCRIPTION", prescriptionConsistent ? "pass" : "fail", [template.id, component.id], { domain: component.domain.value, prescription: component.prescription.kind }));
        if (component.domain.value === null) {
          results.push(rule("info", "COMPONENT_DOMAIN_MISSING", "unknown", [component.id], {}, ["domain"]));
          dataGaps.push({ code: "COMPONENT_DOMAIN_MISSING", subjectRef: component.id, factPath: "domain", requiredByRuleCodes: [], blocking: false, resolution: "agent_infer" });
        }
        if (component.prescription.kind !== "strength" || component.domain.value !== "strength") continue;
        for (const exercise of component.prescription.exercises) {
          const subjectRefs = [template.id, component.id, exercise.id];
          const definition = exercise.canonicalKey ? known.get(exercise.canonicalKey) : undefined;
          const movement = exercise.classification.primaryMovement;
          const muscles = exercise.classification.primaryMuscles;
          const equipment = exercise.classification.equipment;
          movementFactsTotal += 1; muscleFactsTotal += 1; equipmentFactsTotal += 1;
          const movementConflict = Boolean(definition && movement.source !== "user_confirmed" && !sameValues(movement.value, definition.movement));
          // Catalog equipment lists valid variants; a plan fact describes the concrete variant selected.
          const equipmentConflict = Boolean(definition && equipment.source !== "user_confirmed" && equipment.value.some((item) => !definition.equipment.includes(item)));
          const movementTrusted = factTrustedForBlocker(movement) && !movementConflict;
          const muscleResolved = muscles.value.length > 0 && factTrustedForBlocker(muscles);
          const equipmentTrusted = equipment.value.length > 0 && factTrustedForBlocker(equipment) && !equipmentConflict;
          if (movementTrusted) movementFactsResolved += 1;
          if (muscleResolved) muscleFactsResolved += 1;
          if (equipmentTrusted) equipmentFactsResolved += 1;
          const multiplier = Math.max(1, occurrences);
          if (movement.value) setsByPattern[movement.value] = (setsByPattern[movement.value] ?? 0) + exercise.sets * multiplier;
          for (const muscle of muscles.value) directByMuscle[muscle] = (directByMuscle[muscle] ?? 0) + exercise.sets * multiplier;
          for (const muscle of exercise.classification.secondaryMuscles.value) indirectByMuscle[muscle] = (indirectByMuscle[muscle] ?? 0) + exercise.sets * multiplier;

          const equipmentStatus: RuleStatus = equipmentTrusted ? (equipment.value.some((item) => profile.equipment.includes(item)) ? "pass" : "fail") : "unknown";
          results.push(rule("blocker", "EXERCISE_EQUIPMENT", equipmentStatus, subjectRefs, { required: equipment.value, available: profile.equipment, source: equipment.source, conflict: equipmentConflict }, equipmentStatus === "unknown" ? ["classification.equipment"] : [], { required: AI_HARD_CONFIDENCE, observed: equipment.confidence }, "constraints"));
          if (equipmentStatus === "unknown") dataGaps.push({ code: "EXERCISE_EQUIPMENT_UNKNOWN", subjectRef: exercise.id, factPath: "classification.equipment", requiredByRuleCodes: ["EXERCISE_EQUIPMENT"], blocking: true, resolution: equipment.source === "ai_inferred" ? "user_confirm" : "agent_infer" });

          const exclusions = profile.strengthConstraints.filter((item) => item.type === "exclude_exercise");
          const excluded = exercise.canonicalKey ? exclusions.some((item) => item.canonicalKey === exercise.canonicalKey) : false;
          const identityStatus: RuleStatus = exclusions.length && !exercise.canonicalKey ? "unknown" : excluded ? "fail" : "pass";
          results.push(rule("blocker", "EXERCISE_EXCLUSION", identityStatus, subjectRefs, { canonicalKey: exercise.canonicalKey, exclusions: exclusions.map((item) => item.canonicalKey) }, identityStatus === "unknown" ? ["canonicalKey"] : [], null, "constraints"));
          if (identityStatus === "unknown") dataGaps.push({ code: "EXERCISE_IDENTITY_UNKNOWN", subjectRef: exercise.id, factPath: "canonicalKey", requiredByRuleCodes: ["EXERCISE_EXCLUSION"], blocking: true, resolution: "user_confirm" });

          const prohibited = profile.strengthConstraints.filter((item) => item.type === "prohibit_movement_pattern");
          if (prohibited.length) {
            const movementStatus: RuleStatus = movementTrusted ? (prohibited.some((item) => item.movementPattern === movement.value) ? "fail" : "pass") : "unknown";
            results.push(rule("blocker", "MOVEMENT_PATTERN_PROHIBITED", movementStatus, subjectRefs, { movement: movement.value, prohibited: prohibited.map((item) => item.movementPattern), source: movement.source, conflict: movementConflict }, movementStatus === "unknown" ? ["classification.primaryMovement"] : [], { required: AI_HARD_CONFIDENCE, observed: movement.confidence }, "constraints"));
            if (movementStatus === "unknown") dataGaps.push({ code: "MOVEMENT_PATTERN_UNKNOWN", subjectRef: exercise.id, factPath: "classification.primaryMovement", requiredByRuleCodes: ["MOVEMENT_PATTERN_PROHIBITED"], blocking: true, resolution: movement.source === "ai_inferred" ? "user_confirm" : "agent_infer" });
          }
        }
      }
    }
    results.push(rule("info", "STRENGTH_VOLUME_DISTRIBUTION", "pass", [], { directSetsByMuscle: directByMuscle, indirectParticipationsByMuscle: indirectByMuscle, setsByPattern }, [], null, "strength"));
    const push = (setsByPattern.horizontal_push ?? 0) + (setsByPattern.vertical_push ?? 0); const pull = (setsByPattern.horizontal_pull ?? 0) + (setsByPattern.vertical_pull ?? 0);
    results.push(rule("advisory", "STRENGTH_PUSH_PULL_BALANCE", ratioStatus(push, pull), [], { pushSets: push, pullSets: pull, boundary: 2 }, [], null, "strength"));
    const knee = (setsByPattern.squat ?? 0) + (setsByPattern.lunge ?? 0); const hinge = setsByPattern.hinge ?? 0;
    results.push(rule("advisory", "STRENGTH_KNEE_HINGE_BALANCE", ratioStatus(knee, hinge), [], { kneeDominantSets: knee, hingeSets: hinge, boundary: 2 }, [], null, "strength"));
    results.push(rule("advisory", "STRENGTH_WEEKLY_FREQUENCY", strengthFrequency === profile.weeklyStrengthSessions ? "pass" : "fail", [], { planned: strengthFrequency, preferred: profile.weeklyStrengthSessions }, [], null, "strength"));

    const highDays = mesocycle.weeklyStructure.filter((day) => day.templateIds.some((id) => mesocycle.sessionTemplates.find((template) => template.id === id)?.recoveryDemand === "high")).map((day) => day.dayOfWeek);
    let closestHours = Infinity;
    for (let left = 0; left < highDays.length; left += 1) for (let right = left + 1; right < highDays.length; right += 1) { const distance = Math.abs(highDays[left]! - highDays[right]!); closestHours = Math.min(closestHours, Math.min(distance, 7 - distance) * 24); }
    if (highDays.length > 1) {
      if (profile.explicitRecoveryHours !== null) results.push(rule("blocker", "EXPLICIT_RECOVERY_INTERVAL", closestHours >= profile.explicitRecoveryHours ? "pass" : "fail", [], { closestHours, requiredHours: profile.explicitRecoveryHours }, [], null, "constraints"));
      else results.push(rule("advisory", "ADJACENT_HIGH_DEMAND_SESSIONS", closestHours > 24 ? "pass" : "fail", [], { closestHours }, [], null, "balance"));
    }
  }
  const blockers = results.filter((item) => item.enforcement === "blocker");
  const coverage = { hardChecksResolved: blockers.filter((item) => item.status === "pass" || item.status === "fail").length, hardChecksTotal: blockers.length, movementFactsResolved, movementFactsTotal, muscleFactsResolved, muscleFactsTotal, equipmentFactsResolved, equipmentFactsTotal };
  const valid = !blockers.some((item) => item.status === "fail" || item.status === "unknown");
  return { valid, results, dataGaps, validatedAt: now.toISOString(), inputHash: stableHash({ mesocycle: draft.mesocycle ?? null, profile, classificationSnapshot: catalog, taxonomyVersion: TAXONOMY_VERSION, rulePacks: { structure: RULE_VERSION, constraints: RULE_VERSION, strength: RULE_VERSION, balance: RULE_VERSION } }), coverage };
}

export function findExerciseCandidates(profile: AthleteProfile, catalog: ExerciseDefinition[], query: { movement?: string; muscles?: string[]; equipment?: string[] }) {
  return catalog.map((exercise) => {
    const reasons: string[] = [];
    if (profile.strengthConstraints.some((item) => item.type === "exclude_exercise" && item.canonicalKey === exercise.key)) reasons.push("excluded_by_profile");
    if (!exercise.equipment.some((item) => profile.equipment.includes(item as typeof profile.equipment[number]))) reasons.push("equipment_unavailable");
    if (query.movement && exercise.movement !== query.movement) reasons.push("movement_mismatch");
    if (query.muscles?.length && !query.muscles.some((item) => exercise.primaryMuscles.includes(item))) reasons.push("muscle_mismatch");
    if (query.equipment?.length && !query.equipment.some((item) => exercise.equipment.includes(item))) reasons.push("requested_equipment_mismatch");
    return { exercise, eligible: reasons.length === 0, exclusionReasons: reasons };
  });
}
