import { useId, useState, type ReactNode } from "react";
import { formatDistance, formatDuration, friendlyLabel, type CalendarSession, type TrainingHistorySession, type TrainingSummary, type WellnessRecord } from "./view-models";
import { addDays, weekdayIndex } from "./plan/view";

const domainOrder = ["strength", "endurance", "sport_skill", "mind_body", "recovery"] as const;
const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function localDay(startAt: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(startAt));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function overviewDateRange(today: string) {
  const weekStart = addDays(today, -weekdayIndex(today));
  const monthStart = `${today.slice(0, 7)}-01`;
  const nextMonth = new Date(`${monthStart}T12:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  return { weekStart, monthStart, monthEnd: addDays(nextMonth.toISOString().slice(0, 10), -1) };
}

export function calendarDays(anchorDay: string, history: TrainingHistorySession[], planned: CalendarSession[], timezone = "UTC") {
  const { monthStart, monthEnd } = overviewDateRange(anchorDay);
  const completed = new Set([
    ...history.map((session) => localDay(session.startAt, timezone)),
    ...planned.filter((session) => session.status === "completed").map((session) => session.scheduledDate),
  ].filter((day) => day >= monthStart && day <= monthEnd));
  const scheduled = new Set(planned.filter((session) => session.status === "planned" && !completed.has(session.scheduledDate)).map((session) => session.scheduledDate));
  const skipped = new Set(planned.filter((session) => session.status === "skipped").map((session) => session.scheduledDate));
  type Marker = "completed" | "planned" | "skipped";
  const result: Array<{ day: string | null; marker: Marker | null; markers: Marker[] }> = Array.from({ length: weekdayIndex(monthStart) }, () => ({ day: null, marker: null, markers: [] }));
  for (let day = monthStart; day <= monthEnd; day = addDays(day, 1)) {
    const markers: Marker[] = [...(completed.has(day) ? ["completed" as const] : []), ...(scheduled.has(day) ? ["planned" as const] : []), ...(skipped.has(day) ? ["skipped" as const] : [])];
    result.push({ day, marker: markers[0] ?? null, markers });
  }
  while (result.length < 42) result.push({ day: null, marker: null, markers: [] });
  return result;
}

type WellnessKey = Exclude<keyof WellnessRecord["fields"], "notes">;
const wellnessPriority: Array<{ key: WellnessKey; label: string; format: (value: number) => string; tone: string }> = [
  { key: "readiness", label: "Readiness", format: String, tone: "green" },
  { key: "sleepScore", label: "Sleep score", format: String, tone: "purple" },
  { key: "sleepSeconds", label: "Sleep", format: (value) => formatDuration(Math.round(value / 60)), tone: "purple" },
  { key: "hrvRmssdMs", label: "HRV", format: (value) => `${value} ms`, tone: "orange" },
  { key: "restingHeartRateBpm", label: "Resting HR", format: (value) => `${value} bpm`, tone: "blue" },
  { key: "fatigue", label: "Fatigue", format: String, tone: "orange" },
  { key: "stress", label: "Stress", format: String, tone: "orange" },
  { key: "soreness", label: "Soreness", format: String, tone: "orange" },
  { key: "mood", label: "Mood", format: String, tone: "green" },
  { key: "motivation", label: "Motivation", format: String, tone: "green" },
  { key: "weightKg", label: "Weight", format: (value) => `${value} kg`, tone: "blue" },
];

export function wellnessHighlights(records: WellnessRecord[]) {
  const sorted = [...records].sort((left, right) => right.day.localeCompare(left.day));
  const latest = sorted.find((record) => wellnessPriority.some(({ key }) => typeof record.fields[key]?.value === "number"));
  if (!latest) return null;
  const chosen: typeof wellnessPriority = [];
  for (const item of wellnessPriority) {
    if (item.key === "sleepSeconds" && typeof latest.fields.sleepScore?.value === "number") continue;
    if (typeof latest.fields[item.key]?.value === "number") chosen.push(item);
    if (chosen.length === 4) break;
  }
  return { day: latest.day, values: chosen.map((item) => {
    const value = latest.fields[item.key]!.value as number;
    const previous = sorted.find((record) => record.day < latest.day && typeof record.fields[item.key]?.value === "number")?.fields[item.key]?.value as number | undefined;
    const series = [...sorted].reverse().flatMap((record) => typeof record.fields[item.key]?.value === "number" ? [record.fields[item.key]!.value as number] : []).slice(-7);
    return { ...item, display: item.format(value), delta: previous === undefined ? null : Number((value - previous).toFixed(1)), series };
  }) };
}

export function formatWellnessDate(day: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

export function recoveryStatus(records: WellnessRecord[]) {
  const readiness = [...records].sort((left, right) => right.day.localeCompare(left.day)).find((record) => typeof record.fields.readiness?.value === "number")?.fields.readiness?.value;
  if (typeof readiness !== "number") return { label: "No data", detail: "Record readiness", value: null };
  if (readiness >= 80) return { label: "Excellent", detail: "Ready to train", value: readiness };
  if (readiness >= 60) return { label: "Good", detail: "Ready to train", value: readiness };
  if (readiness >= 40) return { label: "Fair", detail: "Train with care", value: readiness };
  return { label: "Low", detail: "Prioritize recovery", value: readiness };
}

export function weeklyOverview(today: string, history: TrainingHistorySession[], planned: CalendarSession[], timezone: string) {
  const weekStart = overviewDateRange(today).weekStart;
  const elapsed = weekdayIndex(today) + 1;
  const previousStart = addDays(weekStart, -7);
  const previousEnd = addDays(previousStart, elapsed - 1);
  const current = history.filter((session) => { const day = localDay(session.startAt, timezone); return day >= weekStart && day <= today; });
  const previous = history.filter((session) => { const day = localDay(session.startAt, timezone); return day >= previousStart && day <= previousEnd; });
  const duration = (sessions: TrainingHistorySession[]) => sessions.reduce((total, session) => total + session.durationMinutes, 0);
  const currentMinutes = duration(current); const previousMinutes = duration(previous);
  const weekEnd = addDays(weekStart, 6);
  const weekPlan = planned.filter((session) => session.scheduledDate >= weekStart && session.scheduledDate <= weekEnd && session.status !== "skipped");
  return { current, sessionDelta: current.length - previous.length, currentMinutes, durationPercent: previousMinutes > 0 ? Math.round(((currentMinutes - previousMinutes) / previousMinutes) * 100) : null, completedPlans: weekPlan.filter((session) => session.status === "completed").length, planTotal: weekPlan.length, unrecordedPlans: weekPlan.filter((session) => session.displayState === "unrecorded").length, skippedPlans: planned.filter((session) => session.scheduledDate >= weekStart && session.scheduledDate <= weekEnd && session.status === "skipped").length };
}

export function mesocycleProgress(planned: CalendarSession[]) {
  const total = planned.length;
  const completed = planned.filter((session) => session.status === "completed").length;
  return { completed, total, percent: total ? Math.round((completed / total) * 100) : 0 };
}

export function weeklyLoad(today: string, history: TrainingHistorySession[], planned: CalendarSession[], timezone: string) {
  const weekStart = overviewDateRange(today).weekStart;
  return weekdayLabels.map((label, index) => {
    const day = addDays(weekStart, index);
    const completed = history.filter((session) => localDay(session.startAt, timezone) === day).reduce((total, session) => total + session.durationMinutes, 0);
    const scheduled = planned.filter((session) => session.scheduledDate === day && session.status === "planned").reduce((total, session) => total + session.durationMinutes, 0);
    return { label, day, completed, scheduled };
  });
}

export function twelveWeekConsistency(today: string, history: TrainingHistorySession[], timezone: string) {
  const start = addDays(overviewDateRange(today).weekStart, -77);
  const completed = new Set(history.map((session) => localDay(session.startAt, timezone)));
  return Array.from({ length: 84 }, (_, index) => {
    const day = addDays(start, index);
    return { day, active: day <= today && completed.has(day), future: day > today };
  });
}

const sparklineBounds = { left: 4, right: 96, top: 5, bottom: 32, baseline: 39 };

function pathNumber(value: number) { return Number(value.toFixed(3)); }

export function sparklineGeometry(input: number[]) {
  const values = input.filter(Number.isFinite).slice(-7);
  if (!values.length) return null;
  const min = Math.min(...values); const max = Math.max(...values); const spread = max - min;
  const width = sparklineBounds.right - sparklineBounds.left;
  const points = values.map((value, index) => ({
    x: values.length === 1 ? (sparklineBounds.left + sparklineBounds.right) / 2 : sparklineBounds.left + index / (values.length - 1) * width,
    y: spread === 0 ? (sparklineBounds.top + sparklineBounds.bottom) / 2 : sparklineBounds.bottom - (value - min) / spread * (sparklineBounds.bottom - sparklineBounds.top),
  }));
  if (points.length === 1) return { linePath: `M ${pathNumber(points[0]!.x)} ${pathNumber(points[0]!.y)}`, areaPath: null, points };

  const slopes = points.slice(0, -1).map((point, index) => (points[index + 1]!.y - point.y) / (points[index + 1]!.x - point.x));
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0]!;
    if (index === points.length - 1) return slopes.at(-1)!;
    return slopes[index - 1]! * slopes[index]! <= 0 ? 0 : (slopes[index - 1]! + slopes[index]!) / 2;
  });
  slopes.forEach((slope, index) => {
    if (slope === 0) { tangents[index] = 0; tangents[index + 1] = 0; return; }
    const first = tangents[index]! / slope; const second = tangents[index + 1]! / slope;
    const magnitude = first * first + second * second;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * first * slope;
      tangents[index + 1] = scale * second * slope;
    }
  });

  let linePath = `M ${pathNumber(points[0]!.x)} ${pathNumber(points[0]!.y)}`;
  points.slice(0, -1).forEach((point, index) => {
    const next = points[index + 1]!; const segment = next.x - point.x;
    linePath += ` C ${pathNumber(point.x + segment / 3)} ${pathNumber(point.y + tangents[index]! * segment / 3)} ${pathNumber(next.x - segment / 3)} ${pathNumber(next.y - tangents[index + 1]! * segment / 3)} ${pathNumber(next.x)} ${pathNumber(next.y)}`;
  });
  return { linePath, areaPath: `${linePath} L ${sparklineBounds.right} ${sparklineBounds.baseline} L ${sparklineBounds.left} ${sparklineBounds.baseline} Z`, points };
}

function Sparkline({ values }: { values: number[] }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const gradientId = `wellness-spark-${uid}`;
  const sideFadeId = `wellness-spark-side-${uid}`;
  const maskId = `wellness-spark-mask-${uid}`;
  const geometry = sparklineGeometry(values);
  if (!geometry) return <span className="sparkline-empty" data-chart="wellness-trend-empty" aria-hidden="true"/>;
  return <svg className="sparkline" data-chart="wellness-trend" data-points={geometry.points.length} viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity="0.25"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient>
      <linearGradient id={sideFadeId} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#fff" stopOpacity="0"/><stop offset="0.16" stopColor="#fff" stopOpacity="1"/><stop offset="0.84" stopColor="#fff" stopOpacity="1"/><stop offset="1" stopColor="#fff" stopOpacity="0"/></linearGradient>
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="40"><rect x="0" y="0" width="100" height="40" fill={`url(#${sideFadeId})`}/></mask>
    </defs>
    {geometry.areaPath && <path className="sparkline-area" fill={`url(#${gradientId})`} mask={`url(#${maskId})`} d={geometry.areaPath}/>} 
    {geometry.points.length === 1 ? <circle cx={geometry.points[0]!.x} cy={geometry.points[0]!.y} r="2.2"/> : <path className="sparkline-line" d={geometry.linePath}/>} 
  </svg>;
}

function wellnessDeltaTone(key: WellnessKey, delta: number | null) {
  if (delta === null || delta === 0) return "neutral";
  const favorable = key === "restingHeartRateBpm" ? delta < 0 : delta > 0;
  return favorable ? "favorable" : "unfavorable";
}

function OverviewIcon({ kind }: { kind: "workout" | "target" | "recovery" | (typeof domainOrder)[number] }) {
  const icon = kind === "workout" || kind === "strength" ? <><path d="M5 9v6M3 10v4M19 9v6M21 10v4M5 12h14"/><path d="M7 8v8M17 8v8"/></>
    : kind === "target" ? <><circle cx="11" cy="13" r="7"/><circle cx="11" cy="13" r="3.2"/><path d="m13.5 10.5 6-6M16 4.5h3.5V8"/></>
    : kind === "recovery" ? <><path d="M5 18c1-8 6-12 14-12-1 8-5 13-12 12"/><path d="M7 18c3-4 6-7 10-9"/></>
    : kind === "endurance" ? <><circle cx="14" cy="5" r="2"/><path d="m12 9 3 2 2 4M12 9l-3 4-4 1M10 13l-1 6M15 12l-4 3 4 4"/></>
    : kind === "sport_skill" ? <><circle cx="12" cy="12" r="8.5"/><path d="m12 3.5 3 4-1 4-4 1-3-3M14 11.5l4 2 1 4M10 12.5l1 4-3 3M7 9.5 4 9"/></>
    : <><path d="M7 18c2-2 2-5 1-7M17 18c-2-2-2-5-1-7M9 8c1 2 5 2 6 0"/><circle cx="12" cy="5" r="2"/><path d="M8 19h8"/></>;
  return <span className={`overview-icon icon-${kind}`} data-icon={kind} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icon}</svg></span>;
}

function MiniBars({ values, tone, slots = 4 }: { values: number[]; tone: "coral" | "green"; slots?: number }) {
  const visible = values.slice(-slots);
  const padded: Array<number | null> = [...Array(Math.max(0, slots - visible.length)).fill(null), ...visible];
  const max = Math.max(1, ...visible);
  return <span className={`summary-bars ${tone} ${visible.length ? "" : "empty"}`} data-chart={`${tone}-bars`} aria-hidden="true">{padded.map((value, index) => <i key={index} style={{ height: value === null ? undefined : `${Math.max(18, value / max * 100)}%` }}/>)}</span>;
}

function TrophyIcon() {
  return <span className="consistency-trophy" data-icon="trophy" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 4h8v4a4 4 0 0 1-8 0V4Z"/><path d="M8 6H4v1a4 4 0 0 0 4 4M16 6h4v1a4 4 0 0 1-4 4M12 12v4M8 20h8M9 16h6v4"/></svg></span>;
}

function Change({ value, suffix = " from last week" }: { value: number | null; suffix?: string }) {
  if (value === null) return <small className="metric-change neutral">No prior data</small>;
  const direction = value > 0 ? "up" : value < 0 ? "down" : "neutral";
  return <small className={`metric-change ${direction}`}>{value > 0 ? "↑" : value < 0 ? "↓" : "→"} {Math.abs(value)}{suffix}</small>;
}

function SummaryCard({ icon, title, value, children, className = "" }: { icon: "workout" | "target" | "recovery"; title: string; value: ReactNode; children: ReactNode; className?: string }) {
  return <article className={`overview-summary-card ${className}`}><OverviewIcon kind={icon}/><div className="summary-card-copy"><span>{title}</span><strong>{value}</strong>{children}</div></article>;
}

function ActivityDonut({ summary }: { summary: TrainingSummary }) {
  const values = domainOrder.map((domain) => summary.byDomain[domain] ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0); let offset = 0;
  return <div className="activity-donut"><svg viewBox="0 0 42 42" aria-hidden="true"><circle className="donut-track" cx="21" cy="21" r="15.9"/>{total > 0 && values.map((value, index) => {
    const percent = value / total * 100; const start = offset; offset += percent;
    return <circle key={domainOrder[index]} className={`donut-segment domain-${domainOrder[index]}`} cx="21" cy="21" r="15.9" pathLength="100" strokeDasharray={`${percent} ${100 - percent}`} strokeDashoffset={-start}/>;
  })}</svg><span><strong>{summary.sessionCount}</strong><small>Workout{summary.sessionCount === 1 ? "" : "s"}</small></span></div>;
}

function monthShift(month: string, amount: number) { const date = new Date(`${month}-01T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() + amount); return date.toISOString().slice(0, 7); }

export function OverviewDashboard({ summary, wellness, history, planned, today, timezone }: { summary: TrainingSummary; wellness: WellnessRecord[]; history: TrainingHistorySession[]; planned: CalendarSession[]; today: string; timezone: string }) {
  const [visibleMonth, setVisibleMonth] = useState(today.slice(0, 7));
  const wellnessData = wellnessHighlights(wellness); const recovery = recoveryStatus(wellness); const week = weeklyOverview(today, history, planned, timezone); const load = weeklyLoad(today, history, planned, timezone);
  const calendarAnchor = `${visibleMonth}-01`; const days = calendarDays(calendarAnchor, history, planned, timezone);
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${visibleMonth}-01T12:00:00Z`));
  const monthCompleted = new Set(history.map((session) => localDay(session.startAt, timezone)).filter((day) => day.startsWith(`${visibleMonth}-`)));
  planned.filter((session) => session.status === "completed" && session.scheduledDate.startsWith(`${visibleMonth}-`)).forEach((session) => monthCompleted.add(session.scheduledDate));
  const monthDays = Number(overviewDateRange(calendarAnchor).monthEnd.slice(-2));
  const meso = mesocycleProgress(planned);
  const readinessSeries = wellnessData?.values.find((item) => item.key === "readiness")?.series ?? []; const maxDomainDuration = Math.max(1, ...domainOrder.map((domain) => summary.durationMinutesByDomain[domain] ?? 0));
  const completedSeries = load.map((item) => week.current.filter((session) => localDay(session.startAt, timezone) === item.day).length);
  const consistencyDays = twelveWeekConsistency(today, history, timezone);
  const maxLoad = Math.max(60, ...load.map((item) => item.completed + item.scheduled)); const loadCeiling = Math.ceil(maxLoad / 60) * 60;
  const incomplete = summary.metrics.strength.workingSets.dataQuality.completeness < 1 || summary.metrics.endurance.distanceMeters.dataQuality.completeness < 1;

  return <div className="overview-dashboard">
    <section className="overview-summary-grid" aria-label="This week so far">
      <SummaryCard icon="workout" title="Completed workouts" value={summary.sessionCount} className="bars-summary"><Change value={week.sessionDelta}/><MiniBars values={completedSeries} tone="coral"/></SummaryCard>
      <SummaryCard icon="target" title="Plan progress" value={`${meso.completed} / ${meso.total}`} className="plan-summary"><small>this mesocycle</small><span className="progress-ring" style={{ "--progress": `${meso.percent * 3.6}deg` } as React.CSSProperties}><b>{meso.percent}%</b></span></SummaryCard>
      <SummaryCard icon="recovery" title="Recovery" value={recovery.label} className="bars-summary recovery-summary"><small>{recovery.detail}</small><MiniBars values={readinessSeries} tone="green" slots={5}/></SummaryCard>
    </section>

    <div className="overview-layout">
      <section className="overview-panel overview-activity"><header><div><h2>Activity Mix</h2><p>Your workouts this week</p></div><button type="button" className="activity-arrow" aria-label="Open Training" title="Open Training" onClick={() => window.dispatchEvent(new CustomEvent("athria-open-training"))}><span aria-hidden="true">›</span></button></header>
        {!summary.sessionCount ? <p className="overview-empty">No completed workouts yet this week.</p> : <div className="activity-content"><ActivityDonut summary={summary}/><div className="activity-list">{domainOrder.map((domain) => {
          const count = summary.byDomain[domain] ?? 0; const duration = summary.durationMinutesByDomain[domain] ?? 0;
          const detail = domain === "strength" ? `${formatDuration(duration)} · ${summary.metrics.strength.workingSets.value} sets` : domain === "endurance" ? `${formatDuration(duration)} · ${formatDistance(summary.metrics.endurance.distanceMeters.value)}` : domain === "sport_skill" && summary.sports.length ? `${formatDuration(duration)} · ${summary.sports.map((sport) => sport.name).join(", ")}` : formatDuration(duration);
          return <article className={`activity-row domain-${domain}`} key={domain}><OverviewIcon kind={domain}/><div><span><strong>{friendlyLabel(domain)}</strong><small>{count} workout{count === 1 ? "" : "s"}</small><em>{detail}</em></span><i><b style={{ width: `${duration / maxDomainDuration * 100}%` }}/></i></div></article>;
        })}</div></div>}
        {summary.sessionCount > 0 && incomplete && <p className="overview-note">Some workout details were unavailable, so sport-specific totals may be incomplete.</p>}
      </section>

      <section className="overview-panel overview-calendar"><header><h2>{monthLabel}</h2><div className="calendar-controls"><button type="button" aria-label="Previous month" onClick={() => setVisibleMonth((value) => monthShift(value, -1))}>‹</button><button type="button" aria-label="Next month" onClick={() => setVisibleMonth((value) => monthShift(value, 1))}>›</button></div></header>
        <div className="mini-calendar" aria-label={`${monthLabel} training calendar`}>{weekdayLabels.map((label) => <span className="mini-weekday" key={label}>{label}</span>)}{days.map((item, index) => <span className={`mini-day ${item.day === today ? "today" : ""}`} key={item.day ?? `blank-${index}`}>{item.day ? Number(item.day.slice(-2)) : ""}{item.markers.length > 0 && <span className="mini-day-markers">{item.markers.map((marker) => <i key={marker} className={marker} aria-label={marker === "completed" ? "Completed training" : marker === "planned" ? "Scheduled training" : "Skipped plan"}/>)}</span>}</span>)}</div>
        <div className="calendar-legend"><span><i className="completed"/>Completed</span><span><i className="planned"/>Scheduled</span><span><i className="skipped"/>Skipped plan</span></div>
      </section>

      <div className="overview-lower-grid"><section className="overview-panel training-load"><header><div><h2>Training Load</h2><p>Your weekly training time</p></div><div className="panel-metric"><strong>{formatDuration(summary.totalDurationMinutes)}</strong><Change value={week.durationPercent} suffix="% from last week"/></div></header>
        <div className="load-chart"><div className="load-axis"><span>{loadCeiling / 60}h</span><span>{loadCeiling / 120}h</span><span>0h</span></div><div className="load-bars">{load.map((item) => <div className="load-day" key={item.day}><span className="load-stack" style={{ height: `${((item.completed + item.scheduled) / loadCeiling) * 100}%` }}><i className="load-planned" style={{ height: `${item.completed + item.scheduled ? item.scheduled / (item.completed + item.scheduled) * 100 : 0}%` }}/><i className="load-completed" style={{ height: `${item.completed + item.scheduled ? item.completed / (item.completed + item.scheduled) * 100 : 0}%` }}/></span><small>{item.label}</small></div>)}</div></div>
      </section>
      <section className="overview-panel consistency"><header><div><h2>Consistency</h2><p>Active days this month</p></div><strong>{monthCompleted.size} / {monthDays}</strong></header>
        <div className="consistency-grid" data-range="twelve-weeks" aria-label="Training consistency over the last twelve weeks">{consistencyDays.filter((item) => !item.future).map((item) => <i key={item.day} className={item.active ? "active" : ""} title={item.day}/>)}</div>
        <div className="consistency-note"><TrophyIcon/><div><strong>{monthCompleted.size ? "Nice consistency!" : "Your month starts here"}</strong><small>{monthCompleted.size ? `You've been active ${monthCompleted.size} day${monthCompleted.size === 1 ? "" : "s"} this month.` : "Complete a workout to begin your streak."}</small></div></div>
      </section></div>
      <section className="overview-panel overview-wellness"><header><h2>Wellness</h2>{wellnessData && <time dateTime={wellnessData.day}>{formatWellnessDate(wellnessData.day)}</time>}</header>
        {!wellnessData ? <p className="overview-empty">No wellness data yet. Connect Intervals.icu or record a wellness check-in.</p> : <div className="wellness-grid">{wellnessData.values.map((item) => <article className={`wellness-${item.tone}`} key={item.key}><div className="wellness-copy"><span>{item.label}</span><strong>{item.display}</strong><small className={wellnessDeltaTone(item.key, item.delta)}>{item.delta === null ? "No earlier value" : `${item.delta > 0 ? "↑" : item.delta < 0 ? "↓" : "→"} ${Math.abs(item.delta)} from previous`}</small></div><Sparkline values={item.series}/></article>)}</div>}
      </section></div>
  </div>;
}
