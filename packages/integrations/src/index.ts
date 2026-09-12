import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { trainingSessionSchema, type TrainingSession } from "@athria/schemas";

export const HEVY_PARSER_VERSION = "0.1.0";
export const XUNJI_PARSER_VERSION = "0.1.0";
export const XUNJI_SYNC_DAYS = 90;

const aliases: Record<string, string[]> = {
  title: ["title", "workout_title", "workout name"],
  start_time: ["start_time", "start time", "workout_start_time"],
  end_time: ["end_time", "end time", "workout_end_time"],
  exercise_title: ["exercise_title", "exercise title", "exercise_name"],
  set_index: ["set_index", "set index", "set_number"],
  set_type: ["set_type", "set type"],
  weight_kg: ["weight_kg", "weight kg"],
  weight_lbs: ["weight_lbs", "weight lbs", "weight_lb"],
  reps: ["reps", "repetitions"],
  rpe: ["rpe"],
  workout_id: ["workout_id", "workout id"],
  set_id: ["set_id", "set id"],
};

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

function parseDate(value: string): Date {
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;
  const named = value.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4}), (\d{2}):(\d{2})$/);
  if (named) {
    const result = new Date(`${named[1]} ${named[2]} ${named[3]} ${named[4]}:${named[5]} UTC`);
    if (!Number.isNaN(result.getTime())) return result;
  }
  throw new Error(`Invalid date/time: ${value}`);
}

