// Cross-language deterministic-core fixture harness for the Rust migration
// (Phase 4).
//
//   bun run scripts/core-golden.ts
//     Runs every scenario below through the TypeScript core (packages/core) and
//     rewrites crates/athria-core/tests/fixtures/<kind>.<name>.json. The Rust
//     integration test crates/athria-core/tests/golden.rs replays the same
//     inputs through the Rust core and must produce semantically identical
//     output, proving both implementations agree until the TypeScript core is
//     retired.
//
// Fixture shape:
//   { kind, name, input, expected }  value cases
//   { kind, name, input, error }     cases where the TypeScript core throws
//
// Inputs are schema-parsed before being recorded, so the fixture documents the
// canonical document shape the Rust core is allowed to assume. A few
// `validate_plan` cases are marked `mutated`: they start from a parsed
// document and change a semantic value the schema would reject, because the
// rule engine's behavior for those drafts must still match byte for byte.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  calculateHeartRateZones,
  calculateTrainingMetrics,
  estimateOneRepMax,
  evaluateDoubleProgression,
  evaluateRpeAutoregulation,
  expandSchedule,
  stableHash,
  validatePlan,
} from "../packages/core/src/index.ts";
import {
  TAXONOMY_VERSION,
  athleteProfileSchema,
  mesocycleSchema,
  scheduleSchema,
  trainingSessionSchema,
} from "../packages/schemas/src/index.ts";

const root = resolve(import.meta.dir, "..");
const fixturesDir = join(root, "crates", "athria-core", "tests", "fixtures");

type Fixture = { kind: string; name: string; input: unknown; expected: unknown } | { kind: string; name: string; input: unknown; error: string };
const fixtures: Fixture[] = [];

function capture(kind: string, name: string, input: unknown, compute: () => unknown) {
  try {
    fixtures.push({ kind, name, input, expected: compute() });
  } catch (error) {
    fixtures.push({ kind, name, input, error: error instanceof Error ? error.message : String(error) });
  }
}

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// schedule: expandSchedule
// ---------------------------------------------------------------------------

function scheduleCase(name: string, effectiveStartDate: string, durationWeeks: number, schedule: Json) {
  const input = { effectiveStartDate, durationWeeks, schedule: scheduleSchema.parse(schedule) };
  capture("schedule", name, input, () => expandSchedule(input));
}

scheduleCase("fixed_week_two_days", "2026-09-07", 2, { kind: "fixed_week", days: [0, 4] });
scheduleCase("fixed_week_boundary_clip", "2026-09-09", 1, { kind: "fixed_week", days: [0, 6] });
scheduleCase("fixed_week_all_days", "2026-09-07", 3, { kind: "fixed_week", days: [0, 1, 2, 3, 4, 5, 6] });
scheduleCase("fixed_week_year_boundary", "2026-12-28", 2, { kind: "fixed_week", days: [0, 4] });
scheduleCase("flexible_week_three_days", "2026-09-07", 4, { kind: "flexible_week", targetDaysPerWeek: 3, minDaysPerWeek: 2, maxDaysPerWeek: 4 });
scheduleCase("flexible_week_one_day_tie_break", "2026-09-07", 3, { kind: "flexible_week", targetDaysPerWeek: 1, minDaysPerWeek: 1, maxDaysPerWeek: 1 });
scheduleCase("flexible_week_seven_days", "2026-09-07", 2, { kind: "flexible_week", targetDaysPerWeek: 7, minDaysPerWeek: 7, maxDaysPerWeek: 7 });
scheduleCase("interval_three_days", "2026-09-07", 4, { kind: "interval", intervalDays: 3 });
scheduleCase("interval_daily_one_week", "2026-09-07", 1, { kind: "interval", intervalDays: 1 });
scheduleCase("interval_ten_days_clipped", "2026-01-05", 5, { kind: "interval", intervalDays: 10 });

// ---------------------------------------------------------------------------
// one_rep_max: estimateOneRepMax
// ---------------------------------------------------------------------------

function oneRepMaxCase(name: string, load: number, reps: number, unit: "kg" | "lb") {
  capture("one_rep_max", name, { load, reps, unit }, () => estimateOneRepMax(load, reps, unit));
}

