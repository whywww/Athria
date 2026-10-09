import { assessWellness, type WellnessAssessment, type WellnessAssessmentKey } from "./wellness-assessment";
import { T, tr, currentLanguage, weekdayName } from "./i18n";
import { useId, useLayoutEffect, useState, type ReactNode } from "react";
import { adjustmentReasonMessage, formatDistance, formatDuration, friendlyLabel, type AdjustmentAssessment, type CalendarSession, type TrainingHistorySession, type TrainingSummary, type WellnessRecord } from "./view-models";
import { addDays, weekdayIndex } from "./plan/view";
import { domainIconPath } from "./domain-icons";
import { useModalDismiss } from "./components";
import { sleepDurationField } from "./wellness-view";

const domainOrder = ["strength", "endurance", "sport_skill", "mind_body", "mobility", "functional"] as const;
const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function useOverviewEntrance() {
  const [entrance, setEntrance] = useState({ progress: 1, playing: true });
  useLayoutEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let started: number | undefined;
    let finished = false;
    const finish = () => {
      finished = true;
      window.cancelAnimationFrame(frame);
      setEntrance({ progress: 1, playing: false });
    };
    const tick = (now: number) => {
      if (finished) return;
      started ??= now;
      const elapsed = now - started;
      if (elapsed >= 1600) { finish(); return; }
      const fraction = Math.min(1, elapsed / 1300);
      setEntrance({ progress: 1 - (1 - fraction) ** 3, playing: true });
      frame = window.requestAnimationFrame(tick);
    };
    const onMotionChange = () => { if (motion.matches) finish(); };
    if (motion.matches) finish();
    else {
      setEntrance({ progress: 0, playing: true });
      frame = window.requestAnimationFrame(tick);
    }
    motion.addEventListener("change", onMotionChange);
    return () => {
      finished = true;
      window.cancelAnimationFrame(frame);
      motion.removeEventListener("change", onMotionChange);
    };
  }, []);
  return entrance;
}

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
  type Marker = "completed" | "planned";
  const result: Array<{ day: string | null; marker: Marker | null; markers: Marker[] }> = Array.from({ length: weekdayIndex(monthStart) }, () => ({ day: null, marker: null, markers: [] }));
  for (let day = monthStart; day <= monthEnd; day = addDays(day, 1)) {
    const markers: Marker[] = [...(completed.has(day) ? ["completed" as const] : []), ...(scheduled.has(day) ? ["planned" as const] : [])];
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
function wellnessCompactNumber(value: number) {
  return String(Number(value.toFixed(1)));
}
function wellnessNumber(record: WellnessRecord, key: WellnessKey) {
  const value = key === "sleepSeconds" ? sleepDurationField(record)?.value : record.fields[key]?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
// The first four entries are the featured wellness trends; the next three backfill empty slots (steps, SDNN, sleep), then the remaining signals.
const wellnessPriority: Array<{ key: WellnessAssessmentKey; label: string; format: (value: number) => string; tone: string }> = [
  { key: "sleepScore", label: "Sleep score", format: wellnessCompactNumber, tone: "purple" },
  { key: "hrvRmssdMs", label: "HRV (ms)", format: wellnessCompactNumber, tone: "orange" },
  { key: "restingHeartRateBpm", label: "Resting HR (bpm)", format: wellnessCompactNumber, tone: "blue" },
  { key: "vo2maxMlKgMin", label: "VO2 max (ml/kg/min)", format: wellnessCompactNumber, tone: "green" },
  { key: "stepsCount", label: "Steps", format: (value) => String(Math.round(value)), tone: "green" },
  { key: "hrvSdnnMs", label: "HRV SDNN (ms)", format: wellnessCompactNumber, tone: "orange" },
  { key: "sleepSeconds", label: "Sleep time", format: wellnessSleepFormat, tone: "purple" },
  { key: "avgSleepingHeartRateBpm", label: "Sleeping HR (bpm)", format: wellnessCompactNumber, tone: "blue" },
  { key: "sleepQuality", label: "Sleep quality", format: wellnessCompactNumber, tone: "purple" },
  { key: "spo2Percent", label: "SpO2 (%)", format: (value) => value.toFixed(1), tone: "blue" },
  { key: "fatigue", label: "Fatigue", format: wellnessCompactNumber, tone: "orange" },
  { key: "stress", label: "Stress", format: wellnessCompactNumber, tone: "orange" },
  { key: "soreness", label: "Soreness", format: wellnessCompactNumber, tone: "orange" },
  { key: "mood", label: "Mood", format: wellnessCompactNumber, tone: "green" },
  { key: "motivation", label: "Motivation", format: wellnessCompactNumber, tone: "green" },
];

// All selected metrics share the actual data range within seven days of the latest measurement.
export function wellnessHighlights(records: WellnessRecord[], today: string) {
  const available = records.filter((record) => record.day <= today && wellnessPriority.some((item) => wellnessNumber(record, item.key) !== null));
  const latestDay = available.map((record) => record.day).sort().at(-1);
  if (!latestDay) return null;
  const windowStart = addDays(latestDay, -6);
  const windowRecords = available.filter((record) => record.day >= windowStart && record.day <= latestDay).sort((left, right) => left.day.localeCompare(right.day));
  const chosen: typeof wellnessPriority = [];
  for (const item of wellnessPriority) {
    if (windowRecords.some((record) => wellnessNumber(record, item.key) !== null)) chosen.push(item);
    if (chosen.length === 4) break;
  }
  if (!chosen.length) return null;
  const days = windowRecords.filter((record) => chosen.some((item) => wellnessNumber(record, item.key) !== null)).map((record) => record.day);
  const start = days[0]!; const end = days.at(-1)!;
  const measurementDay = end >= addDays(today, -1) ? end : today;
  const dayCount = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  const values = chosen.map((item) => {
    const samples = windowRecords.flatMap((record) => { const value = wellnessNumber(record, item.key); return value === null ? [] : [{ value, day: record.day }]; });
    const byDay = new Map(samples.map((sample) => [sample.day, sample.value]));
    const series = Array.from({ length: dayCount }, (_, index) => byDay.get(addDays(start, index)) ?? null);
    const value = byDay.get(measurementDay); const previous = samples.filter((sample) => sample.day < measurementDay).at(-1)?.value;
    return { ...item, display: value === undefined ? "-" : item.format(value), measurementDay, assessment: assessWellness(records, item.key, measurementDay), delta: value === undefined || previous === undefined ? null : Number((value - previous).toFixed(1)), series };
  });
  return { start, end, values };
}

export function formatWellnessDate(day: string) {
  return new Intl.DateTimeFormat(currentLanguage() === "en" ? "en-US" : "zh-CN", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

function wellnessAssessmentTitle(value: WellnessAssessment) {
  const number = (input: number | null) => input === null ? tr("Not available") : wellnessCompactNumber(input);
  const change = (input: number | null) => input === null ? tr("Not available") : value.mode === "ratio" ? `${wellnessCompactNumber(input * 100)}%` : wellnessCompactNumber(input);
  return `${tr("Assessment date")}: ${formatWellnessDate(value.day)}
${tr("Personal baseline")}: ${number(value.baseline)}
${tr("Valid days")}: ${value.sampleCount}
${tr("Previous 28 days, same source")}
${tr("Change from baseline")}: ${change(value.change)}
${tr("Comparison threshold")}: ±${change(value.threshold)}`;
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

// Score independent device estimates and subjective reports before blending them.
export function recoverySleepScore(current: WellnessRecord): number | null {
  const band = (score: number) => score >= 85 ? 90 : score >= 75 ? 75 : score >= 65 ? 60 : score >= 55 ? 45 : 30;
  const scores = (["sleepScore", "subjectiveSleepScore"] as const).flatMap((key) => {
    const value = wellnessNumber(current, key);
    return value !== null && value >= 0 && value <= 100 ? [band(value)] : [];
  });
  if (scores.length) return scores.reduce((sum, value) => sum + value, 0) / scores.length;
  for (const key of ["manualSleepSeconds", "sleepSeconds"] as const) {
    const seconds = wellnessNumber(current, key);
    if (seconds !== null && seconds >= 0) return seconds >= 27000 ? 90 : seconds >= 25200 ? 75 : seconds >= 23400 ? 60 : seconds >= 21600 ? 45 : 30;
  }
  return null;
}

// HRV and resting HR are required; sleep contributes when available.
function recoveryScore(current: WellnessRecord, sleepRecord: WellnessRecord | undefined, records: WellnessRecord[]): number | null {
  const baseline = (key: "hrvRmssdMs" | "hrvSdnnMs" | "restingHeartRateBpm") => {
    const value = wellnessNumber(current, key);
    if (value === null || value <= 0) return null;
    const start = addDays(current.day, -28);
    const days = new Map<string, number>();
    for (const record of records) {
      const previous = wellnessNumber(record, key);
      if (record.ownerId === current.ownerId && record.day >= start && record.day < current.day && record.fields[key]?.source === current.fields[key]?.source && previous !== null && previous > 0) days.set(record.day, previous);
    }
    return days.size >= 7 ? medianValue([...days.values()]) : null;
  };
  let hrvScore: number | null = null;
  for (const key of ["hrvRmssdMs", "hrvSdnnMs"] as const) {
    const usual = baseline(key);
    if (usual === null) continue;
    const ratio = wellnessNumber(current, key)! / usual;
    hrvScore = ratio >= 1 ? 90 : ratio >= 0.95 ? 75 : ratio >= 0.9 ? 60 : ratio >= 0.85 ? 45 : 30;
    break;
  }
  const usualHr = baseline("restingHeartRateBpm");
  if (hrvScore === null || usualHr === null) return null;
  const delta = wellnessNumber(current, "restingHeartRateBpm")! - usualHr;
  const heartScore = delta <= 0 ? 90 : delta <= 2 ? 75 : delta <= 4 ? 60 : delta <= 6 ? 45 : 30;
  const sleep = sleepRecord ? recoverySleepScore(sleepRecord) : null;
  return Math.round(sleep === null ? (hrvScore + heartScore) / 2 : (hrvScore + heartScore + sleep) / 3);
}

export function recoveryStatus(records: WellnessRecord[], today: string) {
  const heart = records.find((record) => record.day === addDays(today, -1));
  const empty = { label: "-", detail: "More wellness data needed.", value: null, day: null, signalCount: 0, series: [] as number[] };
  if (!heart) return empty;
  const sleepFor = (day: string) => records.find((record) => record.day === day && record.ownerId === heart.ownerId);
  const sleep = sleepFor(today);
  const score = recoveryScore(heart, sleep, records);
  if (score === null) return empty;
  const series: number[] = [];
  const days = [...new Set(records.filter((record) => record.ownerId === heart.ownerId).map((record) => addDays(record.day, 1)))].filter((day) => day <= today).sort((left, right) => right.localeCompare(left));
  for (const day of days) {
    const previousHeart = records.find((record) => record.day === addDays(day, -1) && record.ownerId === heart.ownerId)!;
    const value = recoveryScore(previousHeart, sleepFor(day), records);
    if (value !== null) series.unshift(value);
    if (series.length === 5) break;
  }
  const signalCount = sleep && recoverySleepScore(sleep) !== null ? 3 : 2;
  if (score >= 70) return { label: "Ready", detail: "Ready to train", value: score, day: today, series, signalCount };
  if (score >= 45) return { label: "Caution", detail: "Train with care", value: score, day: today, series, signalCount };
  return { label: "Rest", detail: "Prioritize recovery", value: score, day: today, series, signalCount };
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
  return { current, sessionDelta: current.length - previous.length, currentMinutes, durationPercent: previousMinutes > 0 ? Math.round(((currentMinutes - previousMinutes) / previousMinutes) * 100) : null, completedPlans: weekPlan.filter((session) => session.status === "completed").length, planTotal: weekPlan.length, planMinutes: weekPlan.reduce((total, session) => total + session.durationMinutes, 0), unrecordedPlans: weekPlan.filter((session) => session.displayState === "unrecorded").length, skippedPlans: planned.filter((session) => session.scheduledDate >= weekStart && session.scheduledDate <= weekEnd && session.status === "skipped").length };
}

export function mesocycleProgress(planned: CalendarSession[]) {
  const total = planned.length;
  const completed = planned.filter((session) => session.status === "completed").length;
  return { completed, total, percent: total ? Math.round((completed / total) * 100) : 0 };
}

export function weeklyLoad(today: string, history: TrainingHistorySession[], timezone: string) {
  const weekStart = overviewDateRange(today).weekStart;
  const minutesByDay = new Map<string, number>();
  history.forEach((session) => {
    const day = localDay(session.startAt, timezone);
    minutesByDay.set(day, (minutesByDay.get(day) ?? 0) + session.durationMinutes);
  });
  return weekdayLabels.map((label, index) => {
    const day = addDays(weekStart, index);
    const previousDay = addDays(day, -7);
    return { label, day, previousDay, current: day <= today ? minutesByDay.get(day) ?? 0 : 0, previous: minutesByDay.get(previousDay) ?? 0 };
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

export function sparklineGeometry(input: (number | null)[]) {
  const slots = input.slice(-7);
  const samples = slots.flatMap((value, index) => value !== null && Number.isFinite(value) ? [{ value, index }] : []);
  if (!samples.length) return null;
  const values = samples.map((sample) => sample.value);
  const min = Math.min(...values); const max = Math.max(...values); const spread = max - min;
  const width = sparklineBounds.right - sparklineBounds.left;
  const points = samples.map(({ value, index }) => ({
    x: slots.length === 1 ? (sparklineBounds.left + sparklineBounds.right) / 2 : sparklineBounds.left + index / (slots.length - 1) * width,
    y: spread === 0 ? (sparklineBounds.top + sparklineBounds.bottom) / 2 : sparklineBounds.bottom - (value - min) / spread * (sparklineBounds.bottom - sparklineBounds.top),
  }));
  if (points.length === 1) return { linePath: `M ${pathNumber(points[0]!.x)} ${pathNumber(points[0]!.y)}`, areaPath: null, points };
  const linePath = monotonePath(points);
  return { linePath, areaPath: `${linePath} L ${pathNumber(points.at(-1)!.x)} ${sparklineBounds.baseline} L ${pathNumber(points[0]!.x)} ${sparklineBounds.baseline} Z`, points };
}

function monotonePath(points: { x: number; y: number }[]) {
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
  return linePath;
}

function Sparkline({ values }: { values: (number | null)[] }) {
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

function OverviewIcon({ kind }: { kind: "target" | "recovery" | (typeof domainOrder)[number] }) {
  const icon = kind === "target" ? <><circle cx="11" cy="13" r="7"/><circle cx="11" cy="13" r="3.2"/><path d="m13.5 10.5 6-6M16 4.5h3.5V8"/></>
    : domainIconPath(kind === "recovery" ? "mobility" : kind);
  return <span className={`overview-icon icon-${kind}`} data-icon={kind} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icon}</svg></span>;
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
    return <small className={`metric-change stacked ${direction}`}><span>{arrow} {Math.abs(value)}{head}</span>{words.length > 0 && <span>{tr(words.join(" "))}</span>}</small>;
  }
  return <small className={`metric-change ${direction}`}>{arrow} {Math.abs(value)}{tr(suffix)}</small>;
}

function SummaryCard({ title, titleAction, value, ring, children, className = "" }: { title: string; titleAction?: ReactNode; value: ReactNode; ring: ReactNode; children: ReactNode; className?: string }) {
  return <article className={`overview-summary-card ${className}`}><span className="summary-card-width" aria-hidden="true"><span>Readiness</span><span className="summary-card-width-help">(How to calculate?)</span></span><div className="summary-card-copy"><span className="summary-card-title"><span>{title}</span>{titleAction}</span><strong>{value}</strong>{children}</div>{ring}</article>;
}

export function SummaryProgressRing({ percent, children, tone = "plan", entranceProgress = 1 }: { percent: number; children: ReactNode; tone?: string; entranceProgress?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const progress = Math.max(0, Math.min(100, percent * entranceProgress));
  const colors = tone === "ready" ? ["#a3e4b7", "#50b875", "#329553"] : tone === "caution" ? ["#ffe0a0", "#e8a33d", "#cf8423"] : tone === "rest" ? ["#ffb69b", "#dd633e", "#bd4728"] : ["#8CDFFF", "var(--domain-endurance)", "#2385EF"];
  return <span className={`progress-ring${tone === "plan" ? "" : ` ${tone}`}`}><svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id={`summary-ring-${uid}`} gradientUnits="userSpaceOnUse" x1="10" y1="5" x2="90" y2="95"><stop offset="0" stopColor={colors[0]} stopOpacity=".9"/><stop offset=".45" stopColor={colors[1]} stopOpacity=".88"/><stop offset="1" stopColor={colors[2]} stopOpacity=".95"/></linearGradient></defs><circle className="summary-ring-track" cx="50" cy="50" r="40"/>{progress > 0 && <circle className="summary-ring-fill" cx="50" cy="50" r="40" pathLength="100" stroke={`url(#summary-ring-${uid})`} strokeDasharray={progress < 100 ? `${progress} 100` : undefined} transform="rotate(-90 50 50)"/>}</svg><b>{children}</b></span>;
}

export function RecoveryHelpModal({ onClose }: { onClose: () => void }) {
  useModalDismiss(onClose);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="connection-modal recovery-modal" role="dialog" aria-modal="true" aria-labelledby="recovery-help-title">
      <header><div><h2 id="recovery-help-title"><T>{"How We Calculate Overall Readiness"}</T></h2><p><T>{"A recovery estimate from sleep, HRV and resting heart rate."}</T></p></div><button type="button" className="modal-close" aria-label={tr("Close dialog")} onClick={onClose}><svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
      <div className="modal-body">
        <ul className="recovery-help-signals">
          <li><strong><T>{"HRV"}</T></strong><span><T>{"Compared with your personal baseline. RMSSD is preferred; SDNN is used when it has a valid baseline and RMSSD does not."}</T></span></li>
          <li><strong><T>{"Resting heart rate"}</T></strong><span><T>{"Compared with your personal baseline; an elevated rate lowers the estimate."}</T></span></li>
          <li><strong><T>{"Sleep"}</T></strong><span><T>{"Device and subjective sleep scores are scored separately and averaged equally. Without a score, manual duration is preferred, then device duration."}</T></span></li>
        </ul>
        <p className="recovery-help-lead"><T>{"HRV and resting heart rate scores are averaged with sleep when available; without sleep, the two heart signals are averaged:"}</T></p>
        <ul className="recovery-help-verdicts">
          <li className="ready"><i/><div><strong><T>{"Ready · 70+"}</T></strong><span><T>{"Recovered. Train as planned."}</T></span></div></li>
          <li className="caution"><i/><div><strong><T>{"Caution · 45-69"}</T></strong><span><T>{"You can train, but keep it lighter."}</T></span></div></li>
          <li className="rest"><i/><div><strong><T>{"Rest · below 45"}</T></strong><span><T>{"Prioritize recovery today."}</T></span></div></li>
        </ul>
        <p className="recovery-help-note"><T>{"Today's readiness uses yesterday's HRV and resting heart rate, with last night's sleep recorded on today's wake-up date. Each heart baseline requires at least 7 valid days from the same source in the 28 days before yesterday, excluding yesterday itself. If yesterday's heart data or baselines are insufficient, no estimate is shown; older readiness is not substituted. Missing sleep is skipped and labelled. Manual sleep scores describe how you felt; they are stored separately from device estimates. Training load and other subjective check-ins are not included. These are Athria's estimation rules, not a scientifically validated score or a reproduction of another product's algorithm."}</T></p>
      </div>
    </section>
  </div>;
}

export function weeklyRingProgress(actual: number, target: number) {
  const ratio = target > 0 ? Math.max(0, actual / target) : 0;
  return { ratio, percent: Math.round(ratio * 100), full: ratio >= 1, remainder: ratio > 0 ? (ratio % 1 || 1) : 0 };
}

export function activityAxis(maximum: number, counts = false) {
  const rough = Math.max(counts ? 1 : 5, maximum / 4);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((value) => value * magnitude).find((value) => value >= rough)!;
  const ceiling = Math.max(step * 3, Math.ceil(maximum / step) * step);
  return { ceiling, ticks: Array.from({ length: Math.round(ceiling / step) + 1 }, (_, index) => index * step) };
}

function WeeklyActivityRings({ summary, minutesTarget, countTarget, entranceProgress }: { summary: TrainingSummary; minutesTarget: number; countTarget: number; entranceProgress: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const rings = [
    { kind: "minutes", radius: 112, actual: summary.totalDurationMinutes, target: minutesTarget, label: tr("Minutes") },
    { kind: "sessions", radius: 86, actual: summary.sessionCount, target: countTarget, label: tr("Workout count") },
  ];
  return <div className="weekly-rings-block" role="img" aria-label={rings.map((ring) => `${ring.label}: ${ring.actual} / ${ring.target > 0 ? ring.target : tr("No target set")} · ${weeklyRingProgress(ring.actual, ring.target).percent}%`).join("; ")}><div className="weekly-rings">
    <svg viewBox="0 0 260 260" aria-hidden="true"><defs>
      {rings.map((ring) => <linearGradient key={ring.kind} id={`ring-glass-${ring.kind}-${uid}`} gradientUnits="userSpaceOnUse" x1="30" y1="20" x2="230" y2="240"><stop offset="0" stopColor={ring.kind === "minutes" ? "#8CDFFF" : "#FFD29A"} stopOpacity=".9"/><stop offset=".45" stopColor={ring.kind === "minutes" ? "#36AEFF" : "#FF9850"} stopOpacity=".88"/><stop offset="1" stopColor={ring.kind === "minutes" ? "#2385EF" : "#F87540"} stopOpacity=".95"/></linearGradient>)}
      <filter id={`ring-tip-${uid}`} x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="#52687c" floodOpacity=".18"/></filter>
    </defs>
      {rings.map((ring) => {
        const progress = weeklyRingProgress(ring.actual, ring.target);
        const drawn = weeklyRingProgress(ring.actual * entranceProgress, ring.target);
        const angle = drawn.remainder * Math.PI * 2 - Math.PI / 2;
        return <g key={ring.kind} className={`weekly-ring weekly-ring-${ring.kind}`} data-progress={progress.percent}>
          <circle className="weekly-ring-track" cx="130" cy="130" r={ring.radius}/>
          {drawn.full && <circle className="weekly-ring-fill" stroke={`url(#ring-glass-${ring.kind}-${uid})`} cx="130" cy="130" r={ring.radius}/>}
          {drawn.ratio > 0 && <circle className="weekly-ring-fill" stroke={`url(#ring-glass-${ring.kind}-${uid})`} cx="130" cy="130" r={ring.radius} pathLength="100" strokeDasharray={`${drawn.remainder * 100} 100`} transform="rotate(-90 130 130)"/>}
          {drawn.ratio > 0 && <circle className="weekly-ring-tip" fill={`url(#ring-glass-${ring.kind}-${uid})`} cx={130 + ring.radius * Math.cos(angle)} cy={130 + ring.radius * Math.sin(angle)} r="12" filter={drawn.ratio > 1 ? `url(#ring-tip-${uid})` : undefined}/>}
        </g>;
      })}
    </svg>
    <div className="weekly-rings-center"><strong>{summary.sessionCount}</strong><span>{tr("Workout count")}</span><hr/><strong>{Number(summary.totalDurationMinutes.toFixed(1))}</strong><span>{tr("Minutes")}</span></div>
  </div></div>;
}

/* The `bottom` offset (inside the marker's inner box) that keeps a duration label just above its marker without leaving the 104px plot box. */
export function durationLabelBottom(pointY: number) {
  return 4 + Math.min(6, Math.round(pointY) - 14);
}

function ActivityDomainChart({ summary }: { summary: TrainingSummary }) {
  const counts = activityAxis(Math.max(0, ...domainOrder.map((domain) => summary.byDomain[domain] ?? 0)), true);
  const minutes = activityAxis(Math.max(0, ...domainOrder.map((domain) => summary.durationMinutesByDomain[domain] ?? 0)));
  const points = domainOrder.map((domain, index) => ({ x: (index + .5) / domainOrder.length * 100, y: 100 * (1 - (summary.durationMinutesByDomain[domain] ?? 0) / minutes.ceiling) }));
  const linePath = monotonePath(points);
  return <section className="activity-domain-chart" aria-label={tr("Workout frequency and duration")} data-chart="weekly-combined">
    <div className="activity-chart-legend"><span><i className="legend-bar"/>{tr("Bars: frequency")}</span><span><i className="legend-line"/>{tr("Line: duration")}</span></div>
    <div className="activity-chart-plot">
      <div className="activity-chart-axis-units"><span>{tr("Count")}</span><span>{currentLanguage() === "en" ? "Min" : tr("Minutes")}</span></div>
      <div className="activity-chart-grid" aria-hidden="true">{[...counts.ticks].reverse().map((tick) => <div key={tick} style={{ bottom: `${tick / counts.ceiling * 100}%` }}><span>{tick}</span><i/></div>)}</div>
      <div className="activity-chart-right-axis" aria-hidden="true">{minutes.ticks.map((tick) => <span key={tick} style={{ bottom: `${tick / minutes.ceiling * 100}%` }}>{tick}</span>)}</div>
      <div className="activity-chart-columns">{domainOrder.map((domain, index) => {
        const count = summary.byDomain[domain] ?? 0;
        const duration = Number((summary.durationMinutesByDomain[domain] ?? 0).toFixed(1));
        const label = `${friendlyLabel(domain)}: ${count} ${tr("Count")} · ${duration} ${tr("Minutes")}`;
        return <div className={`activity-chart-column domain-${domain}`} key={domain} style={{ "--entrance-delay": `${index * 50}ms` } as React.CSSProperties} aria-label={label} title={label} tabIndex={0}>
          <div className="activity-chart-bar-slot"><div className={`activity-chart-bar ${count > 0 ? "" : "zero"}`} style={{ height: count > 0 ? `${count / counts.ceiling * 100}%` : "4px" }}/></div>
          <div className="activity-chart-label"><OverviewIcon kind={domain}/><span>{currentLanguage() === "zh-CN" ? ({ strength: "力量", endurance: "耐力", sport_skill: "技能", mind_body: "身心", mobility: "灵活", functional: "功能" }[domain]) : friendlyLabel(domain)}</span></div>
        </div>;
      })}</div>
      <svg className="activity-duration-line" viewBox="0 0 100 104" preserveAspectRatio="none" aria-hidden="true"><path d={linePath}/></svg>
      <div className="activity-duration-points" aria-hidden="true">{points.map((point, index) => {
        const domain = domainOrder[index]!;
        const duration = Number((summary.durationMinutesByDomain[domain] ?? 0).toFixed(1));
        const bottom = durationLabelBottom(point.y);
        return <i key={domain} style={{ left: `${point.x}%`, top: `${point.y / 104 * 100}%` }}>{duration > 0 ? <span style={{ bottom: `${bottom}px` }}>{duration}</span> : <span className="zero" style={{ bottom: `${bottom}px` }}>0</span>}</i>;
      })}</div>
    </div>
  </section>;
}

function monthShift(month: string, amount: number) { const date = new Date(`${month}-01T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() + amount); return date.toISOString().slice(0, 7); }

const severityRank = { hard: 0, strong: 1, soft: 2, info: 3 } as const;

const noticeCopy = {
  watch: "Weekly check:",
  review_recommended: "Ask your agent to review the plan:",
  review_required: "Plan review required — ask your agent:",
} as const;

export function AdjustmentReviewNotice({ value, onDismiss }: { value: AdjustmentAssessment; onDismiss?: (() => void) | undefined }) {
  const [dismissed, setDismissed] = useState(false);
  const reason = [...value.reasons].sort((left, right) => severityRank[left.severity] - severityRank[right.severity])[0];
  if (!reason || dismissed) return null;
  const status = value.reviewStatus as keyof typeof noticeCopy;
  const conditionChanged = reason.reasonCode.startsWith("PROFILE_") || ["GOAL_PLAN_INTENT_DRIFT", "RACE_TARGET_PLAN_INTENT_DRIFT", "PREFERENCE_CHANGED", "MESOCYCLE_DURATION_PREFERENCE_CHANGED"].includes(reason.reasonCode);
  const prefix = conditionChanged ? "Plan conditions changed:" : value.trigger === "weekly_review" ? "Last week's review — consider this week's plan:" : noticeCopy[status];
  const message = adjustmentReasonMessage(reason, value.trigger === "weekly_review");
  return <div className={`adjustment-notice adjustment-notice-${status}`} role="status"><span>{tr(prefix)} {message}</span><button type="button" className="adjustment-notice-close" aria-label={tr("Dismiss message")} onClick={() => { setDismissed(true); onDismiss?.(); }}>×</button></div>;
}

export function OverviewDashboard({ summary, wellness, history, planned, today, timezone, adjustment, onDismissReview, onOpenWellness }: { summary: TrainingSummary; wellness: WellnessRecord[]; history: TrainingHistorySession[]; planned: CalendarSession[]; today: string; timezone: string; adjustment?: AdjustmentAssessment | undefined; onDismissReview?: (() => void) | undefined; onOpenWellness?: (() => void) | undefined }) {
  const entrance = useOverviewEntrance();
  const [visibleMonth, setVisibleMonth] = useState(today.slice(0, 7));
  const [helpOpen, setHelpOpen] = useState(false);
  const wellnessData = wellnessHighlights(wellness, today); const recovery = recoveryStatus(wellness, today); const week = weeklyOverview(today, history, planned, timezone); const load = weeklyLoad(today, history, timezone);
  const calendarAnchor = `${visibleMonth}-01`; const days = calendarDays(calendarAnchor, history, planned, timezone);
  const monthLabel = new Intl.DateTimeFormat(currentLanguage(), { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${visibleMonth}-01T12:00:00Z`));
  const monthCompleted = new Set(history.map((session) => localDay(session.startAt, timezone)).filter((day) => day.startsWith(`${visibleMonth}-`)));
  planned.filter((session) => session.status === "completed" && session.scheduledDate.startsWith(`${visibleMonth}-`)).forEach((session) => monthCompleted.add(session.scheduledDate));
  const monthDays = Number(overviewDateRange(calendarAnchor).monthEnd.slice(-2));
  const meso = mesocycleProgress(planned);
  const consistencyDays = twelveWeekConsistency(today, history, timezone);
  const maxLoad = Math.max(0, ...load.flatMap((item) => [item.current, item.previous])); const loadCeiling = Math.max(30, Math.ceil(maxLoad / 30) * 30);
  const incomplete = summary.metrics.strength.workingSets.dataQuality.completeness < 1 || summary.metrics.endurance.distanceMeters.dataQuality.completeness < 1;

  return <div className="overview-dashboard" data-entering={entrance.playing ? "true" : undefined}>
    {adjustment && <AdjustmentReviewNotice key={`${adjustment.currentPlanRevision}:${adjustment.profileHash}:${adjustment.inputSnapshotHash}`} value={adjustment} onDismiss={onDismissReview}/>}
    <div className="overview-layout">
      <div className="overview-left-column">
        <section className="overview-summary-grid" aria-label={tr("This week so far")}>
          <SummaryCard title={tr("Plan Progress")} value={`${meso.completed} / ${meso.total}`} className="plan-summary" ring={<SummaryProgressRing percent={meso.percent} entranceProgress={entrance.progress}>{meso.percent}%</SummaryProgressRing>}><small>{tr("this mesocycle")}</small></SummaryCard>
          <SummaryCard title={tr("Readiness")} titleAction={<button type="button" className="recovery-help" aria-haspopup="dialog" onClick={() => setHelpOpen(true)}>{currentLanguage() === "zh-CN" ? "（" : "("}<T>{"How to calculate?"}</T>{currentLanguage() === "zh-CN" ? "）" : ")"}</button>} value={tr(recovery.label)} className="recovery-summary" ring={<SummaryProgressRing percent={recovery.value ?? 0} tone={recoveryRingTone(recovery.label)} entranceProgress={entrance.progress}>{recovery.value ?? "-"}</SummaryProgressRing>}><small>{tr(recovery.signalCount === 3 ? recovery.detail : recovery.signalCount === 2 ? "Sleep not included" : "Insufficient data")}</small></SummaryCard>
        </section>

        <section className="overview-panel overview-activity"><header><div><h2><T>{"Your workouts this week"}</T></h2></div><button type="button" className="wellness-open" aria-label={tr("Open Training")} title={tr("Open Training")} onClick={() => window.dispatchEvent(new CustomEvent("athria-open-training"))}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></button></header>
          <div className="activity-content"><WeeklyActivityRings summary={summary} minutesTarget={week.planMinutes} countTarget={week.planTotal} entranceProgress={entrance.progress}/><ActivityDomainChart summary={summary}/></div>
          {!summary.sessionCount && <p className="overview-empty"><T>{"No completed workouts yet this week."}</T><br/>{tr("Connect to your ")}<button type="button" className="overview-empty-link" onClick={() => window.dispatchEvent(new CustomEvent("athria-open-connections"))}>{tr("training apps")}</button>{tr(" or check out your ")}<button type="button" className="overview-empty-link" onClick={() => document.getElementById("overview-next-day")?.scrollIntoView({ behavior: "smooth", block: "start" })}>{tr("next plan")}</button>{tr(".")}</p>}
          {summary.sessionCount > 0 && incomplete && <p className="overview-note"><T>{"Some workout details were unavailable, so sport-specific totals may be incomplete."}</T></p>}
        </section>

        <div className="overview-lower-grid"><section className="overview-panel training-load"><header><div><h2><T>{"Training Load"}</T></h2></div><strong>{formatDuration(summary.totalDurationMinutes)}</strong><Change value={week.durationPercent} suffix="% from last week" stacked/><p><T>{"Your weekly training time"}</T></p></header>
          <div className="load-chart"><div className="load-axis"><span>{loadAxisLabel(loadCeiling)}</span><span>{loadAxisLabel(loadCeiling / 2)}</span><span>0h</span></div><div className="load-bars">{load.map((item, index) => {
            const description = `${tr(item.label)} · ${tr("This week")} (${item.day}): ${item.current} ${tr("min")} · ${tr("Last week")} (${item.previousDay}): ${item.previous} ${tr("min")}`;
            return <div className="load-day" key={item.day} style={{ "--entrance-delay": `${index * 50}ms` } as React.CSSProperties} title={description} aria-label={description} tabIndex={0}><span className="load-comparison" aria-hidden="true">{item.previous > 0 && <i className="load-previous" style={{ height: `${item.previous / loadCeiling * 100}%` }}/>}{item.current > 0 && <i className="load-current" style={{ height: `${item.current / loadCeiling * 100}%` }}/>}</span><small>{tr(item.label)}</small></div>;
          })}</div></div>
          <div className="load-legend"><span><i className="load-current"/><T>{"This week"}</T></span><span><i className="load-previous"/><T>{"Last week"}</T></span></div>
        </section>
        <section className="overview-panel consistency"><header><div><h2><T>{"Consistency"}</T></h2><p><T>{"Active days this month"}</T></p></div><strong>{monthCompleted.size} / {monthDays}</strong></header>
          <div className="consistency-grid" data-range="twelve-weeks" aria-label={tr("Training consistency over the last twelve weeks")}>{consistencyDays.filter((item) => !item.future).map((item) => <i key={item.day} className={item.active ? "active" : ""} title={item.day}/>)}</div>
          <div className="consistency-note"><TrophyIcon/><div><strong>{tr(monthCompleted.size ? "Nice consistency!" : "Your month starts here")}</strong><small>{monthCompleted.size ? currentLanguage() === "zh-CN" ? `本月已活跃 ${monthCompleted.size} 天。` : `You've been active ${monthCompleted.size} day${monthCompleted.size === 1 ? "" : "s"} this month.` : tr("Complete a workout to begin your streak.")}</small></div></div>
        </section></div>
      </div>
      <div className="overview-right-column">
        <section className="overview-panel overview-calendar"><header><h2>{monthLabel}</h2><div className="calendar-controls"><button type="button" aria-label={tr("Previous month")} onClick={() => setVisibleMonth((value) => monthShift(value, -1))}><span aria-hidden="true">‹</span></button><button type="button" aria-label={tr("Next month")} onClick={() => setVisibleMonth((value) => monthShift(value, 1))}><span aria-hidden="true">›</span></button></div></header>
          <div className="mini-calendar" aria-label={`${monthLabel} training calendar`}>{weekdayLabels.map((label, index) => <span className="mini-weekday" key={label}>{weekdayName(index, currentLanguage(), "short")}</span>)}{days.map((item, index) => <span className={`mini-day ${item.day === today ? "today" : ""}`} key={item.day ?? `blank-${index}`}>{item.day ? Number(item.day.slice(-2)) : ""}{item.markers.length > 0 && <span className="mini-day-markers">{item.markers.map((marker) => <i key={marker} className={marker} aria-label={tr(marker === "completed" ? "Completed training" : "Scheduled training")}/>)}</span>}</span>)}</div>
          <div className="calendar-legend"><span><i className="completed"/><T>{"Completed"}</T></span><span><i className="planned"/><T>{"Scheduled"}</T></span></div>
        </section>

        <section className="overview-panel overview-wellness"><header><h2><T>{"Wellness"}</T></h2>{wellnessData && <time dateTime={wellnessData.end}>{formatWellnessRange(wellnessData.start, wellnessData.end)}</time>}<button type="button" className="wellness-open" aria-label={tr("Open wellness trends")} onClick={onOpenWellness}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></button></header>
          {!wellnessData ? <p className="overview-empty"><T>{"No wellness data yet."}</T><br/><T>{"Connect to a data source or record with your AI agent."}</T></p> : <div className="wellness-grid">{wellnessData.values.map((item) => <article className={`wellness-${item.tone}`} key={item.key}><div className="wellness-copy"><span>{tr(item.label)}</span><strong title={item.display}>{item.display}</strong></div><Sparkline values={item.series}/><small className={`wellness-assessment ${item.assessment.level}`} title={wellnessAssessmentTitle(item.assessment)}>{tr(item.assessment.message)}</small></article>)}</div>}
        </section>
      </div>
    </div>
    {helpOpen && <RecoveryHelpModal onClose={() => setHelpOpen(false)}/>}
  </div>;
}
