import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { intervalModality, normalizeIntervalsActivity, normalizeXunjiTraining, parseHevyCsv, syncDateWindow } from "../packages/integrations/src/index.ts";

const hevy = [
  "\uFEFFtitle,start_time,end_time,exercise_title,set_index,weight_lbs,reps,rpe,notes",
  "Workout,2026-09-01T10:00:00Z,2026-09-01T11:00:00Z,Squat,1,225,5,8,fixture",
  "Bad,not-a-date,,Squat,1,20,10,,bad",
].join("\n") + "\n";
const intervals = [
  { resource: "activities", item: { id: "run", type: "Run", name: "Easy", start_date: "2026-09-01T10:00:00Z", moving_time: 1800, distance: 5000, average_heartrate: 150, average_watts: 220 } },
  { resource: "activities", item: { id: 1, type: "Run", start_date: "2026-09-01T10:00:00Z" } },
  { resource: "events", item: { id: 44, type: "Ride", start_date_local: "2026-09-02T18:00:00Z", duration: 45 } },
];
const xunji = [
  { localid: 42, datestr: "2026-09-03", title: "力量", start: 1_788_400_000_000, end: 1_788_403_600_000, movements: [{ name: "卧推", restTime: 90, sets: [{ done: true, weight: "60", unit: "kg", reps: "8", rpe: "8.5", leftWeight: "30", rightWeight: "30", restSeconds: 75 }, { done: false, weight: "60", reps: "8" }] }] },
  { localid: 7, datestr: "2026-09-03", start: 1_788_400_000_000, end: 1_788_401_800_000, movements: [{ name: "跑步", cardio: true, recordPreset: "running", metrics: { distance: "5", avgHeartRate: 145, maxHeartRate: 172 } }] },
  { localid: 8, datestr: "2026-09-03", movements: [{ name: "深蹲", sets: [{ done: true, reps: 5 }] }, { name: "单车", cardio: true, metrics: { workoutTime: 600 } }] },
];
const fixture = {
  hevy: { content: hevy, fileName: "hevy.csv", expected: parseHevyCsv(new TextEncoder().encode(hevy), "hevy.csv") },
  modalities: ["Weight Training", "weight-training", "Run", "HIIT", "Yoga", "Unlisted Sport", null].map((input) => ({ input, expected: intervalModality(input) })),
  intervals: intervals.map(({ resource, item }) => ({ resource, item, expected: normalizeIntervalsActivity(item, resource as "activities" | "events") })),
  windows: [null, "2026-09-05T10:00:00Z", "2025-01-01T00:00:00Z"].map((lastSuccessAt) => ({ lastSuccessAt, expected: syncDateWindow(lastSuccessAt, "incremental", new Date("2026-09-11T12:00:00Z")) })),
  xunji: xunji.map((input) => ({ input, expected: normalizeXunjiTraining(input) })),
};
const output = resolve(import.meta.dir, "..", "crates", "athria-integrations", "tests", "fixtures", "integrations.json");
mkdirSync(resolve(output, ".."), { recursive: true });
writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Wrote integration compatibility fixture to ${output}`);