oneRepMaxCase("single_at_load", 100, 1, "kg");
oneRepMaxCase("epley_five_reps", 102.5, 5, "kg");
oneRepMaxCase("epley_twelve_reps", 80, 12, "lb");
oneRepMaxCase("tofixed_float_artifact", 1.005, 1, "kg");
oneRepMaxCase("decimal_load_two_decimals", 0.1, 3, "kg");
oneRepMaxCase("error_zero_load", 0, 5, "kg");
oneRepMaxCase("error_negative_load", -50, 5, "kg");
oneRepMaxCase("error_reps_zero", 100, 0, "kg");
oneRepMaxCase("error_reps_thirteen", 100, 13, "kg");
oneRepMaxCase("error_reps_fractional", 100, 2.5, "kg");

// ---------------------------------------------------------------------------
// heart_rate_zones: calculateHeartRateZones
// ---------------------------------------------------------------------------

function heartRateCase(name: string, maxHeartRate: number) {
  capture("heart_rate_zones", name, { maxHeartRate }, () => calculateHeartRateZones(maxHeartRate));
}

heartRateCase("measured_186", 186);
heartRateCase("lower_bound_80", 80);
heartRateCase("upper_bound_240", 240);
heartRateCase("half_up_rounding_161", 161);
heartRateCase("odd_ratio_rounding_187", 187);
heartRateCase("error_79", 79);
heartRateCase("error_241", 241);
heartRateCase("error_fractional_180_5", 180.5);

// ---------------------------------------------------------------------------
// training_metrics: calculateTrainingMetrics
// ---------------------------------------------------------------------------

function strengthSet(setIndex: number, overrides: Json = {}): Json {
  return { exerciseRaw: "Squat", setIndex, setType: "normal", weight: 100, reps: 5, primaryMuscles: ["quadriceps"], secondaryMuscles: [], ...overrides };
}

function strengthSession(id: string, source: string, startAt: string, endAt: string, durationMinutes: number, strengthSets: Json[], overrides: Json = {}) {
  return trainingSessionSchema.parse({ id, source, externalId: id, modality: "strength", name: id, startAt, endAt, durationMinutes, domains: ["strength"], strengthSets, ...overrides });
}

function enduranceSession(id: string, source: string, startAt: string, endAt: string, durationMinutes: number, endurance: Json, overrides: Json = {}) {
  return trainingSessionSchema.parse({ id, source, externalId: id, modality: "endurance", name: id, startAt, endAt, durationMinutes, domains: ["endurance"], endurance, ...overrides });
}

function metricsCase(name: string, sessions: unknown[]) {
  capture("training_metrics", name, { sessions }, () => calculateTrainingMetrics(sessions as never));
}

metricsCase("empty_sessions", []);

const strengthMixed = [
  strengthSession("s-mixed-1", "manual", "2026-09-07T08:00:00Z", "2026-09-07T09:00:00Z", 60, [
    strengthSet(0, { setType: "warmup", weight: 40, reps: 10, primaryMuscles: ["quadriceps"] }),
    strengthSet(1, { weight: 100, reps: 5, primaryMuscles: ["quadriceps"], secondaryMuscles: ["glutes"] }),
    strengthSet(2, { weight: null, reps: 5, primaryMuscles: ["quadriceps"], secondaryMuscles: ["glutes"] }),
    strengthSet(3, { weight: 80, reps: 8, primaryMuscles: ["quadriceps", "glutes"] }),
  ]),
  strengthSession("s-mixed-2", "hevy", "2026-09-08T18:00:00Z", "2026-09-08T19:30:00Z", 90, [
    strengthSet(0, { exerciseRaw: "Bench Press", weight: 60, reps: 12, rpe: 8.5, primaryMuscles: ["chest"], secondaryMuscles: ["triceps", "shoulders"] }),
    strengthSet(1, { exerciseRaw: "Bench Press", weight: 60, reps: 12, primaryMuscles: ["chest"], secondaryMuscles: ["triceps", "shoulders"] }),
  ]),
];
metricsCase("strength_mixed_sets", strengthMixed);

const strengthWarmupOnly = [
  strengthSession("s-warmup", "manual", "2026-09-07T08:00:00Z", "2026-09-07T08:20:00Z", 20, [
    strengthSet(0, { setType: "warmup", weight: 20, reps: 12 }),
    strengthSet(1, { setType: "warmup", weight: null, reps: null }),
  ]),
];
metricsCase("strength_warmup_only", strengthWarmupOnly);

