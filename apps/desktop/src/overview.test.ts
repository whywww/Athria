import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OverviewDashboard, RecoveryHelpModal, SummaryProgressRing, calendarDays, durationAxis, formatWellnessDate, formatWellnessRange, loadAxisLabel, mesocycleProgress, overviewDateRange, recoveryRingTone, recoveryStatus, sparklineGeometry, twelveWeekConsistency, weeklyLoad, weeklyOverview, weeklyRingProgress, frequencyAxis, wellnessHighlights } from "./overview";
import { LanguageProvider } from "./i18n";
import type { CalendarSession, TrainingHistorySession, TrainingSummary, WellnessRecord } from "./view-models";
import { addDays } from "./plan/view";

const quality = { completeness: 1, missingFields: [], anomalies: [] };
const summary: TrainingSummary = {
  periodDays: 7, sessionCount: 3, totalDurationMinutes: 135,
  byDomain: { strength: 1, endurance: 1, sport_skill: 1, mind_body: 0, mobility: 0, functional: 0 },
  durationMinutesByDomain: { strength: 45, endurance: 30, sport_skill: 60, mind_body: 0, mobility: 0, functional: 0 },
  sports: [{ name: "Basketball", sessionCount: 1, durationMinutes: 60 }],
  metrics: { strength: { workingSets: { value: 8, unit: "sets", dataQuality: quality } }, endurance: { distanceMeters: { value: 5000, unit: "m", dataQuality: quality } } },
};

const field = (value: number) => ({ value, source: "intervals_icu" as const, updatedAt: "2026-09-10T00:00:00Z" });
const wellness: WellnessRecord[] = [
  { ownerId: "local-user", day: "2026-09-10", fields: { readiness: field(72), sleepScore: field(84), sleepSeconds: field(28000), hrvRmssdMs: field(55), restingHeartRateBpm: field(50) }, updatedAt: "2026-09-10T00:00:00Z" },
  { ownerId: "local-user", day: "2026-09-09", fields: { readiness: field(70), sleepScore: field(86), hrvRmssdMs: field(50), restingHeartRateBpm: field(51) }, updatedAt: "2026-09-09T00:00:00Z" },
];

