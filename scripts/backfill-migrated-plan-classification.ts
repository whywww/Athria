// One-time data fix for plans imported by the legacy -> Schema v3 migration.
//
// migrateExercise() leaves custom (non-catalog) strength exercises honestly empty:
// equipment = { value: [], source: "migration" }. The v0.2.0 rules engine reports those
// as blocking EXERCISE_EQUIPMENT = unknown, so the migrated draft can never be approved.
// This script backfills a trusted ai_inferred classification (confidence >= AI_HARD_CONFIDENCE,
// real evidence) for the known set of migrated exercises and marks the draft reviewed
// (migration = null). It never invents data for exercises outside the table below.
//
// Safety: dry-run by default (prints the diff and the recomputed validation). Pass --write
// to persist. Idempotent: only touches strength exercises whose equipment fact is still
// empty AND migration-sourced. The write is a surgical UPDATE of plan_drafts.data only;
// validation is intentionally not persisted (the service recomputes it on read).
//
// Close the desktop app before running --write so SQLite is not locked.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import * as z from "zod";
import { validatePlan } from "../packages/core/src/index";
import { AthriaRepository } from "../packages/data/src/index";
import {
  TAXONOMY_VERSION,
  equipmentTypeSchema,
  movementPatternSchema,
  muscleGroupSchema,
  planDraftSchema,
  type PlanDraft,
} from "../packages/schemas/src/index";

type Movement = z.infer<typeof movementPatternSchema>;
type Muscle = z.infer<typeof muscleGroupSchema>;
type Equipment = z.infer<typeof equipmentTypeSchema>;

const CONFIDENCE = 0.92;

// Every equipment value stays within the athlete profile's available list
// [bodyweight, cable, machine, dumbbell] so EXERCISE_EQUIPMENT resolves to pass.
const CLASSIFICATIONS: Record<string, { movement: Movement; primaryMuscles: Muscle[]; secondaryMuscles: Muscle[]; equipment: Equipment[] }> = {
  "assisted-pullup": { movement: "vertical_pull", primaryMuscles: ["lats", "back"], secondaryMuscles: ["biceps"], equipment: ["machine"] },
  "half-bent-lateral-raise": { movement: "abduction", primaryMuscles: ["shoulders"], secondaryMuscles: ["upper_back"], equipment: ["dumbbell"] },
  "machine-chest-press": { movement: "horizontal_push", primaryMuscles: ["chest"], secondaryMuscles: ["triceps", "shoulders"], equipment: ["machine"] },
  "db-row": { movement: "horizontal_pull", primaryMuscles: ["back", "upper_back"], secondaryMuscles: ["biceps"], equipment: ["dumbbell"] },
  "plank-or-crunch": { movement: "anti_rotation", primaryMuscles: ["core"], secondaryMuscles: [], equipment: ["bodyweight"] },
  "pullup-skill": { movement: "vertical_pull", primaryMuscles: ["lats", "back"], secondaryMuscles: ["biceps"], equipment: ["bodyweight"] },
  "incline-pushup": { movement: "horizontal_push", primaryMuscles: ["chest"], secondaryMuscles: ["triceps", "shoulders"], equipment: ["bodyweight"] },
  "face-pull": { movement: "horizontal_pull", primaryMuscles: ["shoulders", "upper_back"], secondaryMuscles: ["biceps"], equipment: ["cable"] },
};

const aiFact = <T>(value: T, evidence: string) => ({ value, source: "ai_inferred" as const, confidence: CONFIDENCE, evidence, taxonomyVersion: TAXONOMY_VERSION });
const blockersOf = (draft: PlanDraft, profile: ReturnType<AthriaRepository["getProfile"]>, catalog: ReturnType<AthriaRepository["listExercises"]>) => {
  const validation = validatePlan(profile, draft, catalog, new Date());
  return { valid: validation.valid, blockers: validation.results.filter((item) => item.enforcement === "blocker" && (item.status === "fail" || item.status === "unknown")) };
};

const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Local");
const dataDir = resolve(process.env.ATHRIA_DATA_DIR ?? join(localAppData, "Athria", "data"));
const databasePath = process.env.ATHRIA_DATABASE_PATH ?? join(dataDir, "athria.sqlite3");
const write = process.argv.includes("--write");

if (!existsSync(databasePath)) throw new Error(`Athria database not found at ${databasePath}. Set ATHRIA_DATABASE_PATH if it lives elsewhere.`);

