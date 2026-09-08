import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { AthriaApplication, AthriaError } from "@athria/application";
import { AthriaRepository } from "@athria/data";
import { XUNJI_SYNC_DAYS, XunjiAuthenticationError, fetchIntervals, fetchXunjiTraining } from "@athria/integrations";
import { createMcpHttpHandler, serveMcpStdio } from "@athria/mcp";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { applyCors, corsPreflightResponse, isAllowedOrigin } from "./http-security";

const VERSION = "0.2.0";
function platformDataRoot(): string {
  if (process.platform === "win32") return process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? homedir(), "AppData", "Local");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  throw new Error(`Unsupported Athria service host: ${process.platform}/${process.arch}`);
}

const localAppData = platformDataRoot();
const dataDir = resolve(process.env.ATHRIA_DATA_DIR ?? join(localAppData, "Athria", "data"));
mkdirSync(dataDir, { recursive: true });
for (const name of ["imports", "backups", "logs", "exports"]) mkdirSync(join(dataDir, name), { recursive: true });
const databasePath = process.env.ATHRIA_DATABASE_PATH ?? join(dataDir, "athria.sqlite3");
const repository = new AthriaRepository(databasePath);
const application = new AthriaApplication(repository);

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try { return await request.json() as Record<string, unknown>; }
  catch { throw new AthriaError("INVALID_JSON", "Request body must be valid JSON."); }
}

async function backupDatabase(): Promise<string> {
  repository.checkpoint();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(dataDir, "backups", `athria-backup-${stamp}.zip`);
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify({ athriaVersion: VERSION, createdAt: new Date().toISOString(), secretsIncluded: false }, null, 2)),
  };
  if (statSync(databasePath, { throwIfNoEntry: false })?.isFile()) files["athria.sqlite3"] = new Uint8Array(await Bun.file(databasePath).arrayBuffer());
  const importsRoot = join(dataDir, "imports");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files[`imports/${relative(importsRoot, path).replaceAll("\\", "/")}`] = readFileSync(path);
    }
  };
  visit(importsRoot);
  const archive = zipSync(files, { level: 6 });
  await Bun.write(target, archive);
  return target;
}