const enduranceMixing = [
  enduranceSession("e-1", "intervals_icu", "2026-09-07T06:00:00Z", "2026-09-07T07:00:00Z", 60, { distanceMeters: 10000, heartRateZoneSeconds: { zone1: 600, zone2: 1200 } }),
  enduranceSession("e-2", "intervals_icu", "2026-09-08T06:00:00Z", "2026-09-08T06:40:00Z", 40, { distanceMeters: null, heartRateZoneSeconds: {} }),
  trainingSessionSchema.parse({
    id: "e-3", source: "manual", externalId: "e-3", modality: "recovery", name: "e-3", startAt: "2026-09-09T07:00:00Z", endAt: "2026-09-09T07:30:00Z",
    durationMinutes: 30, domains: ["recovery"], endurance: null,
  }),
];
metricsCase("endurance_mixing", enduranceMixing);

const domainFallback = [
  trainingSessionSchema.parse({
    id: "m-1", source: "manual", externalId: "m-1", modality: "mixed", name: "m-1", startAt: "2026-09-07T08:00:00Z", endAt: "2026-09-07T08:45:00Z",
    durationMinutes: 45, domains: [],
    strengthSets: [strengthSet(0, { weight: 50, reps: 10, primaryMuscles: ["quadriceps"] })],
    endurance: { distanceMeters: 5000, heartRateZoneSeconds: { zone2: 300 } },
  }),
];
metricsCase("mixed_domain_fallback", domainFallback);

// ---------------------------------------------------------------------------
// double_progression: evaluateDoubleProgression
// ---------------------------------------------------------------------------

function doubleProgressionCase(name: string, input: Json) {
  capture("double_progression", name, input, () => evaluateDoubleProgression(input as never));
}

doubleProgressionCase("increase_without_ceiling", { completedReps: [10, 10, 10], repMin: 8, repMax: 10, currentLoad: 60, loadIncrement: 2.5, unit: "kg" });
doubleProgressionCase("increase_with_satisfied_ceiling", { completedReps: [10, 10], repMin: 8, repMax: 10, currentLoad: 60, loadIncrement: 2.5, unit: "kg", rpeValues: [7, 8], rpeCeiling: 8 });
doubleProgressionCase("hold_when_ceiling_exceeded", { completedReps: [10, 10], repMin: 8, repMax: 10, currentLoad: 60, loadIncrement: 2.5, unit: "kg", rpeValues: [8.5, 7], rpeCeiling: 8 });
doubleProgressionCase("hold_missing_rpe_data", { completedReps: [10, 10], repMin: 8, repMax: 10, currentLoad: 60, loadIncrement: 2.5, unit: "kg", rpeCeiling: 8 });
doubleProgressionCase("hold_partial_rpe_length", { completedReps: [10, 10], repMin: 8, repMax: 10, currentLoad: 60, loadIncrement: 2.5, unit: "kg", rpeValues: [7], rpeCeiling: 8 });
doubleProgressionCase("review_below_floor", { completedReps: [10, 5, 10], repMin: 8, repMax: 10, currentLoad: 60, loadIncrement: 2.5, unit: "kg" });
doubleProgressionCase("review_beats_ceiling_hold", { completedReps: [5, 10], repMin: 8, repMax: 10, currentLoad: 60, loadIncrement: 2.5, unit: "kg", rpeValues: [9, 9], rpeCeiling: 8 });
doubleProgressionCase("hold_within_range", { completedReps: [8, 9], repMin: 8, repMax: 10, currentLoad: 60, loadIncrement: 2.5, unit: "lb" });
doubleProgressionCase("error_empty_completed_reps", { completedReps: [], repMin: 8, repMax: 10, currentLoad: 60, loadIncrement: 2.5, unit: "kg" });
doubleProgressionCase("error_rep_min_zero", { completedReps: [10], repMin: 0, repMax: 10, currentLoad: 60, loadIncrement: 2.5, unit: "kg" });
doubleProgressionCase("error_rep_max_below_min", { completedReps: [10], repMin: 8, repMax: 5, currentLoad: 60, loadIncrement: 2.5, unit: "kg" });

