import { T, tr, currentLanguage, weekdayName } from "./i18n";
import { useId, useState, type ReactNode } from "react";
import { adjustmentReasonMessage, formatDistance, formatDuration, friendlyLabel, type AdjustmentAssessment, type CalendarSession, type TrainingHistorySession, type TrainingSummary, type WellnessRecord } from "./view-models";
import { addDays, weekdayIndex } from "./plan/view";
import { domainIconPath } from "./domain-icons";
import { useModalDismiss } from "./components";

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
function wellnessSleepFormat(value: number) {
  const minutes = Math.round(value / 60); const hours = Math.floor(minutes / 60); const remaining = minutes % 60;
  return `${hours}:${String(remaining).padStart(2, "0")}`;
}
function wellnessNumber(record: WellnessRecord, key: WellnessKey) {
  const value = record.fields[key]?.value;
  return typeof value === "number" ? value : null;
}
// The first four entries are the featured wellness trends; the next three backfill empty slots (steps, SDNN, sleep), then the remaining signals.
const wellnessPriority: Array<{ key: WellnessKey; label: string; format: (value: number) => string; tone: string }> = [
  { key: "sleepScore", label: "Sleep score", format: String, tone: "purple" },
  { key: "hrvRmssdMs", label: "HRV (ms)", format: String, tone: "orange" },
  { key: "restingHeartRateBpm", label: "Resting HR (bpm)", format: String, tone: "blue" },
  { key: "vo2maxMlKgMin", label: "VO2 max (ml/kg/min)", format: String, tone: "green" },
  { key: "stepsCount", label: "Steps", format: String, tone: "green" },
  { key: "hrvSdnnMs", label: "HRV SDNN (ms)", format: String, tone: "orange" },
  { key: "sleepSeconds", label: "Sleep", format: wellnessSleepFormat, tone: "purple" },
  { key: "avgSleepingHeartRateBpm", label: "Sleeping HR (bpm)", format: String, tone: "blue" },
  { key: "sleepQuality", label: "Sleep quality", format: String, tone: "purple" },
  { key: "spo2Percent", label: "SpO2 (%)", format: String, tone: "blue" },
  { key: "fatigue", label: "Fatigue", format: String, tone: "orange" },
  { key: "stress", label: "Stress", format: String, tone: "orange" },
  { key: "soreness", label: "Soreness", format: String, tone: "orange" },
  { key: "mood", label: "Mood", format: String, tone: "green" },
  { key: "motivation", label: "Motivation", format: String, tone: "green" },
];

// Every metric curve shares one fourteen-day window ending today, so the header range always matches the trends shown.
export function wellnessHighlights(records: WellnessRecord[], today: string) {
  const start = addDays(today, -13); const end = today;
  const windowRecords = records.filter((record) => record.day >= start && record.day <= end).sort((left, right) => left.day.localeCompare(right.day));
  const chosen: typeof wellnessPriority = [];
  for (const item of wellnessPriority) {
    if (windowRecords.some((record) => wellnessNumber(record, item.key) !== null)) chosen.push(item);
    if (chosen.length === 4) break;
  }
  if (!chosen.length) return null;
  const values = chosen.map((item) => {
    const series = windowRecords.flatMap((record) => { const value = wellnessNumber(record, item.key); return value === null ? [] : [value]; }).slice(-14);
    const value = series.at(-1)!; const previous = series.at(-2);
    return { ...item, display: item.format(value), delta: previous === undefined ? null : Number((value - previous).toFixed(1)), series };
  });
  return { start, end, values };
}

