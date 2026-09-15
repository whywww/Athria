import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverviewDashboard, calendarDays, formatWellnessDate, mesocycleProgress, overviewDateRange, recoveryStatus, sparklineGeometry, twelveWeekConsistency, weeklyLoad, weeklyOverview, wellnessHighlights } from "./overview";
import type { CalendarSession, TrainingHistorySession, TrainingSummary, WellnessRecord } from "./view-models";

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
  it("derives Monday-to-today and leap-month bounds", () => {
    expect(overviewDateRange("2028-02-29")).toEqual({ weekStart: "2028-02-28", monthStart: "2028-02-01", monthEnd: "2028-02-29" });
  });

  it("uses completed markers before planned and rest markers", () => {
    const history = [{ id: "done", name: "Run", startAt: "2026-09-10T16:30:00Z", timezone: null, domains: ["endurance"], sport: "Run", durationMinutes: 30 }] as TrainingHistorySession[];
    const planned = [{ scheduledDate: "2026-09-11", status: "planned" }, { scheduledDate: "2026-09-12", status: "skipped" }] as CalendarSession[];
    const days = calendarDays("2026-09-11", history, planned, "Asia/Hong_Kong");
    expect(days.find((item) => item.day === "2026-09-11")?.marker).toBe("completed");
    expect(days.find((item) => item.day === "2026-09-12")?.marker).toBe("skipped");
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
    const result = wellnessHighlights(wellness)!;
    expect(result.values.map((item) => item.key)).toEqual(["readiness", "sleepScore", "hrvRmssdMs", "restingHeartRateBpm"]);
    expect(result.values[0]?.delta).toBe(2);
    expect(result.values[0]?.series).toEqual([70, 72]);
  });

  it("formats the wellness date without a status prefix", () => {
    expect(formatWellnessDate("2026-09-11")).toBe("Sep 11, 2026");
  });

  it("builds bounded smooth trend geometry from at most seven finite samples", () => {
    const geometry = sparklineGeometry([Number.NaN, 10, 14, 12, 18, 17, 21, 19, 23])!;
    expect(geometry.points).toHaveLength(7);
    expect(geometry.linePath).toMatch(/^M 4 /);
    expect(geometry.linePath).toContain(" C ");
    expect(geometry.linePath).toMatch(/ 96 /);
    expect(geometry.points.every(({ y }) => y >= 5 && y <= 32)).toBe(true);
    expect(geometry.areaPath).toMatch(/L 96 39 L 4 39 Z$/);
  });

  it("handles empty, single, two-point, and flat wellness trends", () => {
    expect(sparklineGeometry([])).toBeNull();
    expect(sparklineGeometry([42])?.points).toEqual([{ x: 50, y: 18.5 }]);
    expect(sparklineGeometry([1, 2])?.linePath).toBe("M 4 32 C 34.667 23 65.333 14 96 5");
    expect(sparklineGeometry([3, 3, 3])?.points.every(({ y }) => y === 18.5)).toBe(true);
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

  it("stacks completed and still-planned minutes by local weekday", () => {
    const history = [{ id: "done", startAt: "2026-09-07T16:30:00Z", durationMinutes: 45 }] as TrainingHistorySession[];
    const planned = [{ scheduledDate: "2026-09-08", status: "planned", durationMinutes: 30 }] as CalendarSession[];
    const load = weeklyLoad("2026-09-11", history, planned, "Asia/Hong_Kong");
    expect(load[1]).toMatchObject({ completed: 45, scheduled: 30 });
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

  it("maps readiness to recovery copy and handles missing data", () => {
    expect(recoveryStatus(wellness).label).toBe("Good");
    expect(recoveryStatus([])).toMatchObject({ label: "No data", value: null });
  });

  it("renders all dashboard sections, fixed domains, wellness trends, and calendar legend", () => {
    const history = [{ id: "current", name: "Basketball", startAt: "2026-09-08T04:00:00Z", timezone: null, domains: ["sport_skill"], sport: "Basketball", durationMinutes: 60 }] as TrainingHistorySession[];
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary, wellness, history, planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain("Basketball");
    expect(html).toContain("Readiness");
    expect(html).toContain("September 2026");
    expect(html).toContain("Mind-body");
    expect(html).toContain("Training Load");
    expect(html).toContain("Consistency");
    expect(html).toContain("Skipped plan");
    expect(html).toContain('class="activity-arrow"');
    expect(html).toContain('aria-label="Open Training"');
    expect(html).toContain('data-icon="workout"');
    expect(html).toContain('data-icon="target"');
    expect(html).toContain('data-icon="recovery"');
    expect(html).toContain('data-chart="coral-bars"');
    expect(html).toContain('data-chart="green-bars"');
    expect(html).toContain("donut-segment domain-strength");
    expect(html).toContain("donut-segment domain-endurance");
    expect(html).toContain("donut-segment domain-sport_skill");
    expect(html).toContain("donut-segment domain-mind_body");
    expect(html).toContain("donut-segment domain-recovery");
    expect(html).toContain("progress-ring");
    expect(html).toContain("this mesocycle");
    expect(html).toContain('data-icon="trophy"');
    expect(html).toContain('data-range="twelve-weeks"');
    expect(html).toContain('data-chart="wellness-trend"');
    expect(html).toContain('<path class="sparkline-line"');
    expect(html).toContain("<linearGradient");
    expect(html).toContain('fill="url(#wellness-spark-');
    expect(html).toContain('mask="url(#wellness-spark-mask-');
    expect(html).toContain('<time dateTime="2026-09-10">Sep 10, 2026</time>');
    expect(html.indexOf("September 2026")).toBeLessThan(html.indexOf("Wellness"));
    expect(html).toContain('class="favorable">↓ 1 from previous</small>');
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
    expect(html).toContain('<span class="mini-day-markers"><i class="completed" aria-label="Completed training"></i><i class="skipped" aria-label="Skipped plan"></i></span>');
    expect(html).toContain('<span class="mini-day-markers"><i class="planned" aria-label="Scheduled training"></i></span>');
  });

  it("keeps compact summary visuals when comparison and readiness history are missing", () => {
    const html = renderToStaticMarkup(createElement(OverviewDashboard, { summary: { ...summary, totalDurationMinutes: 1250 }, wellness: [], history: [], planned: [], today: "2026-09-11", timezone: "Asia/Hong_Kong" }));
    expect(html).toContain("20 hr 50 min");
    expect(html).toContain("No prior data");
    expect(html).toContain("No data");
    expect(html).toContain('data-chart="green-bars"');
    expect(html).toContain("0%");
  });
});