// ---------------------------------------------------------------------------
// rpe_autoregulation: evaluateRpeAutoregulation
// ---------------------------------------------------------------------------

function autoregulationCase(name: string, input: Json) {
  capture("rpe_autoregulation", name, input, () => evaluateRpeAutoregulation(input as never));
}

autoregulationCase("insufficient_data", { actualRpe: null, targetRpe: 8, load: 100, increment: 5, unit: "kg" });
autoregulationCase("increase_below_target", { actualRpe: 6, targetRpe: 8, load: 100, increment: 5, unit: "kg" });
autoregulationCase("decrease_above_target", { actualRpe: 9, targetRpe: 7, load: 100, increment: 5, unit: "kg" });
autoregulationCase("decrease_clamped_at_zero", { actualRpe: 10, targetRpe: 5, load: 2, increment: 5, unit: "kg" });
autoregulationCase("hold_on_target", { actualRpe: 8, targetRpe: 8, load: 100, increment: 5, unit: "kg" });
autoregulationCase("hold_within_half_point", { actualRpe: 8.5, targetRpe: 8, load: 100, increment: 2.5, unit: "lb" });
autoregulationCase("increase_at_zero_boundary", { actualRpe: 0, targetRpe: 1, load: 50, increment: 2.5, unit: "kg" });
autoregulationCase("error_actual_out_of_range", { actualRpe: 10.5, targetRpe: 8, load: 100, increment: 5, unit: "kg" });
autoregulationCase("error_target_out_of_range", { actualRpe: 6, targetRpe: 0.5, load: 100, increment: 5, unit: "kg" });

// ---------------------------------------------------------------------------
// stable_hash: stableHash
// ---------------------------------------------------------------------------

function hashCase(name: string, value: unknown) {
  capture("stable_hash", name, { value }, () => stableHash(value));
}

hashCase("nested_plan_snapshot", {
  planSchemaVersion: "7.0", title: "Base Block", revision: 3, effectiveStartDate: "2026-09-07",
  mesocycle: { durationWeeks: 4, schedule: { kind: "fixed_week", days: [0, 3] }, weeks: [{ weekNumber: 1, sessions: [{ id: "w1-mon", durationMinutes: 60 }] }] },
  target: null,
});
hashCase("key_case_ordering", { aB: 1, Ac: 2, a: 3, B: 4 });
hashCase("string_escapes", { text: "a\"b\\c\nd\te", control: "\u0001\u001f", json: "{}[]:" });
hashCase("unicode_values", { name: "Ångström 训练", note: "interval 🏃 done" });
hashCase("empty_containers", { object: {}, array: [], nested: [{}, []] });
hashCase("numbers_and_null", { int: 42, float: 119.58, negative: -3.5, zero: 0, flag: true, disabled: false, nothing: null });
hashCase("array_order_matters", { list: [3, 1, 2], nested: [[1], [2, 3]] });
hashCase("scalar_string", "hello");
hashCase("scalar_number", 2026.09);
hashCase("scalar_null", null);

// ---------------------------------------------------------------------------
// validate_plan: validatePlan
// ---------------------------------------------------------------------------

const pinnedNow = new Date("2026-09-17T10:30:00.000Z");

const fact = (value: unknown, source = "user_confirmed", confidence = 1, evidence = "golden fixture"): Json => ({ value, source, confidence, evidence, taxonomyVersion: TAXONOMY_VERSION });

const classification = (overrides: Json = {}): Json => ({
  primaryMovement: fact("squat"), primaryMuscles: fact(["quadriceps"]), secondaryMuscles: fact(["glutes"]),
  equipment: fact(["barbell"]), impact: fact("moderate"), laterality: fact("bilateral"), ...overrides,
});

const exercise = (id: string, overrides: Json = {}): Json => ({
  id, displayName: id, canonicalKey: null, classification: classification(),
  sets: 4, repsMin: 5, repsMax: 8, targetRpe: 8, restSeconds: 150, referenceLoad: 100, referenceLoadUnit: "kg", notes: "",
  ...overrides,
});

