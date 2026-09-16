import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration, friendlyLabel, type CalendarSession, type CurrentPlan, type StoredSessionTemplate } from "../view-models";
import { domainIconPath } from "../domain-icons";
import { currentWeekNumber, formatShortDate, groupSessionsByWeek, type CalendarDay, type CalendarWeek } from "./view";
import { sessionDomains, sessionStatusLabel, sessionTone, weekdayShort, type DomainValue } from "./calendar-utils";
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
 * receive primitive or reference-stable props so a selection change re-renders
 * the minimum number of nodes.
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

function CalendarDomainIcon({ domain }: { domain: DomainValue }) {
  return <svg className="wc-domain-icon" data-domain-icon={domain} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{domainIconPath(domain)}</svg>;
}

function RestIcon() {
  return <svg className="wc-rest-icon" data-icon="rest" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 18V8M20 18v-6a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v3M4 15h16M7 10V8h4a2 2 0 0 1 2 2"/><path d="M4 19v-1M20 19v-1"/></svg>;
}

const SessionChip = memo(function SessionChip({ session, today, selected, onSelect }: SessionChipProps) {
  const tone = sessionTone(session, today);
  const domains = sessionDomains(session);
  const primaryDomain = domains[0] ?? "neutral";
  return (
    <button
      type="button"
      className={`wc-chip tone-${primaryDomain} status-${tone}${selected ? " is-selected" : ""}`}
      data-session-id={session.id}
      aria-pressed={selected}
      onClick={(event) => onSelect(session.id, event.currentTarget)}
    >
      <span className="wc-chip-top">
        <span className="wc-chip-domains">
          {domains.map((domain) => (
            <span className="wc-chip-domain" key={domain} title={friendlyLabel(domain)}>
              <CalendarDomainIcon domain={domain}/>
              <span className="sr-only">{friendlyLabel(domain)}</span>
            </span>
          ))}
        </span>
        {(tone === "completed" || tone === "unrecorded") && (
          <span className={`wc-status-light status-${tone}`}>
            <span className="sr-only">{sessionStatusLabel(tone)}</span>
          </span>
        )}
      </span>
      <span className="wc-chip-meta"><span className="wc-duration">{formatDuration(session.durationMinutes)}</span></span>
      <span className="wc-chip-name">{session.name}</span>
      {tone === "skipped" && <span className="wc-badge badge-skipped">{sessionStatusLabel(tone)}</span>}
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
        <span className="wc-day-label">
          <span className="wc-day-weekday">{weekdayShort[day.weekday]}</span>
          <span className="wc-day-date">{formatShortDate(day.date)}</span>
        </span>
        {isToday && <span className="wc-today-tag">Today</span>}
      </div>
      {sessions.length === 0 ? (
        // LLM-scheduled empty day → Rest (§7.6). A skipped session still renders
        // as a chip with a "Skipped" badge, never rewritten into a rest day.
        <span className="wc-rest"><RestIcon/><span>Rest</span></span>
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
  expanded: boolean;
  isCurrent: boolean;
  today: string;
  selectedSessionId: string | null;
  onToggleWeek: (weekNumber: number) => void;
  onSelect: (sessionId: string, triggerEl: HTMLElement | null) => void;
}

function weekSummary(week: CalendarWeek): string {
  const sessions = week.days.flatMap((day) => day.sessions);
  let enduranceMeters = 0; let enduranceMinutes = 0; let strengthSets = 0; let sport = 0; let recovery = 0;
  for (const session of sessions) {
    const domains = sessionDomains(session);
    if (domains.includes("endurance")) enduranceMinutes += session.durationMinutes;
    if (domains.includes("sport_skill")) sport += 1;
    if (domains.includes("recovery") || domains.includes("mind_body")) recovery += 1;
    for (const component of session.components) {
      if (component.prescription.kind === "endurance") for (const segment of component.prescription.segments) enduranceMeters += segment.type === "repeat" ? segment.repetitions * (segment.work.distanceMeters ?? 0) + segment.repetitions * (segment.recovery?.distanceMeters ?? 0) : segment.distanceMeters ?? 0;
      if (component.prescription.kind === "strength") strengthSets += component.prescription.exercises.reduce((sum, exercise) => sum + exercise.sets, 0);
    }
  }
  return [enduranceMeters ? `${Math.round(enduranceMeters / 100) / 10} km` : enduranceMinutes ? `${enduranceMinutes} min` : null, strengthSets ? `${strengthSets} sets` : null, sport ? `${sport} sport` : null, recovery ? `${recovery} recovery` : null].filter(Boolean).join(" · ");
}

function compactWeekRange(startDate: string, endDate: string): string {
  const start = formatShortDate(startDate);
  const end = formatShortDate(endDate);
  const startMonth = start.split(" ")[0]!;
  return end.startsWith(`${startMonth} `) ? `${start} – ${end.slice(startMonth.length + 1)}` : `${start} – ${end}`;
}

const WeekRow = memo(function WeekRow({ week, expanded, isCurrent, today, selectedSessionId, onToggleWeek, onSelect }: WeekRowProps) {
  const sessionCount = week.days.reduce((total, day) => total + day.sessions.length, 0);
  const title = `W${week.weekNumber} · ${compactWeekRange(week.startDate, week.endDate)}`;
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
          <span className="wc-week-chevron" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m8 10 4 4 4-4"/></svg></span>
          <span className="wc-week-title">{title}</span>
          <span className="wc-week-summary">{weekSummary(week) || `${sessionCount} session${sessionCount === 1 ? "" : "s"}`}</span>
        </button>
      </div>
      {expanded && (
        <div className="wc-week-body">
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

  const weeks = useMemo(
    () => groupSessionsByWeek(sessions, plan.effectiveStartDate, durationWeeks),
    [sessions, plan.effectiveStartDate, durationWeeks],
  );
  const currentWeek = useMemo(
    () => currentWeekNumber(plan.effectiveStartDate, today, durationWeeks),
    [plan.effectiveStartDate, today, durationWeeks],
  );
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

  // Scroll to an explicitly requested week whenever `scrollToWeek` changes (§7.3).
  useEffect(() => {
    if (scrollToWeek === null) return;
    setExpanded((current) => { const next = new Set(current); next.add(scrollToWeek); if (storageKey) sessionStorage.setItem(`${storageKey}:weeks`, JSON.stringify([...next])); return next; });
    const element = rootRef.current?.querySelector<HTMLElement>(`[data-week="${scrollToWeek}"]`);
    requestAnimationFrame(() => element?.scrollIntoView({ block: "nearest" }));
  }, [scrollToWeek, storageKey]);

  const first = weeks.at(0);
  const last = weeks.at(-1);
  const overallRange = first && last ? compactWeekRange(first.startDate, last.endDate) : "";
  const durationLabel = `${durationWeeks} week${durationWeeks === 1 ? "" : "s"}`;

  return (
    <section className="wc-calendar" ref={rootRef} aria-label="Weekly training calendar">
      <div className="wc-toolbar">
        <div className="wc-toolbar-text">
          <h3 className="wc-heading">Weekly Calendar</h3>
          <span className="wc-subheading">{overallRange}{overallRange ? ` (${durationLabel})` : durationLabel}</span>
        </div>
        <div className="wc-status-legend" aria-label="Session status legend">
          <span><i className="wc-status-light status-completed" aria-hidden="true"/>Completed</span>
          <span><i className="wc-status-light status-unrecorded" aria-hidden="true"/>Unrecorded</span>
        </div>
      </div>
      <div className="wc-weeks">
        {weeks.map((week) => (
          <WeekRow
            key={week.weekNumber}
            week={week}
            expanded={expanded.has(week.weekNumber)}
            isCurrent={week.weekNumber === currentWeek}
            today={today}
            selectedSessionId={selectedSessionId}
            onToggleWeek={toggleWeek}
            onSelect={handleSelect}
          />
        ))}
      </div>
    </section>
  );
}
