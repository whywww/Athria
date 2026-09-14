import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AthriaApplication, AthriaError } from "@athria/application";
import { AthriaRepository } from "@athria/data";
import { XUNJI_SYNC_DAYS, XunjiAuthenticationError, fetchIntervals, fetchXunjiTraining, syncDateWindow } from "@athria/integrations";
import { createMcpHttpHandler, serveMcpStdio } from "@athria/mcp";
import { applyCors, corsPreflightResponse, isAllowedOrigin } from "./http-security";
import { createBackup, prepareRestore, previewBackup } from "./backup";

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

const backupDatabase = () => createBackup(repository, databasePath, dataDir, VERSION);

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
    const source = process.argv[3];
    if (!source) throw new Error("Usage: athria-service restore BACKUP_PATH");
    console.log(JSON.stringify(await prepareRestore(source, repository, databasePath, dataDir, VERSION), null, 2));
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
        if (url.pathname === "/api/personal-information" && request.method === "GET") return json(application.getPersonalInformation());
        if (url.pathname === "/api/personal-information" && request.method === "PUT") return json(application.savePersonalInformation(await body(request)));
        if (url.pathname === "/api/state" && request.method === "GET") return json(application.getTrainingState());
        if (url.pathname === "/api/summary" && request.method === "GET") return json(application.getTrainingSummary(Number(url.searchParams.get("days") ?? "7"), url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined));
        if (url.pathname === "/api/sessions" && request.method === "GET") return json(application.listSessions(Number(url.searchParams.get("days") ?? "90")));
        if (url.pathname === "/api/training-sessions" && request.method === "POST") return json(application.recordTrainingSession(await body(request)), 201);
        const trainingSessionPlanMatch = url.pathname.match(/^\/api\/training-sessions\/([^/]+)\/plan-match$/);
        if (trainingSessionPlanMatch && request.method === "PATCH") return json(application.setTrainingSessionPlanMatch(decodeURIComponent(trainingSessionPlanMatch[1]!), await body(request)));
        const trainingSessionAutoMatch = url.pathname.match(/^\/api\/training-sessions\/([^/]+)\/automatic-match$/);
        if (trainingSessionAutoMatch && request.method === "POST") return json(application.clearTrainingSessionPlanExclusion(decodeURIComponent(trainingSessionAutoMatch[1]!), await body(request)));
        const trainingSessionType = url.pathname.match(/^\/api\/training-sessions\/([^/]+)\/type$/);
        if (trainingSessionType && request.method === "PATCH") return json(application.updateTrainingSessionType(decodeURIComponent(trainingSessionType[1]!), await body(request)));
        const manualTrainingSession = url.pathname.match(/^\/api\/training-sessions\/([^/]+)\/manual$/);
        if (manualTrainingSession && request.method === "PATCH") return json(application.updateManualTrainingSession(decodeURIComponent(manualTrainingSession[1]!), await body(request)));
        if (manualTrainingSession && request.method === "DELETE") return json(application.deleteManualTrainingSession(decodeURIComponent(manualTrainingSession[1]!), await body(request)));
        const trainingSession = url.pathname.match(/^\/api\/training-sessions\/([^/]+)$/);
        if (trainingSession && request.method === "PUT") return json(application.recordTrainingSession({ ...(await body(request)), id: decodeURIComponent(trainingSession[1]!) }));
        if (trainingSession && request.method === "DELETE") return json(application.deleteTrainingSession(decodeURIComponent(trainingSession[1]!), await body(request)));
        if (url.pathname === "/api/wellness" && request.method === "GET") return json(application.listWellness(Number(url.searchParams.get("days") ?? "42")));
        const wellness = url.pathname.match(/^\/api\/wellness\/(\d{4}-\d{2}-\d{2})$/);
        if (wellness && request.method === "GET") return json(application.getWellnessDay(wellness[1]!));
        if (wellness && request.method === "PATCH") return json(application.updateWellness(wellness[1]!, await body(request)));
        if (url.pathname === "/api/training-taxonomy" && request.method === "GET") return json(application.getTrainingTaxonomy());
        if (url.pathname === "/api/templates" && request.method === "GET") return json(application.listTemplates());
        if (url.pathname === "/api/templates" && request.method === "POST") return json(application.createTemplate(await body(request)), 201);
        const template = url.pathname.match(/^\/api\/templates\/([^/]+)$/);
        if (template && request.method === "GET") return json(application.getTemplate(decodeURIComponent(template[1]!)));
        if (template && request.method === "PUT") return json(application.updateTemplate(await body(request)));
        if (template && request.method === "DELETE") { const value = await body(request); return json(application.deleteTemplate(decodeURIComponent(template[1]!), Number(value.expectedRevision))); }
        if (url.pathname === "/api/plans/current" && request.method === "GET") return json(application.getCurrentPlan());
        if (url.pathname === "/api/plans/current" && request.method === "PUT") return json(application.saveCurrentPlan(await body(request)));
        if (url.pathname === "/api/plans/current/validate" && request.method === "POST") return json(application.validateCurrentPlan(await body(request)));
        if (url.pathname === "/api/plans/next-training-day" && request.method === "GET") {
          const onOrAfterDate = url.searchParams.get("onOrAfterDate");
          return json(application.getNextTrainingDay({ ...(onOrAfterDate ? { onOrAfterDate } : {}) }));
        }
        if (url.pathname === "/api/plans/calendar" && request.method === "GET") {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          return json(application.getCalendar({ ...(from ? { from } : {}), ...(to ? { to } : {}) }));
        }
        if (url.pathname === "/api/planned-sessions/validate" && request.method === "POST") return json(application.validateNextTrainingDaySessions(await body(request)));
        if (url.pathname === "/api/planned-sessions" && request.method === "POST") return json(application.saveNextTrainingDaySessions(await body(request)), 201);
        const plannedSession = url.pathname.match(/^\/api\/planned-sessions\/([^/]+)$/);
        if (plannedSession && request.method === "PATCH") return json(application.updatePlannedSession(decodeURIComponent(plannedSession[1]!), await body(request)));
        if (url.pathname === "/api/imports/hevy/status" && request.method === "GET") return json(application.getHevyImportStatus());
        if (url.pathname === "/api/imports/hevy/preview" && request.method === "POST") { const value = await body(request); const fileName = String(value.fileName ?? "hevy.csv"); if (!fileName.toLowerCase().endsWith(".csv")) throw new AthriaError("INVALID_IMPORT_TYPE", "Hevy imports must be CSV files."); const content = Uint8Array.fromBase64(String(value.contentBase64)); if (content.byteLength > 20 * 1024 * 1024) throw new AthriaError("IMPORT_TOO_LARGE", "Hevy CSV files must not exceed 20 MB.", 413); return json(application.previewHevy(content, fileName)); }
        if (url.pathname === "/api/imports/hevy/commit" && request.method === "POST") return json(application.commitHevy(String((await body(request)).previewToken)));
        if (url.pathname === "/api/connections/intervals/test" && request.method === "POST") { const value = await body(request); const payload = await fetchIntervals(String(value.apiKey), String(value.athleteId ?? "0")); if (typeof payload.wellness === "string") throw new AthriaError("INTERVALS_CONNECTION_FAILED", payload.wellness); return json({ status: "connected", athleteId: String(value.athleteId ?? "0") }); }
        if (url.pathname === "/api/connections/intervals/status" && request.method === "GET") return json(application.getIntervalsSyncStatus());
        if (url.pathname === "/api/connections/intervals/sync" && request.method === "POST") {
          const value = await body(request);
          const today = new Date();
          const attemptedAt = today.toISOString();
          const previous = application.getIntervalsSyncStatus();
          const window = syncDateWindow(previous?.lastSuccessAt ?? null, value.range ?? value.days, today);
          const payload = await fetchIntervals(String(value.apiKey), String(value.athleteId ?? "0"), { today, activitiesOldest: window.rangeStart, wellnessOldest: window.rangeStart });
          return json(application.commitIntervals(payload, { attemptedAt, rangeStart: window.rangeStart, rangeEnd: window.rangeEnd }));
        }
        if (url.pathname === "/api/connections/xunji/status" && request.method === "GET") return json(application.getXunjiSyncStatus());
        if (url.pathname === "/api/connections/xunji/sync" && request.method === "POST") {
          const value = await body(request);
          const apiKey = typeof value.apiKey === "string" ? value.apiKey : "";
          if (!apiKey.startsWith("xjllm_")) throw new AthriaError("XUNJI_KEY_INVALID", "The imported Xunji Skill does not contain a valid API key.");
          const today = new Date();
          const attemptedAt = today.toISOString();
          const previous = application.getXunjiSyncStatus();
          if (!value.replaceCredential && previous && Date.now() - new Date(previous.lastAttemptAt).getTime() < 30_000) throw new AthriaError("XUNJI_SYNC_THROTTLED", "Wait 30 seconds before syncing Xunji again.", 429);
          const window = syncDateWindow(previous?.lastSuccessAt ?? null, value.range ?? value.days ?? XUNJI_SYNC_DAYS, today);
          try { return json(application.commitXunji(await fetchXunjiTraining(apiKey, window.days, today), attemptedAt)); }
          catch (error) {
            const code = error instanceof XunjiAuthenticationError ? "XUNJI_AUTHENTICATION_FAILED" : "XUNJI_SYNC_FAILED";
            const message = error instanceof XunjiAuthenticationError ? "Xunji rejected this API key. Export a new Skill from Xunji and try again." : "Xunji sync failed. Try again later.";
            application.recordXunjiFailure({ attemptedAt, rangeStart: window.rangeStart, rangeEnd: window.rangeEnd, code, message });
            throw new AthriaError(code, message, error instanceof XunjiAuthenticationError ? 401 : 502);
          }
        }
        if (url.pathname === "/api/system/doctor" && request.method === "GET") return json({ status: "ok", version: VERSION, dataDir, database: repository.counts() });
        if (url.pathname === "/api/system/backup" && request.method === "POST") return json({ path: await backupDatabase() });
        if (url.pathname === "/api/system/backup/preview" && request.method === "POST") { const value = await body(request); return json(await previewBackup(String(value.path), dataDir, VERSION)); }
        if (url.pathname === "/api/system/restore/prepare" && request.method === "POST") { const value = await body(request); return json(await prepareRestore(String(value.path), repository, databasePath, dataDir, VERSION)); }
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