const strengthComponent = (id: string, exercises: unknown[]): Json => ({ id, name: "Strength", domain: fact("strength"), prescription: { kind: "strength", exercises } });
const durationOnlyComponent = (id: string, domain: unknown = fact("recovery")): Json => ({ id, name: "Recovery", domain, prescription: { kind: "duration_only", notes: "" } });
const enduranceComponent = (id: string, segments: unknown[]): Json => ({ id, name: "Endurance", domain: fact("endurance"), prescription: { kind: "endurance", segments } });

const planSession = (id: string, scheduledDate: string, components: unknown[], overrides: Json = {}): Json => ({
  id, scheduledDate, order: 0, name: `${id} session`, intent: "Golden fixture session", durationMinutes: 60, recoveryDemand: "normal", keySession: false, components, ...overrides,
});

function progressionsFor(weeks: unknown[]): unknown[] {
  const domains = [...new Set((weeks as Json[]).flatMap((week) => ((week.sessions ?? []) as Json[]).flatMap((session) => ((session.components ?? []) as Json[]).map((component) => (component.domain as Json).value))))];
  return domains
    .filter((domain): domain is string => typeof domain === "string")
    .map((domain) => ({ domain, phases: [{ id: `${domain}-base`, phaseType: "foundation", name: "Base", startWeek: 1, endWeek: weeks.length, focus: "Base", progression: [] }] }));
}

function mesocycleOf(weeks: unknown[], overrides: Json = {}): unknown {
  return mesocycleSchema.parse({ durationWeeks: weeks.length, schedule: { kind: "fixed_week", days: [0] }, domainProgressions: progressionsFor(weeks), weeks, adjustmentRules: [], ...overrides });
}

function sessionsFromSchedule(effectiveStartDate: string, durationWeeks: number, schedule: Json, makeComponents: () => unknown[]): unknown[] {
  const parsed = scheduleSchema.parse(schedule);
  const occurrences = expandSchedule({ effectiveStartDate, durationWeeks, schedule: parsed });
  return Array.from({ length: durationWeeks }, (_, index) => ({
    weekNumber: index + 1, focus: null,
    sessions: occurrences.filter((occurrence) => occurrence.weekNumber === index + 1)
      .map((occurrence, order) => planSession(`w${occurrence.weekNumber}-${occurrence.slotId}`, occurrence.scheduledDate, makeComponents(), { order })),
  }));
}

function planCase(name: string, profileRaw: Json, effectiveStartDate: string | undefined, mesocycle: unknown, mutate?: (value: Json) => Json) {
  const profile = athleteProfileSchema.parse(profileRaw);
  const resolved = mutate ? mutate(structuredClone(mesocycle) as Json) : mesocycle;
  const draft = effectiveStartDate === undefined ? { mesocycle: resolved } : { mesocycle: resolved, effectiveStartDate };
  capture("validate_plan", name, { profile, draft, now: pinnedNow.toISOString() }, () => validatePlan(profile, draft as never, pinnedNow));
}

const fixedProfile = (days: number[], overrides: Json = {}) => ({ maxSessionMinutes: 60, trainingRhythm: { kind: "fixed_week", days }, ...overrides });

planCase("empty_mesocycle", fixedProfile([0]), undefined, null);

const strengthWeek = mesocycleOf([
  { weekNumber: 1, focus: null, sessions: [
    planSession("mon-strength", "2026-09-07", [strengthComponent("mon-lower", [
      exercise("back-squat", { classification: classification({ primaryMovement: fact("squat"), primaryMuscles: fact(["quadriceps"]), secondaryMuscles: fact(["glutes"]) }) }),
      exercise("romanian-deadlift", { classification: classification({ primaryMovement: fact("hinge"), primaryMuscles: fact(["hamstrings"]), secondaryMuscles: fact(["glutes"]) }) }),
    ])]),
    planSession("fri-strength", "2026-09-11", [strengthComponent("fri-upper", [
      exercise("bench-press", { classification: classification({ primaryMovement: fact("horizontal_push"), primaryMuscles: fact(["chest"]), secondaryMuscles: fact(["triceps"]) }) }),
      exercise("barbell-row", { classification: classification({ primaryMovement: fact("horizontal_pull"), primaryMuscles: fact(["upper_back"]), secondaryMuscles: fact(["biceps"]) }) }),
    ])]),
  ] },
], { schedule: { kind: "fixed_week", days: [0, 4] } });
planCase("strength_week_all_pass", fixedProfile([0, 4]), "2026-09-07", strengthWeek);