describe("Overview", () => {
  it("renders summary ring tracks, animated arcs, full rings and missing values", () => {
    const render = (percent: number, entranceProgress = 1, tone = "plan", children = "50%") => renderToStaticMarkup(createElement(SummaryProgressRing, { percent, entranceProgress, tone, children }));
    expect(render(0)).not.toContain('class="summary-ring-fill"');
    expect(render(50, .5)).toContain('stroke-dasharray="25 100"');
    expect(render(100)).toContain('class="summary-ring-fill"');
    expect(render(100)).not.toContain("stroke-dasharray");
    expect(render(0, 1, "empty", "-")).toContain("<b>-</b>");
    expect(render(0, 1, "empty", "-")).not.toContain('class="summary-ring-fill"');
    const rings = renderToStaticMarkup(createElement("div", null, createElement(SummaryProgressRing, { percent: 50, children: "50%" }), createElement(SummaryProgressRing, { percent: 75, children: "75" })));
    const ids = [...rings.matchAll(/<linearGradient id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(2);
  });
  it("derives Monday-to-today and leap-month bounds", () => {
    expect(overviewDateRange("2028-02-29")).toEqual({ weekStart: "2028-02-28", monthStart: "2028-02-01", monthEnd: "2028-02-29" });
  });

  it("prioritizes completed markers and omits skipped plans", () => {
    const history = [{ id: "done", name: "Run", startAt: "2026-09-10T16:30:00Z", timezone: null, domains: ["endurance"], type: "Run", subtype: null, durationMinutes: 30 }] as TrainingHistorySession[];
    const planned = [{ scheduledDate: "2026-09-11", status: "planned" }, { scheduledDate: "2026-09-12", status: "skipped" }] as CalendarSession[];
    const days = calendarDays("2026-09-11", history, planned, "Asia/Hong_Kong");
    expect(days.find((item) => item.day === "2026-09-11")?.marker).toBe("completed");
    expect(days.find((item) => item.day === "2026-09-12")?.markers).toEqual([]);
  });

  it("always reserves six calendar weeks", () => {
    const fiveWeekMonth = calendarDays("2026-09-11", [], []);
    const sixWeekMonth = calendarDays("2026-08-11", [], []);

    expect(fiveWeekMonth).toHaveLength(42);
    expect(fiveWeekMonth.at(-1)?.day).toBeNull();
    expect(sixWeekMonth).toHaveLength(42);
    expect(sixWeekMonth.filter((item) => item.day === null)).toHaveLength(11);
    expect(sixWeekMonth.findIndex((item) => item.day === "2026-08-01")).toBe(5);
    expect(sixWeekMonth.findIndex((item) => item.day === "2026-08-31")).toBe(35);
  });

  it("selects only fields on the latest valid date and compares their history", () => {
    const result = wellnessHighlights(wellness, "2026-09-11")!;
    expect(result.start).toBe("2026-09-09");
    expect(result.end).toBe("2026-09-10");
    expect(result.values.map((item) => item.key)).toEqual(["sleepScore", "hrvRmssdMs", "restingHeartRateBpm", "sleepSeconds"]);
    expect(result.values.find((item) => item.key === "hrvRmssdMs")).toMatchObject({ display: "55", measurementDay: "2026-09-10", delta: 5, series: [50, 55] });
  });
  it("shows sleep on its stored evening and excludes tomorrow's records", () => {
    const result = wellnessHighlights([
      { ownerId: "local-user", day: "2026-10-09", fields: { sleepScore: field(80) }, updatedAt: "2026-10-09T00:00:00Z" },
      { ownerId: "local-user", day: "2026-10-10", fields: { sleepScore: field(20), hrvRmssdMs: field(60) }, updatedAt: "2026-10-10T00:00:00Z" },
    ], "2026-10-09")!;
    expect(result.end).toBe("2026-10-09");
    expect(result.values).toHaveLength(1);
    expect(result.values[0]).toMatchObject({ key: "sleepScore", display: "80", measurementDay: "2026-10-09" });
  });
  it("reads the single sleep duration in highlights for device and manual sources", () => {
    const base: WellnessRecord = { ownerId: "local-user", day: "2026-10-09", fields: { sleepSeconds: field(28800) }, updatedAt: "2026-10-09T00:00:00Z" };
    expect(wellnessHighlights([base], base.day)?.values[0]).toMatchObject({ key: "sleepSeconds", display: "8:00", series: [28800] });
    expect(wellnessHighlights([{ ...base, fields: { sleepSeconds: { ...field(27000), source: "user" } } }], base.day)?.values[0]).toMatchObject({ display: "7:30", series: [27000] });
  });

  it("excludes metrics missing on the common end day", () => {
    const records: WellnessRecord[] = [
      { ownerId: "local-user", day: "2026-09-11", fields: {}, updatedAt: "2026-09-11T00:00:00Z" },
      { ownerId: "local-user", day: "2026-09-10", fields: { restingHeartRateBpm: field(50), hrvSdnnMs: { ...field(0), value: null } }, updatedAt: "2026-09-11T00:00:00Z" },
      { ownerId: "local-user", day: "2026-09-09", fields: { restingHeartRateBpm: field(51), hrvSdnnMs: field(24) }, updatedAt: "2026-09-11T00:00:00Z" },
    ];
    const result = wellnessHighlights(records, "2026-09-11")!;
    expect(result.values.map(({ key }) => key)).toEqual(["restingHeartRateBpm"]);
    expect(result.values[0]).toMatchObject({ display: "50", series: [51, 50], delta: -1 });
  });

  it("formats wellness dates and the shared actual range without a status prefix", () => {
    expect(formatWellnessDate("2026-09-11")).toBe("Sep 11, 2026");
    expect(formatWellnessRange("2026-08-29", "2026-09-11")).toBe("Aug 29 – Sep 11, 2026");
    expect(formatWellnessRange("2025-12-28", "2026-01-10")).toBe("Dec 28, 2025 – Jan 10, 2026");
    expect(formatWellnessRange("2026-09-11", "2026-09-11")).toBe("Sep 11, 2026");
  });

  it("renders personal baseline feedback with date and comparison details in the tooltip", () => {
    const records: WellnessRecord[] = [
      { ownerId: "local-user", day: "2026-10-05", fields: { hrvSdnnMs: field(35) }, updatedAt: "2026-10-06T00:00:00Z" },
      ...Array.from({ length: 7 }, (_, index) => ({ ownerId: "local-user", day: `2026-09-${String(28 - index).padStart(2, "0")}`, fields: { hrvSdnnMs: field(30) }, updatedAt: "2026-10-06T00:00:00Z" })),
    ];
    const props = { summary, wellness: records, history: [], planned: [], today: "2026-10-06", timezone: "Asia/Hong_Kong" };
    const html = renderToStaticMarkup(createElement(OverviewDashboard, props));
    expect(html).toContain('class="wellness-assessment favorable"');
    expect(html).toContain(">Recovery looks good</small>");
    expect(html).toContain("Assessment date: Oct 5, 2026");
    expect(html).toContain("Personal baseline: 30");
    expect(html).toContain("Valid days: 7");
    expect(html).toContain("Comparison threshold: ±10%");
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    try {
      const localized = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(OverviewDashboard, props)));
      expect(localized).toContain(">恢复表现不错</small>");
      expect(localized).toContain("评估日期: 2026年10月5日");
      expect(localized).toContain("个人基线: 30");
      expect(localized).toContain("柱：频次");
      expect(localized).toContain("线：时长");
      expect(localized).toContain("未设置目标");
      for (const label of ["力量", "耐力", "技能", "身心", "灵活", "功能"]) expect(localized).toContain(`<span>${label}</span>`);
      expect(localized).toContain("activity-chart-axis-units");
      expect(localized).toContain('aria-label="力量训练:');
    } finally {
      vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
      renderToStaticMarkup(createElement(LanguageProvider, null, createElement("span", null, "reset")));
      vi.unstubAllGlobals();
    }
  });

  it("bounds numeric precision and keeps SpO2 at exactly one decimal", () => {
    const record: WellnessRecord = { ownerId: "local-user", day: "2026-09-23", fields: { restingHeartRateBpm: field(65.333336), stepsCount: field(14055), hrvSdnnMs: field(24.123456), spo2Percent: field(96.333336) }, updatedAt: "2026-09-23T00:00:00Z" };
    expect(wellnessHighlights([record], "2026-09-23")!.values.map(({ display }) => display)).toEqual(["65.3", "14055", "24.1", "96.3"]);
    record.fields.spo2Percent = field(95);
    expect(wellnessHighlights([record], "2026-09-23")!.values.find(({ key }) => key === "spo2Percent")?.display).toBe("95.0");
  });

  it("builds bounded smooth trend geometry from at most seven daily slots", () => {
    const geometry = sparklineGeometry([Number.NaN, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])!;
    expect(geometry.points).toHaveLength(7);
    expect(geometry.linePath).toMatch(/^M 4 /);
    expect(geometry.linePath).toContain(" C ");
    expect(geometry.linePath).toMatch(/ 96 /);
    expect(geometry.points.every(({ y }) => y >= 5 && y <= 32)).toBe(true);
    expect(geometry.areaPath).toMatch(/L 96 39 L 4 39 Z$/);
  });

  it("restricts wellness series and fields to the shared actual window", () => {
    const records: WellnessRecord[] = [
      { ownerId: "local-user", day: "2026-09-10", fields: { sleepScore: field(80), hrvRmssdMs: field(60) }, updatedAt: "2026-09-10T00:00:00Z" },
      { ownerId: "local-user", day: "2026-08-25", fields: { sleepScore: field(70), weightKg: field(70) }, updatedAt: "2026-08-25T00:00:00Z" },
      { ownerId: "local-user", day: "2026-08-20", fields: { restingHeartRateBpm: field(44) }, updatedAt: "2026-08-20T00:00:00Z" },
    ];
    const result = wellnessHighlights(records, "2026-09-10")!;
    expect(result.start).toBe("2026-09-10");
    expect(result.end).toBe("2026-09-10");
    expect(result.values.map((item) => item.key)).toEqual(["sleepScore", "hrvRmssdMs"]);
    expect(result.values.find((item) => item.key === "hrvRmssdMs")?.series).toEqual([60]);
    expect(result.values.find((item) => item.key === "restingHeartRateBpm")).toBeUndefined();
    expect(wellnessHighlights(records, "2026-10-01")?.end).toBe("2026-09-10");
  });

  it("handles empty, single, two-point, and flat wellness trends", () => {
    expect(sparklineGeometry([])).toBeNull();
    expect(sparklineGeometry([42])?.points).toEqual([{ x: 50, y: 18.5 }]);
    expect(sparklineGeometry([1, 2])?.linePath).toBe("M 4 32 C 34.667 23 65.333 14 96 5");
    expect(sparklineGeometry([3, 3, 3])?.points.every(({ y }) => y === 18.5)).toBe(true);
  });

  it("anchors seven days on the latest measurement and shares the union of selected dates", () => {
    const record = (day: string, fields: WellnessRecord["fields"]): WellnessRecord => ({ ownerId: "local-user", day, fields, updatedAt: "2026-10-06T00:00:00Z" });
    const records = [
      record("2026-10-06", {}),
      record("2026-10-05", { spo2Percent: field(95) }),
      record("2026-10-04", { restingHeartRateBpm: field(65), hrvSdnnMs: field(25) }),
      record("2026-10-02", { restingHeartRateBpm: field(66), hrvSdnnMs: field(24) }),
      record("2026-09-29", { stepsCount: field(14055) }),
      record("2026-09-28", { sleepScore: field(80), restingHeartRateBpm: field(99) }),
    ];
    const result = wellnessHighlights(records, "2026-10-06")!;
    expect(result).toMatchObject({ start: "2026-10-05", end: "2026-10-05" });
    expect(result.values.map(({ key }) => key)).toEqual(["spo2Percent"]);
    expect(result.values[0]).toMatchObject({ display: "95.0", measurementDay: "2026-10-05", series: [95] });
  });

  it("takes the first four latest-day candidates in the existing priority order", () => {
    const records: WellnessRecord[] = [{ ownerId: "local-user", day: "2026-10-05", updatedAt: "2026-10-05T00:00:00Z", fields: { hrvRmssdMs: field(50), restingHeartRateBpm: field(60), vo2maxMlKgMin: field(40), stepsCount: field(100), hrvSdnnMs: field(30), spo2Percent: field(98) } }];
    expect(wellnessHighlights(records, "2026-10-09")!.values.map(({ key }) => key)).toEqual(["hrvRmssdMs", "restingHeartRateBpm", "vo2maxMlKgMin", "stepsCount"]);
  });

  it("displays valid zero values on the common end day", () => {
    const records: WellnessRecord[] = [
      { ownerId: "local-user", day: "2026-10-04", fields: { stepsCount: field(14055), spo2Percent: field(95) }, updatedAt: "2026-10-04T00:00:00Z" },
      { ownerId: "local-user", day: "2026-10-05", fields: { stepsCount: field(0), spo2Percent: field(0) }, updatedAt: "2026-10-05T00:00:00Z" },
    ];
    expect(wellnessHighlights(records, "2026-10-06")!.values.map(({ display }) => display)).toEqual(["0", "0.0"]);
  });

  it("displays older measurements and assesses their recorded date", () => {
    const records: WellnessRecord[] = [
      { ownerId: "local-user", day: "2026-10-05", fields: { restingHeartRateBpm: field(67), stepsCount: field(15615), hrvSdnnMs: field(35), spo2Percent: field(98.7) }, updatedAt: "2026-10-05T00:00:00Z" },
      { ownerId: "local-user", day: "2026-10-03", fields: { restingHeartRateBpm: field(65) }, updatedAt: "2026-10-03T00:00:00Z" },
    ];
    const result = wellnessHighlights(records, "2026-10-07")!;
    expect(result).toMatchObject({ start: "2026-10-03", end: "2026-10-05" });
    expect(result.values.map(({ display }) => display)).toEqual(["67", "15615", "35", "98.7"]);
    expect(result.values.every((item) => item.measurementDay === "2026-10-05" && item.assessment.message !== "No record for this day")).toBe(true);
    expect(result.values[0]?.series).toEqual([65, null, 67]);
    expect(wellnessHighlights(records, "2026-10-06")!.values.map(({ display }) => display)).toEqual(["67", "15615", "35", "98.7"]);
    expect(wellnessHighlights(records, "2026-10-05")!.values.map(({ display }) => display)).toEqual(["67", "15615", "35", "98.7"]);
  });

  it("ignores unsupported and future measurements and centers a shared single-day range", () => {
    const records: WellnessRecord[] = [
      { ownerId: "local-user", day: "2026-10-06", fields: { weightKg: field(70) }, updatedAt: "2026-10-06T00:00:00Z" },
      { ownerId: "local-user", day: "2026-10-08", fields: { sleepScore: field(80) }, updatedAt: "2026-10-08T00:00:00Z" },
    ];
    expect(wellnessHighlights(records, "2026-10-06")).toBeNull();
    expect(wellnessHighlights([], "2026-10-06")).toBeNull();
    records.push({ ownerId: "local-user", day: "2026-10-05", fields: { spo2Percent: field(95) }, updatedAt: "2026-10-06T00:00:00Z" });
    const result = wellnessHighlights(records, "2026-10-06")!;
    expect(result).toMatchObject({ start: "2026-10-05", end: "2026-10-05" });
    expect(sparklineGeometry(result.values[0]!.series)?.points).toEqual([{ x: 50, y: 18.5 }]);
    expect(sparklineGeometry([null, null])).toBeNull();
  });

  it("calculates weekly targets including future sessions but excluding skipped and other weeks", () => {
    const planned = [
      { scheduledDate: "2026-09-07", status: "completed", durationMinutes: 40 },
      { scheduledDate: "2026-09-13", status: "planned", durationMinutes: 60 },
      { scheduledDate: "2026-09-11", status: "skipped", durationMinutes: 30 },
      { scheduledDate: "2026-09-14", status: "planned", durationMinutes: 90 },
      { scheduledDate: "2026-09-06", status: "completed", durationMinutes: 90 },
    ] as CalendarSession[];
    expect(weeklyOverview("2026-09-11", [], planned, "Asia/Hong_Kong")).toMatchObject({ planTotal: 2, planMinutes: 100 });
    expect(weeklyOverview("2026-09-11", [], [], "UTC")).toMatchObject({ planTotal: 0, planMinutes: 0 });
  });

  it("preserves full laps and the remaining progress without capping the percentage", () => {
    expect(weeklyRingProgress(20, 0)).toMatchObject({ ratio: 0, percent: 0 });
    expect(weeklyRingProgress(0, 10)).toMatchObject({ remainder: 0, full: false });
    expect(weeklyRingProgress(10, 10)).toMatchObject({ remainder: 1, full: true, percent: 100 });
    expect(weeklyRingProgress(15, 10)).toMatchObject({ remainder: .5, full: true, percent: 150 });
    expect(weeklyRingProgress(32, 10)).toMatchObject({ remainder: expect.closeTo(.2), percent: 320 });
    expect(weeklyRingProgress(30, 10)).toMatchObject({ remainder: 1, percent: 300 });
  });

  it("keeps every axis at four evenly spaced ticks", () => {
    expect(frequencyAxis(0).ceiling).toBeGreaterThan(0);
    expect(frequencyAxis(108).ceiling).toBeGreaterThanOrEqual(108);
    expect(frequencyAxis(2).ticks).toEqual([0, 1, 2, 3]);
    expect(frequencyAxis(7).ticks).toEqual([0, 3, 6, 9]);
  });

  it("renders both charts and empty goal rings even with no recorded workouts", () => {
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary: { ...summary, sessionCount: 0, totalDurationMinutes: 0, byDomain: {}, durationMinutesByDomain: {} }, wellness: [], history: [], planned: [], today: "2026-09-11", timezone: "UTC" }));
    expect(html).toContain('data-chart="weekly-combined"');
    expect(html).toContain("activity-duration-line");
    expect(html).not.toContain("weekly-ring-goals");
    expect(html.match(/top:96.15384615384616%/g)).toHaveLength(6);
    expect(html).toContain('style="bottom:0%"');
    expect(html).toContain('r="86"');
    expect(html.match(/activity-chart-bar zero/g)).toHaveLength(6);
    expect(html).toContain("No target set");
    expect(html).toContain("weekly-rings-center");
    expect(html).not.toContain("No completed workouts yet this week.");
  });

  it("labels the duration curve at every domain without bar count labels", () => {
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness: [], history: [], planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain('<path d="M 8.333');
    expect(html).not.toContain("<polyline");
    expect(html.match(/class="zero"/g)).toHaveLength(3);
    for (const value of [45, 30, 60]) expect(html).toContain(`>${value}</span>`);
    expect(html).not.toContain("<b>1</b>");
    expect(html).toContain("bottom:11px");
    const count = (needle: string) => html.split(needle).length - 1;
    expect(count(`style="bottom:${1 / 3 * 100}%"`)).toBe(2);
    expect(count(`style="bottom:${2 / 3 * 100}%"`)).toBe(2);

    const empty = renderToStaticMarkup(createElement(OverviewDashboard, { summary: { ...summary, sessionCount: 0, totalDurationMinutes: 0, byDomain: {}, durationMinutesByDomain: {} }, wellness: [], history: [], planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(empty.match(/class="zero"/g)).toHaveLength(6);
    expect(empty).not.toContain("<b>0</b>");
  });

  it("keeps four evenly divided ticks so the minute labels align with the grid lines", () => {
    expect(durationAxis(0)).toEqual({ ceiling: 15, ticks: [0, 5, 10, 15] });
    expect(durationAxis(45)).toEqual({ ceiling: 60, ticks: [0, 20, 40, 60] });
    expect(durationAxis(53)).toEqual({ ceiling: 75, ticks: [0, 25, 50, 75] });
    expect(durationAxis(60).ceiling).toBeGreaterThanOrEqual(75);
  });

  it("compares the current week with the matching elapsed days last week", () => {
    const history = [
      { id: "current", startAt: "2026-09-08T04:00:00Z", durationMinutes: 90 },
      { id: "previous", startAt: "2026-09-01T04:00:00Z", durationMinutes: 60 },
    ] as TrainingHistorySession[];
    const result = weeklyOverview("2026-09-11", history, [], "Asia/Hong_Kong");
    expect(result.sessionDelta).toBe(0);
    expect(result.durationPercent).toBe(50);
  });

  it("compares actual minutes by local weekday across the month boundary", () => {
    const history = [
      { startAt: "2026-09-07T16:30:00Z", durationMinutes: 45 },
      { startAt: "2026-09-08T04:00:00Z", durationMinutes: 15 },
      { startAt: "2026-08-31T16:30:00Z", durationMinutes: 90 },
      { startAt: "2026-09-06T04:00:00Z", durationMinutes: 30 },
      { startAt: "2026-09-12T04:00:00Z", durationMinutes: 100 },
    ] as TrainingHistorySession[];
    const load = weeklyLoad("2026-09-11", history, "Asia/Hong_Kong");
    expect(load[1]).toMatchObject({ day: "2026-09-08", previousDay: "2026-09-01", current: 60, previous: 90 });
    expect(load[6]).toMatchObject({ current: 0, previous: 30 });
    expect(load[5]?.current).toBe(0);
    expect(load[0]).toMatchObject({ current: 0, previous: 0 });
    expect(weeklyLoad("2026-09-11", [], "Asia/Hong_Kong").every((day) => day.current === 0 && day.previous === 0)).toBe(true);
  });

  it("overlays independently scaled weeks and excludes planned training", () => {
    const history = [
      { startAt: "2026-09-08T04:00:00Z", durationMinutes: 60 },
      { startAt: "2026-09-01T04:00:00Z", durationMinutes: 90 },
    ] as TrainingHistorySession[];
    const planned = [{ scheduledDate: "2026-09-09", status: "planned", durationMinutes: 300 }] as CalendarSession[];
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness: [], history, planned, today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain('class="load-previous" style="height:100%"');
    expect(html).toContain('class="load-current" style="height:66.66666666666666%"');
    expect(html).toContain('<span>1.5h</span>');
    expect(html).toContain('class="load-legend"');
    expect(html).toContain('This week (2026-09-08): 60 min');
    expect(html).toContain('Last week (2026-09-01): 90 min');
    expect(html).toContain('aria-label="Tue · This week');
    expect(html).not.toContain('load-planned');
    const empty = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness: [], history: [], planned, today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(empty).not.toContain('class="load-previous" style=');
    expect(empty).not.toContain('class="load-current" style=');
    expect(empty).toContain('No prior data');
  });

  it("formats compact load axis labels", () => {
    expect(loadAxisLabel(30)).toBe("30m");
    expect(loadAxisLabel(60)).toBe("1h");
    expect(loadAxisLabel(90)).toBe("1.5h");
    expect(loadAxisLabel(75)).toBe("75m");
    expect(loadAxisLabel(150)).toBe("2.5h");
  });

  it("scales the weekly load axis to the heaviest day", () => {
    const history = [{ id: "heavy", startAt: "2026-09-07T04:00:00Z", durationMinutes: 70 }] as TrainingHistorySession[];
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness: [], history, planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain("<span>1.5h</span>");
    expect(html).toContain("<span>45m</span>");
    expect(html).toContain("<span>0h</span>");
  });

  it("omits the redundant empty activity message and links", () => {
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary: { ...summary, sessionCount: 0 }, wellness: [], history: [], planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).not.toContain("No completed workouts yet this week.");
    expect(html).not.toContain(">training apps</button>");
    expect(html).not.toContain(">next plan</button>.");
    expect(html).not.toContain(">Connect to your training apps</button>");
    expect(html).not.toContain("overview-empty-link");
  });

  it("stacks the training load change into two right-aligned lines", () => {
    const history = [
      { id: "previous", startAt: "2026-09-01T04:00:00Z", durationMinutes: 30 },
      { id: "current", startAt: "2026-09-08T04:00:00Z", durationMinutes: 60 },
    ] as TrainingHistorySession[];
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness: [], history, planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain("<span>↑ 100%</span>");
    expect(html).toContain("<span>from last week</span>");
  });

  it("counts mesocycle completion across all weeks for the plan progress card", () => {
    const planned = [
      { scheduledDate: "2026-09-07", status: "completed" },
      { scheduledDate: "2026-09-11", status: "planned" },
      { scheduledDate: "2026-09-14", status: "skipped" },
    ] as CalendarSession[];
    expect(mesocycleProgress(planned)).toEqual({ completed: 1, total: 3, percent: 33 });
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness: [], history: [], planned, today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain("1 / 3");
    expect(html).toContain("this mesocycle");
  });

  it("renders localized mesocycle and weekly-change labels", () => {
    const history = [
      { id: "previous", startAt: "2026-09-01T04:00:00Z", durationMinutes: 30 },
      { id: "current", startAt: "2026-09-08T04:00:00Z", durationMinutes: 60 },
    ] as TrainingHistorySession[];
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    const html = renderToStaticMarkup(createElement(LanguageProvider, null,
      createElement(OverviewDashboard, { summary, wellness: [], history, planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" })));
    expect(html).toContain("本训练周期");
    expect(html).toContain("较上周");
    const wellnessHtml = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness, history: [], planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(wellnessHtml).toContain("还在了解你的日常");
    expect(wellnessHtml).toContain("评估日期: 2026年9月10日");
    expect(formatWellnessDate("2026-09-23")).toBe("2026年9月23日");
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
    renderToStaticMarkup(createElement(LanguageProvider, null, createElement("span", null, "reset")));
    vi.unstubAllGlobals();
  });

  it("builds a timezone-aware twelve-week consistency window", () => {
    const history = [{ id: "done", startAt: "2026-09-10T16:30:00Z" }] as TrainingHistorySession[];
    const days = twelveWeekConsistency("2026-09-11", history, "Asia/Hong_Kong");
    expect(days).toHaveLength(84);
    expect(days[0]?.day).toBe("2026-06-22");
    expect(days.at(-1)).toMatchObject({ day: "2026-09-13", active: false, future: true });
    expect(days.find((item) => item.day === "2026-09-11")).toMatchObject({ active: true, future: false });
  });

  it("renders consistency squares only through today", () => {
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness: [], history: [], planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain('title="2026-09-11"');
    expect(html).not.toContain('title="2026-09-12"');
    expect(html).not.toContain('title="2026-09-13"');
  });

  const recoveryRecord = (day: string, fields: WellnessRecord["fields"]): WellnessRecord => ({ ownerId: "local-user", day, fields, updatedAt: `${day}T00:00:00Z` });
  const core = { sleepScore: field(85), hrvRmssdMs: field(50), restingHeartRateBpm: field(50) };
  const recoveryHistory = (day: string, fields: WellnessRecord["fields"] = core, count = 7) => Array.from({ length: count }, (_, index) => recoveryRecord(addDays(day, -index - 2), fields));
  const recoveryPair = (day: string, fields: WellnessRecord["fields"], value = 90) => [recoveryRecord(addDays(day, -1), { ...fields, readiness: { ...field(value), source: "athria" } }), recoveryRecord(day, fields)];
  it("reads persisted Athria scores and never calculates or substitutes other dates", () => {
    const score = (day: string, value: number, source: "athria" | "intervals_icu" = "athria") => recoveryRecord(day, { readiness: { ...field(value), source } });
    expect(recoveryStatus([score("2026-10-05", 90)], "2026-10-06")).toMatchObject({ value: 90, label: "Ready", day: "2026-10-05", signalCount: 3 });
    expect(recoveryStatus([score("2026-10-05", 45)], "2026-10-06")).toMatchObject({ value: 45, label: "Caution" });
    expect(recoveryStatus([score("2026-10-05", 44)], "2026-10-06")).toMatchObject({ value: 44, label: "Rest" });
    for (const records of [[], [score("2026-10-04", 90)], [score("2026-10-06", 90)], [score("2026-10-05", 90, "intervals_icu")], [...recoveryPair("2026-10-06", core).map((record) => ({ ...record, fields: core })), ...recoveryHistory("2026-10-06")]]) {
      expect(recoveryStatus(records, "2026-10-06")).toMatchObject({ value: null, day: null, signalCount: 0 });
    }
    const history = Array.from({ length: 7 }, (_, index) => score(addDays("2026-10-05", -index), 90 - index));
    expect(recoveryStatus([...history, { ...score("2026-10-04", 10), ownerId: "other-user" }, score("2026-10-06", 30)], "2026-10-06").series).toEqual([86, 87, 88, 89, 90]);
  });

  it("maps recovery verdicts to readiness ring tones", () => {
    expect(recoveryRingTone("Ready")).toBe("ready");
    expect(recoveryRingTone("Caution")).toBe("caution");
    expect(recoveryRingTone("Rest")).toBe("rest");
    expect(recoveryRingTone("-")).toBe("empty");
  });

  it.each(["en", "zh-CN"])("renders exactly one readiness line for every state in %s", (language) => {
    vi.stubGlobal("localStorage", { getItem: () => language, setItem: () => {} });
    try {
      const cases: [WellnessRecord["fields"] | null, string, string, number | null][] = [
        [core, "Ready to train", "可以训练", 90],
        [{ ...core, hrvRmssdMs: field(40), restingHeartRateBpm: field(55), sleepScore: field(70) }, "Train with care", "谨慎训练", 45],
        [{ ...core, hrvRmssdMs: field(40), restingHeartRateBpm: field(57), sleepScore: field(50) }, "Prioritize recovery", "优先恢复", 30],
        [{ hrvRmssdMs: field(50), restingHeartRateBpm: field(50) }, "Insufficient data", "数据不足", null],
        [null, "Insufficient data", "数据不足", null],
      ];
      for (const day of ["2026-10-06"]) {
        for (const [fields, english, chinese, value] of cases) {
          const records = fields ? [...(value === null ? [recoveryRecord(addDays(day, -1), fields)] : recoveryPair(day, fields, value)), ...recoveryHistory(day)] : [];
          const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(OverviewDashboard, { summary, wellness: records, history: [], planned: [], today: "2026-10-06", timezone: "Asia/Hong_Kong" })));
          const card = html.match(/<article class="overview-summary-card recovery-summary">[\s\S]*?<\/article>/)![0];
          expect(card).toContain(`<small>${language === "en" ? english : chinese}</small>`);
          expect(card.match(/<small>/g)).toHaveLength(1);
          expect(card).not.toContain("<time");
          expect(card).not.toContain("Assessment date");
          expect(card).not.toContain("评估日期");
          expect(card).not.toContain("Based on");
          expect(card).not.toContain("依据");
        }
      }
    } finally {
      vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
      renderToStaticMarkup(createElement(LanguageProvider, null, createElement("span", null, "reset")));
      vi.unstubAllGlobals();
    }
  });

  it("hides assessment dates and keeps incomplete readiness empty", () => {
    const card = (records: WellnessRecord[]) => {
      const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness: records, history: [], planned: [], today: "2026-10-06", timezone: "Asia/Hong_Kong" }));
      return { html, recovery: html.match(/<article class="overview-summary-card recovery-summary">[\s\S]*?<\/article>/)![0] };
    };
    const today = card([...recoveryPair("2026-10-06", core), ...recoveryHistory("2026-10-06")]);
    expect(today.recovery).toContain("<small>Ready to train</small>");
    expect(today.recovery).not.toContain("Assessment date");
    expect(today.recovery).not.toContain("<time");
    expect(today.recovery).toContain('class="progress-ring ready"');
    expect(today.recovery).toContain("<b>90</b>");
    const yesterday = card([recoveryRecord("2026-10-05", core), ...recoveryHistory("2026-10-06")]);
    expect(yesterday.recovery).toContain("<small>Insufficient data</small>");
    expect(yesterday.recovery).not.toContain("Assessment date");
    expect(yesterday.recovery).not.toContain("<time");
    const stale = card([...recoveryPair("2026-10-04", core), ...recoveryHistory("2026-10-04")]);
    expect(stale.recovery).toContain("<strong>-</strong>");
    expect(stale.recovery).toContain("Insufficient data");
    expect(stale.recovery).toContain('class="progress-ring empty"');
    expect(stale.recovery).toContain("<b>-</b>");
    expect(stale.recovery).not.toContain("Assessment date");
    expect(stale.html).toContain('data-chart="wellness-trend"');
  });

  it("localizes readiness advice, empty state and the revised calculation help", () => {
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    try {
      const render = (records: WellnessRecord[]) => renderToStaticMarkup(createElement(LanguageProvider, null, createElement(OverviewDashboard, { summary, wellness: records, history: [], planned: [], today: "2026-10-06", timezone: "Asia/Hong_Kong" })));
      expect(render([...recoveryPair("2026-10-06", core), ...recoveryHistory("2026-10-06")])).toContain("<small>可以训练</small>");
      expect(render([...recoveryPair("2026-10-05", core), ...recoveryHistory("2026-10-05")])).toContain("<small>数据不足</small>");
      const empty = render([]);
      expect(empty).toContain("<strong>-</strong>");
      expect(empty).toContain("<small>数据不足</small>");
      const help = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(RecoveryHelpModal, { onClose: () => undefined })));
      expect(help).not.toContain("同一天的三项指标必须齐全");
      expect(help).toContain("Athria 估计规则");
      expect(help).toContain("至少需要两个恢复维度");
      expect(help).not.toContain("每项指标取 30、45、60、75 或 90 分");
      expect(help).toContain("并非经过科学验证");
    } finally {
      vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
      renderToStaticMarkup(createElement(LanguageProvider, null, createElement("span", null, "reset")));
      vi.unstubAllGlobals();
    }
  });

  it("shows the core breakdown, its morning date and missing data without recalculating", () => {
    const assessment: NonNullable<WellnessRecord["readinessAssessment"]> = {
      algorithmVersion: "athria-readiness-v2", assessmentDay: "2026-10-06", score: 69, status: "Caution",
      cardiacScore: 85, sleepScore: null, subjectiveScore: 50, baseScore: 71.5,
      loadAdjustment: 0, loadMethod: null, scoreCap: 69, dataQuality: "limited",
      missingReasons: ["Sleep not included", "Training load not included"],
      hrvField: "hrvRmssdMs", heartRateField: null, hrvBaselineDays: 14, heartRateBaselineDays: 0,
    };
    const html = renderToStaticMarkup(createElement(RecoveryHelpModal, { assessment, onClose: () => undefined }));
    expect(html).toContain("Readiness breakdown");
    expect(html).toContain("Oct 6, 2026");
    expect(html).toContain("Limited data");
    expect(html).toContain("<dt>Weighted base score</dt><dd>71.5</dd>");
    expect(html).toContain("<dt>Final readiness</dt><dd>69</dd>");
    expect(html).not.toContain("Sleep not included");
    expect(html).not.toContain("Training load not included");
    expect(html).not.toContain("Wellness influence factor");
    const record = { ...recoveryRecord("2026-10-05", { readiness: { ...field(69), source: "athria" } }), readinessAssessment: assessment };
    expect(recoveryStatus([record], "2026-10-06")).toMatchObject({ value: 69, label: "Caution" });
  });

  it.each(["en", "zh-CN"])("shows only the compact score chain and no load statistics in %s", (language) => {
    vi.stubGlobal("localStorage", { getItem: () => language, setItem: () => {} });
    try {
      const assessment: NonNullable<WellnessRecord["readinessAssessment"]> = {
        algorithmVersion: "athria-readiness-percentile-load", assessmentDay: "2026-10-06", score: 52, status: "Caution",
        cardiacScore: 34, sleepScore: 89, subjectiveScore: 30, baseScore: 52, loadAdjustment: 0, loadMethod: "sessionRpe", scoreCap: 69,
        dataQuality: "limited", missingReasons: [], hrvField: "hrvSdnnMs", heartRateField: "restingHeartRateBpm", hrvBaselineDays: 17, heartRateBaselineDays: 16,
        trainingLoad: {
          status: "not_elevated", recentSessionCount: 6, durationMinutes: 280, ratedSessionCount: 6, knownRpeLoad: 670, knownRpePressure: 236.5,
          combinedAdjustment: 0, wellnessFactor: 0.28, groups: [{
            activityType: null, method: "sessionRpe", recentSessionCount: 6, validSessionCount: 6, durationMinutes: 280,
            knownLoad: 670, knownPressure: 236.5, complete: true, historyWindows: 23, referenceDays: 7, referenceSpanDays: 10,
            percentile: 0.696, evidenceWeight: 0.293, rawAdjustment: 0, weightedAdjustment: 0, durationShare: 1, eligible: true, selected: true, status: "not_elevated",
          }],
        },
      };
      const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(RecoveryHelpModal, { assessment, onClose: () => undefined })));
      const labels = language === "zh-CN"
        ? { base: "加权基础分", deduction: "训练负荷扣分", cap: "分数上限", final: "最终准备度", quality: "数据有限" }
        : { base: "Weighted base score", deduction: "Training load deduction", cap: "Score cap", final: "Final readiness", quality: "Limited data" };
      expect(html).toContain(`<dt>${labels.base}</dt><dd>52</dd>`);
      expect(html).toContain(`<dt>${labels.deduction}</dt><dd>0</dd>`);
      expect(html).toContain(`<dt>${labels.cap}</dt><dd>69</dd>`);
      expect(html).toContain(`<dt>${labels.final}</dt><dd>52</dd>`);
      expect(html).toContain(labels.quality);
      const hidden = language === "zh-CN"
        ? ["历史支持权重", "Wellness 影响系数", "近期训练次数", "负荷计算方式"]
        : ["Historical support weight", "Wellness influence factor", "Recent workouts", "Load method"];
      for (const text of hidden) expect(html).not.toContain(text);
    } finally {
      vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
      renderToStaticMarkup(createElement(LanguageProvider, null, createElement("span", null, "reset")));
      vi.unstubAllGlobals();
    }
  });

  it("renders the recovery help dialog with the plain-language calculation", () => {
    const html = renderToStaticMarkup(createElement(RecoveryHelpModal, { onClose: () => undefined }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain("How We Calculate Overall Readiness");
    expect(html).toContain("Ready · 70+");
    expect(html).toContain("Caution · 45-69");
    expect(html).toContain("Rest · below 45");
    expect(html).not.toContain("All three signals must be available on the same day");
    expect(html).toContain("yesterday evening&#x27;s sleep ending today,");
    expect(html).toContain("At least two recovery dimensions are required");
    expect(html).not.toContain("Each signal receives 30, 45, 60, 75 or 90 points");
    expect(html).toContain("not a scientifically validated score");
    expect(html).not.toContain("Signals with no data are skipped");
    expect(html).toContain("<dt>Final readiness</dt><dd>–</dd>");
    expect(html).not.toContain("Seven-day pressure uses a two-day half-life");
  });

  it("renders featured wellness trends, compact sleep, and never the excluded weight", () => {
    const records: WellnessRecord[] = [
      { ownerId: "local-user", day: "2026-09-10", fields: { sleepSeconds: field(28000), hrvRmssdMs: field(55), restingHeartRateBpm: field(50), vo2maxMlKgMin: field(51.2), weightKg: field(70) }, updatedAt: "2026-09-10T00:00:00Z" },
      { ownerId: "local-user", day: "2026-09-09", fields: { sleepSeconds: field(27900), hrvRmssdMs: field(50), restingHeartRateBpm: field(51), weightKg: field(71) }, updatedAt: "2026-09-09T00:00:00Z" },
    ];
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness: records, history: [], planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain("<span>Sleep time</span>");
    expect(html).toContain('<strong title="7:47">7:47</strong>');
    expect(html).toContain("VO2 max");
    expect(html).not.toContain("VO2 max (ml/kg/min)");
    expect(html).toContain('<strong title="51.2">51.2</strong>');
    expect(html).not.toContain("Weight (kg)");
  });

  it("renders all dashboard sections, fixed domains, wellness trends, and calendar legend", () => {
    const history = [{ id: "current", name: "Basketball", startAt: "2026-09-08T04:00:00Z", timezone: null, domains: ["sport_skill"], type: "Basketball", subtype: null, durationMinutes: 60 }] as TrainingHistorySession[];
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness, history, planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain("Bars: frequency");
    expect(html).toContain("Line: duration");
    expect(html).toContain("<span>Sleep score</span>");
    expect(html).toContain("<strong>-</strong>");
    expect(html).toContain("Insufficient data");
    expect(html).toContain("How to calculate?");
    const readinessTitle = html.match(/<span class="summary-card-title"><span>Readiness<\/span>[\s\S]*?<\/button><\/span>/)?.[0];
    expect(readinessTitle).toContain('class="recovery-help"');
    expect(readinessTitle).toContain('aria-haspopup="dialog"');
    expect(readinessTitle).not.toContain("→");
    expect(html.match(/class="recovery-help"/g)).toHaveLength(1);
    expect(html).not.toContain("recovery-modal");
    expect(html).toContain("HRV RMSSD (ms)");
    expect(html).toContain("Resting HR (bpm)");
    expect(html).toContain('<strong title="55">55</strong>');
    expect(html).not.toContain("55 ms");
    expect(html).toContain("September 2026");
    expect(html).toContain("Mind-body");
    expect(html).toContain("Training Load");
    expect(html).toContain("Consistency");
    expect(html).not.toContain("Skipped plan");
    expect(html).toContain('class="wellness-open" aria-label="Open Training"');
    expect(html).toContain('aria-label="Open Training"');
    expect(html).not.toContain("Completed Workouts");
    expect(html).not.toContain('data-icon="target"');
    expect(html).not.toContain('data-icon="recovery"');
    expect(html).not.toContain('data-chart="green-bars"');
    expect(html).toContain("Plan Progress");
    const leftColumn = html.slice(html.indexOf('class="overview-left-column"'), html.indexOf('class="overview-right-column"'));
    const rightColumn = html.slice(html.indexOf('class="overview-right-column"'));
    expect(leftColumn.indexOf("Plan Progress")).toBeLessThan(leftColumn.indexOf("Your workouts this week"));
    expect(leftColumn.indexOf("Readiness")).toBeLessThan(leftColumn.indexOf("Your workouts this week"));
    expect(leftColumn.indexOf("Your workouts this week")).toBeLessThan(leftColumn.indexOf("Training Load"));
    expect(leftColumn).toContain("Consistency");
    expect(leftColumn).not.toContain("September 2026");
    expect(rightColumn.indexOf("September 2026")).toBeLessThan(rightColumn.indexOf("Wellness"));
    expect(html).toContain("Readiness");
    expect(html).toContain("<b>-</b>");
    expect(html).toContain("activity-chart-column domain-strength");
    expect(html).toContain("activity-chart-column domain-endurance");
    expect(html).toContain("activity-chart-column domain-sport_skill");
    expect(html).toContain("activity-chart-column domain-mind_body");
    expect(html).toContain("activity-chart-column domain-mobility");
    expect(html).toContain("progress-ring");
    expect(html).toContain('class="progress-ring empty"');
    expect(html).toContain("this mesocycle");
    expect(html).toContain('data-icon="trophy"');
    expect(html).toContain('data-range="twelve-weeks"');
    expect(html).toContain('data-chart="wellness-trend"');
    expect(html).toContain('<path class="sparkline-line"');
    expect(html).toContain("<linearGradient");
    expect(html).toContain('fill="url(#wellness-spark-');
    expect(html).toContain('mask="url(#wellness-spark-mask-');
    expect(html).toContain('<time dateTime="2026-09-10">Sep 9 – Sep 10, 2026</time>');
    expect(html.indexOf("September 2026")).toBeLessThan(html.indexOf("Wellness"));
    expect(html).toContain("Still learning your usual rhythm");
    expect(html).not.toContain("Latest ·");
    expect(html).not.toContain("Latest status");
    expect(html).not.toContain("consistency-weekdays");
  });

  it("renders calendar markers in centered groups only on marked days", () => {
    const history = [{ id: "done", name: "Run", startAt: "2026-09-08T04:00:00Z", timezone: null, domains: ["endurance"], type: "Run", subtype: null, durationMinutes: 30 }] as TrainingHistorySession[];
    const planned = [
      { scheduledDate: "2026-09-08", status: "skipped" },
      { scheduledDate: "2026-09-09", status: "planned" },
    ] as CalendarSession[];
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness: [], history, planned, today: "2026-09-11", timezone: "Asia/Hong_Kong" }));

    expect(html).toContain('<span class="mini-day ">7</span>');
    expect(html).toContain('<span class="mini-day-markers"><i class="completed" aria-label="Completed training"></i></span>');
    expect(html).toContain('<span class="mini-day-markers"><i class="planned" aria-label="Scheduled training"></i></span>');
    expect(html).not.toContain("Skipped plan");
    expect(html).not.toContain('class="skipped"');
  });

  it("keeps compact summary visuals when comparison and recovery history are missing", () => {
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary: { ...summary, totalDurationMinutes: 1250 }, wellness: [], history: [], planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain("20 hr 50 min");
    expect(html).toContain("No prior data");
    expect(html).toContain("<strong>-</strong>");
    expect(html).toContain("<b>-</b>");
    expect(html).toContain("0%");
  });
});
