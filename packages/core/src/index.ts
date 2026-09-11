import {
  AI_HARD_CONFIDENCE,
  FORMULA_VERSION,
  RULE_VERSION,
  TAXONOMY_VERSION,
  type AthleteProfile,
  type DataQuality,
  type ResolvedMesocycle,
  type Schedule,
  type PlanValidation,
  type RuleResult,
  type TrainingSession,
} from "@athria/schemas";

export interface ScheduleOccurrence {
  ordinal: number;
  slotId: string;
  scheduledDate: string;
  dayOfWeek: number;
  weekNumber: number;
}

const scheduleAddDays = (date: string, days: number): string => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const scheduleWeekday = (date: string): number => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;

function combinations(values: number[], count: number): number[][] {
  if (count === 0) return [[]];
  if (values.length < count) return [];
  const output: number[][] = [];
  for (let index = 0; index <= values.length - count; index += 1) {
    for (const tail of combinations(values.slice(index + 1), count - 1)) output.push([values[index]!, ...tail]);
  }
  return output;
}

function evenlySpacedOffsets(candidates: number[], count: number, acceptable: (choice: number[]) => boolean = () => true): number[] {
  const choices = combinations(candidates, count).filter(acceptable);
  const ideal = Array.from({ length: count }, (_, index) => ((index + 1) * 7 / (count + 1)) - 1);
  return choices.sort((left, right) => {
    const score = (choice: number[]) => choice.reduce((total, value, index) => total + ((value - ideal[index]!) ** 2), 0);
    return score(left) - score(right) || left.join(",").localeCompare(right.join(","));
  })[0] ?? [];
}