planCase("duration_only_domain_missing", fixedProfile([0]), "2026-09-07", mesocycleOf([
  { weekNumber: 1, focus: null, sessions: [planSession("mon-recovery", "2026-09-07", [durationOnlyComponent("mon-flush", fact(null, "ai_inferred", 0.4))], { durationMinutes: 30 })] },
]));

planCase("constraint_failures", fixedProfile([0], { equipment: ["barbell", "bench"] }), "2026-09-07", mesocycleOf([
  { weekNumber: 1, focus: null, sessions: [planSession("mon-strength", "2026-09-07", [strengthComponent("mon-lower", [
    exercise("kettlebell-press", { classification: classification({ primaryMovement: fact("horizontal_push"), primaryMuscles: fact(["chest"]), equipment: fact(["kettlebell"]) }) }),
    exercise("ai-squat", { classification: classification({ primaryMovement: fact("squat", "ai_inferred", 0.5), primaryMuscles: fact(["quadriceps"], "ai_inferred", 0.5), equipment: fact(["barbell"], "ai_inferred", 0.5) }) }),
    exercise("ai-hinge", { classification: classification({ primaryMovement: fact("hinge", "ai_inferred", 0.95), primaryMuscles: fact(["hamstrings"], "ai_inferred", 0.95), equipment: fact(["barbell"], "ai_inferred", 0.95, "") }), sets: 3 }),
    exercise("ai-pull", { classification: classification({ primaryMovement: fact("vertical_pull", "ai_inferred", 0.95, "imported from ledger"), primaryMuscles: fact(["lats"], "ai_inferred", 0.95, "imported from ledger"), equipment: fact(["barbell"], "ai_inferred", 0.95, "imported from ledger") }), sets: 1 }),
  ])], { durationMinutes: 90 })] },
]));

planCase("zero_side_balance_pass", fixedProfile([0]), "2026-09-07", mesocycleOf([
  { weekNumber: 1, focus: null, sessions: [planSession("mon-strength", "2026-09-07", [strengthComponent("mon-lower", [exercise("back-squat", { sets: 2 })])])] },
]));

const enduranceSegments = [
  { type: "step", name: "warm up", role: "warm_up", heartRateZone: "Zone 1" },
  { type: "repeat", name: "main set", repetitions: 4, work: { type: "step", name: "work interval", role: "work", heartRateZone: "Zone 4" }, recovery: { type: "step", name: "recover", role: "recovery", heartRateZone: "Zone 1" } },
  { type: "step", name: "cool down", role: "cool_down", heartRateZone: "Zone 1" },
];
planCase("endurance_all_zoned", fixedProfile([0]), "2026-09-07", mesocycleOf([
  { weekNumber: 1, focus: null, sessions: [planSession("mon-endurance", "2026-09-07", [enduranceComponent("mon-run", enduranceSegments)])] },
]));

const enduranceSegmentsMissingZone = enduranceSegments.map((segment) => segment.type === "repeat"
  ? { ...segment, recovery: { type: "step", name: "recover jog", role: "recovery" } }
  : segment);
planCase("endurance_zone_missing", fixedProfile([0]), "2026-09-07", mesocycleOf([
  { weekNumber: 1, focus: null, sessions: [planSession("mon-endurance", "2026-09-07", [enduranceComponent("mon-run", enduranceSegmentsMissingZone)])] },
]));

const twoHighSessions = (days: number[], dates: string[]) => mesocycleOf([
  { weekNumber: 1, focus: null, sessions: dates.map((date, index) => planSession(`high-${index}`, date, [durationOnlyComponent(`flush-${index}`)], { durationMinutes: 40, recoveryDemand: "high" })) },
], { schedule: { kind: "fixed_week", days } });

planCase("explicit_recovery_fail", fixedProfile([0, 2], { explicitRecoveryDays: 3 }), "2026-09-07", twoHighSessions([0, 2], ["2026-09-07", "2026-09-09"]));
planCase("adjacent_high_demand_pass", fixedProfile([0, 2]), "2026-09-07", twoHighSessions([0, 2], ["2026-09-07", "2026-09-09"]));
planCase("adjacent_high_demand_fail", fixedProfile([0, 1]), "2026-09-07", twoHighSessions([0, 1], ["2026-09-07", "2026-09-08"]));

