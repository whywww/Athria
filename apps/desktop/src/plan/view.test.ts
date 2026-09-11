import { describe, expect, it } from "vitest";
import type { CalendarSession } from "../view-models";
import { currentWeekNumber, formatWeekRange, groupSessionsByWeek, localDateForTimezone, planPosition, weekdayIndex } from "./view";

// 2026-09-07 is a Monday, matching the Core convention that plans start on a Monday.
const START = "2026-09-07";

function session(scheduledDate: string, weekNumber: number, id = `${scheduledDate}-${weekNumber}`): CalendarSession {
  return {
    id, occurrenceId: `occ-${id}`, revision: 0, scheduledDate, order: 0, weekNumber, phaseRefs: [{ domain: "strength", phaseId: "base" }], templateRef: { source: "builtin", id: "full-body", catalogVersion: "1.0" },
    name: "Full body", intent: "Build strength", durationMinutes: 60, recoveryDemand: "normal", keySession: false, progressionNote: null, schedulingRationale: null, status: "planned", components: [],
    legacySnapshot: false, overrideReason: null,
  };
}

describe("plan calendar view helpers", () => {
  it("anchors the current week to the start date and clamps to the plan span", () => {
    expect(currentWeekNumber(START, "2026-09-01", 3)).toBe(1); // before the plan starts
    expect(currentWeekNumber(START, START, 3)).toBe(1);
    expect(currentWeekNumber(START, "2026-09-13", 3)).toBe(1); // last day of week 1
    expect(currentWeekNumber(START, "2026-09-14", 3)).toBe(2); // first day of week 2
    expect(currentWeekNumber(START, "2026-09-21", 3)).toBe(3);
    expect(currentWeekNumber(START, "2026-09-30", 3)).toBe(3); // after the plan ends
  });

  it("uses a Monday-based weekday index", () => {
    expect(weekdayIndex(START)).toBe(0); // Monday
    expect(weekdayIndex("2026-09-13")).toBe(6); // Sunday
  });

  it("builds one Mon-Sun week block per plan week", () => {
    const weeks = groupSessionsByWeek([], START, 3);
    expect(weeks.map((week) => week.weekNumber)).toEqual([1, 2, 3]);
    expect(weeks[0]).toMatchObject({ startDate: "2026-09-07", endDate: "2026-09-13" });
    expect(weeks[2]).toMatchObject({ startDate: "2026-09-21", endDate: "2026-09-27" });
    expect(weeks[0]!.days).toHaveLength(7);
    expect(weeks[0]!.days.map((day) => day.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(weeks[0]!.days.map((day) => day.date)).toEqual(["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"]);
  });

  it("places sessions on the matching day and ignores out-of-range weeks", () => {
    const weeks = groupSessionsByWeek([session("2026-09-09", 1, "a"), session("2026-09-27", 3, "b"), session("2026-10-05", 5, "outside")], START, 3);
    expect(weeks[0]!.days[2]!.sessions.map((item) => item.id)).toEqual(["a"]); // Wednesday of week 1
    expect(weeks[2]!.days[6]!.sessions.map((item) => item.id)).toEqual(["b"]); // Sunday of week 3
    expect(weeks.flatMap((week) => week.days.flatMap((day) => day.sessions.map((item) => item.id)))).toEqual(["a", "b"]);
  });

  it("formats an inclusive week range as a compact label", () => {
    expect(formatWeekRange("2026-09-21", "2026-09-27")).toBe("Sep 21 – Sep 27");
  });

  it("derives local dates and the single plan positioning week", () => {
    expect(localDateForTimezone("Asia/Hong_Kong", new Date("2026-09-06T17:00:00Z"))).toBe("2026-09-07");
    expect(planPosition(START, "2026-09-01", 3)).toEqual({ weekNumber: 1, state: "future" });
    expect(planPosition(START, "2026-09-14", 3)).toEqual({ weekNumber: 2, state: "active" });
    expect(planPosition(START, "2026-10-01", 3)).toEqual({ weekNumber: 3, state: "completed" });
  });
});
