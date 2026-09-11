import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration, friendlyLabel, type CalendarSession, type CurrentPlan, type StoredSessionTemplate } from "../view-models";
import { currentWeekNumber, formatShortDate, formatWeekRange, groupSessionsByWeek, type CalendarDay, type CalendarWeek } from "./view";
import { domainGlyph, phaseNamesForWeek, sessionDomains, sessionStatusLabel, sessionTone, weekdayShort } from "./calendar-utils";
import "./calendar.css";

/**
 * Weekly Calendar (UNIFIED_MULTISPORT_MESOCYCLE_DESIGN §7).
 *
 * The full-mesocycle training calendar. Data organisation is delegated to the
 * pure helpers in `./view` (`groupSessionsByWeek` / `currentWeekNumber`) so this
 * component never re-derives week numbers. It is fully controlled: the parent
 * owns `selectedSessionId` and receives `onSelectSession(sessionId, triggerEl)`
 * so it can open the Session Detail Drawer and later restore focus.
 *
 * Sub-components (`WeekRow` / `DayCell` / `SessionChip`) are memoised and only
 * receive primitive or reference-stable props; grouping and phase mapping are
 * memoised so a selection change re-renders the minimum number of nodes.
 */

export interface WeeklyCalendarProps {
  plan: CurrentPlan;
  sessions: CalendarSession[];
  templates: StoredSessionTemplate[];
  today: string;
  onSelectSession: (sessionId: string, triggerEl: HTMLElement | null) => void;
  selectedSessionId?: string | null;
  scrollToWeek?: number | null;
  storageKey?: string;
}

interface SessionChipProps {
  session: CalendarSession;
  today: string;
  selected: boolean;
  onSelect: (sessionId: string, triggerEl: HTMLElement | null) => void;
}

const SessionChip = memo(function SessionChip({ session, today, selected, onSelect }: SessionChipProps) {
  const tone = sessionTone(session, today);
  const domains = sessionDomains(session);
  return (
    <button
      type="button"
      className={`wc-chip status-${tone}${selected ? " is-selected" : ""}`}
      data-session-id={session.id}
      aria-pressed={selected}
      onClick={(event) => onSelect(session.id, event.currentTarget)}
    >
      <span className="wc-chip-top">
        {domains.map((domain) => (
          <span className="wc-domain" key={domain} title={friendlyLabel(domain)}>
            <span aria-hidden="true">{domainGlyph(domain)}</span>
            <span className="wc-domain-label">{friendlyLabel(domain)}</span>
          </span>
        ))}
        <span className="wc-duration">{formatDuration(session.durationMinutes)}</span>
      </span>
      <span className="wc-chip-name">{session.name}</span>
      <span className={`wc-badge badge-${tone}`}>
        {tone === "completed" && <span aria-hidden="true">✓ </span>}
        {sessionStatusLabel(tone)}
      </span>
    </button>
  );
});

interface DayCellProps {
  day: CalendarDay;
  today: string;
  selectedSessionId: string | null;
  onSelect: (sessionId: string, triggerEl: HTMLElement | null) => void;
}

const DayCell = memo(function DayCell({ day, today, selectedSessionId, onSelect }: DayCellProps) {
  // Per-day overflow expansion (§7.5): more than three sessions collapse to the
  // first two plus a "+N more" affordance. Local state keeps this off the parent.
  const [showAll, setShowAll] = useState(false);
  const sessions = day.sessions;
  const collapsed = sessions.length > 3 && !showAll;
  const visible = collapsed ? sessions.slice(0, 2) : sessions;
  const overflow = sessions.length - visible.length;
  const isToday = day.date === today;
  const isPast = day.date < today;

  return (
    <div className={`wc-day${isToday ? " is-today" : ""}${isPast ? " is-past" : ""}`}>
      <div className="wc-day-head">
        <span className="wc-day-date">{formatShortDate(day.date)}</span>
        {isToday && <span className="wc-today-tag">Today</span>}
      </div>
      {sessions.length === 0 ? (
        // LLM-scheduled empty day → Rest (§7.6). A skipped session still renders
        // as a chip with a "Skipped" badge, never rewritten into a rest day.
        <span className="rest-pill wc-rest">Rest</span>
      ) : (
        <div className="wc-day-sessions">
          {visible.map((session) => (
            <SessionChip
              key={session.id}
              session={session}
              today={today}
              selected={session.id === selectedSessionId}
              onSelect={onSelect}
            />
          ))}
          {collapsed && overflow > 0 && (
            <button type="button" className="wc-more" onClick={() => setShowAll(true)}>
              +{overflow} more
            </button>
          )}
        </div>
      )}
    </div>
  );
});

