import { describe, expect, it } from "vitest";
import { assessWellness, type WellnessAssessmentKey } from "./wellness-assessment";
import type { WellnessRecord, WellnessFieldValue } from "./view-models";
import { addDays } from "./plan/view";
import { translate } from "./i18n";

const day = "2026-10-05";
function record(day: string, key: WellnessAssessmentKey, value: number | null, source: WellnessFieldValue["source"] = "intervals_icu"): WellnessRecord {
  return { ownerId: "local-user", day, fields: { [key]: { value, source, updatedAt: "2026-10-06T00:00:00Z" } }, updatedAt: "2026-10-06T00:00:00Z" };
}
function data(key: WellnessAssessmentKey, baseline: number, current: number, count = 7) {
  return [record(day, key, current), ...Array.from({ length: count }, (_, index) => record(addDays(day, -index - 1), key, baseline))];
}

describe("personal wellness assessment", () => {
  it("assesses a single sleep duration against matching-source history without mixing sources", () => {
    const manual = [record(day, "sleepSeconds", 25200, "user"), ...Array.from({ length: 7 }, (_, index) => record(addDays(day, -index - 1), "sleepSeconds", 27000, "user"))];
    expect(assessWellness(manual, "sleepSeconds", day)).toMatchObject({ baseline: 27000, sampleCount: 7, change: -1800 });
    const device = [record(day, "sleepSeconds", 28800), ...manual.slice(1)];
    expect(assessWellness(device, "sleepSeconds", day)).toMatchObject({ message: "Still learning your usual rhythm", sampleCount: 0 });
  });
  const cases: [WellnessAssessmentKey, number, number, number, string, string, string][] = [
    ["hrvRmssdMs", 30, 35, 25, "Recovery looks good", "Recovery is steady", "Recovery is slower; take it easy"],
    ["hrvSdnnMs", 30, 35, 25, "Recovery looks good", "Recovery is steady", "Recovery is slower; take it easy"],
    ["restingHeartRateBpm", 60, 64, 56, "Heart rate is up; ease off", "Heart rate is steady; keep your rhythm", "Heart rate is lower; notice how you feel"],
    ["avgSleepingHeartRateBpm", 60, 64, 56, "Nighttime heart rate is higher", "Nighttime heart rate is steady", "Nighttime heart rate is lower"],
    ["stepsCount", 10000, 13000, 7000, "More active than usual", "Activity is in your usual rhythm", "Less active; take your time"],
    ["sleepSeconds", 25000, 28000, 22000, "You slept longer than usual", "Sleep duration is steady", "A little less sleep; rest up"],
    ["sleepScore", 80, 86, 74, "Sleep looks good", "Sleep is steady", "Sleep dipped; rest up"],
    ["vo2maxMlKgMin", 40, 43, 37, "Your endurance indicator improved", "Your endurance indicator is steady", "Your endurance indicator dipped"],
    ["spo2Percent", 97, 99, 95, "Oxygen reading is higher than usual", "Oxygen reading is steady", "Reading is lower; check again"],
  ];
  it.each(cases)("maps all three levels for %s with translated messages", (key, baseline, high, low, highMessage, middleMessage, lowMessage) => {
    for (const [value, message] of [[high, highMessage], [baseline, middleMessage], [low, lowMessage]] as const) {
      const result = assessWellness(data(key, baseline, value), key, day);
      expect(result).toMatchObject({ message, baseline, sampleCount: 7, day });
      expect(translate(message, "zh-CN")).not.toBe(message);
    }
  });
  it.each([
    ["hrvRmssdMs", 30, 3], ["hrvSdnnMs", 30, 3], ["restingHeartRateBpm", 60, 3],
    ["avgSleepingHeartRateBpm", 60, 3], ["stepsCount", 10000, 2000], ["sleepSeconds", 25000, 1800],
    ["sleepScore", 80, 5], ["vo2maxMlKgMin", 40, 2], ["spo2Percent", 97, 1],
  ] as [WellnessAssessmentKey, number, number][])("keeps threshold boundaries neutral for %s", (key, baseline, threshold) => {
    for (const value of [baseline + threshold, baseline - threshold]) expect(assessWellness(data(key, baseline, value), key, day).level).toBe("neutral");
  });
  it("handles HRV exceptional rises and zero baselines", () => {
    expect(assessWellness(data("hrvSdnnMs", 30, 46), "hrvSdnnMs", day)).toMatchObject({ level: "unfavorable", message: "Big change; notice how you feel" });
    expect(assessWellness(data("hrvSdnnMs", 30, 45), "hrvSdnnMs", day).message).toBe("Recovery looks good");
    for (const key of ["hrvSdnnMs", "hrvRmssdMs", "stepsCount", "vo2maxMlKgMin"] as const) expect(assessWellness(data(key, 0, 1), key, day).message).toBe("Cannot compare just yet");
  });
  it("uses only 28 prior days from the same source and counts unique valid days", () => {
    const records = data("hrvSdnnMs", 30, 35, 6);
    records.push(record(addDays(day, -28), "hrvSdnnMs", 30), record(addDays(day, -29), "hrvSdnnMs", 900), record(addDays(day, 1), "hrvSdnnMs", 900), record(addDays(day, -8), "hrvSdnnMs", 900, "user"), record(addDays(day, -9), "hrvRmssdMs", 900), record(addDays(day, -10), "hrvSdnnMs", null), records[1]!);
    expect(assessWellness(records, "hrvSdnnMs", day)).toMatchObject({ baseline: 30, sampleCount: 7, message: "Recovery looks good" });
    expect(assessWellness(data("hrvSdnnMs", 30, 35, 6), "hrvSdnnMs", day).message).toBe("Still learning your usual rhythm");
    expect(assessWellness(data("hrvSdnnMs", 30, 35, 8).map((r, i) => i === 1 ? record(r.day, "hrvSdnnMs", 50) : r), "hrvSdnnMs", day).baseline).toBe(30);
  });
  it("does not fall back for missing values and keeps valid zero", () => {
    expect(assessWellness(data("stepsCount", 100, 0), "stepsCount", day).message).toBe("Less active; take your time");
    expect(assessWellness([record(day, "stepsCount", null), ...data("stepsCount", 100, 0).slice(1)], "stepsCount", day).message).toBe("No record for this day");
    expect(assessWellness([], "stepsCount", day).message).toBe("No record for this day");
  });
  it("keeps descriptive indicators and low heart rate neutral", () => {
    for (const [key, baseline, current] of [["stepsCount", 100, 200], ["stepsCount", 100, 0], ["spo2Percent", 97, 99], ["restingHeartRateBpm", 60, 50], ["avgSleepingHeartRateBpm", 60, 50]] as [WellnessAssessmentKey, number, number][]) expect(assessWellness(data(key, baseline, current), key, day).level).toBe("neutral");
    expect(assessWellness(data("spo2Percent", 97, 95), "spo2Percent", day).level).toBe("unfavorable");
  });
});