export function expandSchedule(input: { effectiveStartDate: string; durationWeeks: number; schedule: Schedule }): ScheduleOccurrence[] {
  const { effectiveStartDate, durationWeeks, schedule } = input;
  const endOffset = durationWeeks * 7;
  const occurrences: ScheduleOccurrence[] = [];
  const add = (scheduledDate: string, slotId: string) => {
    const elapsed = Math.round((Date.parse(`${scheduledDate}T12:00:00Z`) - Date.parse(`${effectiveStartDate}T12:00:00Z`)) / 86_400_000);
    if (elapsed < 0 || elapsed >= endOffset) return;
    occurrences.push({ ordinal: occurrences.length, slotId, scheduledDate, dayOfWeek: scheduleWeekday(scheduledDate), weekNumber: Math.floor(elapsed / 7) + 1 });
  };
  if (schedule.kind === "fixed_week") {
    for (let offset = 0; offset < endOffset; offset += 1) {
      const date = scheduleAddDays(effectiveStartDate, offset);
      if (schedule.days.includes(scheduleWeekday(date))) add(date, `weekday-${scheduleWeekday(date)}`);
    }
  } else if (schedule.kind === "flexible_week") {
    for (let week = 0; week < durationWeeks; week += 1) {
      const candidates = Array.from({ length: 7 }, (_, offset) => offset);
      for (const [index, offset] of evenlySpacedOffsets(candidates, schedule.targetDaysPerWeek).entries()) add(scheduleAddDays(effectiveStartDate, week * 7 + offset), `flex-${week + 1}-${index + 1}`);
    }
  } else {
    let date = effectiveStartDate; let index = 0;
    while (Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${effectiveStartDate}T12:00:00Z`)) / 86_400_000) < endOffset) {
      add(date, `interval-${index + 1}`); index += 1; date = scheduleAddDays(date, schedule.intervalDays);
    }
  }
  return occurrences;
}

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

export function validatePlan(profile: AthleteProfile, draft: { mesocycle: ResolvedMesocycle | null; effectiveStartDate?: string }, now = new Date()): PlanValidation {
  const results: RuleResult[] = [];
  const dataGaps: PlanValidation["dataGaps"] = [];
  let movementFactsTotal = 0; let movementFactsResolved = 0; let muscleFactsTotal = 0; let muscleFactsResolved = 0; let equipmentFactsTotal = 0; let equipmentFactsResolved = 0;
  if (draft.mesocycle) {
    const mesocycle = draft.mesocycle;
    const weekdays = mesocycle.schedule.kind === "fixed_week" ? mesocycle.schedule.days : [];
    const scheduleOccurrences = expandSchedule({ effectiveStartDate: draft.effectiveStartDate ?? "2026-01-05", durationWeeks: mesocycle.durationWeeks, schedule: mesocycle.schedule });
    const weeklyPrescriptions = mesocycle.weeks.flatMap((week) => week.sessions.map((session) => ({ ...session, weekNumber: week.weekNumber })));
    const scheduledDates = [...new Set(weeklyPrescriptions.map((session) => session.scheduledDate))].sort();
    const expectedDates = scheduleOccurrences.map((occurrence) => occurrence.scheduledDate).sort();
    const sameDates = scheduledDates.length === expectedDates.length && scheduledDates.every((date, index) => date === expectedDates[index]);
    const rhythm = profile.trainingRhythm;
    const rhythmParametersMatch = rhythm.kind === "fixed_week"
      ? mesocycle.schedule.kind === "fixed_week" && [...rhythm.days].sort().join(",") === [...weekdays].sort().join(",")
      : rhythm.kind === "flexible_week"
        ? mesocycle.schedule.kind === "flexible_week" && mesocycle.schedule.targetDaysPerWeek === rhythm.targetDaysPerWeek && mesocycle.schedule.minDaysPerWeek === rhythm.minDaysPerWeek && mesocycle.schedule.maxDaysPerWeek === rhythm.maxDaysPerWeek
        : mesocycle.schedule.kind === "interval" && mesocycle.schedule.intervalDays === rhythm.intervalDays;
    const rhythmDates = scheduledDates;
    const weeklyRhythmMatches = rhythm.kind === "flexible_week"
      ? mesocycle.weeks.every((week) => {
        const trainingDays = new Set(week.sessions.map((session) => session.scheduledDate)).size;
        return trainingDays >= rhythm.minDaysPerWeek && trainingDays <= rhythm.maxDaysPerWeek;
      })
      : rhythm.kind === "interval"
        ? rhythmDates[0] === (draft.effectiveStartDate ?? "2026-01-05") && rhythmDates.every((date, index) => index === 0 || Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${rhythmDates[index - 1]}T12:00:00Z`)) / 86_400_000) === rhythm.intervalDays)
        : sameDates;
    const prescriptions = weeklyPrescriptions;
    const componentIds = prescriptions.flatMap((item) => item.components.map((component) => component.id));
    const exerciseIds = prescriptions.flatMap((item) => item.components.flatMap((component) => component.prescription.kind === "strength" ? component.prescription.exercises.map((exercise) => exercise.id) : []));
    const uniqueWithinTemplate = (ids: string[]) => ids.length === new Set(ids).size;
    const componentIdsUnique = prescriptions.every((item) => uniqueWithinTemplate(item.components.map((component) => component.id)));
    const exerciseIdsUnique = prescriptions.every((item) => uniqueWithinTemplate(item.components.flatMap((component) => component.prescription.kind === "strength" ? component.prescription.exercises.map((exercise) => exercise.id) : [])));
    results.push(rule("blocker", "COMPONENT_IDS", componentIdsUnique ? "pass" : "fail", [], { componentIds }));
    results.push(rule("blocker", "EXERCISE_IDS", exerciseIdsUnique ? "pass" : "fail", [], { exerciseIds }));
    results.push(rule("blocker", "MESOCYCLE_SCHEDULE", "pass", [], { kind: mesocycle.schedule.kind, weekdays, occurrenceCount: scheduleOccurrences.length }));
    results.push(rule("blocker", "PROFILE_TRAINING_RHYTHM", rhythmParametersMatch && weeklyRhythmMatches ? "pass" : "fail", [], { profileRhythm: rhythm, planSchedule: mesocycle.schedule, scheduledDates }));
    const progressionDomains = mesocycle.domainProgressions.map((item) => item.domain);
    const sessionDomains = [...new Set(weeklyPrescriptions.flatMap((session) => session.components.map((component) => component.domain.value).filter((domain) => domain !== null)))];
    const domainsMatch = progressionDomains.length === new Set(progressionDomains).size
      && sessionDomains.length === progressionDomains.length
      && progressionDomains.every((domain) => sessionDomains.includes(domain));
    const progressionsCoverDuration = mesocycle.domainProgressions.every((progression) => {
      const phases = [...progression.phases].sort((a, b) => a.startWeek - b.startWeek);
      return phases.length === new Set(phases.map((phase) => phase.id)).size
        && phases[0]?.startWeek === 1
        && phases.at(-1)?.endWeek === mesocycle.durationWeeks
        && phases.every((phase, index) => phase.startWeek <= phase.endWeek
          && phase.endWeek <= mesocycle.durationWeeks
          && (index === 0 || phase.startWeek === phases[index - 1]!.endWeek + 1));
    });
    results.push(rule("blocker", "DOMAIN_PROGRESSION", domainsMatch && progressionsCoverDuration ? "pass" : "fail", [], { durationWeeks: mesocycle.durationWeeks, sessionDomains, progressions: mesocycle.domainProgressions }));
    const directByMuscle: Record<string, number> = {}; const indirectByMuscle: Record<string, number> = {}; const setsByPattern: Record<string, number> = {};
    for (const template of prescriptions) {
      const occurrences = 1 / mesocycle.durationWeeks;
      results.push(rule("blocker", "MAX_SESSION_DURATION", template.durationMinutes <= profile.maxSessionMinutes ? "pass" : "fail", [template.id], { durationMinutes: template.durationMinutes, maximum: profile.maxSessionMinutes }));
      for (const component of template.components) {
        const prescriptionConsistent = component.prescription.kind === "duration_only"
          ? component.domain.value !== "strength"
          : component.prescription.kind === component.domain.value;
        results.push(rule("blocker", "COMPONENT_PRESCRIPTION", prescriptionConsistent ? "pass" : "fail", [template.id, component.id], { domain: component.domain.value, prescription: component.prescription.kind }));
        if (component.domain.value === null) {
          results.push(rule("info", "COMPONENT_DOMAIN_MISSING", "unknown", [component.id], {}, ["domain"]));
          dataGaps.push({ code: "COMPONENT_DOMAIN_MISSING", subjectRef: component.id, factPath: "domain", requiredByRuleCodes: [], blocking: false, resolution: "agent_infer" });
        }
        if (component.prescription.kind !== "strength" || component.domain.value !== "strength") continue;
        for (const exercise of component.prescription.exercises) {
          const subjectRefs = [template.id, component.id, exercise.id];
          const movement = exercise.classification.primaryMovement;
          const muscles = exercise.classification.primaryMuscles;
          const equipment = exercise.classification.equipment;
          movementFactsTotal += 1; muscleFactsTotal += 1; equipmentFactsTotal += 1;
          const equipmentConflict = false;
          const movementTrusted = factTrustedForBlocker(movement);
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
        }
      }
    }
    results.push(rule("info", "STRENGTH_VOLUME_DISTRIBUTION", "pass", [], { directSetsByMuscle: directByMuscle, indirectParticipationsByMuscle: indirectByMuscle, setsByPattern }, [], null, "strength"));
    const push = (setsByPattern.horizontal_push ?? 0) + (setsByPattern.vertical_push ?? 0); const pull = (setsByPattern.horizontal_pull ?? 0) + (setsByPattern.vertical_pull ?? 0);
    results.push(rule("advisory", "STRENGTH_PUSH_PULL_BALANCE", ratioStatus(push, pull), [], { pushSets: push, pullSets: pull, boundary: 2 }, [], null, "strength"));
    const knee = (setsByPattern.squat ?? 0) + (setsByPattern.lunge ?? 0); const hinge = setsByPattern.hinge ?? 0;
    results.push(rule("advisory", "STRENGTH_KNEE_HINGE_BALANCE", ratioStatus(knee, hinge), [], { kneeDominantSets: knee, hingeSets: hinge, boundary: 2 }, [], null, "strength"));
    const highDates = [...new Set(weeklyPrescriptions.filter((session) => session.recoveryDemand === "high").map((session) => session.scheduledDate))].sort();
    let closestDays = Infinity;
    for (let index = 1; index < highDates.length; index += 1) closestDays = Math.min(closestDays, Math.round((Date.parse(`${highDates[index]}T12:00:00Z`) - Date.parse(`${highDates[index - 1]}T12:00:00Z`)) / 86_400_000));
    if (highDates.length > 1) {
      if (profile.explicitRecoveryDays !== null) results.push(rule("blocker", "EXPLICIT_RECOVERY_INTERVAL", closestDays >= profile.explicitRecoveryDays ? "pass" : "fail", [], { closestDays, requiredDays: profile.explicitRecoveryDays }, [], null, "constraints"));
      else results.push(rule("advisory", "ADJACENT_HIGH_DEMAND_SESSIONS", closestDays > 1 ? "pass" : "fail", [], { closestDays }, [], null, "balance"));
    }
  }
  const blockers = results.filter((item) => item.enforcement === "blocker");
  const coverage = { hardChecksResolved: blockers.filter((item) => item.status === "pass" || item.status === "fail").length, hardChecksTotal: blockers.length, movementFactsResolved, movementFactsTotal, muscleFactsResolved, muscleFactsTotal, equipmentFactsResolved, equipmentFactsTotal };
  const valid = !blockers.some((item) => item.status === "fail" || item.status === "unknown");
  return { valid, results, dataGaps, validatedAt: now.toISOString(), inputHash: stableHash({ mesocycle: draft.mesocycle ?? null, profile, taxonomyVersion: TAXONOMY_VERSION, rulePacks: { structure: RULE_VERSION, constraints: RULE_VERSION, strength: RULE_VERSION, balance: RULE_VERSION } }), coverage };
}