planCase("duplicate_component_and_exercise_ids", fixedProfile([0]), "2026-09-07", mesocycleOf([
  { weekNumber: 1, focus: null, sessions: [planSession("mon-strength", "2026-09-07", [
    strengthComponent("dup-component", [exercise("dup-exercise"), exercise("dup-exercise")]),
    durationOnlyComponent("dup-component"),
  ])] },
]));

planCase("flexible_rhythm_pass", { maxSessionMinutes: 60, trainingRhythm: { kind: "flexible_week", targetDaysPerWeek: 3, minDaysPerWeek: 2, maxDaysPerWeek: 4 } }, "2026-09-07",
  mesocycleOf(sessionsFromSchedule("2026-09-07", 2, { kind: "flexible_week", targetDaysPerWeek: 3, minDaysPerWeek: 2, maxDaysPerWeek: 4 }, () => [durationOnlyComponent("flush")]), {
    schedule: { kind: "flexible_week", targetDaysPerWeek: 3, minDaysPerWeek: 2, maxDaysPerWeek: 4 },
  }));

planCase("interval_rhythm_pass", { maxSessionMinutes: 60, trainingRhythm: { kind: "interval", intervalDays: 3 } }, "2026-09-07",
  mesocycleOf(sessionsFromSchedule("2026-09-07", 3, { kind: "interval", intervalDays: 3 }, () => [durationOnlyComponent("flush")]), {
    schedule: { kind: "interval", intervalDays: 3 },
  }));

planCase("rhythm_parameters_mismatch", fixedProfile([0]), "2026-09-07",
  mesocycleOf(sessionsFromSchedule("2026-09-07", 2, { kind: "flexible_week", targetDaysPerWeek: 3, minDaysPerWeek: 2, maxDaysPerWeek: 4 }, () => [durationOnlyComponent("flush")]), {
    schedule: { kind: "flexible_week", targetDaysPerWeek: 3, minDaysPerWeek: 2, maxDaysPerWeek: 4 },
  }));

// mutated: a parsed mesocycle gains a progression domain no session resolves.
planCase("domain_progression_mutated_fail", fixedProfile([0, 4]), "2026-09-07", strengthWeek, (value) => ({
  ...value,
  domainProgressions: [...(value.domainProgressions as unknown[]), { domain: "endurance", phases: [{ id: "endurance-base", phaseType: "foundation", name: "Base", startWeek: 1, endWeek: 1, focus: "Base", progression: [] }] }],
}));

// mutated: a strength component turns into a duration_only prescription.
planCase("duration_only_strength_mutated_fail", fixedProfile([0]), "2026-09-07", mesocycleOf([
  { weekNumber: 1, focus: null, sessions: [planSession("mon-strength", "2026-09-07", [strengthComponent("mon-lower", [exercise("back-squat")])])] },
]), (value) => {
  const weeks = value.weeks as Json[];
  const sessions = weeks[0]!.sessions as Json[];
  const components = sessions[0]!.components as Json[];
  components[0]!.prescription = { kind: "duration_only", notes: "mutated" };
  return value;
});

planCase("default_effective_start_date", fixedProfile([0]), undefined, mesocycleOf([
  { weekNumber: 1, focus: null, sessions: [planSession("mon-recovery", "2026-01-05", [durationOnlyComponent("mon-flush")], { durationMinutes: 30 })] },
]));

// ---------------------------------------------------------------------------
// write fixtures
// ---------------------------------------------------------------------------

rmSync(fixturesDir, { recursive: true, force: true });
mkdirSync(fixturesDir, { recursive: true });
for (const fixture of fixtures) {
  writeFileSync(join(fixturesDir, `${fixture.kind}.${fixture.name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
}

const counts = new Map<string, number>();
for (const fixture of fixtures) counts.set(fixture.kind, (counts.get(fixture.kind) ?? 0) + 1);
const errorCount = fixtures.filter((fixture) => "error" in fixture).length;
console.log(`==> Wrote ${fixtures.length} fixtures (${errorCount} error cases) to ${fixturesDir}`);
for (const [kind, count] of [...counts].sort()) console.log(`    ${kind}: ${count}`);
