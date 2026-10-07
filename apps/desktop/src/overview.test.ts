import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdjustmentReviewNotice, OverviewDashboard, RecoveryHelpModal, calendarDays, formatWellnessDate, formatWellnessRange, loadAxisLabel, mesocycleProgress, overviewDateRange, recoveryRingTone, recoveryStatus, sparklineGeometry, twelveWeekConsistency, weeklyLoad, weeklyOverview, wellnessHighlights } from "./overview";
import { LanguageProvider } from "./i18n";
import type { AdjustmentAssessment, CalendarSession, TrainingHistorySession, TrainingSummary, WellnessRecord } from "./view-models";
import { adjustmentReasonMessage } from "./view-models";
import { addDays } from "./plan/view";

const quality = { completeness: 1, missingFields: [], anomalies: [] };
const summary: TrainingSummary = {
  periodDays: 7, sessionCount: 3, totalDurationMinutes: 135,
  byDomain: { strength: 1, endurance: 1, sport_skill: 1, mind_body: 0, recovery: 0 },
  durationMinutesByDomain: { strength: 45, endurance: 30, sport_skill: 60, mind_body: 0, recovery: 0 },
  sports: [{ name: "Basketball", sessionCount: 1, durationMinutes: 60 }],
  metrics: { strength: { workingSets: { value: 8, unit: "sets", dataQuality: quality } }, endurance: { distanceMeters: { value: 5000, unit: "m", dataQuality: quality } } },
};

const field = (value: number) => ({ value, source: "intervals_icu" as const, updatedAt: "2026-09-10T00:00:00Z" });
const wellness: WellnessRecord[] = [
  { ownerId: "local-user", day: "2026-09-10", fields: { readiness: field(72), sleepScore: field(84), sleepSeconds: field(28000), hrvRmssdMs: field(55), restingHeartRateBpm: field(50) }, updatedAt: "2026-09-10T00:00:00Z" },
  { ownerId: "local-user", day: "2026-09-09", fields: { readiness: field(70), sleepScore: field(86), hrvRmssdMs: field(50), restingHeartRateBpm: field(51) }, updatedAt: "2026-09-09T00:00:00Z" },
];