const numberOrNull = (value: string | undefined): number | null => {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`);
  return parsed;
};

export interface HevyPreview {
  contentHash: string;
  fileName: string;
  parserVersion: string;
  counts: { rows: number; sessions: number; sets: number; validRows: number; invalidRows: number };
  errors: Array<{ line: number; message: string }>;
  unknownColumns: string[];
  sessions: TrainingSession[];
  rawRows: Record<string, string>[];
}

export function parseHevyCsv(content: Uint8Array, fileName = "hevy.csv"): HevyPreview {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content).replace(/^\uFEFF/, "");
  const records = parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true }) as Record<string, string>[];
  const headers = records[0] ? Object.keys(records[0]) : (parse(text, { to_line: 1 })[0] as string[] | undefined ?? []);
  if (!headers.length) throw new Error("CSV has no header row");
  const normalized = new Map(headers.map((item) => [item.trim().toLowerCase(), item]));
  const fields: Record<string, string> = {};
  for (const [target, options] of Object.entries(aliases)) {
    const match = options.map((item) => normalized.get(item)).find(Boolean);
    if (match) fields[target] = match;
  }
  const missing = ["title", "start_time", "exercise_title", "set_index"].filter((item) => !fields[item]);
  if (missing.length) throw new Error(`Missing required Hevy columns: ${missing.join(", ")}`);
  if (!fields.weight_kg && !fields.weight_lbs) throw new Error("A declared weight_kg or weight_lbs column is required");

  const grouped = new Map<string, { name: string; start: Date; end: Date; sets: TrainingSession["strengthSets"] }>();
  const errors: HevyPreview["errors"] = [];
  let validRows = 0;
  records.forEach((row, index) => {
    try {
      const title = row[fields.title!]!.trim();
      const start = parseDate(row[fields.start_time!]!);
      const workoutId = fields.workout_id ? row[fields.workout_id]?.trim() : "";
      const sessionKey = workoutId || hash(`${start.toISOString()}|${title}`).slice(0, 24);
      const exercise = row[fields.exercise_title!]!.trim();
      if (!title || !exercise) throw new Error("Workout title and exercise title are required");
      const setIndex = Math.trunc(numberOrNull(row[fields.set_index!]) ?? 0);
      const setType = fields.set_type ? row[fields.set_type]?.trim() || "normal" : "normal";
      const kg = fields.weight_kg ? numberOrNull(row[fields.weight_kg]) : null;
      const lb = fields.weight_lbs ? numberOrNull(row[fields.weight_lbs]) : null;
      const end = fields.end_time && row[fields.end_time]?.trim() ? parseDate(row[fields.end_time]!) : new Date(start.getTime());
      const current = grouped.get(sessionKey) ?? { name: title, start, end, sets: [] };
      if (end > current.end) current.end = end;
      current.sets.push({ exerciseRaw: exercise, exerciseKey: slug(exercise), movement: null, primaryMuscles: [], secondaryMuscles: [], setIndex, setType, weight: kg ?? lb, weightUnit: kg !== null ? "kg" : lb !== null ? "lb" : null, reps: fields.reps ? numberOrNull(row[fields.reps]) : null, rpe: fields.rpe ? numberOrNull(row[fields.rpe]) : null });
      grouped.set(sessionKey, current);
      validRows += 1;
    } catch (error) {
      errors.push({ line: index + 2, message: error instanceof Error ? error.message : String(error) });
    }
  });
  const sessions = [...grouped.entries()].map(([externalId, value]) => trainingSessionSchema.parse({ id: `hevy:${externalId}`, source: "hevy", externalId, modality: "strength", name: value.name, startAt: value.start.toISOString(), endAt: value.end.toISOString(), durationMinutes: Math.max(0, Math.round((value.end.getTime() - value.start.getTime()) / 60_000)), strengthSets: value.sets }));
  return { contentHash: hash(content), fileName, parserVersion: HEVY_PARSER_VERSION, counts: { rows: records.length, sessions: sessions.length, sets: sessions.reduce((sum, item) => sum + item.strengthSets.length, 0), validRows, invalidRows: errors.length }, errors, unknownColumns: headers.filter((header) => !Object.values(fields).includes(header)), sessions, rawRows: records };
}

const strengthTypes = new Set(["strengthtraining", "weighttraining"]);
const enduranceTypes = new Set(["hike", "ride", "rowing", "run", "swim", "walk"]);
const mixedTypes = new Set(["crossfit", "functionalstrengthtraining", "functionaltraining", "highintensityintervaltraining", "hiit", "hyrox"]);
const recoveryTypes = new Set(["mobility", "pilates", "recovery", "stretching", "yoga"]);

export function intervalModality(value: unknown): TrainingSession["modality"] {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!normalized) return "unknown";
  if (strengthTypes.has(normalized)) return "strength";
  if (enduranceTypes.has(normalized)) return "endurance";
  if (mixedTypes.has(normalized)) return "mixed";
  if (recoveryTypes.has(normalized)) return "recovery";
  return "unknown";
}

export function normalizeIntervalsActivity(item: Record<string, unknown>, resource: "activities" | "events"): TrainingSession | null {
  if (resource === "events") return null;
  const startValue = item.start_date ?? item.start_date_local ?? item.start;
  if (!startValue) return null;
  const start = new Date(String(startValue));
  if (Number.isNaN(start.getTime())) return null;
  const durationValue = item.moving_time ?? item.elapsed_time ?? item.duration;
  let durationSeconds = durationValue === undefined || durationValue === null ? 0 : Number(durationValue);
  if (item.duration !== undefined && durationSeconds > 0 && durationSeconds < 1000) durationSeconds *= 60;
  const durationMinutes = durationSeconds > 0 ? Math.max(1, Math.round(durationSeconds / 60)) : 0;
  const type = item.type ?? item.sport;
  const external = String(item.id ?? item.external_id ?? hash(JSON.stringify(item)).slice(0, 24));
  return trainingSessionSchema.parse({
    id: `intervals:${resource}:${external}`, source: "intervals", externalId: `${resource}:${external}`, modality: intervalModality(type), sport: type == null ? null : String(type),
    name: String(item.name ?? type ?? "Intervals activity"), startAt: start.toISOString(), endAt: new Date(start.getTime() + durationMinutes * 60_000).toISOString(), durationMinutes,
    status: "completed", missingFields: durationValue == null ? ["duration"] : [],
    endurance: { distanceMeters: item.distance == null ? null : Number(item.distance), averageHeartRate: item.average_heartrate == null ? null : Number(item.average_heartrate), maxHeartRate: item.max_heartrate == null ? null : Number(item.max_heartrate), averagePowerWatts: item.average_watts == null ? null : Number(item.average_watts), maxPowerWatts: item.max_watts == null ? null : Number(item.max_watts), heartRateZoneSeconds: typeof item.time_in_zones === "object" && item.time_in_zones ? item.time_in_zones : {} },
  });
}

export interface IntervalsFetchOptions {
  today?: Date;
  activitiesOldest?: string;
  wellnessOldest?: string;
}

export interface SyncDateWindow { days: number; rangeStart: string; rangeEnd: string }

export function syncDateWindow(lastSuccessAt: string | null, requestedRange: unknown = "incremental", today = new Date()): SyncDateWindow {
  const rangeEnd = today.toISOString().slice(0, 10);
  if (requestedRange === undefined || requestedRange === null || requestedRange === "incremental") {
    if (!lastSuccessAt) return syncDateWindow(null, 90, today);
    const parsedStart = Date.parse(`${lastSuccessAt.slice(0, 10)}T00:00:00Z`);
    const parsedEnd = Date.parse(`${rangeEnd}T00:00:00Z`);
    const elapsedDays = Number.isFinite(parsedStart) ? Math.floor((parsedEnd - parsedStart) / 86_400_000) + 1 : 90;
    const days = Math.max(1, Math.min(365, elapsedDays));
    return syncDateWindow(null, days, today);
  }
  const parsedDays = Number(requestedRange);
  if (!Number.isFinite(parsedDays)) throw new Error("Sync range must be 'incremental' or a number of days.");
  const days = Math.max(1, Math.min(365, Math.trunc(parsedDays)));
  const rangeStart = new Date(Date.parse(`${rangeEnd}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { days, rangeStart, rangeEnd };
}