console.log(`Athria DB: ${databasePath}`);
console.log(`Mode: ${write ? "WRITE (persisting changes)" : "DRY-RUN (no writes; pass --write to persist)"}`);
console.log("Reminder: close the desktop app before --write so SQLite is not locked.\n");

const repository = new AthriaRepository(databasePath);
try {
  const profile = repository.getProfile("local-user");
  const catalog = repository.listExercises();
  const drafts = repository.listDrafts("local-user");
  console.log(`Profile equipment: [${profile.equipment.join(", ")}]`);
  console.log(`Found ${drafts.length} draft(s).\n`);

  let totalBackfilled = 0;
  let skippedDrafts = 0;

  for (const { draft } of drafts) {
    const modified: PlanDraft = structuredClone(draft);
    if (!modified.mesocycle) continue;
    const lines: string[] = [];
    const draftUnmatched: string[] = [];
    for (const template of modified.mesocycle.sessionTemplates) {
      for (const component of template.components) {
        if (component.prescription.kind !== "strength") continue;
        for (const exercise of component.prescription.exercises) {
          const equipment = exercise.classification.equipment;
          if (equipment.source !== "migration" || equipment.value.length > 0) continue;
          const entry = CLASSIFICATIONS[exercise.id];
          if (!entry) { draftUnmatched.push(`${exercise.id} ("${exercise.displayName}")`); continue; }
          const name = exercise.displayName;
          exercise.classification.primaryMovement = aiFact(entry.movement, `Migration review of "${name}": ${entry.movement.replace(/_/g, " ")} pattern`);
          exercise.classification.primaryMuscles = aiFact(entry.primaryMuscles, `Migration review of "${name}": primary muscles ${entry.primaryMuscles.join(", ")}`);
          exercise.classification.secondaryMuscles = aiFact(entry.secondaryMuscles, entry.secondaryMuscles.length ? `Migration review of "${name}": secondary muscles ${entry.secondaryMuscles.join(", ")}` : `Migration review of "${name}": no distinct secondary muscles`);
          exercise.classification.equipment = aiFact(entry.equipment, `Migration review of "${name}": requires ${entry.equipment.join(", ")}`);
          lines.push(`    [${template.id}] ${exercise.id} "${name}": equipment [] -> [${entry.equipment.join(", ")}]; movement null -> ${entry.movement}; primary [] -> [${entry.primaryMuscles.join(", ")}]; secondary [] -> [${entry.secondaryMuscles.join(", ")}]`);
        }
      }
    }
    if (!lines.length && !draftUnmatched.length) continue;

    // Skip any draft we cannot fully classify: a partial backfill would clear its migration
    // review flag while blockers remain, leaving it marked "reviewed" yet still unapprovable.
    if (draftUnmatched.length) {
      skippedDrafts += 1;
      console.log(`Draft ${draft.id} "${draft.title}": SKIPPED (${draftUnmatched.length} exercise(s) not in the classification table; left untouched)`);
      for (const item of draftUnmatched) console.log(`    - ${item}`);
      console.log("");
      continue;
    }

    const before = blockersOf(draft, profile, catalog);
    const migrationBefore = modified.migration;
    modified.migration = null;
    const parsed = planDraftSchema.parse(modified);
    const after = blockersOf(parsed, profile, catalog);
    totalBackfilled += lines.length;

    console.log(`Draft ${parsed.id} "${parsed.title}"`);
    for (const line of lines) console.log(line);
    if (migrationBefore) console.log(`    migration: reviewRequired=${migrationBefore.reviewRequired} -> null (reviewed)`);
    console.log(`    before: valid=${before.valid}, blockers=${before.blockers.length}${before.blockers.length ? ` (${before.blockers.map((item) => item.reasonCode).join(", ")})` : ""}`);
    console.log(`    after:  valid=${after.valid}, blockers=${after.blockers.length}${after.blockers.length ? ` (${after.blockers.map((item) => item.reasonCode).join(", ")})` : ""}`);

    if (write) {
      repository.sqlite.query("UPDATE plan_drafts SET data = ? WHERE id = ? AND owner_id = ?").run(JSON.stringify(parsed), parsed.id, parsed.ownerId);
      console.log("    -> UPDATED plan_drafts.data");
    }
    console.log("");
  }

  console.log(`Summary: ${totalBackfilled} exercise(s) ${write ? "backfilled" : "would be backfilled"}; ${skippedDrafts} draft(s) skipped as not fully classifiable.`);
  if (!write && totalBackfilled > 0) console.log("Re-run with --write to persist.");
  if (write) repository.checkpoint();
} finally {
  repository.close();
}
