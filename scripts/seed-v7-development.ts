import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { AthriaApplication, builtinSessionTemplates } from "../packages/application/src/index.ts";
import { expandSchedule } from "../packages/core/src/index.ts";
import { AthriaRepository } from "../packages/data/src/index.ts";
import { PLAN_SCHEMA_VERSION, TAXONOMY_VERSION, type SessionTemplate } from "../packages/schemas/src/index.ts";

const args = new Set(process.argv.slice(2));
const valueAfter = (flag: string) => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
const defaultDatabase = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? homedir(), "AppData", "Local"), "Athria", "data", "athria.sqlite3");
const databasePath = resolve(valueAfter("--database") ?? process.env.ATHRIA_DATABASE_PATH ?? defaultDatabase);
const replace = args.has("--replace");
if (!existsSync(databasePath)) throw new Error(`Athria database not found: ${databasePath}`);

const stamp = new Date().toISOString().replaceAll(":", "-");
const backupDirectory = join(dirname(databasePath), "backups", `pre-v7-seed-${stamp}`);
mkdirSync(backupDirectory, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${databasePath}${suffix}`)) copyFileSync(`${databasePath}${suffix}`, join(backupDirectory, `${basename(databasePath)}${suffix}`));

const repository = new AthriaRepository(databasePath);
const application = new AthriaApplication(repository);
const profile = application.getProfile();
const existingDebug = repository.listTemplates().filter((item) => item.name.startsWith("Debug · "));
if ((existingDebug.length || repository.getCurrentPlan()) && !replace) {
  repository.close();
  throw new Error("Development seed already exists or a Current Plan is present. Re-run with --replace to overwrite planning data.");
}

const debugTemplates = builtinSessionTemplates.map((item) => {
  const { origin: _origin, catalogVersion: _catalogVersion, ...template } = structuredClone(item);
  return { ...template, id: `debug.${item.id.slice("builtin.".length)}`, name: `Debug · ${item.name}` } as SessionTemplate;
});
const fact = <T>(value: T) => ({ value, source: "user_confirmed" as const, confidence: 1, evidence: "Development seed", taxonomyVersion: TAXONOMY_VERSION });
const addDays = (date: string, days: number) => { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
const today = new Date();
const day = (today.getUTCDay() + 6) % 7;
const effectiveStartDate = addDays(today.toISOString().slice(0, 10), -day);
const occurrences = expandSchedule({ effectiveStartDate, durationWeeks: 2, schedule: profile.trainingRhythm });
const sessionFor = (scheduledDate: string, index: number) => {
  const kind = (["endurance", "sport_skill", "recovery", "mind_body"] as const)[index % 4]!;
  const template = debugTemplates.find((item) => item.domain === kind)!;
  const durationMinutes = Math.min(profile.maxSessionMinutes, kind === "recovery" || kind === "mind_body" ? 25 : 45);
  const prescription = kind === "endurance"
    ? { kind, segments: [{ type: "step" as const, name: "Easy aerobic work", role: "steady" as const, durationSeconds: durationMinutes * 60, rpe: "3" }] }
    : kind === "sport_skill"
      ? { kind, sessionType: "practice" as const, blocks: [{ name: "Technical practice", role: "technical" as const, durationMinutes, intensity: "moderate" }] }
      : { kind, blocks: [{ name: kind === "recovery" ? "Mobility reset" : "Breathing practice", durationMinutes, instructions: "Comfortable, controlled practice." }] };
  return { id: `debug-session-${index + 1}`, scheduledDate, order: 0, templateRef: { source: "user" as const, id: template.id, revision: 1 }, name: `Debug ${kind.replace("_", " ")}`, intent: "Executable development sample", durationMinutes, recoveryDemand: kind === "sport_skill" ? "high" as const : "low" as const, keySession: kind === "sport_skill", components: [{ id: `component-${index + 1}`, name: "Main block", domain: fact(kind), prescription }], progressionNote: null, schedulingRationale: "Placed by Profile training rhythm", legacySnapshot: false };
};

try {
  repository.sqlite.transaction(() => {
    for (const item of existingDebug) repository.deleteTemplate(item.id, item.revision);
    for (const template of debugTemplates) application.createTemplate(template);
    const sessions = occurrences.map((item, index) => sessionFor(item.scheduledDate, index));
    const activeDomains = [...new Set(sessions.flatMap((session) => session.components.map((component) => component.domain.value)))];
    const plan = { planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: "local-user", title: "Debug · Two-week Multisport Plan", summary: "Development-only v7 plan with complete prescriptions.", effectiveStartDate, mesocycle: { durationWeeks: 2, schedule: profile.trainingRhythm, domainProgressions: activeDomains.map((domain) => ({ domain, phases: [{ id: `${domain}-debug-base`, phaseType: "foundation" as const, name: "Foundation", startWeek: 1, endWeek: 2, focus: `Establish ${domain.replace("_", " ")} consistency`, progression: ["Repeat the prescribed work with stable quality"] }] })), weeks: [1, 2].map((weekNumber) => ({ weekNumber, focus: `Debug week ${weekNumber}`, sessions: sessions.filter((session) => session.scheduledDate >= addDays(effectiveStartDate, (weekNumber - 1) * 7) && session.scheduledDate < addDays(effectiveStartDate, weekNumber * 7)) })), adjustmentRules: [] }, sourceAgent: "development-seed", model: null, skillVersion: "0.6.0", inputSnapshotHash: application.snapshotHash(), expectedRevision: repository.getCurrentPlan()?.revision ?? 0 };
    application.saveCurrentPlan(plan);
  })();
  console.log(JSON.stringify({ databasePath, backupDirectory, templates: debugTemplates.length, sessions: occurrences.length }, null, 2));
} finally {
  repository.close();
}