export function intervalsIncrementalWindow(lastSuccessAt: string | null, today = new Date(), requestedRange: unknown = "incremental"): { activitiesOldest: string; wellnessOldest: string } {
  const { rangeStart } = syncDateWindow(lastSuccessAt, requestedRange, today);
  return { activitiesOldest: rangeStart, wellnessOldest: rangeStart };
}

export async function fetchIntervals(apiKey: string, athleteId = "0", options: IntervalsFetchOptions = {}, fetcher: typeof fetch = fetch): Promise<Record<"activities" | "events" | "wellness", unknown[] | string>> {
  const today = options.today ?? new Date();
  const date = (offsetDays: number) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const paths = {
    activities: `/athlete/${athleteId}/activities?oldest=${options.activitiesOldest ?? date(-90)}&newest=${date(0)}`,
    wellness: `/athlete/${athleteId}/wellness?oldest=${options.wellnessOldest ?? date(-42)}&newest=${date(0)}`,
    events: `/athlete/${athleteId}/events?oldest=${date(-14)}&newest=${date(14)}`,
  };
  const authorization = `Basic ${btoa(`API_KEY:${apiKey}`)}`;
  const entries = await Promise.all(Object.entries(paths).map(async ([name, path]) => {
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await fetcher(`https://intervals.icu/api/v1${path}`, { headers: { Authorization: authorization, "User-Agent": "Athria/0.1" }, signal: AbortSignal.timeout(60_000) });
        if ([401, 403].includes(response.status)) throw new Error("Intervals.icu rejected the API key");
        if ((response.status === 429 || response.status >= 500) && attempt < 2) continue;
        if (!response.ok) throw new Error(`Intervals.icu returned HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload)) throw new Error("Intervals.icu response was not a list");
        return [name, payload] as const;
      }
      throw new Error("Intervals.icu request failed");
    } catch (error) { return [name, error instanceof Error ? error.message : String(error)] as const; }
  }));
  return Object.fromEntries(entries) as Record<"activities" | "events" | "wellness", unknown[] | string>;
}

export class XunjiAuthenticationError extends Error {}

export interface XunjiSyncResult {
  rangeStart: string;
  rangeEnd: string;
  successfulDates: string[];
  errors: Array<{ datestr: string; code: string; message: string }>;
  records: Record<string, unknown>[];
}

const finiteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const integerNumber = (value: unknown): number | null => {
  const parsed = finiteNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
};

const xunjiDate = (value: Date): string => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const xunjiDates = (days: number, today: Date): string[] => Array.from({ length: days }, (_, index) => {
  const value = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - index - 1));
  return xunjiDate(value);
});

const safeMessage = (value: unknown, fallback: string): string => {
  if (typeof value === "string" && value.trim()) return value.slice(0, 500);
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    const candidate = item.message ?? item.error ?? item.msg;
    if (typeof candidate === "string" && candidate.trim()) return candidate.slice(0, 500);
  }
  return fallback;
};

const isXunjiAuthFailure = (status: number, message: string): boolean => [401, 403].includes(status) || /apikey\s*(missing|invalid)|api.?key\s*(missing|invalid)|仅vip可用/i.test(message);

export async function fetchXunjiTraining(
  apiKey: string,
  days = XUNJI_SYNC_DAYS,
  today = new Date(),
  fetcher: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<XunjiSyncResult> {
  const dates = xunjiDates(Math.max(1, Math.min(365, Math.trunc(days))), today);
  const result: XunjiSyncResult = { rangeStart: dates[0]!, rangeEnd: dates.at(-1)!, successfulDates: [], errors: [], records: [] };
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < dates.length) {
      const datestr = dates[cursor++]!;
      try {
        let payload: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const response = await fetcher("https://trains.xunjiapp.cn/api_trains_for_llm_v2", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "Athria/0.1" },
            body: JSON.stringify({ schema_version: "train_open_api_v2", datestr, include_full_data: true }),
            signal: AbortSignal.timeout(30_000),
          });
          let value: unknown;
          try { value = await response.json(); } catch { value = undefined; }
          const message = safeMessage(value, `Xunji returned HTTP ${response.status}`);
          if (isXunjiAuthFailure(response.status, message)) throw new XunjiAuthenticationError(message);
          if (response.status === 429 || /too frequent/i.test(message)) {
            if (attempt === 2) throw new Error(message);
            const retry = value && typeof value === "object" ? finiteNumber((value as Record<string, unknown>).retry_after_ms) : null;
            await wait(Math.min(30_000, retry ?? 1_000));
            continue;
          }
          if (response.status >= 500 && attempt < 2) { await wait(250 * (attempt + 1)); continue; }
          if (!response.ok) throw new Error(message);
          payload = value;
          break;
        }
        if (!payload || typeof payload !== "object") throw new Error("Xunji returned an invalid response");
        const container = (payload as Record<string, unknown>).res;
        let trains: unknown[] = [];
        if (Array.isArray(container)) trains = container;
        else if (container && typeof container === "object" && Array.isArray((container as Record<string, unknown>).trains)) trains = (container as Record<string, unknown>).trains as unknown[];
        result.records.push(...trains.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object"));
        result.successfulDates.push(datestr);
      } catch (error) {
        if (error instanceof XunjiAuthenticationError) throw error;
        result.errors.push({ datestr, code: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "request_failed", message: safeMessage(error instanceof Error ? error.message : error, "Xunji request failed") });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, dates.length) }, () => worker()));
  return result;
}

function xunjiStart(record: Record<string, unknown>): { start: Date; missing: string[] } {
  const missing: string[] = [];
  const raw = record.start;
  const millis = finiteNumber(raw);
  if (millis !== null) return { start: new Date(millis < 10_000_000_000 ? millis * 1_000 : millis), missing };
  if (typeof raw === "string" && !Number.isNaN(new Date(raw).getTime())) return { start: new Date(raw), missing };
  missing.push("startAt");
  const datestr = /^\d{4}-\d{2}-\d{2}$/.test(String(record.datestr ?? "")) ? String(record.datestr) : "1970-01-01";
  return { start: new Date(`${datestr}T00:00:00.000Z`), missing };
}

function metricValue(metrics: Record<string, unknown>[], names: string[]): number | null {
  for (const metricsItem of metrics) for (const name of names) {
    const value = finiteNumber(metricsItem[name]);
    if (value !== null) return value;
  }
  return null;
}

export function normalizeXunjiTraining(record: Record<string, unknown>): TrainingSession {
  const movements = Array.isArray(record.movements) ? record.movements.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
  const cardioMovements = movements.filter((movement) => movement.cardio === true || movement.metrics && typeof movement.metrics === "object");
  const strengthMovements = movements.filter((movement) => Array.isArray(movement.sets) && movement.sets.length > 0 && movement.cardio !== true);
  const modality: TrainingSession["modality"] = cardioMovements.length && strengthMovements.length ? "mixed" : cardioMovements.length ? "endurance" : strengthMovements.length ? "strength" : "unknown";
  const { start, missing } = xunjiStart(record);
  let end: Date;
  const endMillis = finiteNumber(record.end);
  if (endMillis !== null) end = new Date(endMillis < 10_000_000_000 ? endMillis * 1_000 : endMillis);
  else { end = new Date(start); missing.push("endAt"); }
  if (end < start) { end = new Date(start); missing.push("duration"); }
  const strengthSets: TrainingSession["strengthSets"] = [];
  strengthMovements.forEach((movement) => {
    const sets = movement.sets as unknown[];
    sets.forEach((rawSet, index) => {
      if (!rawSet || typeof rawSet !== "object") return;
      const set = rawSet as Record<string, unknown>;
      if (set.done === false) return;
      strengthSets.push({
        exerciseRaw: String(movement.name ?? "Unknown exercise"), exerciseKey: null, movement: null, primaryMuscles: [], secondaryMuscles: [], setIndex: index,
        setType: String(set.type ?? set.setType ?? "normal"), weight: finiteNumber(set.weight ?? set.weight_kg), weightUnit: String(set.unit ?? "kg").toLowerCase() === "lb" ? "lb" : "kg",
        reps: integerNumber(set.reps), rpe: finiteNumber(set.rpe), leftWeight: finiteNumber(set.leftWeight ?? set.weightLeft ?? set.left_weight), rightWeight: finiteNumber(set.rightWeight ?? set.weightRight ?? set.right_weight),
        durationSeconds: finiteNumber(set.duration_s ?? set.time ?? set.workoutTime), restSeconds: finiteNumber(set.restSeconds ?? set.rest_times), plannedRestSeconds: finiteNumber(movement.restTime),
      });
    });
  });
  const metrics = cardioMovements.flatMap((movement) => {
    const values: Record<string, unknown>[] = [];
    if (movement.metrics && typeof movement.metrics === "object") values.push(movement.metrics as Record<string, unknown>);
    if (Array.isArray(movement.sets)) for (const set of movement.sets) if (set && typeof set === "object" && (set as Record<string, unknown>).metrics && typeof (set as Record<string, unknown>).metrics === "object") values.push((set as Record<string, unknown>).metrics as Record<string, unknown>);
    return values;
  });
  const distanceMetersDirect = metricValue(metrics, ["distanceMeters", "distance_m"]);
  const distance = distanceMetersDirect ?? (() => { const km = metricValue(metrics, ["distance"]); return km === null ? null : km * 1_000; })();
  const externalId = String(record.localid ?? hash(`${record.datestr ?? ""}|${record.start ?? ""}|${record.title ?? ""}`).slice(0, 24));
  return trainingSessionSchema.parse({
    id: `xunji:${externalId}`, source: "xunji", externalId, modality, sport: cardioMovements[0] ? String(cardioMovements[0].recordPreset ?? cardioMovements[0].name ?? "cardio") : null,
    name: String(record.title ?? record.name ?? "Xunji workout"), startAt: start.toISOString(), endAt: end.toISOString(), durationMinutes: Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000)),
    status: "completed", timezone: null, strengthSets, endurance: cardioMovements.length ? { distanceMeters: distance, averageHeartRate: metricValue(metrics, ["avgHeartRate", "averageHeartRate", "bpm"]), maxHeartRate: metricValue(metrics, ["maxHeartRate"]), averagePowerWatts: metricValue(metrics, ["averagePowerWatts", "avgPower"]), maxPowerWatts: metricValue(metrics, ["maxPowerWatts", "maxPower"]), heartRateZoneSeconds: {} } : null,
    missingFields: missing,
  });
}