async function restoreBackup(path: string, target: string): Promise<void> {
  const resolvedTarget = resolve(target);
  mkdirSync(resolvedTarget, { recursive: true });
  if (readdirSync(resolvedTarget).length) throw new AthriaError("RESTORE_TARGET_NOT_EMPTY", "Restore target must be empty.");
  const entries = unzipSync(new Uint8Array(await Bun.file(path).arrayBuffer()));
  for (const [name, content] of Object.entries(entries)) {
    const destination = resolve(resolvedTarget, name);
    if (destination !== resolvedTarget && !destination.startsWith(`${resolvedTarget}${sep}`)) throw new AthriaError("INVALID_BACKUP", "Backup contains an unsafe path.");
    if (basename(name) === "manifest.json") JSON.parse(strFromU8(content));
    mkdirSync(dirname(destination), { recursive: true });
    await Bun.write(destination, content);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command === "mcp") {
    await serveMcpStdio(application);
    return;
  }
  if (command === "doctor") {
    const executable = process.platform === "win32" ? "Athria.exe" : "Athria.app/Contents/MacOS/Athria";
    console.log(JSON.stringify({ status: "ok", version: VERSION, dataDir, database: repository.counts(), mcpStdioCommand: `${executable} mcp` }, null, 2));
    repository.close();
    return;
  }
  if (command === "backup") {
    console.log(await backupDatabase());
    repository.close();
    return;
  }
  if (command === "restore") {
    const source = process.argv[3]; const target = process.argv[4];
    if (!source || !target) throw new Error("Usage: athria-service restore BACKUP_PATH EMPTY_TARGET_DIR");
    await restoreBackup(source, target);
    repository.close();
    return;
  }
  if (command !== "serve") throw new Error(`Unknown command: ${command}`);

  const token = process.env.ATHRIA_SESSION_TOKEN ?? crypto.randomUUID().replaceAll("-", "");
  const mcpToken = process.env.ATHRIA_MCP_TOKEN ?? token;
  const requestedPort = Number(process.env.ATHRIA_PORT ?? "0");
  const mcp = await createMcpHttpHandler(application);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: requestedPort,
    async fetch(request) {
      const url = new URL(request.url);
      const host = request.headers.get("host")?.split(":")[0];
      if (!host || !["127.0.0.1", "localhost"].includes(host)) return json({ error: { code: "INVALID_HOST", message: "Host is not allowed." } }, 403);
      const origin = request.headers.get("origin");
      if (origin && !isAllowedOrigin(origin)) return json({ error: { code: "INVALID_ORIGIN", message: "Origin is not allowed." } }, 403);
      if (origin && request.method === "OPTIONS") return corsPreflightResponse(origin);
      const routeRequest = async (): Promise<Response> => {
        if (url.pathname === "/health") return json({ status: "ok", version: VERSION });
        const expected = url.pathname.startsWith("/mcp") ? mcpToken : token;
        if (request.headers.get("authorization") !== `Bearer ${expected}`) return json({ error: { code: "UNAUTHORIZED", message: "A valid local bearer token is required." } }, 401);
        try {
        if (url.pathname === "/mcp") return mcp(request);
        if (url.pathname === "/api/profile" && request.method === "GET") return json(application.getProfile());
        if (url.pathname === "/api/profile" && request.method === "PUT") return json(application.saveProfile(await body(request)));
        if (url.pathname === "/api/preferences" && request.method === "GET") return json(application.getPreference());
        if (url.pathname === "/api/preferences" && request.method === "PUT") return json(application.savePreference(await body(request)));
        if (url.pathname === "/api/profile-proposals" && request.method === "GET") return json(repository.listProfileUpdateProposals());
        const approveProfile = url.pathname.match(/^\/api\/profile-proposals\/([^/]+)\/approve$/);
        if (approveProfile && request.method === "POST") { const value = await body(request); return json(application.approveProfileUpdate(decodeURIComponent(approveProfile[1]!), String(value.approvedBy ?? "local-user"))); }
        if (url.pathname === "/api/state" && request.method === "GET") return json(application.getTrainingState());
        if (url.pathname === "/api/summary" && request.method === "GET") return json(application.getTrainingSummary(Number(url.searchParams.get("days") ?? "7")));
        if (url.pathname === "/api/sessions" && request.method === "GET") return json(application.listSessions(Number(url.searchParams.get("days") ?? "90")));
        if (url.pathname === "/api/exercises" && request.method === "GET") return json(repository.listExercises());
        if (url.pathname === "/api/templates" && request.method === "GET") return json(application.listTemplates());
        if (url.pathname === "/api/templates" && request.method === "POST") return json(application.createTemplate(await body(request)), 201);
        const template = url.pathname.match(/^\/api\/templates\/([^/]+)$/);
        if (template && request.method === "GET") return json(application.getTemplate(decodeURIComponent(template[1]!)));
        if (template && request.method === "PUT") return json(application.updateTemplate(await body(request)));
        if (template && request.method === "DELETE") { const value = await body(request); return json(application.deleteTemplate(decodeURIComponent(template[1]!), Number(value.expectedRevision))); }
        const templateImpact = url.pathname.match(/^\/api\/templates\/([^/]+)\/impact$/);
        if (templateImpact && request.method === "POST") return json(application.templateImpact(decodeURIComponent(templateImpact[1]!)));
        if (url.pathname === "/api/plans/current" && request.method === "GET") return json(application.getCurrentPlan());
        if (url.pathname === "/api/plans/current" && request.method === "PUT") return json(application.saveCurrentPlan(await body(request)));
        if (url.pathname === "/api/plans/current/validate" && request.method === "POST") return json(application.validateCurrentPlan(await body(request)));
        if (url.pathname === "/api/plans/next-training-day" && request.method === "GET") {
          const onOrAfterDate = url.searchParams.get("onOrAfterDate");
          return json(application.getNextTrainingDay({ ...(onOrAfterDate ? { onOrAfterDate } : {}) }));
        }
        if (url.pathname === "/api/planned-sessions/validate" && request.method === "POST") return json(application.validateNextTrainingDaySessions(await body(request)));
        if (url.pathname === "/api/planned-sessions" && request.method === "POST") return json(application.saveNextTrainingDaySessions(await body(request)), 201);
        if (url.pathname === "/api/imports/hevy/status" && request.method === "GET") return json(application.getHevyImportStatus());
        if (url.pathname === "/api/imports/hevy/preview" && request.method === "POST") { const value = await body(request); const fileName = String(value.fileName ?? "hevy.csv"); if (!fileName.toLowerCase().endsWith(".csv")) throw new AthriaError("INVALID_IMPORT_TYPE", "Hevy imports must be CSV files."); const content = Uint8Array.fromBase64(String(value.contentBase64)); if (content.byteLength > 20 * 1024 * 1024) throw new AthriaError("IMPORT_TOO_LARGE", "Hevy CSV files must not exceed 20 MB.", 413); return json(application.previewHevy(content, fileName)); }
        if (url.pathname === "/api/imports/hevy/commit" && request.method === "POST") return json(application.commitHevy(String((await body(request)).previewToken)));
        if (url.pathname === "/api/connections/intervals/test" && request.method === "POST") { const value = await body(request); const payload = await fetchIntervals(String(value.apiKey), String(value.athleteId ?? "0")); if (typeof payload.wellness === "string") throw new AthriaError("INTERVALS_CONNECTION_FAILED", payload.wellness); return json({ status: "connected", athleteId: String(value.athleteId ?? "0") }); }
        if (url.pathname === "/api/connections/intervals/sync" && request.method === "POST") { const value = await body(request); return json(application.commitIntervals(await fetchIntervals(String(value.apiKey), String(value.athleteId ?? "0")))); }
        if (url.pathname === "/api/connections/xunji/status" && request.method === "GET") return json(application.getXunjiSyncStatus());
        if (url.pathname === "/api/connections/xunji/sync" && request.method === "POST") {
          const value = await body(request);
          const apiKey = typeof value.apiKey === "string" ? value.apiKey : "";
          if (!apiKey.startsWith("xjllm_")) throw new AthriaError("XUNJI_KEY_INVALID", "The imported Xunji Skill does not contain a valid API key.");
          const days = Math.max(1, Math.min(365, Math.trunc(Number(value.days ?? XUNJI_SYNC_DAYS))));
          const attemptedAt = new Date().toISOString();
          const previous = application.getXunjiSyncStatus();
          if (!value.replaceCredential && previous && Date.now() - new Date(previous.lastAttemptAt).getTime() < 30_000) throw new AthriaError("XUNJI_SYNC_THROTTLED", "Wait 30 seconds before syncing Xunji again.", 429);
          const end = attemptedAt.slice(0, 10);
          const startDate = new Date(); startDate.setDate(startDate.getDate() - days + 1);
          const rangeStart = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;
          try { return json(application.commitXunji(await fetchXunjiTraining(apiKey, days), attemptedAt)); }
          catch (error) {
            const code = error instanceof XunjiAuthenticationError ? "XUNJI_AUTHENTICATION_FAILED" : "XUNJI_SYNC_FAILED";
            const message = error instanceof XunjiAuthenticationError ? "Xunji rejected this API key. Export a new Skill from Xunji and try again." : "Xunji sync failed. Try again later.";
            application.recordXunjiFailure({ attemptedAt, rangeStart, rangeEnd: end, code, message });
            throw new AthriaError(code, message, error instanceof XunjiAuthenticationError ? 401 : 502);
          }
        }
        if (url.pathname === "/api/system/doctor" && request.method === "GET") return json({ status: "ok", version: VERSION, dataDir, database: repository.counts() });
        if (url.pathname === "/api/system/backup" && request.method === "POST") return json({ path: await backupDatabase() });
        if (url.pathname === "/api/system/restore" && request.method === "POST") { const value = await body(request); await restoreBackup(String(value.path), String(value.target)); return json({ status: "restored", target: value.target }); }
        return json({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404);
        } catch (error) {
          const athriaError = error instanceof AthriaError ? error : new AthriaError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error), 500);
          return json({ error: { code: athriaError.code, message: athriaError.message } }, athriaError.status);
        }
      };
      return applyCors(await routeRequest(), origin);
    },
  });
  console.error(`ATHRIA_READY:${JSON.stringify({ port: server.port, token, mcpPath: "/mcp" })}`);
  let parentWatch: ReturnType<typeof setInterval> | undefined;
  const shutdown = () => {
    if (parentWatch) clearInterval(parentWatch);
    server.stop(true);
    repository.close();
    process.exit(0);
  };
  const parentPid = Number(process.env.ATHRIA_PARENT_PID ?? "0");
  if (Number.isSafeInteger(parentPid) && parentPid > 0) {
    parentWatch = setInterval(() => {
      try { process.kill(parentPid, 0); }
      catch { shutdown(); }
    }, 1_000);
  }
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}

main().catch((error) => { console.error(error); repository.close(); process.exit(1); });
