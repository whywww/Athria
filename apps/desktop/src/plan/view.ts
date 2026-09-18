import type { CalendarSession } from "../view-models";

/**
 * Pure, side-effect-free helpers for the Plan calendar view.
 *
 * Week numbering follows the deterministic Core convention
 * (`getCalendar` / `updatePlannedSession`): a week is a
 * 7-day block anchored at the plan's `effectiveStartDate`, so
 * `weekNumber = floor(elapsedDays / 7) + 1`. All date maths run in UTC at local
 * noon to stay immune to timezone drift and DST boundaries.
 */

const MS_PER_DAY = 86_400_000;

/** One calendar day of a week block. `weekday` is Monday-based: 0 = Mon … 6 = Sun. */
export interface CalendarDay {
  date: string;
  weekday: number;
  sessions: CalendarSession[];
}

/** One week of the plan calendar, spanning `startDate` … `endDate` (7 days). */
export interface CalendarWeek {
  weekNumber: number;
  startDate: string;
  endDate: string;
  days: CalendarDay[];
}

/** Parse a `YYYY-MM-DD` string as a UTC instant at noon (avoids off-by-one days). */
function toUtcNoon(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

/** Add (or subtract) whole days to a `YYYY-MM-DD` string, in UTC. */
export function addDays(date: string, days: number): string {
  const value = toUtcNoon(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` precedes `from`), in UTC. */
export function dayDifference(from: string, to: string): number {
  return Math.round((toUtcNoon(to).getTime() - toUtcNoon(from).getTime()) / MS_PER_DAY);
}

/** Monday-based weekday index of a date: 0 = Mon … 6 = Sun. */
export function weekdayIndex(date: string): number {
  return (toUtcNoon(date).getUTCDay() + 6) % 7;
}

/** Clamp a number into the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Compute the plan week (1-based) that `today` falls in.
 *
 * Anchored at `effectiveStartDate`; returns 1 before the plan starts and
 * `durationWeeks` after it ends. Mirrors the Core `weekNumber` derivation so the
 * value agrees with `CalendarSession.weekNumber`.
 */
export function currentWeekNumber(effectiveStartDate: string, today: string, durationWeeks: number): number {
  const span = Math.max(1, durationWeeks);
  const week = Math.floor(dayDifference(effectiveStartDate, today) / 7) + 1;
  return clamp(week, 1, span);
}

export function localDateForTimezone(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function planPosition(effectiveStartDate: string, today: string, durationWeeks: number): { weekNumber: number; state: "future" | "active" | "completed" } {
  const endDate = addDays(effectiveStartDate, Math.max(1, durationWeeks) * 7 - 1);
  if (today < effectiveStartDate) return { weekNumber: 1, state: "future" };
  if (today > endDate) return { weekNumber: Math.max(1, durationWeeks), state: "completed" };
  return { weekNumber: currentWeekNumber(effectiveStartDate, today, durationWeeks), state: "active" };
}

/**
 * Build the full `durationWeeks` calendar skeleton and place each session into
 * the day of its week. Weeks run 1 … `durationWeeks`, each with 7 `Mon`-ordered
 * day slots. Sessions whose `weekNumber` falls outside the plan are ignored.
 */
export function groupSessionsByWeek(sessions: CalendarSession[], effectiveStartDate: string, durationWeeks: number): CalendarWeek[] {
  const span = Math.max(1, durationWeeks);
  const weeks: CalendarWeek[] = [];
  for (let index = 0; index < span; index += 1) {
    const startDate = addDays(effectiveStartDate, index * 7);
    const endDate = addDays(startDate, 6);
    const days: CalendarDay[] = Array.from({ length: 7 }, (_, dayIndex) => {
      const date = addDays(startDate, dayIndex);
      return { date, weekday: weekdayIndex(date), sessions: [] };
    });
    weeks.push({ weekNumber: index + 1, startDate, endDate, days });
  }
  for (const session of sessions) {
    const week = weeks.find((candidate) => candidate.weekNumber === session.weekNumber);
    if (!week) continue;
    const dayIndex = clamp(dayDifference(week.startDate, session.scheduledDate), 0, 6);
    week.days[dayIndex]!.sessions.push(session);
  }
  return weeks;
}

/** Format a `YYYY-MM-DD` date as a compact UTC label, e.g. `Sep 21`. */
export function formatShortDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(toUtcNoon(date));
}

/** Format an inclusive date range as a compact label, e.g. `Sep 21 – Sep 27`. */
export function formatWeekRange(startDate: string, endDate: string): string {
  return `${formatShortDate(startDate)} – ${formatShortDate(endDate)}`;
}