describe("Overview", () => {
  const reviewOf = (reviewStatus: AdjustmentAssessment["reviewStatus"], reasons: AdjustmentAssessment["reasons"], dataGaps: AdjustmentAssessment["dataGaps"] = []) => ({
    trigger: "weekly_review", reviewStatus, recommendedScope: "week", reasons, hardOverrides: [], dataGaps,
    currentPlanRevision: 4, inputSnapshotHash: "snapshot", profileHash: "profile", suggestedReadWindow: 3,
  } satisfies AdjustmentAssessment);

  it("renders one tier-colored line naming the strongest review reason", () => {
    const review = reviewOf("review_recommended", [
      { reasonCode: "ADHERENCE_MINOR_DEVIATION", severity: "soft", evidenceRefs: [], affectedScope: "none" },
      { reasonCode: "KEY_SESSION_MISSED", severity: "strong", evidenceRefs: ["session:s1"], affectedDomain: "endurance", affectedScope: "week" },
    ], [{ code: "WELLNESS_EVIDENCE_MISSING", evidenceRefs: [] }]);
    const html = renderToStaticMarkup(createElement(AdjustmentReviewNotice, { value: review }));
    expect(html).toContain("Ask your agent to review the plan: You missed a key Endurance session this week.");
    expect(html).toContain("adjustment-notice-review_recommended");
    expect(html).not.toContain("You missed 1 of the 4 sessions");
    expect(html).not.toContain("Plan Review");
    expect(html).toContain('aria-label="Dismiss message"');
    expect(html).not.toContain("Missing evidence");
  });

  it("escalates the required tier and keeps the neutral copy for watch", () => {
    const required = renderToStaticMarkup(createElement(AdjustmentReviewNotice, { value: reviewOf("review_required", [{ reasonCode: "PROFILE_TRAINING_RHYTHM_CONFLICT", severity: "hard", evidenceRefs: [], affectedScope: "plan" }]) }));
    expect(required).toContain("Plan review required — ask your agent: Your preferred weekly training rhythm differs from this plan.");
    expect(required).toContain("adjustment-notice-review_required");

    const watch = renderToStaticMarkup(createElement(AdjustmentReviewNotice, { value: reviewOf("watch", [{ reasonCode: "ADHERENCE_MINOR_DEVIATION", severity: "soft", evidenceRefs: [], affectedScope: "none" }]) }));
    expect(watch).toContain("Weekly check: You missed 1 of the 4 sessions planned for this week.");
    expect(watch).toContain("adjustment-notice-watch");
  });

  it("stays silent when only evidence is missing and no reason was found", () => {
    const html = renderToStaticMarkup(createElement(AdjustmentReviewNotice, { value: reviewOf("watch", [], [{ code: "WELLNESS_EVIDENCE_MISSING", evidenceRefs: [] }]) }));
    expect(html).toBe("");
  });

  it("falls back to a title-cased label for reason codes the mapping does not know", () => {
    const html = renderToStaticMarkup(createElement(AdjustmentReviewNotice, { value: reviewOf("watch", [{ reasonCode: "SOME_NEW_SIGNAL", severity: "soft", evidenceRefs: [], affectedScope: "none" }]) }));
    expect(html).toContain("Some New Signal");
  });

  it("omits the domain from review reasons that carry none", () => {
    const reason = (value: Partial<AdjustmentAssessment["reasons"][number]>) => ({ reasonCode: "KEY_SESSION_MISSED", severity: "soft", evidenceRefs: [], affectedScope: "week", ...value }) as AdjustmentAssessment["reasons"][number];
    expect(adjustmentReasonMessage(reason({}))).toBe("You missed a key session this week.");
    expect(adjustmentReasonMessage(reason({ reasonCode: "PROFILE_EQUIPMENT_CONFLICT", affectedDomain: "strength" }))).toBe("Some planned exercises need equipment you no longer have.");
  });

  it("derives Monday-to-today and leap-month bounds", () => {
    expect(overviewDateRange("2028-02-29")).toEqual({ weekStart: "2028-02-28", monthStart: "2028-02-01", monthEnd: "2028-02-29" });
  });

  it("prioritizes completed markers and omits skipped plans", () => {
    const history = [{ id: "done", name: "Run", startAt: "2026-09-10T16:30:00Z", timezone: null, domains: ["endurance"], sport: "Run", durationMinutes: 30 }] as TrainingHistorySession[];
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

  it("selects four prioritized wellness fields and compares prior matching values", () => {
    const result = wellnessHighlights(wellness, "2026-09-11")!;
    expect(result.start).toBe("2026-09-09");
    expect(result.end).toBe("2026-09-10");
    expect(result.values.map((item) => item.key)).toEqual(["sleepScore", "hrvRmssdMs", "restingHeartRateBpm", "sleepSeconds"]);
    expect(result.values[0]?.delta).toBe(-2);
    expect(result.values[0]?.series).toEqual([86, 84]);
    expect(result.values[0]?.measurementDay).toBe("2026-09-10");
  });

  it("uses the common end day and shows a dash for missing measurements without losing history", () => {
    const records: WellnessRecord[] = [
      { ownerId: "local-user", day: "2026-09-11", fields: {}, updatedAt: "2026-09-11T00:00:00Z" },
      { ownerId: "local-user", day: "2026-09-10", fields: { restingHeartRateBpm: field(50), hrvSdnnMs: { ...field(0), value: null } }, updatedAt: "2026-09-11T00:00:00Z" },
      { ownerId: "local-user", day: "2026-09-09", fields: { restingHeartRateBpm: field(51), hrvSdnnMs: field(24) }, updatedAt: "2026-09-11T00:00:00Z" },
    ];
    const result = wellnessHighlights(records, "2026-09-11")!;
    expect(result.values.map(({ key, measurementDay }) => ({ key, measurementDay }))).toEqual([
      { key: "restingHeartRateBpm", measurementDay: "2026-09-10" },
      { key: "hrvSdnnMs", measurementDay: "2026-09-10" },
    ]);
    expect(result.values.map(({ display }) => display)).toEqual(["50", "-"]);
    expect(result.values[1]?.series).toEqual([24, null]);
    expect(result.values[1]?.delta).toBeNull();
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness: records, history: [], planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain("Still learning your usual rhythm");
    expect(html).toContain('<strong title="-">-</strong>');
    expect(html).toContain("No record for this day");
    expect(html).not.toContain("No earlier value");
    expect(html).not.toContain("from previous");
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
    expect(result.values.find((item) => item.key === "sleepScore")?.series).toEqual([80]);
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
    expect(result).toMatchObject({ start: "2026-09-29", end: "2026-10-05" });
    expect(result.values.map(({ key }) => key)).toEqual(["restingHeartRateBpm", "stepsCount", "hrvSdnnMs", "spo2Percent"]);
    const hr = result.values[0]!;
    expect(hr.series).toEqual([null, null, null, 66, null, 65, null]);
    expect(result.values.every(({ measurementDay }) => measurementDay === result.end)).toBe(true);
    expect(result.values.map(({ display }) => display)).toEqual(["-", "-", "-", "95.0"]);
    const geometry = sparklineGeometry(hr.series)!;
    expect(geometry.points.map(({ x }) => x)).toEqual([50, 4 + 5 / 6 * 92]);
    expect(sparklineGeometry(result.values[2]!.series)!.points.map(({ x }) => x)).toEqual(geometry.points.map(({ x }) => x));
    expect(geometry.linePath).toContain(" C ");
    expect(geometry.areaPath).toMatch(/L 80\.667 39 L 50 39 Z$/);
    expect(sparklineGeometry(result.values[1]!.series)?.points).toEqual([{ x: 4, y: 18.5 }]);
    expect(sparklineGeometry(result.values[3]!.series)?.points).toEqual([{ x: 96, y: 18.5 }]);
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness: records, history: [], planned: [], today: "2026-10-06", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain('<time dateTime="2026-10-05">Sep 29 – Oct 5, 2026</time>');
    expect(html.match(/Assessment date: Oct 5, 2026/g)).toHaveLength(4);
  });

  it("displays valid zero values on the common end day", () => {
    const records: WellnessRecord[] = [
      { ownerId: "local-user", day: "2026-10-04", fields: { stepsCount: field(14055), spo2Percent: field(95) }, updatedAt: "2026-10-04T00:00:00Z" },
      { ownerId: "local-user", day: "2026-10-05", fields: { stepsCount: field(0), spo2Percent: field(0) }, updatedAt: "2026-10-05T00:00:00Z" },
    ];
    expect(wellnessHighlights(records, "2026-10-06")!.values.map(({ display }) => display)).toEqual(["0", "0.0"]);
  });

  it("hides values and assessments older than yesterday while preserving historical trends", () => {
    const records: WellnessRecord[] = [
      { ownerId: "local-user", day: "2026-10-05", fields: { restingHeartRateBpm: field(67), stepsCount: field(15615), hrvSdnnMs: field(35), spo2Percent: field(98.7) }, updatedAt: "2026-10-05T00:00:00Z" },
      { ownerId: "local-user", day: "2026-10-03", fields: { restingHeartRateBpm: field(65) }, updatedAt: "2026-10-03T00:00:00Z" },
    ];
    const result = wellnessHighlights(records, "2026-10-07")!;
    expect(result).toMatchObject({ start: "2026-10-03", end: "2026-10-05" });
    expect(result.values.map(({ display }) => display)).toEqual(["-", "-", "-", "-"]);
    expect(result.values.every((item) => item.measurementDay === "2026-10-07" && item.delta === null && item.assessment.message === "No record for this day")).toBe(true);
    expect(result.values[0]?.series).toEqual([65, null, 67]);
    expect(wellnessHighlights(records, "2026-10-06")!.values.map(({ display }) => display)).toEqual(["67", "15615", "35", "98.7"]);
    expect(wellnessHighlights(records, "2026-10-05")!.values.map(({ display }) => display)).toEqual(["67", "15615", "35", "98.7"]);
  });

  it("ignores unsupported and future measurements and centers a shared single-day range", () => {
    const records: WellnessRecord[] = [
      { ownerId: "local-user", day: "2026-10-06", fields: { weightKg: field(70) }, updatedAt: "2026-10-06T00:00:00Z" },
      { ownerId: "local-user", day: "2026-10-07", fields: { sleepScore: field(80) }, updatedAt: "2026-10-07T00:00:00Z" },
    ];
    expect(wellnessHighlights(records, "2026-10-06")).toBeNull();
    expect(wellnessHighlights([], "2026-10-06")).toBeNull();
    records.push({ ownerId: "local-user", day: "2026-10-05", fields: { spo2Percent: field(95) }, updatedAt: "2026-10-06T00:00:00Z" });
    const result = wellnessHighlights(records, "2026-10-06")!;
    expect(result).toMatchObject({ start: "2026-10-05", end: "2026-10-05" });
    expect(sparklineGeometry(result.values[0]!.series)?.points).toEqual([{ x: 50, y: 18.5 }]);
    expect(sparklineGeometry([null, null])).toBeNull();
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

  it("links the empty activity state to connections and the next training day", () => {
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary: { ...summary, sessionCount: 0 }, wellness: [], history: [], planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain("No completed workouts yet this week.");
    expect(html).toContain(">training apps</button>");
    expect(html).toContain(">next plan</button>.");
    expect(html).not.toContain(">Connect to your training apps</button>");
    expect(html.match(/overview-empty-link/g)).toHaveLength(2);
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
  const recoveryHistory = (day: string, fields: WellnessRecord["fields"] = core, count = 7) => Array.from({ length: count }, (_, index) => recoveryRecord(addDays(day, -index - 1), fields));
  const recoveryFor = (fields: WellnessRecord["fields"]) => recoveryStatus([recoveryRecord("2026-10-06", fields), ...recoveryHistory("2026-10-06", { hrvRmssdMs: field(50), restingHeartRateBpm: field(50) })], "2026-10-06");

  it("averages three required recovery signals and excludes subjective check-ins", () => {
    expect(recoveryFor({ ...core, hrvRmssdMs: field(40), restingHeartRateBpm: field(55), sleepScore: field(70), readiness: field(100), fatigue: field(0), soreness: field(0) })).toMatchObject({ label: "Caution", value: 45, day: "2026-10-06", series: [45] });
    expect(recoveryFor(core)).toMatchObject({ label: "Ready", value: 90 });
    expect(recoveryFor({ ...core, hrvRmssdMs: field(40), restingHeartRateBpm: field(57), sleepScore: field(50) })).toMatchObject({ label: "Rest", value: 30 });
  });

  it("prefers today, falls back only to a complete yesterday, and never uses older or future scores", () => {
    const previous = recoveryHistory("2026-10-06");
    expect(recoveryStatus([recoveryRecord("2026-10-06", { ...core, sleepScore: field(55) }), ...previous].reverse(), "2026-10-06")).toMatchObject({ value: 75, day: "2026-10-06" });
    const completeYesterday = [...previous, recoveryRecord("2026-09-28", core)];
    expect(recoveryStatus([recoveryRecord("2026-10-06", { readiness: field(100) }), ...completeYesterday], "2026-10-06")).toMatchObject({ value: 90, day: "2026-10-05" });
    const old = [recoveryRecord("2026-10-04", core), ...recoveryHistory("2026-10-04")];
    expect(recoveryStatus([recoveryRecord("2026-10-07", core), ...old], "2026-10-06")).toMatchObject({ label: "-", value: null, day: null, series: [] });
    expect(recoveryStatus([], "2026-10-06")).toMatchObject({ value: null, day: null, series: [] });
  });

  it.each(["sleepScore", "hrvRmssdMs", "restingHeartRateBpm"] as const)("requires %s on the assessment day without borrowing it from history", (key) => {
    const fields: WellnessRecord["fields"] = { ...core };
    delete fields[key];
    expect(recoveryFor(fields).value).toBeNull();
  });

  it("requires seven distinct historical days and excludes the current day", () => {
    const history = recoveryHistory("2026-10-06", { hrvRmssdMs: field(50), restingHeartRateBpm: field(50) }, 6);
    expect(recoveryStatus([recoveryRecord("2026-10-06", core), ...history, history[0]!], "2026-10-06").value).toBeNull();
    expect(recoveryStatus([recoveryRecord("2026-10-06", core), ...history, recoveryRecord("2026-09-29", core)], "2026-10-06").value).toBe(90);
  });

  it("uses a median baseline only from the preceding 28 calendar days and the same source", () => {
    const history = recoveryHistory("2026-10-06", { hrvRmssdMs: field(50), restingHeartRateBpm: field(50) }, 6);
    const today = recoveryRecord("2026-10-06", core);
    expect(recoveryStatus([today, ...history, recoveryRecord("2026-09-08", { hrvRmssdMs: field(1000), restingHeartRateBpm: field(1000) })], "2026-10-06").value).toBe(90);
    expect(recoveryStatus([today, ...history, recoveryRecord("2026-09-07", core)], "2026-10-06").value).toBeNull();
    expect(recoveryStatus([today, ...history, recoveryRecord("2026-09-08", { hrvRmssdMs: { ...field(50), source: "user" }, restingHeartRateBpm: field(50) })], "2026-10-06").value).toBeNull();
    expect(recoveryStatus([today, ...history, recoveryRecord("2026-09-08", { hrvRmssdMs: field(50), restingHeartRateBpm: { ...field(50), source: "user" } })], "2026-10-06").value).toBeNull();
  });

  it("keeps RMSSD and SDNN baselines separate and falls back to SDNN when RMSSD cannot be compared", () => {
    const history = recoveryHistory("2026-10-06", { hrvSdnnMs: field(20), restingHeartRateBpm: field(50) });
    const today = recoveryRecord("2026-10-06", { ...core, hrvRmssdMs: field(500), hrvSdnnMs: field(16) });
    expect(recoveryStatus([today, ...history], "2026-10-06").value).toBe(70);
    expect(recoveryStatus([today, ...recoveryHistory("2026-10-06", { ...core, hrvSdnnMs: field(20) })], "2026-10-06").value).toBe(90);
    delete today.fields.hrvSdnnMs;
    expect(recoveryStatus([today, ...history], "2026-10-06").value).toBeNull();
  });

  it("prefers valid sleep scores, uses duration as a fallback, and accepts a recorded zero sleep value", () => {
    expect(recoveryFor({ ...core, sleepScore: field(55), sleepSeconds: field(27000) }).value).toBe(75);
    for (const value of [null, Number.NaN, -1, 101]) {
      expect(recoveryFor({ ...core, sleepScore: { ...field(0), value }, sleepSeconds: field(27000) }).value).toBe(90);
    }
    expect(recoveryFor({ ...core, sleepScore: field(0) }).value).toBe(70);
    expect(recoveryFor({ ...core, sleepScore: { ...field(0), value: null }, sleepSeconds: field(0) }).value).toBe(70);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid current and baseline heart metrics (%s)", (value) => {
    expect(recoveryFor({ ...core, hrvRmssdMs: field(value) }).value).toBeNull();
    expect(recoveryFor({ ...core, restingHeartRateBpm: field(value) }).value).toBeNull();
    expect(recoveryStatus([recoveryRecord("2026-10-06", core), ...recoveryHistory("2026-10-06", { ...core, hrvRmssdMs: field(value) })], "2026-10-06").value).toBeNull();
    expect(recoveryStatus([recoveryRecord("2026-10-06", core), ...recoveryHistory("2026-10-06", { ...core, restingHeartRateBpm: field(value) })], "2026-10-06").value).toBeNull();
  });

  it.each([[85, 90], [75, 85], [65, 80], [55, 75], [54, 70]])("scores sleep score %s at its band boundary", (sleepScore, expected) => {
    expect(recoveryFor({ ...core, sleepScore: field(sleepScore) }).value).toBe(expected);
  });
  it.each([[27000, 90], [25200, 85], [23400, 80], [21600, 75], [21599, 70]])("scores sleep duration %s at its band boundary", (sleepSeconds, expected) => {
    expect(recoveryFor({ ...core, sleepScore: { ...field(0), value: null }, sleepSeconds: field(sleepSeconds) }).value).toBe(expected);
  });
  it.each([[50, 90], [47.5, 85], [45, 80], [42.5, 75], [42.4, 70]])("scores HRV %s against its own baseline", (hrv, expected) => {
    expect(recoveryFor({ ...core, hrvRmssdMs: field(hrv) }).value).toBe(expected);
  });
  it.each([[50, 90], [52, 85], [54, 80], [56, 75], [57, 70]])("scores resting heart rate %s against its own baseline", (heartRate, expected) => {
    expect(recoveryFor({ ...core, restingHeartRateBpm: field(heartRate) }).value).toBe(expected);
  });

  it("rounds the mean and keeps the Ready and Caution verdict boundaries", () => {
    expect(recoveryFor({ ...core, hrvRmssdMs: field(42.5), restingHeartRateBpm: field(54), sleepScore: field(55) })).toMatchObject({ value: 50, label: "Caution" });
    expect(recoveryFor({ ...core, hrvRmssdMs: field(40), restingHeartRateBpm: field(55), sleepScore: field(70) })).toMatchObject({ value: 45, label: "Caution" });
    expect(recoveryFor({ ...core, hrvRmssdMs: field(40), restingHeartRateBpm: field(57), sleepScore: field(70) })).toMatchObject({ value: 40, label: "Rest" });
    expect(recoveryFor({ ...core, hrvRmssdMs: field(40) })).toMatchObject({ value: 70, label: "Ready" });
  });

  it("maps recovery verdicts to readiness ring tones", () => {
    expect(recoveryRingTone("Ready")).toBe("ready");
    expect(recoveryRingTone("Caution")).toBe("caution");
    expect(recoveryRingTone("Rest")).toBe("rest");
    expect(recoveryRingTone("-")).toBe("empty");
  });

  it("shows today's or yesterday's assessment date and keeps stale readiness empty while wellness history remains", () => {
    const card = (records: WellnessRecord[]) => {
      const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness: records, history: [], planned: [], today: "2026-10-06", timezone: "Asia/Hong_Kong" }));
      return { html, recovery: html.match(/<article class="overview-summary-card recovery-summary">[\s\S]*?<\/article>/)![0] };
    };
    const today = card([recoveryRecord("2026-10-06", core), ...recoveryHistory("2026-10-06")]);
    expect(today.recovery).toContain('<time dateTime="2026-10-06">Oct 6, 2026</time> (Today)');
    expect(today.recovery).toContain('class="progress-ring ready"');
    expect(today.recovery).toContain("<b>90</b>");
    const yesterday = card([recoveryRecord("2026-10-05", core), ...recoveryHistory("2026-10-05")]);
    expect(yesterday.recovery).toContain('<time dateTime="2026-10-05">Oct 5, 2026</time> (Yesterday)');
    const stale = card([recoveryRecord("2026-10-04", core), ...recoveryHistory("2026-10-04")]);
    expect(stale.recovery).toContain("<strong>-</strong>");
    expect(stale.recovery).toContain("More wellness data needed.");
    expect(stale.recovery).toContain('class="progress-ring empty"');
    expect(stale.recovery).toContain("<b>—</b>");
    expect(stale.recovery).not.toContain("Assessment date");
    expect(stale.html).toContain('data-chart="wellness-trend"');
  });

  it("localizes readiness dates, empty state and the revised calculation help", () => {
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    try {
      const render = (records: WellnessRecord[]) => renderToStaticMarkup(createElement(LanguageProvider, null, createElement(OverviewDashboard, { summary, wellness: records, history: [], planned: [], today: "2026-10-06", timezone: "Asia/Hong_Kong" })));
      expect(render([recoveryRecord("2026-10-06", core), ...recoveryHistory("2026-10-06")])).toContain('<time dateTime="2026-10-06">2026年10月6日</time> (今天)');
      expect(render([recoveryRecord("2026-10-05", core), ...recoveryHistory("2026-10-05")])).toContain('<time dateTime="2026-10-05">2026年10月5日</time> (昨天)');
      const empty = render([]);
      expect(empty).toContain("<strong>-</strong>");
      expect(empty).toContain("需要更多健康指标。");
      const help = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(RecoveryHelpModal, { onClose: () => undefined })));
      expect(help).not.toContain("同一天的三项指标必须齐全");
      expect(help).toContain('class="recovery-help-note">指标缺失或基线不足时不显示估算；HRV 和静息心率的基线各需此前 28 天内至少 7 天同一来源的有效数据。');
      expect(help).toContain("各项指标分别计分，再取三项得分的平均值");
      expect(help).not.toContain("每项指标取 30、45、60、75 或 90 分");
      expect(help).toContain("未经科学验证");
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
    expect(html).toContain('class="recovery-help-note">No estimate is shown when signals are missing or baselines are insufficient. HRV and resting heart rate baselines each require at least 7 valid days from the same source in the previous 28 days.');
    expect(html).toContain("Each signal is scored separately, then the three scores are averaged");
    expect(html).not.toContain("Each signal receives 30, 45, 60, 75 or 90 points");
    expect(html).toContain("not a scientifically validated score");
    expect(html).not.toContain("Signals with no data are skipped");
  });

  it("renders featured wellness trends, compact sleep, and never the excluded weight", () => {
    const records: WellnessRecord[] = [
      { ownerId: "local-user", day: "2026-09-10", fields: { sleepSeconds: field(28000), hrvRmssdMs: field(55), restingHeartRateBpm: field(50), vo2maxMlKgMin: field(51.2), weightKg: field(70) }, updatedAt: "2026-09-10T00:00:00Z" },
      { ownerId: "local-user", day: "2026-09-09", fields: { sleepSeconds: field(27900), hrvRmssdMs: field(50), restingHeartRateBpm: field(51), weightKg: field(71) }, updatedAt: "2026-09-09T00:00:00Z" },
    ];
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness: records, history: [], planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain('<strong title="7:47">7:47</strong>');
    expect(html).toContain("VO2 max (ml/kg/min)");
    expect(html).toContain('<strong title="51.2">51.2</strong>');
    expect(html).not.toContain("Weight (kg)");
  });

  it("renders all dashboard sections, fixed domains, wellness trends, and calendar legend", () => {
    const history = [{ id: "current", name: "Basketball", startAt: "2026-09-08T04:00:00Z", timezone: null, domains: ["sport_skill"], sport: "Basketball", durationMinutes: 60 }] as TrainingHistorySession[];
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness, history, planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain("Basketball");
    expect(html).toContain("Sleep score");
    expect(html).toContain("<strong>-</strong>");
    expect(html).toContain("More wellness data needed.");
    expect(html).toContain("How do we calculate?");
    expect(html).not.toContain("recovery-modal");
    expect(html).toContain("HRV (ms)");
    expect(html).toContain("Resting HR (bpm)");
    expect(html).toContain('<strong title="55">55</strong>');
    expect(html).not.toContain("55 ms");
    expect(html).toContain("September 2026");
    expect(html).toContain("Mind-body");
    expect(html).toContain("Training Load");
    expect(html).toContain("Consistency");
    expect(html).not.toContain("Skipped plan");
    expect(html).toContain('class="activity-arrow"');
    expect(html).toContain('aria-label="Open Training"');
    expect(html).toContain('data-icon="workout"');
    expect(html).toContain('data-icon="target"');
    expect(html).toContain('data-icon="recovery"');
    expect(html).toContain('data-chart="green-bars"');
    expect(html).toContain("Overall Readiness");
    expect(html).toContain("<b>—</b>");
    expect(html).toContain("donut-segment domain-strength");
    expect(html).toContain("donut-segment domain-endurance");
    expect(html).toContain("donut-segment domain-sport_skill");
    expect(html).toContain("donut-segment domain-mind_body");
    expect(html).toContain("donut-segment domain-recovery");
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
    const history = [{ id: "done", name: "Run", startAt: "2026-09-08T04:00:00Z", timezone: null, domains: ["endurance"], sport: "Run", durationMinutes: 30 }] as TrainingHistorySession[];
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
    expect(html).toContain("<b>—</b>");
    expect(html).toContain("0%");
  });
});
