import type { WellnessRecord } from "./view-models";
import { addDays } from "./plan/view";

export type WellnessAssessmentKey = "hrvRmssdMs" | "hrvSdnnMs" | "restingHeartRateBpm" | "avgSleepingHeartRateBpm" | "stepsCount" | "sleepSeconds" | "sleepScore" | "vo2maxMlKgMin" | "spo2Percent" | "sleepQuality" | "fatigue" | "soreness" | "stress" | "mood" | "motivation";
export interface WellnessAssessment {
  level: "favorable" | "neutral" | "unfavorable";
  message: string;
  day: string;
  baseline: number | null;
  sampleCount: number;
  change: number | null;
  threshold: number | null;
  mode: "ratio" | "absolute";
}
const rules = {
  hrvRmssdMs: { mode: "ratio", threshold: 0.1, direction: "higher", messages: ["Recovery looks good", "Recovery is steady", "Recovery is slower; take it easy"] },
  hrvSdnnMs: { mode: "ratio", threshold: 0.1, direction: "higher", messages: ["Recovery looks good", "Recovery is steady", "Recovery is slower; take it easy"] },
  restingHeartRateBpm: { mode: "absolute", threshold: 3, direction: "heart", messages: ["Heart rate is up; ease off", "Heart rate is steady; keep your rhythm", "Heart rate is lower; notice how you feel"] },
  avgSleepingHeartRateBpm: { mode: "absolute", threshold: 3, direction: "heart", messages: ["Nighttime heart rate is higher", "Nighttime heart rate is steady", "Nighttime heart rate is lower"] },
  stepsCount: { mode: "ratio", threshold: 0.2, direction: "descriptive", messages: ["More active than usual", "Activity is in your usual rhythm", "Less active; take your time"] },
  sleepSeconds: { mode: "absolute", threshold: 1800, direction: "higher", messages: ["You slept longer than usual", "Sleep duration is steady", "A little less sleep; rest up"] },
  sleepScore: { mode: "absolute", threshold: 5, direction: "higher", messages: ["Sleep looks good", "Sleep is steady", "Sleep dipped; rest up"] },
  vo2maxMlKgMin: { mode: "ratio", threshold: 0.05, direction: "higher", messages: ["Your endurance indicator improved", "Your endurance indicator is steady", "Your endurance indicator dipped"] },
  spo2Percent: { mode: "absolute", threshold: 1, direction: "oxygen", messages: ["Oxygen reading is higher than usual", "Oxygen reading is steady", "Reading is lower; check again"] },
  sleepQuality: { mode: "absolute", threshold: 0.5, direction: "subjective", messages: ["Sleep felt less settled", "Sleep feels much as usual", "Sleep feels good; keep it up"] },
  fatigue: { mode: "absolute", threshold: 0.5, direction: "subjective", messages: ["Feeling tired; ease off", "Fatigue feels much as usual", "Less fatigue; looking good"] },
  soreness: { mode: "absolute", threshold: 0.5, direction: "subjective", messages: ["Some soreness; take it easy", "Soreness feels much as usual", "Your body feels easier"] },
  stress: { mode: "absolute", threshold: 0.5, direction: "subjective", messages: ["More stress; take a breather", "Stress feels much as usual", "Less stress; take a breath"] },
  mood: { mode: "absolute", threshold: 0.5, direction: "subjective", messages: ["Mood dipped; be kind to yourself", "Mood feels much as usual", "Mood looks good; keep it up"] },
  motivation: { mode: "absolute", threshold: 0.5, direction: "subjective", messages: ["Less motivation; take your time", "Motivation feels much as usual", "Motivation looks good; stay steady"] },
} as const;

// These thresholds describe personal changes in the UI, not clinical cutoffs.
export function assessWellness(records: WellnessRecord[], key: WellnessAssessmentKey, day: string): WellnessAssessment {
  const rule = rules[key];
  const current = records.find((record) => record.day === day)?.fields[key];
  const currentValue = current?.value;
  const result: WellnessAssessment = { level: "neutral", message: "No record for this day", day, baseline: null, sampleCount: 0, change: null, threshold: null, mode: rule.mode };
  if (!current || typeof currentValue !== "number" || !Number.isFinite(currentValue)) return result;
  const history = new Map<string, number>();
  const start = addDays(day, -28);
  for (const record of records) {
    const field = record.fields[key];
    if (record.day >= start && record.day < day && field?.source === current.source && typeof field.value === "number" && Number.isFinite(field.value)) history.set(record.day, field.value);
  }
  const values = [...history.values()].sort((a, b) => a - b);
  result.sampleCount = values.length;
  if (values.length) {
    const middle = Math.floor(values.length / 2);
    result.baseline = values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  }
  if (values.length < 7) return { ...result, message: "Still learning your usual rhythm" };
  const baseline = result.baseline!;
  if (rule.mode === "ratio" && baseline === 0) return { ...result, message: "Cannot compare just yet" };
  const change = rule.mode === "ratio" ? (currentValue - baseline) / baseline : currentValue - baseline;
  result.change = change;
  result.threshold = rule.threshold;
  const index = change > rule.threshold ? 0 : change < -rule.threshold ? 2 : 1;
  if ((key === "hrvRmssdMs" || key === "hrvSdnnMs") && change > 0.5) return { ...result, level: "unfavorable", message: "Big change; notice how you feel" };
  if (rule.direction === "subjective" && current.source !== "intervals_icu") return { ...result, message: ["Score is higher than usual", "Score is close to usual", "Score is lower than usual"][index]! };
  const level = index === 1 ? "neutral" : rule.direction === "subjective" ? (index === 2 ? "favorable" : "unfavorable") : rule.direction === "heart" ? (index === 0 ? "unfavorable" : "neutral") : rule.direction === "descriptive" ? "neutral" : rule.direction === "oxygen" ? (index === 2 ? "unfavorable" : "neutral") : index === 0 ? "favorable" : "unfavorable";
  return { ...result, level, message: rule.messages[index] };
}
