import { friendlyLabel, type CalendarSession, type Mesocycle, type PlanComponent } from "../view-models";
import { formatShortDate, weekdayIndex } from "./view";

/**
 * Calendar-specific presentation helpers shared by `WeeklyCalendar` and
 * `SessionDetailDrawer`. Everything here is pure and side-effect free; all
 * week/date maths stays in `./view` so this module never re-derives weeks.
 */

/** A resolved, non-null training domain carried by a component. */
export type DomainValue = NonNullable<PlanComponent["domain"]["value"]>;

/** Monday-based short weekday labels, indexed by `weekdayIndex()` (0 = Mon). */
export const weekdayShort: string[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const domainGlyphs: Record<DomainValue, string> = {
  strength: "🏋",
  endurance: "🏃",
  sport_skill: "🎯",
  mind_body: "🧘",
  recovery: "❋",
};

/** Short glyph used as the sport-type icon on a session chip (§7.4). */
export function domainGlyph(domain: DomainValue): string {
  return domainGlyphs[domain];
}

/** Resolve domain-aware phase labels carried by a materialized session. */
export function phaseLabelsForSession(progressions: Mesocycle["domainProgressions"], session: Pick<CalendarSession, "phaseRefs">): string[] {
  return session.phaseRefs.flatMap((ref) => {
    const phase = progressions.find((item) => item.domain === ref.domain)?.phases.find((item) => item.id === ref.phaseId);
    return phase ? [`${friendlyLabel(ref.domain)} · ${phase.name.trim() || friendlyLabel(phase.phaseType)}`] : [];
  });
}

/** Domain phase summary for a week, preserving progression order. */
export function phaseNamesForWeek(progressions: Mesocycle["domainProgressions"], weekNumber: number): string {
  return progressions.flatMap((progression) => {
    const phase = progression.phases.find((item) => weekNumber >= item.startWeek && weekNumber <= item.endWeek);
    return phase ? [`${friendlyLabel(progression.domain)} ${phase.name.trim() || friendlyLabel(phase.phaseType)}`] : [];
  }).join(" / ");
}

/** Distinct, non-null domains of a session's components, in execution order. */
export function sessionDomains(session: CalendarSession): DomainValue[] {
  const seen = new Set<DomainValue>();
  const result: DomainValue[] = [];
  for (const component of session.components) {
    const value = component.domain.value;
    if (value !== null && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

/** Visual tone used for chip/badge styling; never relies on colour alone (§16.4). */
export type SessionTone = "completed" | "skipped" | "unrecorded" | "planned";

/**
 * A session scheduled before `today` that is still `planned` is "Unrecorded"
 * (§7.7). This is a UI-only derivation — the stored status is never rewritten.
 */
export function isUnrecorded(session: CalendarSession, today: string): boolean {
  return session.displayState === "unrecorded" || (session.status === "planned" && session.scheduledDate < today);
}

/** Derive the display tone for a session relative to `today`. */
export function sessionTone(session: CalendarSession, today: string): SessionTone {
  if (session.displayState === "completed" || session.status === "completed") return "completed";
  if (session.displayState === "skipped" || session.status === "skipped") return "skipped";
  if (isUnrecorded(session, today)) return "unrecorded";
  return "planned";
}

/** Text label for a tone, so status is conveyed by words as well as colour. */
export function sessionStatusLabel(tone: SessionTone): string {
  switch (tone) {
    case "completed":
      return "Completed";
    case "skipped":
      return "Skipped";
    case "unrecorded":
      return "Unrecorded";
    default:
      return "Planned";
  }
}

/** Format a date as a weekday + short date label, e.g. `Thu, Sep 24` (§8.2). */
export function formatDayLabel(date: string): string {
  const label = weekdayShort[weekdayIndex(date)] ?? "";
  return `${label}, ${formatShortDate(date)}`;
}
