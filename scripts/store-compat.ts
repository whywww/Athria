// Cross-language store compatibility harness for the Rust migration (Phase 3).
//
//   bun run scripts/store-compat.ts --dump-schema
//     Regenerates crates/athria-store/src/schema/schema-v24.sql from a database
//     freshly created by the TypeScript AthriaRepository. Run this whenever the
//     TypeScript schema changes, then review the schema diff.
//
//   bun run scripts/store-compat.ts
//     Bidirectional fixture run:
//       1. TypeScript seeds a fresh database with deterministic entities.
//       2. cargo test opens that database with the Rust SqliteStore, asserts it
//          reads what TypeScript wrote, then writes deterministic updates.
//       3. TypeScript reopens the database and asserts the Rust-written values.
//       4. A TypeScript-created and a Rust-created database must produce the
//          same normalized schema manifest and migration rows, and TypeScript
//          must open the Rust-created database without migrating it further.
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AthriaRepository } from "../packages/data/src/index.ts";
import {
  PLAN_SCHEMA_VERSION,
  TAXONOMY_VERSION,
  currentPlanSchema,
  defaultProfile,
  trainingSessionSchema,
} from "../packages/schemas/src/index.ts";

const root = resolve(import.meta.dir, "..");
const schemaPath = join(root, "crates", "athria-store", "src", "schema", "schema-v24.sql");
const mode = process.argv.includes("--dump-schema") ? "dump" : "verify";
const keepWorkdir = process.argv.includes("--keep");

function assert(label: string, condition: boolean, detail = "") {
  if (!condition) throw new Error(`FAILED: ${label}${detail ? ` — ${detail}` : ""}`);
}

function assertEqual(label: string, actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`FAILED: ${label}\n  expected: ${right}\n  actual:   ${left}`);
}

type SchemaManifest = {
  schema: Array<{ type: string; name: string; sql: string }>;
  migrations: number[];
  counts: Record<string, number>;
};

