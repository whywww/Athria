// Demo seed: a 4-week Current Plan alternating Strength and Endurance sessions.
// Skeleton follows scripts/seed-v7-development.ts and uses self-contained
// strength/endurance components without profile-specific assertions.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { AthriaApplication } from "../packages/application/src/index.ts";
import { expandSchedule } from "../packages/core/src/index.ts";
import { AthriaRepository } from "../packages/data/src/index.ts";
import { PLAN_SCHEMA_VERSION, TAXONOMY_VERSION, TEMPLATE_CATALOG_VERSION } from "../packages/schemas/src/index.ts";

const args = new Set(process.argv.slice(2));
const valueAfter = (flag: string) => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
const defaultDatabase = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? homedir(), "AppData", "Local"), "Athria", "data", "athria.sqlite3");
const databasePath = resolve(valueAfter("--database") ?? process.env.ATHRIA_DATABASE_PATH ?? defaultDatabase);
const replace = args.has("--replace");
if (!existsSync(databasePath)) throw new Error(`Athria database not found: ${databasePath}`);

const stamp = new Date().toISOString().replaceAll(":", "-");
const backupDirectory = join(dirname(databasePath), "backups", `pre-demo-seed-${stamp}`);
mkdirSync(backupDirectory, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${databasePath}${suffix}`)) copyFileSync(`${databasePath}${suffix}`, join(backupDirectory, `${basename(databasePath)}${suffix}`));

const repository = new AthriaRepository(databasePath);
const application = new AthriaApplication(repository);
const profile = application.getProfile();
const existingPlan = repository.getCurrentPlan();
if (existingPlan && !replace) {
  repository.close();
  throw new Error(`A Current Plan already exists (revision ${existingPlan.revision}: "${existingPlan.title}"). Re-run with --replace to overwrite planning data.`);
}

// ---- plan configuration ----------------------------------------------------
const durationWeeks = 4;
const addDays = (date: string, days: number) => { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
const today = new Date();
const effectiveStartDate = addDays(today.toISOString().slice(0, 10), -((today.getUTCDay() + 6) % 7)); // Monday of the current week
const occurrences = expandSchedule({ effectiveStartDate, durationWeeks, schedule: profile.trainingRhythm });

// ---- self-contained exercise selection (respects profile equipment) --------
const fact = <T,>(value: T) => ({ value, source: "structured_source" as const, confidence: 1, evidence: "Athria demo seed structured exercise definition", taxonomyVersion: TAXONOMY_VERSION });
const builtinRef = (id: string) => ({ source: "builtin" as const, id, catalogVersion: TEMPLATE_CATALOG_VERSION });
const exerciseDefinitions = [
  { key: "goblet_squat", name: "Goblet Squat", movement: "squat", primaryMuscles: ["quadriceps", "glutes"], secondaryMuscles: ["core"], equipment: ["dumbbell", "kettlebell"], unilateral: false },
  { key: "romanian_deadlift", name: "Romanian Deadlift", movement: "hinge", primaryMuscles: ["hamstrings", "glutes"], secondaryMuscles: ["back"], equipment: ["barbell", "dumbbell"], unilateral: false },
  { key: "split_squat", name: "Split Squat", movement: "squat", primaryMuscles: ["quadriceps", "glutes"], secondaryMuscles: ["core"], equipment: ["bodyweight", "dumbbell"], unilateral: true },
  { key: "hip_thrust", name: "Hip Thrust", movement: "hinge", primaryMuscles: ["glutes"], secondaryMuscles: ["hamstrings"], equipment: ["barbell", "bodyweight"], unilateral: false },
  { key: "dumbbell_bench_press", name: "Dumbbell Bench Press", movement: "horizontal_push", primaryMuscles: ["chest"], secondaryMuscles: ["triceps", "shoulders"], equipment: ["dumbbell"], unilateral: false },
  { key: "seated_row", name: "Seated Row", movement: "horizontal_pull", primaryMuscles: ["back"], secondaryMuscles: ["biceps"], equipment: ["cable", "machine"], unilateral: false },
  { key: "dumbbell_shoulder_press", name: "Dumbbell Shoulder Press", movement: "vertical_push", primaryMuscles: ["shoulders"], secondaryMuscles: ["triceps"], equipment: ["dumbbell"], unilateral: false },
  { key: "lat_pulldown", name: "Lat Pulldown", movement: "vertical_pull", primaryMuscles: ["back"], secondaryMuscles: ["biceps"], equipment: ["cable", "machine"], unilateral: false },
] as const;
const available = exerciseDefinitions.filter((definition) => definition.equipment.some((item) => profile.equipment.includes(item as never)));
const pick = (keys: string[]) => keys.map((key) => available.find((definition) => definition.key === key)).filter((definition) => definition !== undefined);
const lowerBodyPool = pick(["goblet_squat", "romanian_deadlift", "split_squat", "hip_thrust"]);
const upperBodyPool = pick(["dumbbell_bench_press", "seated_row", "dumbbell_shoulder_press", "lat_pulldown"]);

const exerciseFor = (week: number, definition: (typeof exerciseDefinitions)[number], sets: number, targetRpe: number) => ({
  id: `w${week}-${definition.key}`, displayName: definition.name, canonicalKey: definition.key,
  classification: {
    primaryMovement: fact(definition.movement),
    primaryMuscles: fact(definition.primaryMuscles),
    secondaryMuscles: fact(definition.secondaryMuscles),
    // Pick one concrete equipment variant owned by the profile.
    equipment: fact([definition.equipment.find((item) => profile.equipment.includes(item as never))!]),
    impact: fact("low"),
    laterality: fact(definition.unilateral ? "unilateral" : "bilateral"),
  },
  sets, repsMin: 8, repsMax: definition.key === "dumbbell_bench_press" ? 12 : 10, targetRpe, restSeconds: definition.movement === "squat" || definition.movement === "hinge" ? 120 : 90,
  referenceLoad: null, referenceLoadUnit: null,
  notes: "Choose a technically comfortable load; stop with roughly 2-3 reps in reserve.",
});

// ---- session builders ------------------------------------------------------
const maxMinutes = profile.maxSessionMinutes;
let strengthCount = 0;
let enduranceCount = 0;

const strengthSession = (scheduledDate: string, week: number) => {
  strengthCount += 1;
  const lower = strengthCount % 2 === 1;
  const pool = lower ? lowerBodyPool : upperBodyPool;
  if (pool.length < 2) throw new Error(`Not enough ${lower ? "lower" : "upper"}-body exercises available for profile equipment [${profile.equipment.join(", ")}].`);
  const deload = week === durationWeeks;
  const durationMinutes = Math.min(maxMinutes, lower ? 50 : 45);
  const targetRpe = deload ? 6 : 7;
  const rotation = Math.floor((strengthCount - 1) / 2) % Math.max(1, pool.length - 1);
  const selected = [pool[rotation]!, pool[(rotation + 1) % pool.length]!, pool[(rotation + 2) % pool.length] ?? pool[rotation]!]
    .filter((definition, index, list) => list.indexOf(definition) === index)
    .map((definition, index) => exerciseFor(week, definition, index < 2 ? 3 : 2, targetRpe));
  return {
    id: `demo-w${week}-strength-${strengthCount}`, scheduledDate, order: 0,
    templateRef: builtinRef(lower ? "builtin.lower-strength-a" : "builtin.upper-strength-a"),
    name: lower ? "Lower Body Strength" : "Upper Body Strength",
    intent: lower ? "Build lower-body strength through squat and hinge patterns." : "Build balanced upper-body pushing and pulling strength.",
    durationMinutes, recoveryDemand: "normal" as const, keySession: false,
    components: [{ id: `demo-w${week}-strength-${strengthCount}-main`, name: "Strength main block", domain: fact("strength" as const), prescription: { kind: "strength" as const, exercises: selected } }],
    progressionNote: deload ? "Deload: lighter loads, crisp repetitions, no grinding." : "Add load only when every set stays near the target RPE.",
    schedulingRationale: "Alternates lower and upper emphasis across the training rhythm.",
    legacySnapshot: false,
  };
};

const enduranceSession = (scheduledDate: string, week: number) => {
  enduranceCount += 1;
  const id = `demo-w${week}-endurance-${enduranceCount}`;
  const kind = (["easy", "intervals", "long"] as const)[(enduranceCount - 1) % 3]!;
  const deload = week === durationWeeks;
  const step = (name: string, role: "warm_up" | "steady" | "work" | "recovery" | "cool_down", durationSeconds: number, heartRateZone: string, extra: Record<string, unknown> = {}) => ({ type: "step" as const, name, role, durationSeconds, heartRateZone, ...extra });
  const session = (name: string, intent: string, durationMinutes: number, recoveryDemand: "low" | "normal" | "high", keySession: boolean, templateId: string, segments: unknown[], progressionNote: string, rationale: string) => ({
    id, scheduledDate, order: 0, templateRef: builtinRef(templateId), name, intent, durationMinutes, recoveryDemand, keySession,
    components: [{ id: `${id}-main`, name, domain: fact("endurance" as const), prescription: { kind: "endurance" as const, segments } }],
    progressionNote, schedulingRationale: rationale, legacySnapshot: false,
  });
  if (kind === "intervals" && maxMinutes >= 30) {
    const durationMinutes = Math.min(maxMinutes, deload ? 40 : 50);
    const repetitions = deload ? 4 : Math.max(3, Math.min(8, Math.floor((durationMinutes - 20) / 5)));
    return session("Aerobic Intervals", "Improve aerobic power with controlled hard repeats.", durationMinutes, "high", true, "builtin.intervals", [
      step("Easy warm-up", "warm_up", 600, "Zone 1–2"),
      { type: "repeat" as const, name: "Controlled hard repeats", repetitions, work: step("Controlled hard running", "work", 180, deload ? "Zone 3–4" : "Zone 4"), recovery: step("Easy jog recovery", "recovery", 120, "Zone 1–2") },
      step("Easy cooldown", "cool_down", 600, "Zone 1–2"),
    ], `Complete ${repetitions} controlled repetitions; do not sprint.`, "Primary quality endurance session of the week.");
  }
  if (kind === "long" && maxMinutes >= 40) {
    const durationMinutes = Math.min(maxMinutes, deload ? 45 : 60 + 5 * Math.min(week - 1, 2));
    return session("Long Easy Session", "Develop aerobic endurance and durable time on feet.", durationMinutes, "normal", true, "builtin.long-run", [
      step("Easy warm-up", "warm_up", 300, "Zone 1–2"),
      step("Long easy effort", "steady", (durationMinutes - 10) * 60, "Zone 2", { talkTest: "Comfortable full sentences" }),
      step("Easy cooldown", "cool_down", 300, "Zone 1–2"),
    ], deload ? "Shorter final-week long session to absorb training." : `Planned duration: ${durationMinutes} minutes at conversational pace.`, "Longest aerobic effort of the week.");
  }
  const durationMinutes = Math.min(maxMinutes, deload ? 30 : 40);
  return session("Easy Aerobic Session", "Build aerobic consistency without accumulating excessive fatigue.", durationMinutes, "low", false, "builtin.easy-run", [
    step("Easy warm-up", "warm_up", 300, "Zone 1–2"),
    step("Continuous easy effort", "steady", (durationMinutes - 10) * 60, "Zone 2", { talkTest: "Comfortable full sentences" }),
    step("Easy cooldown", "cool_down", 300, "Zone 1–2"),
  ], "Keep this genuinely easy; breathing should stay comfortable.", "Low-intensity aerobic base work.");
};

const sessions = occurrences.map((occurrence) => occurrence.ordinal % 2 === 0 ? strengthSession(occurrence.scheduledDate, occurrence.weekNumber) : enduranceSession(occurrence.scheduledDate, occurrence.weekNumber));
if (!strengthCount || !enduranceCount) { repository.close(); throw new Error(`Training rhythm only produced ${occurrences.length} occurrence(s); the demo plan needs at least one strength and one endurance session.`); }
const weeks = Array.from({ length: durationWeeks }, (_, offset) => {
  const weekNumber = offset + 1;
  return { weekNumber, focus: weekNumber === durationWeeks ? "Deload and consolidate" : weekNumber === 1 ? "Establish technique and rhythm" : "Progress volume and quality", sessions: sessions.filter((session) => occurrences.find((occurrence) => occurrence.scheduledDate === session.scheduledDate && occurrence.weekNumber === weekNumber)) };
});

// ---- write -----------------------------------------------------------------
try {
  const result = repository.sqlite.transaction(() => {
    const expectedRevision = repository.getCurrentPlan()?.revision ?? 0;
    return application.saveCurrentPlan({
      planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: "local-user",
      title: "Strength & Endurance Demo Plan",
      summary: `A ${durationWeeks}-week demonstration plan alternating strength and endurance sessions across the athlete's training rhythm, generated by scripts/seed-demo-strength-endurance.ts.`,
      effectiveStartDate,
      mesocycle: {
        durationWeeks, schedule: profile.trainingRhythm,
        domainProgressions: [
          { domain: "strength" as const, phases: [
            { id: "strength-foundation", phaseType: "foundation" as const, name: "Foundation", startWeek: 1, endWeek: 2, focus: "Establish repeatable technique and volume", progression: ["Add load only when every set stays near the target RPE"] },
            { id: "strength-progression", phaseType: "progression" as const, name: "Build", startWeek: 3, endWeek: 3, focus: "Progress working capacity", progression: ["Progress repetitions before load"] },
            { id: "strength-deload", phaseType: "deload" as const, name: "Deload", startWeek: 4, endWeek: 4, focus: "Reduce load and absorb training", progression: ["Keep every repetition crisp"] },
          ] },
          { domain: "endurance" as const, phases: [
            { id: "endurance-base", phaseType: "foundation" as const, name: "Base", startWeek: 1, endWeek: 2, focus: "Build aerobic consistency", progression: ["Extend easy duration gradually while pace stays conversational"] },
            { id: "endurance-build", phaseType: "progression" as const, name: "Build", startWeek: 3, endWeek: 3, focus: "Develop aerobic power", progression: ["Add controlled interval repetitions before speed"] },
            { id: "endurance-recovery", phaseType: "recovery" as const, name: "Recovery", startWeek: 4, endWeek: 4, focus: "Absorb the training block", progression: ["Reduce total duration while retaining rhythm"] },
          ] },
        ],
        weeks,
        adjustmentRules: [
          { trigger: "Pain changes normal movement", action: "Stop the affected session and seek appropriate professional assessment", rationale: "Do not train through altered movement." },
          { trigger: "Unusually poor recovery for two consecutive days", action: "Replace the next high-intensity session with an easy aerobic session", rationale: "Preserve consistency while reducing acute stress." },
        ],
      },
      target: {
        primaryGoal: { label: "Demonstrate combined strength and endurance planning" },
        supporting: [{ label: "Build general strength" }, { label: "Build aerobic endurance" }],
        coordinationStrategy: "Strength and endurance sessions alternate across the training rhythm; interval days stay separated from the longest aerobic effort.",
      },
      sourceAgent: "demo-seed", model: null, skillVersion: "0.6.0",
      inputSnapshotHash: application.snapshotHash(),
      expectedRevision,
    });
  })();
  const blockers = result.validation.results.filter((item) => item.enforcement === "blocker");
  console.log(JSON.stringify({
    databasePath, backupDirectory, replacedExistingPlan: Boolean(existingPlan),
    profile: { trainingRhythm: profile.trainingRhythm, maxSessionMinutes: profile.maxSessionMinutes, equipment: profile.equipment, injuries: profile.injuries.length, constraintNotes: profile.constraintNotes.length },
    plan: { title: "Strength & Endurance Demo Plan", revision: result.plan.revision, effectiveStartDate, planEnd: addDays(effectiveStartDate, durationWeeks * 7 - 1), durationWeeks, totalSessions: sessions.length, strengthSessions: strengthCount, enduranceSessions: enduranceCount },
    validation: { valid: result.validation.valid, blockerChecks: blockers.length, blockersPassed: blockers.filter((item) => item.status === "pass").length, failedOrUnknownBlockers: blockers.filter((item) => item.status !== "pass").map((item) => ({ reasonCode: item.reasonCode, status: item.status, evidence: item.evidence })), blockingDataGaps: result.validation.dataGaps.filter((gap) => gap.blocking).length },
    impact: result.impact,
  }, null, 2));
} finally {
  repository.close();
}