interface WeekRowProps {
  week: CalendarWeek;
  phaseName: string;
  expanded: boolean;
  isCurrent: boolean;
  today: string;
  selectedSessionId: string | null;
  onToggleWeek: (weekNumber: number) => void;
  onSelect: (sessionId: string, triggerEl: HTMLElement | null) => void;
  focus: string | null | undefined;
  rhythmLabel: string | undefined;
}

function weekSummary(week: CalendarWeek): string {
  const sessions = week.days.flatMap((day) => day.sessions);
  let enduranceMeters = 0; let enduranceMinutes = 0; let strengthSets = 0; let sport = 0; let recovery = 0;
  for (const session of sessions) for (const component of session.components) {
    if (component.domain.value === "endurance") {
      enduranceMinutes += session.durationMinutes;
      if (component.prescription.kind === "endurance") for (const segment of component.prescription.segments) enduranceMeters += segment.type === "repeat" ? segment.repetitions * (segment.work.distanceMeters ?? 0) + segment.repetitions * (segment.recovery?.distanceMeters ?? 0) : segment.distanceMeters ?? 0;
    }
    if (component.prescription.kind === "strength") strengthSets += component.prescription.exercises.reduce((sum, exercise) => sum + exercise.sets, 0);
    if (component.domain.value === "sport_skill") sport += 1;
    if (component.domain.value === "recovery" || component.domain.value === "mind_body") recovery += 1;
  }
  return [enduranceMeters ? `Endurance ${Math.round(enduranceMeters / 100) / 10} km` : enduranceMinutes ? `Endurance ${enduranceMinutes} min` : null, strengthSets ? `Strength ${strengthSets} sets` : null, sport ? `Sport ${sport}` : null, recovery ? `Recovery ${recovery}` : null].filter(Boolean).join(" · ");
}

