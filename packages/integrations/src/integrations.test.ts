import { describe, expect, it } from "vitest";
import { XunjiAuthenticationError, fetchXunjiTraining, intervalModality, normalizeIntervalsActivity, normalizeXunjiTraining, parseHevyCsv } from "./index";

describe("data integrations", () => {
  it("maps mixed activities without inventing endurance", () => expect(intervalModality("HighIntensityIntervalTraining")).toBe("mixed"));
  it("preserves a missing duration", () => expect(normalizeIntervalsActivity({ id: 1, type: "Run", start_date: "2026-09-01T10:00:00Z" }, "activities")?.missingFields).toEqual(["duration"]));
  it("previews a valid Hevy export", () => {
    const csv = "title,start_time,end_time,exercise_title,set_index,weight_kg,reps,rpe\nWorkout,2026-09-01T10:00:00Z,2026-09-01T11:00:00Z,Squat,1,100,5,8\n";
    const preview = parseHevyCsv(new TextEncoder().encode(csv));
    expect(preview.counts).toMatchObject({ sessions: 1, sets: 1, invalidRows: 0 });
  });
  it.each([
    ["Weight Training", "strength"], ["weight-training", "strength"], ["StrengthTraining", "strength"],
    ["Run", "endurance"], ["ROWING", "endurance"], ["HIIT", "mixed"], ["Hyrox", "mixed"],
    ["Functional-Training", "mixed"], ["Yoga", "recovery"], ["Unlisted Sport", "unknown"], [null, "unknown"],
  ])("maps Intervals activity type %s", (type, expected) => expect(intervalModality(type)).toBe(expected));
  it("accepts UTF-8 BOM and reports unknown columns", () => {
    const csv = "\uFEFFtitle,start_time,end_time,exercise_title,set_index,weight_lbs,reps,notes\nWorkout,2026-09-01T10:00:00Z,2026-09-01T11:00:00Z,Squat,1,225,5,fixture\n";
    const preview = parseHevyCsv(new TextEncoder().encode(csv));
    expect(preview.sessions[0]?.strengthSets[0]).toMatchObject({ weight: 225, weightUnit: "lb" });
    expect(preview.unknownColumns).toEqual(["notes"]);
  });
  it.each([
    ["", "header"],
    ["title,start_time\nA,2026-01-01", "required"],
    ["title,start_time,exercise_title,set_index\nA,2026-01-01,Squat,1", "weight"],
  ])("fails malformed CSV clearly", (csv, message) => expect(() => parseHevyCsv(new TextEncoder().encode(csv))).toThrow(new RegExp(message, "i")));
  it("keeps valid Hevy rows when a later row is invalid", () => {
    const csv = "title,start_time,end_time,exercise_title,set_index,weight_kg,reps\nGood,2026-09-01T10:00:00Z,2026-09-01T11:00:00Z,Squat,1,100,5\nBad,not-a-date,,Squat,1,20,10\n";
    const preview = parseHevyCsv(new TextEncoder().encode(csv));
    expect(preview.counts).toMatchObject({ sessions: 1, validRows: 1, invalidRows: 1 });
  });
  it("normalizes supplied Intervals fields and planned events", () => {
    const activity = normalizeIntervalsActivity({ id: "run", type: "Run", name: "Easy", start_date: "2026-09-01T10:00:00Z", moving_time: 1800, distance: 5000, average_heartrate: 150, average_watts: 220 }, "activities");
    expect(activity).toMatchObject({ modality: "endurance", durationMinutes: 30, status: "completed", endurance: { distanceMeters: 5000, averageHeartRate: 150, averagePowerWatts: 220 } });
    expect(normalizeIntervalsActivity({ id: 44, type: "Ride", start_date_local: "2026-09-02T18:00:00Z", duration: 45 }, "events")).toMatchObject({ durationMinutes: 45, status: "planned" });
  });
  it("normalizes Xunji strength details with a stable localid", () => {
    const session = normalizeXunjiTraining({ localid: 42, datestr: "2026-09-03", title: "力量", start: 1_788_400_000_000, end: 1_788_403_600_000, movements: [{ name: "卧推", restTime: 90, sets: [{ done: true, weight: "60", unit: "kg", reps: "8", rpe: "8.5", leftWeight: "30", rightWeight: "30", restSeconds: 75 }, { done: false, weight: "60", reps: "8" }] }] });
    expect(session).toMatchObject({ id: "xunji:42", externalId: "42", source: "xunji", modality: "strength", strengthSets: [{ exerciseRaw: "卧推", weight: 60, reps: 8, rpe: 8.5, leftWeight: 30, rightWeight: 30, restSeconds: 75, plannedRestSeconds: 90 }] });
    expect(session.strengthSets).toHaveLength(1);
  });
  it("normalizes Xunji cardio metrics and mixed sessions", () => {
    const cardio = normalizeXunjiTraining({ localid: 7, datestr: "2026-09-03", start: 1_788_400_000_000, end: 1_788_401_800_000, movements: [{ name: "跑步", cardio: true, recordPreset: "running", metrics: { distance: "5", avgHeartRate: 145, maxHeartRate: 172 } }] });
    expect(cardio).toMatchObject({ modality: "endurance", sport: "running", endurance: { distanceMeters: 5000, averageHeartRate: 145, maxHeartRate: 172 } });
    const mixed = normalizeXunjiTraining({ localid: 8, datestr: "2026-09-03", movements: [{ name: "深蹲", sets: [{ done: true, reps: 5 }] }, { name: "单车", cardio: true, metrics: { workoutTime: 600 } }] });
    expect(mixed.modality).toBe("mixed");
    expect(mixed.missingFields).toEqual(expect.arrayContaining(["startAt", "endAt"]));
  });
  it("fetches each Xunji date once and reads res.trains", async () => {
    const requests: string[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { datestr: string; include_full_data: boolean };
      requests.push(request.datestr);
      expect(request.include_full_data).toBe(true);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer xjllm_fixture");
      return Response.json({ res: { trains: [{ localid: request.datestr, datestr: request.datestr, movements: [] }] } });
    }) as typeof fetch;
    const result = await fetchXunjiTraining("xjllm_fixture", 2, new Date(2026, 8, 3), fetcher);
    expect(requests.sort()).toEqual(["2026-09-02", "2026-09-03"]);
    expect(result.records).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });
  it("rejects an invalid Xunji key without returning it in the error", async () => {
    const fetcher = (async () => Response.json({ error: "apikey invalid" }, { status: 401 })) as unknown as typeof fetch;
    const promise = fetchXunjiTraining("xjllm_should_not_leak", 1, new Date(2026, 8, 3), fetcher);
    await expect(promise).rejects.toBeInstanceOf(XunjiAuthenticationError);
    await expect(promise).rejects.not.toThrow(/should_not_leak/);
  });
});
