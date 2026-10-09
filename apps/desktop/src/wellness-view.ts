import { addDays } from "./plan/view";
import type { WellnessRecord } from "./view-models";

export type WellnessKey = keyof WellnessRecord["fields"];

const sleepKeys: WellnessKey[] = ["sleepSeconds", "manualSleepSeconds", "sleepScore", "subjectiveSleepScore", "sleepQuality", "avgSleepingHeartRateBpm"];
export function sleepStorageDay(eveningDay: string): string { return addDays(eveningDay, 1); }

// Input is always raw API data. This projection must never be saved or re-projected.
export function eveningWellnessRecords(records: WellnessRecord[]): WellnessRecord[] {
  const days = new Map<string, WellnessRecord>();
  const target = (record: WellnessRecord, day: string) => {
    const id = `${record.ownerId}:${day}`;
    let value = days.get(id);
    if (!value) { value = { ownerId: record.ownerId, day, fields: {}, updatedAt: record.updatedAt }; days.set(id, value); }
    if (record.updatedAt > value.updatedAt) value.updatedAt = record.updatedAt;
    return value;
  };
  for (const record of records) {
    for (const key of Object.keys(record.fields) as WellnessKey[]) {
      const day = sleepKeys.includes(key) ? addDays(record.day, -1) : record.day;
      const field = record.fields[key];
      if (field) target(record, day).fields[key] = { ...field };
    }
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export const wellnessRanges = [7, 30, 183, 365] as const;
export type WellnessRange = typeof wellnessRanges[number];
export interface WellnessMetric { id: string; label: string; unit: string; keys: WellnessKey[]; always?: boolean }
export const wellnessMetrics: WellnessMetric[] = [
  { id: "sleep-score", label: "Sleep score", unit: "points", keys: ["sleepScore", "subjectiveSleepScore"], always: true },
  { id: "sleep-duration", label: "Sleep time", unit: "hours", keys: ["sleepSeconds", "manualSleepSeconds"], always: true },
  { id: "hrv", label: "HRV", unit: "ms", keys: ["hrvRmssdMs", "hrvSdnnMs"] },
  { id: "resting-hr", label: "Resting heart rate", unit: "bpm", keys: ["restingHeartRateBpm"] },
  { id: "sleeping-hr", label: "Sleeping heart rate", unit: "bpm", keys: ["avgSleepingHeartRateBpm"] },
  { id: "weight", label: "Weight", unit: "kg", keys: ["weightKg"] },
  { id: "body-fat", label: "Body fat", unit: "%", keys: ["bodyFatPercent"] },
  { id: "steps", label: "Steps", unit: "steps", keys: ["stepsCount"] },
  { id: "oxygen", label: "SpO2", unit: "%", keys: ["spo2Percent"] },
  { id: "respiration", label: "Respiration", unit: "breaths/min", keys: ["respirationRpm"] },
  { id: "vo2max", label: "VO2 max", unit: "ml/kg/min", keys: ["vo2maxMlKgMin"] },
  ...([ ["sleepQuality", "Sleep quality"], ["fatigue", "Fatigue"], ["soreness", "Soreness"], ["stress", "Stress"], ["mood", "Mood"], ["motivation", "Motivation"], ["injuryScore", "Injury score"], ["readiness", "Source readiness"] ] as const).map(([key, label]) => ({ id: key, label, unit: "points", keys: [key] })),
];

export function wellnessWindow(today: string, range: WellnessRange, offset: number) {
  const end = addDays(today, -range * Math.max(0, offset));
  const start = addDays(end, 1 - range);
  // Include a timezone buffer around the server's UTC date cutoff.
  return { start, end, days: range * (Math.max(0, offset) + 1) + 2 };
}

export function normalizeMetricOrder(value: unknown): string[] {
  const preferred = ["hrv", "resting-hr", "steps", "oxygen", "sleep-score", "sleep-duration", "vo2max", "weight"];
  const ids = [...preferred, ...wellnessMetrics.map((metric) => metric.id).filter((id) => !preferred.includes(id))];
  const saved = Array.isArray(value) ? value.map((id) => id === "hrv-rmssd" || id === "hrv-sdnn" ? "hrv" : id).filter((id): id is string => typeof id === "string" && ids.includes(id)) : [];
  return [...new Set([...saved, ...ids])];
}
export function readMetricOrder(databaseUuid: string, storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): string[] {
  try { return normalizeMetricOrder(JSON.parse(storage?.getItem(`athria:wellness:metric-order:${databaseUuid}`) ?? "null")); }
  catch { return normalizeMetricOrder(null); }
}
export function saveMetricOrder(databaseUuid: string, order: string[], storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try { storage?.setItem(`athria:wellness:metric-order:${databaseUuid}`, JSON.stringify(normalizeMetricOrder(order))); }
  catch { /* Sorting remains available when local storage is unavailable. */ }
}
export function moveMetric(order: string[], id: string, target: string): string[] {
  const from = order.indexOf(id), to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return order;
  const next = order.filter((value) => value !== id);
  next.splice(to, 0, id);
  return next;
}
export function metricNumber(record: WellnessRecord, key: WellnessKey): number | null {
  const value = record.fields[key]?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export interface WellnessPoint { day: string; value: number; source: string; key: WellnessKey; x: number; y: number }
export function wellnessSeries(records: WellnessRecord[], metric: WellnessMetric, start: string, end: string) {
  records = eveningWellnessRecords(records);
  const span = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 86400000));
  const series = metric.keys.flatMap((key, keyIndex) => {
    const sources = new Set(records.filter((record) => record.day >= start && record.day <= end && metricNumber(record, key) !== null).map((record) => record.fields[key]!.source));
    return [...sources].map((source) => {
      const days = new Map(records.filter((record) => record.day >= start && record.day <= end && record.fields[key]?.source === source && metricNumber(record, key) !== null).map((record) => [record.day, record]));
      const points = [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((record) => ({
        day: record.day, value: metricNumber(record, key)! / (key === "sleepSeconds" || key === "manualSleepSeconds" ? 3600 : 1), source, key,
        x: 58 + (Date.parse(record.day) - Date.parse(start)) / 86400000 / span * 700, y: 0,
      }));
      return { key, source, tone: metric.id === "hrv" ? key === "hrvSdnnMs" ? "manual" : "device" : keyIndex === 1 || source !== "intervals_icu" ? "manual" : "device", points };
    });
  });
  const all = series.flatMap((item) => item.points);
  const values = all.map((point) => point.value);
  let low = values.length ? Math.min(...values) : 0;
  let high = values.length ? Math.max(...values) : 1;
  const padding = high === low ? Math.max(1, Math.abs(high) * .05) : (high - low) * .15;
  low = Math.max(0, low - padding); high += padding;
  for (const point of all) point.y = 83 - (point.value - low) / (high - low) * 70;
  return { low, high, series: series.map((item) => {
    const segments: WellnessPoint[][] = [];
    for (const point of item.points) {
      const last = segments.at(-1);
      if (!last || addDays(last.at(-1)!.day, 1) !== point.day) segments.push([point]);
      else last.push(point);
    }
    return { ...item, segments };
  }) };
}

export interface SleepDraft { score: string; hours: string; minutes: string }
export interface SleepCleared { score?: boolean; duration?: boolean }
export function sleepDurationField(record?: WellnessRecord) {
  for (const key of ["manualSleepSeconds", "sleepSeconds"] as const) {
    const field = record?.fields[key];
    if (typeof field?.value === "number" && Number.isFinite(field.value)) return { ...field, value: field.value };
  }
  return undefined;
}
export function sleepDraft(record?: WellnessRecord, cleared: SleepCleared = {}): SleepDraft {
  const score = record ? (cleared.score ? null : metricNumber(record, "subjectiveSleepScore")) ?? metricNumber(record, "sleepScore") : null;
  const seconds = record ? (cleared.duration ? null : metricNumber(record, "manualSleepSeconds")) ?? metricNumber(record, "sleepSeconds") : null;
  return { score: score === null ? "" : String(score), hours: seconds === null ? "" : String(Math.floor(seconds / 3600)), minutes: seconds === null ? "" : String(Math.floor(seconds % 3600 / 60)) };
}
export function sleepPatch(draft: SleepDraft, record?: WellnessRecord, cleared: SleepCleared = {}) {
  const scoreText = draft.score.trim(); const hoursText = draft.hours.trim(); const minutesText = draft.minutes.trim();
  let score = cleared.score || scoreText === "" ? null : Number(scoreText);
  const hasDuration = hoursText !== "" || minutesText !== "";
  const hours = Number(hoursText || 0); const minutes = Number(minutesText || 0);
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) throw new Error("Enter a sleep score from 0 to 100.");
  if (!cleared.duration && hasDuration && (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || minutes < 0 || minutes > 59 || hours * 60 + minutes > 1440)) throw new Error("Enter a sleep duration between 0 and 24 hours.");
  let seconds = !cleared.duration && hasDuration ? hours * 3600 + minutes * 60 : null;
  const existingScore = record ? metricNumber(record, "subjectiveSleepScore") : null;
  const existingSeconds = record ? metricNumber(record, "manualSleepSeconds") : null;
  const originalDraft = sleepDraft(record);
  if (!cleared.score && (scoreText === "" ? null : Number(scoreText)) === (originalDraft.score === "" ? null : Number(originalDraft.score))) score = existingScore;
  if (!cleared.duration && hasDuration === (originalDraft.hours !== "" || originalDraft.minutes !== "") && hours === Number(originalDraft.hours || 0) && minutes === Number(originalDraft.minutes || 0)) seconds = existingSeconds;
  if (score === null && seconds === null && originalDraft.score === "" && sleepDurationField(record) === undefined) throw new Error("Enter a score or duration to record sleep.");
  const fields: Partial<Record<"subjectiveSleepScore" | "manualSleepSeconds", number | null>> = {};
  if (score !== existingScore) fields.subjectiveSleepScore = score;
  if (seconds !== existingSeconds) fields.manualSleepSeconds = seconds;
  return fields;
}
export function sleepHasChanges(draft: SleepDraft, record?: WellnessRecord, cleared: SleepCleared = {}) {
  try { return Object.keys(sleepPatch(draft, record, cleared)).length > 0; }
  catch { return false; }
}
export function sleepCanReset(draft: SleepDraft, record: WellnessRecord | undefined, cleared: SleepCleared, key: "score" | "duration") {
  if (!cleared[key] && record && metricNumber(record, key === "score" ? "subjectiveSleepScore" : "manualSleepSeconds") !== null) return true;
  const fallback = sleepDraft(record, { score: true, duration: true });
  return key === "score" ? draft.score !== fallback.score : draft.hours !== fallback.hours || draft.minutes !== fallback.minutes;
}