export function formatWellnessDate(day: string) {
  return new Intl.DateTimeFormat(currentLanguage() === "en" ? "en-US" : "zh-CN", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

function wellnessDayShort(day: string) {
  return new Intl.DateTimeFormat(currentLanguage() === "en" ? "en-US" : "zh-CN", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

export function formatWellnessRange(start: string, end: string) {
  if (start === end) return formatWellnessDate(start);
  if (currentLanguage() === "zh-CN") return `${formatWellnessDate(start)} – ${formatWellnessDate(end)}`;
  const startYear = start.slice(0, 4); const endYear = end.slice(0, 4);
  return startYear === endYear ? `${wellnessDayShort(start)} – ${wellnessDayShort(end)}, ${endYear}` : `${wellnessDayShort(start)}, ${startYear} – ${wellnessDayShort(end)}, ${endYear}`;
}

function medianValue(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right); const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// Each available signal scores 0-100 against its own baseline so one stable verdict can summarize recovery.
function recoveryComponentScores(sorted: WellnessRecord[]) {
  const [latest, ...history] = sorted;
  if (!latest) return [];
  const baseline = (key: WellnessKey, limit = 28) => history.flatMap((record) => { const value = wellnessNumber(record, key); return value === null ? [] : [value]; }).slice(0, limit);
  const scores: number[] = [];
  const hrvKey: WellnessKey | null = wellnessNumber(latest, "hrvRmssdMs") !== null ? "hrvRmssdMs" : wellnessNumber(latest, "hrvSdnnMs") !== null ? "hrvSdnnMs" : null;
  if (hrvKey) {
    const values = baseline(hrvKey); const value = wellnessNumber(latest, hrvKey);
    if (values.length >= 3 && value !== null) { const ratio = value / medianValue(values); scores.push(ratio >= 1 ? 90 : ratio >= 0.95 ? 75 : ratio >= 0.9 ? 60 : ratio >= 0.85 ? 45 : 30); }
  }
  const restingHr = wellnessNumber(latest, "restingHeartRateBpm");
  if (restingHr !== null) {
    const values = baseline("restingHeartRateBpm");
    if (values.length >= 3) { const delta = restingHr - medianValue(values); scores.push(delta <= 0 ? 90 : delta <= 2 ? 75 : delta <= 4 ? 60 : delta <= 6 ? 45 : 30); }
  }
  const sleepScore = wellnessNumber(latest, "sleepScore"); const sleepSeconds = wellnessNumber(latest, "sleepSeconds");
  if (sleepScore !== null) scores.push(sleepScore >= 85 ? 90 : sleepScore >= 75 ? 75 : sleepScore >= 65 ? 60 : sleepScore >= 55 ? 45 : 30);
  else if (sleepSeconds !== null) scores.push(sleepSeconds >= 27000 ? 90 : sleepSeconds >= 25200 ? 75 : sleepSeconds >= 23400 ? 60 : sleepSeconds >= 21600 ? 45 : 30);
  const readiness = wellnessNumber(latest, "readiness");
  if (readiness !== null) scores.push(readiness >= 80 ? 90 : readiness >= 65 ? 75 : readiness >= 50 ? 60 : readiness >= 35 ? 45 : 30);
  for (const key of ["fatigue", "soreness"] as const) {
    const value = wellnessNumber(latest, key); if (value === null) continue;
    const values = baseline(key);
    if (values.length >= 3) { const delta = value - medianValue(values); scores.push(delta <= -1 ? 90 : delta <= 1 ? 75 : delta <= 3 ? 45 : 30); }
  }
  return scores;
}

export function recoveryStatus(records: WellnessRecord[]) {
  const sorted = [...records].sort((left, right) => right.day.localeCompare(left.day));
  let index = -1; let score = 0;
  for (let candidate = 0; candidate < sorted.length; candidate += 1) {
    const scores = recoveryComponentScores(sorted.slice(candidate));
    if (scores.length) { index = candidate; score = Math.round(scores.reduce((total, value) => total + value, 0) / scores.length); break; }
  }
  if (index === -1) return { label: "No data", detail: "Record wellness", value: null, series: [] };
  const series: number[] = [];
  for (let candidate = index; candidate < sorted.length && series.length < 5; candidate += 1) {
    const scores = recoveryComponentScores(sorted.slice(candidate));
    if (scores.length) series.unshift(Math.round(scores.reduce((total, value) => total + value, 0) / scores.length));
  }
  if (score >= 70) return { label: "Ready", detail: "Ready to train", value: score, series };
  if (score >= 45) return { label: "Caution", detail: "Train with care", value: score, series };
  return { label: "Rest", detail: "Prioritize recovery", value: score, series };
}

// The readiness ring colour follows the verdict: green when ready, amber for caution, red for rest.
export function recoveryRingTone(label: string) {
  return label === "Ready" ? "ready" : label === "Caution" ? "caution" : label === "Rest" ? "rest" : "empty";
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

export function loadAxisLabel(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes % 30 === 0) return `${Number((minutes / 60).toFixed(1))}h`;
  return `${minutes}m`;
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
  const values = input.filter(Number.isFinite).slice(-14);
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
  const lowerIsBetter = key === "restingHeartRateBpm" || key === "avgSleepingHeartRateBpm";
  const favorable = lowerIsBetter ? delta < 0 : delta > 0;
  return favorable ? "favorable" : "unfavorable";
}

function OverviewIcon({ kind }: { kind: "workout" | "target" | "recovery" | (typeof domainOrder)[number] }) {
  const icon = kind === "workout" ? domainIconPath("strength")
    : kind === "target" ? <><circle cx="11" cy="13" r="7"/><circle cx="11" cy="13" r="3.2"/><path d="m13.5 10.5 6-6M16 4.5h3.5V8"/></>
    : domainIconPath(kind);
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

function Change({ value, suffix = " from last week", stacked = false }: { value: number | null; suffix?: string; stacked?: boolean }) {
  if (value === null) return <small className="metric-change neutral"><T>{"No prior data"}</T></small>;
  const direction = value > 0 ? "up" : value < 0 ? "down" : "neutral";
  const arrow = value > 0 ? "↑" : value < 0 ? "↓" : "→";
  if (stacked) {
    const [head = "", ...words] = suffix.trim().split(" ");
    return <small className={`metric-change stacked ${direction}`}><span>{arrow} {Math.abs(value)}{head}</span>{words.length > 0 && <span>{words.join(" ")}</span>}</small>;
  }
  return <small className={`metric-change ${direction}`}>{arrow} {Math.abs(value)}{suffix}</small>;
}

function SummaryCard({ icon, title, value, children, className = "" }: { icon: "workout" | "target" | "recovery"; title: string; value: ReactNode; children: ReactNode; className?: string }) {
  return <article className={`overview-summary-card ${className}`}><OverviewIcon kind={icon}/><div className="summary-card-copy"><span>{title}</span><strong>{value}</strong>{children}</div></article>;
}

export function RecoveryHelpModal({ onClose }: { onClose: () => void }) {
  useModalDismiss(onClose);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="connection-modal recovery-modal" role="dialog" aria-modal="true" aria-labelledby="recovery-help-title">
      <header><div><h2 id="recovery-help-title"><T>{"How We Calculate Overall Readiness"}</T></h2><p><T>{"One score that sums up how ready you are to train."}</T></p></div><button type="button" className="modal-close" aria-label={tr("Close dialog")} onClick={onClose}><svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
      <div className="modal-body">
        <p className="recovery-help-lead"><T>{"We compare the signals you track with your own recent baseline (up to 28 days):"}</T></p>
        <ul className="recovery-help-signals">
          <li><strong><T>{"HRV"}</T></strong><span><T>{"Higher than your usual level is good."}</T></span></li>
          <li><strong><T>{"Resting heart rate"}</T></strong><span><T>{"Lower than your usual level is good."}</T></span></li>
          <li><strong><T>{"Sleep"}</T></strong><span><T>{"Last night's sleep score, or duration when no score is available."}</T></span></li>
          <li><strong><T>{"Check-ins"}</T></strong><span><T>{"Fatigue, soreness and readiness you record."}</T></span></li>
        </ul>
        <p className="recovery-help-lead"><T>{"Each signal is scored 0-100, then averaged into one number:"}</T></p>
        <ul className="recovery-help-verdicts">
          <li className="ready"><i/><div><strong>Ready · 70+</strong><span><T>{"Recovered. Train as planned."}</T></span></div></li>
          <li className="caution"><i/><div><strong>Caution · 45-69</strong><span><T>{"You can train, but keep it lighter."}</T></span></div></li>
          <li className="rest"><i/><div><strong>Rest · below 45</strong><span><T>{"Prioritize recovery today."}</T></span></div></li>
        </ul>
        <p className="recovery-help-note"><T>{"Signals with no data are skipped. The ring shows your overall readiness score out of 100."}</T></p>
      </div>
    </section>
  </div>;
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

const severityRank = { hard: 0, strong: 1, soft: 2, info: 3 } as const;

const noticeCopy = {
  watch: "Weekly check:",
  review_recommended: "Ask your agent to review the plan:",
  review_required: "Plan review required — ask your agent:",
} as const;

export function AdjustmentReviewNotice({ value }: { value: AdjustmentAssessment }) {
  const [dismissed, setDismissed] = useState(false);
  const reason = [...value.reasons].sort((left, right) => severityRank[left.severity] - severityRank[right.severity])[0];
  if (!reason || dismissed) return null;
  const status = value.reviewStatus as keyof typeof noticeCopy;
  return <div className={`adjustment-notice adjustment-notice-${status}`} role="status"><span>{tr(noticeCopy[status])} {adjustmentReasonMessage(reason)}</span><button type="button" className="adjustment-notice-close" aria-label={tr("Dismiss message")} onClick={() => setDismissed(true)}>×</button></div>;
}

export function OverviewDashboard({ summary, wellness, history, planned, today, timezone, adjustment }: { summary: TrainingSummary; wellness: WellnessRecord[]; history: TrainingHistorySession[]; planned: CalendarSession[]; today: string; timezone: string; adjustment?: AdjustmentAssessment | undefined }) {
  const [visibleMonth, setVisibleMonth] = useState(today.slice(0, 7));
  const [helpOpen, setHelpOpen] = useState(false);
  const wellnessData = wellnessHighlights(wellness, today); const recovery = recoveryStatus(wellness); const week = weeklyOverview(today, history, planned, timezone); const load = weeklyLoad(today, history, planned, timezone);
  const calendarAnchor = `${visibleMonth}-01`; const days = calendarDays(calendarAnchor, history, planned, timezone);
  const monthLabel = new Intl.DateTimeFormat(currentLanguage(), { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${visibleMonth}-01T12:00:00Z`));
  const monthCompleted = new Set(history.map((session) => localDay(session.startAt, timezone)).filter((day) => day.startsWith(`${visibleMonth}-`)));
  planned.filter((session) => session.status === "completed" && session.scheduledDate.startsWith(`${visibleMonth}-`)).forEach((session) => monthCompleted.add(session.scheduledDate));
  const monthDays = Number(overviewDateRange(calendarAnchor).monthEnd.slice(-2));
  const meso = mesocycleProgress(planned);
  const maxDomainDuration = Math.max(1, ...domainOrder.map((domain) => summary.durationMinutesByDomain[domain] ?? 0));
  const completedSeries = load.map((item) => week.current.filter((session) => localDay(session.startAt, timezone) === item.day).length);
  const consistencyDays = twelveWeekConsistency(today, history, timezone);
  const maxLoad = Math.max(0, ...load.map((item) => item.completed + item.scheduled)); const loadCeiling = Math.max(30, Math.ceil(maxLoad / 30) * 30);
  const incomplete = summary.metrics.strength.workingSets.dataQuality.completeness < 1 || summary.metrics.endurance.distanceMeters.dataQuality.completeness < 1;

  return <div className="overview-dashboard">
    {adjustment && <AdjustmentReviewNotice value={adjustment}/>}
    <section className="overview-summary-grid" aria-label={tr("This week so far")}>
      <SummaryCard icon="workout" title={tr("Completed Workouts")} value={summary.sessionCount} className="bars-summary"><Change value={week.sessionDelta}/><MiniBars values={completedSeries} tone="green"/></SummaryCard>
      <SummaryCard icon="target" title={tr("Plan Progress")} value={`${meso.completed} / ${meso.total}`} className="plan-summary"><small>this mesocycle</small><span className="progress-ring" style={{ "--progress": `${meso.percent * 3.6}deg` } as React.CSSProperties}><b>{meso.percent}%</b></span></SummaryCard>
      <SummaryCard icon="recovery" title={tr("Overall Readiness")} value={tr(recovery.label)} className="recovery-summary"><small>{tr(recovery.detail)}</small><button type="button" className="recovery-help" aria-haspopup="dialog" onClick={() => setHelpOpen(true)}><T>{"How do we calculate?"}</T><span aria-hidden="true">→</span></button><span className={`progress-ring ${recoveryRingTone(recovery.label)}`} style={{ "--progress": `${(recovery.value ?? 0) * 3.6}deg` } as React.CSSProperties}><b>{recovery.value ?? "—"}</b></span></SummaryCard>
    </section>

    <div className="overview-layout">
      <section className="overview-panel overview-activity"><header><div><h2><T>{"Activity Mix"}</T></h2><p><T>{"Your workouts this week"}</T></p></div><button type="button" className="activity-arrow" aria-label={tr("Open Training")} title={tr("Open Training")} onClick={() => window.dispatchEvent(new CustomEvent("athria-open-training"))}><span aria-hidden="true">›</span></button></header>
        {!summary.sessionCount ? <p className="overview-empty"><T>{"No completed workouts yet this week."}</T><br/>{tr("Connect to your ")}<button type="button" className="overview-empty-link" onClick={() => window.dispatchEvent(new CustomEvent("athria-open-connections"))}>{tr("training apps")}</button>{tr(" or check out your ")}<button type="button" className="overview-empty-link" onClick={() => document.getElementById("overview-next-day")?.scrollIntoView({ behavior: "smooth", block: "start" })}>{tr("next plan")}</button>{tr(".")}</p> : <div className="activity-content"><ActivityDonut summary={summary}/><div className="activity-list">{domainOrder.map((domain) => {
          const count = summary.byDomain[domain] ?? 0; const duration = summary.durationMinutesByDomain[domain] ?? 0;
          const detail = domain === "strength" ? `${formatDuration(duration)} · ${summary.metrics.strength.workingSets.value} ${currentLanguage() === "zh-CN" ? "组" : "sets"}` : domain === "endurance" ? `${formatDuration(duration)} · ${formatDistance(summary.metrics.endurance.distanceMeters.value)}` : domain === "sport_skill" && summary.sports.length ? `${formatDuration(duration)} · ${summary.sports.map((sport) => sport.name).join(", ")}` : formatDuration(duration);
          return <article className={`activity-row domain-${domain}`} key={domain}><OverviewIcon kind={domain}/><div><span><strong>{friendlyLabel(domain)}</strong><small>{currentLanguage() === "zh-CN" ? `${count} 次训练` : `${count} workout${count === 1 ? "" : "s"}`}</small><em>{detail}</em></span><i><b style={{ width: `${duration / maxDomainDuration * 100}%` }}/></i></div></article>;
        })}</div></div>}
        {summary.sessionCount > 0 && incomplete && <p className="overview-note"><T>{"Some workout details were unavailable, so sport-specific totals may be incomplete."}</T></p>}
      </section>

      <section className="overview-panel overview-calendar"><header><h2>{monthLabel}</h2><div className="calendar-controls"><button type="button" aria-label={tr("Previous month")} onClick={() => setVisibleMonth((value) => monthShift(value, -1))}><span aria-hidden="true">‹</span></button><button type="button" aria-label={tr("Next month")} onClick={() => setVisibleMonth((value) => monthShift(value, 1))}><span aria-hidden="true">›</span></button></div></header>
        <div className="mini-calendar" aria-label={`${monthLabel} training calendar`}>{weekdayLabels.map((label, index) => <span className="mini-weekday" key={label}>{weekdayName(index, currentLanguage(), "short")}</span>)}{days.map((item, index) => <span className={`mini-day ${item.day === today ? "today" : ""}`} key={item.day ?? `blank-${index}`}>{item.day ? Number(item.day.slice(-2)) : ""}{item.markers.length > 0 && <span className="mini-day-markers">{item.markers.map((marker) => <i key={marker} className={marker} aria-label={tr(marker === "completed" ? "Completed training" : marker === "planned" ? "Scheduled training" : "Skipped plan")}/>)}</span>}</span>)}</div>
        <div className="calendar-legend"><span><i className="completed"/><T>{"Completed"}</T></span><span><i className="planned"/><T>{"Scheduled"}</T></span><span><i className="skipped"/><T>{"Skipped plan"}</T></span></div>
      </section>

      <div className="overview-lower-grid"><section className="overview-panel training-load"><header><div><h2><T>{"Training Load"}</T></h2></div><strong>{formatDuration(summary.totalDurationMinutes)}</strong><Change value={week.durationPercent} suffix="% from last week" stacked/><p><T>{"Your weekly training time"}</T></p></header>
        <div className="load-chart"><div className="load-axis"><span>{loadAxisLabel(loadCeiling)}</span><span>{loadAxisLabel(loadCeiling / 2)}</span><span>0h</span></div><div className="load-bars">{load.map((item) => <div className="load-day" key={item.day}><span className="load-stack" style={{ height: `${((item.completed + item.scheduled) / loadCeiling) * 100}%` }}><i className="load-planned" style={{ height: `${item.completed + item.scheduled ? item.scheduled / (item.completed + item.scheduled) * 100 : 0}%` }}/><i className="load-completed" style={{ height: `${item.completed + item.scheduled ? item.completed / (item.completed + item.scheduled) * 100 : 0}%` }}/></span><small>{tr(item.label)}</small></div>)}</div></div>
      </section>
      <section className="overview-panel consistency"><header><div><h2><T>{"Consistency"}</T></h2><p><T>{"Active days this month"}</T></p></div><strong>{monthCompleted.size} / {monthDays}</strong></header>
        <div className="consistency-grid" data-range="twelve-weeks" aria-label={tr("Training consistency over the last twelve weeks")}>{consistencyDays.filter((item) => !item.future).map((item) => <i key={item.day} className={item.active ? "active" : ""} title={item.day}/>)}</div>
        <div className="consistency-note"><TrophyIcon/><div><strong>{tr(monthCompleted.size ? "Nice consistency!" : "Your month starts here")}</strong><small>{monthCompleted.size ? currentLanguage() === "zh-CN" ? `本月已活跃 ${monthCompleted.size} 天。` : `You've been active ${monthCompleted.size} day${monthCompleted.size === 1 ? "" : "s"} this month.` : tr("Complete a workout to begin your streak.")}</small></div></div>
      </section></div>
      <section className="overview-panel overview-wellness"><header><h2><T>{"Wellness"}</T></h2>{wellnessData && <time dateTime={wellnessData.end}>{formatWellnessRange(wellnessData.start, wellnessData.end)}</time>}</header>
        {!wellnessData ? <p className="overview-empty"><T>{"No wellness data yet."}</T><br/><T>{"Connect to a data source or record with your AI agent."}</T></p> : <div className="wellness-grid">{wellnessData.values.map((item) => <article className={`wellness-${item.tone}`} key={item.key}><div className="wellness-copy"><span>{tr(item.label)}</span><strong>{item.display}</strong><small className={wellnessDeltaTone(item.key, item.delta)}>{item.delta === null ? tr("No earlier value") : currentLanguage() === "zh-CN" ? `${item.delta > 0 ? "↑" : item.delta < 0 ? "↓" : "→"} 较上次 ${Math.abs(item.delta)}` : `${item.delta > 0 ? "↑" : item.delta < 0 ? "↓" : "→"} ${Math.abs(item.delta)} from previous`}</small></div><Sparkline values={item.series}/></article>)}</div>}
      </section></div>
      {helpOpen && <RecoveryHelpModal onClose={() => setHelpOpen(false)}/>}
  </div>;
}