// Deliberately excludes sqlite_* bookkeeping and auto-indexes (sql IS NULL):
// only objects the application itself creates are compared.
function manifest(path: string): SchemaManifest {
  const sqlite = new Database(path, { readonly: true });
  try {
    const rows = sqlite.query("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{ type: string; name: string; sql: string }>;
    const tables = sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    const counts: Record<string, number> = {};
    for (const { name } of tables) counts[name] = Number((sqlite.query(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number }).count);
    const migrations = (sqlite.query("SELECT version FROM athria_migrations ORDER BY version").all() as Array<{ version: number }>).map((row) => row.version);
    return { schema: rows.map(({ type, name, sql }) => ({ type, name, sql: sql.replace(/\s+/g, " ").trim() })), migrations, counts };
  } finally {
    sqlite.close();
  }
}

function diffSchemas(left: SchemaManifest, right: SchemaManifest, leftLabel: string, rightLabel: string) {
  const key = (item: { type: string; name: string }) => `${item.type}:${item.name}`;
  const leftMap = new Map(left.schema.map((item) => [key(item), item.sql]));
  const rightMap = new Map(right.schema.map((item) => [key(item), item.sql]));
  for (const name of leftMap.keys()) if (!rightMap.has(name)) throw new Error(`FAILED: ${rightLabel} is missing ${name} that exists in ${leftLabel}`);
  for (const name of rightMap.keys()) if (!leftMap.has(name)) throw new Error(`FAILED: ${rightLabel} has extra ${name} that ${leftLabel} does not create`);
  for (const [name, sql] of leftMap) if (rightMap.get(name) !== sql) throw new Error(`FAILED: ${name} differs\n  ${leftLabel}: ${sql}\n  ${rightLabel}: ${rightMap.get(name)}`);
  assertEqual(`${leftLabel} vs ${rightLabel} migration rows`, right.migrations, left.migrations);
  assertEqual(`${leftLabel} vs ${rightLabel} fresh row counts`, right.counts, left.counts);
}

function dumpDdl(path: string) {
  const sqlite = new Database(path, { readonly: true });
  try {
    const rows = sqlite.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name").all() as Array<{ sql: string }>;
    return `${rows.map(({ sql }) => `${sql.trim()};`).join("\n\n")}\n`;
  } finally {
    sqlite.close();
  }
}

function createFreshDatabase(path: string) {
  const repository = new AthriaRepository(path);
  repository.checkpoint();
  repository.close();
}

function removeWorkdir(path: string) {
  try {
    // bun:sqlite releases Windows file handles slightly after close(); retry
    // briefly instead of leaving the fixture directory behind.
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    console.log(`!! Could not remove workdir ${path} (file in use); it can be deleted manually.`);
  }
}

if (mode === "dump") {
  const directory = mkdtempSync(join(tmpdir(), "athria-schema-dump-"));
  const path = join(directory, "fresh.sqlite3");
  createFreshDatabase(path);
  writeFileSync(schemaPath, dumpDdl(path));
  removeWorkdir(directory);
  console.log(`==> Wrote ${schemaPath}`);
  process.exit(0);
}

const workdir = mkdtempSync(join(tmpdir(), "athria-store-compat-"));
const compatPath = join(workdir, "compat.sqlite3");
const tsFreshPath = join(workdir, "ts-fresh.sqlite3");
const rustFreshPath = join(workdir, "rust-fresh.sqlite3");
const expectedPath = join(workdir, "expected.json");

function seedCompatDatabase() {
  const repository = new AthriaRepository(compatPath);

  const profile = repository.saveProfile({
    ...defaultProfile(),
    preferredName: "Compat Athlete",
    gender: "non_binary",
    heightCm: 178.5,
    birthDate: "1994-03-05",
    unitSystem: "metric",
  });

  const wellnessDay = "2026-09-10";
  repository.saveWellness({
    ownerId: "local-user",
    day: wellnessDay,
    fields: { restingHeartRateBpm: { value: 52, source: "user", updatedAt: "2026-09-10T06:00:00Z" } },
    updatedAt: "2026-09-10T06:00:00Z",
  });

  const session = trainingSessionSchema.parse({
    id: "compat-session", ownerId: "local-user", source: "manual", externalId: "compat-session", modality: "strength", sport: null, name: "Compat Squat Session",
    startAt: "2026-08-20T09:00:00Z", endAt: "2026-08-20T10:00:00Z", durationMinutes: 60,
  });
  repository.upsertSessions([session]);

  repository.createTemplate({
    id: "compat-template", name: "Compat Tempo Run", intent: "Build aerobic capacity.", domain: "endurance",
    nodes: [{ role: "steady", variables: ["duration"], optionalVariables: ["distance"] }],
  });

  const fact = { value: "recovery", source: "user_confirmed", confidence: 1, evidence: "fixture", taxonomyVersion: TAXONOMY_VERSION };
  const plan = currentPlanSchema.parse({
    planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: "local-user", title: "Compat Plan", summary: "", effectiveStartDate: "2026-09-07",
    mesocycle: {
      durationWeeks: 1, schedule: { kind: "fixed_week", days: [0] },
      domainProgressions: [{ domain: "recovery", phases: [{ id: "base", phaseType: "recovery", name: "Base", startWeek: 1, endWeek: 1, focus: "Recover", progression: [] }] }],
      weeks: [{ weekNumber: 1, focus: null, sessions: [{
        id: "weekly", scheduledDate: "2026-09-07", order: 0, templateRef: { source: "builtin", id: "builtin.easy-run", catalogVersion: "2.0" },
        name: "Recovery", intent: "Recover", durationMinutes: 20, recoveryDemand: "low", keySession: false,
        components: [{ id: "recovery", name: "Recovery", domain: fact, prescription: { kind: "recovery", blocks: [{ name: "Easy", durationMinutes: 20 }] } }],
        progressionNote: null, schedulingRationale: null, legacySnapshot: false,
      }] }],
      adjustmentRules: [],
    },
    revision: 1, sourceAgent: null, model: null, skillVersion: null, inputSnapshotHash: null, updatedAt: "2026-09-02T00:00:00Z",
  });
  repository.saveCurrentPlan(plan, 0);

  repository.saveConnectionSyncState({
    source: "intervals_icu", lastAttemptAt: "2026-09-15T06:00:00Z", lastSuccessAt: "2026-09-15T06:00:00Z",
    rangeStart: "2026-08-01", rangeEnd: "2026-09-15", status: "success", data: { workouts: 12 },
  });

  const templateRow = repository.sqlite.query("SELECT data FROM session_templates WHERE id='compat-template'").get() as { data: string };
  const expected = {
    vaultUuid: repository.getVault().databaseUuid,
    profile: { preferredName: profile.preferredName, gender: profile.gender, heightCm: profile.heightCm, birthDate: profile.birthDate, unitSystem: profile.unitSystem, timezone: profile.timezone },
    wellness: { day: wellnessDay, restingHeartRateBpm: 52 },
    session: { id: "compat-session", source: "manual", externalId: "compat-session", startAt: "2026-08-20T09:00:00Z", modality: "strength", name: "Compat Squat Session" },
    sessionSource: { source: "manual", externalId: "compat-session", localDate: "2026-08-20" },
    template: { id: "compat-template", name: "Compat Tempo Run", revision: 1, origin: "user" },
    templateStoredData: JSON.parse(templateRow.data) as unknown,
    plan: { revision: 1, title: "Compat Plan", sessionId: "weekly", scheduledDate: "2026-09-07", sessionName: "Recovery" },
    sync: { source: "intervals_icu", status: "success", rangeEnd: "2026-09-15", workouts: 12 },
    rustWrites: {
      preferredName: "Rust Compat Athlete",
      wellnessRecord: { ownerId: "local-user", day: "2026-09-12", fields: { restingHeartRateBpm: { value: 47, source: "user", updatedAt: "2026-09-12T07:00:00Z" } }, updatedAt: "2026-09-12T07:00:00Z" },
      template: { id: "rust-compat-template", name: "Rust Compat Template", intent: "Written by the Rust store.", domain: "endurance", nodes: [{ role: "steady", variables: ["duration"], optionalVariables: ["distance"] }] },
      templateV2: { id: "rust-compat-template", name: "Rust Compat Template v2", intent: "Written by the Rust store.", domain: "endurance", nodes: [{ role: "steady", variables: ["duration"], optionalVariables: ["distance"] }] },
      planSessionNameSuffix: " (Rust)",
      planUpdatedAt: "2026-09-16T08:00:00.000Z",
      syncState: { ownerId: "local-user", source: "intervals_icu", lastAttemptAt: "2026-09-16T06:00:00Z", lastSuccessAt: "2026-09-15T06:00:00Z", rangeStart: "2026-08-01", rangeEnd: "2026-09-16", status: "partial", data: { workouts: 13, rust: true } },
    },
  };
  repository.checkpoint();
  repository.close();
  writeFileSync(expectedPath, `${JSON.stringify(expected, null, 2)}\n`);
  return expected;
}

function verifyRustWrites(expected: ReturnType<typeof seedCompatDatabase>) {
  const repository = new AthriaRepository(compatPath);
  const { rustWrites } = expected;

  const profile = repository.getProfile();
  assertEqual("profile.preferredName after Rust write", profile.preferredName, rustWrites.preferredName);
  assertEqual("profile.heightCm survived Rust write", profile.heightCm, expected.profile.heightCm);
  assertEqual("profile.birthDate survived Rust write", profile.birthDate, expected.profile.birthDate);

  const wellness = repository.getWellness("local-user", rustWrites.wellnessRecord.day);
  assert( "wellness record written by Rust is readable", Boolean(wellness));
  assertEqual("wellness field value written by Rust", wellness?.fields.restingHeartRateBpm?.value, 47);

  const template = repository.getTemplate(rustWrites.templateV2.id);
  assert("template written by Rust exists", Boolean(template));
  assertEqual("template revision after Rust update", template?.revision, 2);
  assertEqual("template name after Rust update", template?.name, rustWrites.templateV2.name);
  assertEqual("template origin", template?.origin, "user");

  const rustTemplateRow = repository.sqlite.query("SELECT data FROM session_templates WHERE id = 'rust-compat-template'").get() as { data: string } | null;
  assert("Rust-written template row exists in the table", Boolean(rustTemplateRow));
  const rustTemplateData = JSON.parse(rustTemplateRow?.data ?? "{}") as Record<string, unknown>;
  assertEqual("Rust template row stores the template without its id", Object.keys(rustTemplateData).sort(), ["domain", "intent", "name", "nodes"]);
  assertEqual("Rust template row name", rustTemplateData.name, rustWrites.templateV2.name);
  assertEqual("Rust template row nodes", rustTemplateData.nodes, rustWrites.templateV2.nodes);

  const plan = repository.getCurrentPlan();
  assert("plan exists after Rust write", Boolean(plan));
  assertEqual("plan revision after Rust write", plan?.revision, expected.plan.revision + 1);
  assertEqual("plan session name after Rust write", plan?.mesocycle.weeks[0]?.sessions[0]?.name, `${expected.plan.sessionName}${rustWrites.planSessionNameSuffix}`);
  assertEqual("plan updatedAt after Rust write", plan?.updatedAt, rustWrites.planUpdatedAt);

  const planned = repository.listCurrentPlannedSessions();
  assertEqual("planned sessions derived from Rust-written plan", planned.map((item) => item.name), [`${expected.plan.sessionName}${rustWrites.planSessionNameSuffix}`]);

  const sync = repository.getConnectionSyncState(rustWrites.syncState.source);
  assertEqual("sync state status after Rust write", sync?.status, "partial");
  assertEqual("sync state rangeEnd after Rust write", sync?.rangeEnd, rustWrites.syncState.rangeEnd);
  assertEqual("sync state data after Rust write", sync?.data, rustWrites.syncState.data);

  const sessions = repository.listSessions();
  assertEqual("training sessions untouched by Rust", sessions.map((item) => item.id), [expected.session.id]);
  assertEqual("training session source local date", repository.sqlite.query("SELECT local_date FROM training_session_sources WHERE external_id='compat-session'").get(), { local_date: expected.sessionSource.localDate });

  repository.checkpoint();
  repository.close();
}

function verifyRustCreatedDatabase() {
  const before = manifest(rustFreshPath);
  const repository = new AthriaRepository(rustFreshPath);
  const profile = repository.getProfile();
  assertEqual("TypeScript reads default profile from Rust-created database", profile.preferredName, defaultProfile().preferredName);
  assert(repository.getVault().databaseUuid.length > 0, true);
  assertEqual("Rust-created database has no current plan", repository.getCurrentPlan(), null);
  assertEqual("Rust-created database has no templates", repository.listTemplates().length, 0);
  assertEqual("Rust-created database has no sessions", repository.listSessions().length, 0);
  assertEqual("Rust-created database counts", repository.counts(), Object.fromEntries(Object.keys(repository.counts()).map((name) => [name, 0])));
  repository.checkpoint();
  repository.close();
  const after = manifest(rustFreshPath);
  assertEqual("TypeScript did not add migration rows to the Rust-created database", after.migrations, before.migrations);
  assertEqual("TypeScript did not change the Rust-created schema", after.schema, before.schema);
}

console.log(`==> Workdir: ${workdir}`);
console.log("==> Seeding TypeScript compatibility database");
const expected = seedCompatDatabase();
console.log("==> Creating TypeScript fresh database for schema comparison");
createFreshDatabase(tsFreshPath);

console.log("==> Running Rust store tests against the compatibility database");
const cargo = Bun.spawnSync({
  cmd: ["cargo", "test", "-p", "athria-store", "--", "--test-threads=1", "--nocapture"],
  cwd: root,
  env: {
    ...process.env,
    ATHRIA_COMPAT_DB: compatPath,
    ATHRIA_COMPAT_EXPECTED: expectedPath,
    ATHRIA_COMPAT_FRESH_RUST: rustFreshPath,
  },
  stdout: "inherit",
  stderr: "inherit",
});
if (cargo.exitCode !== 0) throw new Error(`FAILED: cargo test -p athria-store exited with ${cargo.exitCode}`);

if (!existsSync(rustFreshPath)) throw new Error(`FAILED: Rust did not create ${rustFreshPath}`);

console.log("==> Comparing fresh database schemas");
diffSchemas(manifest(tsFreshPath), manifest(rustFreshPath), "TypeScript fresh database", "Rust fresh database");

console.log("==> Reopening the compatibility database with TypeScript");
verifyRustWrites(expected);

console.log("==> Opening the Rust-created database with TypeScript");
verifyRustCreatedDatabase();

if (!keepWorkdir) removeWorkdir(workdir);
console.log("==> PASS: TypeScript <-> Rust store compatibility verified");