const WeekRow = memo(function WeekRow({ week, phaseName, expanded, isCurrent, today, selectedSessionId, onToggleWeek, onSelect, focus, rhythmLabel }: WeekRowProps) {
  const sessionCount = week.days.reduce((total, day) => total + day.sessions.length, 0);
  const range = formatWeekRange(week.startDate, week.endDate);
  const title = `W${week.weekNumber}${phaseName ? ` · ${phaseName}` : ""} · ${range}`;
  return (
    <section
      className={`wc-week${expanded ? " is-expanded" : " is-collapsed"}${isCurrent ? " is-current" : ""}`}
      data-week={week.weekNumber}
    >
      <div className="wc-week-header">
        <button
          type="button"
          className="wc-week-toggle"
          aria-expanded={expanded}
          onClick={() => onToggleWeek(week.weekNumber)}
        >
          <span className="wc-week-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          <span className="wc-week-title">{title}</span>
          {isCurrent && <span className="wc-current-pill">This week</span>}
          <span className="wc-week-summary">{weekSummary(week) || `${sessionCount} session${sessionCount === 1 ? "" : "s"}`}</span>
        </button>
      </div>
      {expanded && (
        <div className="wc-week-body">
          {(focus || rhythmLabel) && <div className="wc-week-context">{focus && <span>{focus}</span>}{rhythmLabel && <small>{rhythmLabel}</small>}</div>}
          <div className="wc-weekdays" aria-hidden="true">
            {weekdayShort.map((label) => <span key={label}>{label}</span>)}
          </div>
          <div className="wc-grid">
            {week.days.map((day) => (
              <DayCell key={day.date} day={day} today={today} selectedSessionId={selectedSessionId} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
});

export function WeeklyCalendar({ plan, sessions, today, onSelectSession, selectedSessionId = null, scrollToWeek = null, storageKey }: WeeklyCalendarProps) {
  const durationWeeks = Math.max(1, plan.mesocycle.durationWeeks);
  const progressions = plan.mesocycle.domainProgressions;

  const weeks = useMemo(
    () => groupSessionsByWeek(sessions, plan.effectiveStartDate, durationWeeks),
    [sessions, plan.effectiveStartDate, durationWeeks],
  );
  const currentWeek = useMemo(
    () => currentWeekNumber(plan.effectiveStartDate, today, durationWeeks),
    [plan.effectiveStartDate, today, durationWeeks],
  );
  const phaseByWeek = useMemo(() => {
    const map = new Map<number, string>();
    for (const week of weeks) {
      map.set(week.weekNumber, phaseNamesForWeek(progressions, week.weekNumber));
    }
    return map;
  }, [weeks, progressions]);

  const defaultExpanded = useMemo(() => {
    if (storageKey) {
      try { const stored = JSON.parse(sessionStorage.getItem(`${storageKey}:weeks`) ?? "null") as number[] | null; if (Array.isArray(stored)) return new Set(stored.filter((week) => week >= 1 && week <= durationWeeks)); } catch { /* use positioning week */ }
    }
    return new Set([currentWeek]);
  }, [durationWeeks, currentWeek, storageKey]);

  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(defaultExpanded));

  const handleSelect = useCallback(
    (sessionId: string, triggerEl: HTMLElement | null) => onSelectSession(sessionId, triggerEl),
    [onSelectSession],
  );
  const toggleWeek = useCallback((weekNumber: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(weekNumber)) next.delete(weekNumber);
      else next.add(weekNumber);
      if (storageKey) sessionStorage.setItem(`${storageKey}:weeks`, JSON.stringify([...next]));
      return next;
    });
  }, [storageKey]);

  const rootRef = useRef<HTMLDivElement>(null);

  // Bring the current week into view on first mount (§7.3). `block: "nearest"`
  // avoids yanking the whole page when the week is already visible.
  useEffect(() => {
    const element = rootRef.current?.querySelector<HTMLElement>(`[data-week="${currentWeek}"]`);
    element?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll to an explicitly requested week whenever `scrollToWeek` changes (§7.3).
  useEffect(() => {
    if (scrollToWeek === null) return;
    setExpanded((current) => { const next = new Set(current); next.add(scrollToWeek); if (storageKey) sessionStorage.setItem(`${storageKey}:weeks`, JSON.stringify([...next])); return next; });
    const element = rootRef.current?.querySelector<HTMLElement>(`[data-week="${scrollToWeek}"]`);
    requestAnimationFrame(() => element?.scrollIntoView({ block: "nearest" }));
  }, [scrollToWeek, storageKey]);

  const first = weeks.at(0);
  const last = weeks.at(-1);
  const overallRange = first && last ? formatWeekRange(first.startDate, last.endDate) : "";

  return (
    <section className="wc-calendar" ref={rootRef} aria-label="Weekly training calendar">
      <div className="wc-toolbar">
        <div className="wc-toolbar-text">
          <h3 className="wc-heading">Weekly Calendar</h3>
          <span className="wc-subheading">{durationWeeks} weeks{overallRange ? ` · ${overallRange}` : ""}</span>
        </div>
      </div>
      <div className="wc-weeks">
        {weeks.map((week) => (
          <WeekRow
            key={week.weekNumber}
            week={week}
            phaseName={phaseByWeek.get(week.weekNumber) ?? ""}
            expanded={expanded.has(week.weekNumber)}
            isCurrent={week.weekNumber === currentWeek}
            today={today}
            selectedSessionId={selectedSessionId}
            onToggleWeek={toggleWeek}
            onSelect={handleSelect}
            focus={plan.mesocycle.weeks.find((item) => item.weekNumber === week.weekNumber)?.focus}
            rhythmLabel={plan.mesocycle.schedule.kind === "flexible_week" ? `Flexible placement · target ${plan.mesocycle.schedule.targetDaysPerWeek} days` : plan.mesocycle.schedule.kind === "interval" ? `Interval rhythm · every ${plan.mesocycle.schedule.intervalDays} days` : undefined}
          />
        ))}
      </div>
    </section>
  );
}
