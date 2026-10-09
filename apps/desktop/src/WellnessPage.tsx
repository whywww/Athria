import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { ErrorBanner, Loading, useModalDismiss } from "./components";
import { currentLanguage, T, tr, useLanguage } from "./i18n";
import { addDays } from "./plan/view";
import type { WellnessRecord } from "./view-models";
import { useWellnessSort } from "./wellness-sort";
import { sleepStorageDay, metricNumber, sleepCanReset, sleepDraft, sleepHasChanges, sleepPatch, wellnessMetrics, wellnessRanges, wellnessSeries, wellnessWindow, type SleepCleared, type SleepDraft, type WellnessMetric, type WellnessPoint, type WellnessRange } from "./wellness-view";

function dateLabel(day: string, short = false) {
  return new Intl.DateTimeFormat(currentLanguage() === "zh-CN" ? "zh-CN" : "en-US", { year: short ? undefined : "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}
function numberLabel(value: number) {
  return new Intl.NumberFormat(currentLanguage(), { maximumFractionDigits: 2 }).format(value);
}
function sourceLabel(source: string, key: string) {
  if (key === "subjectiveSleepScore") return tr("Subjective sleep score");
  if (key === "manualSleepSeconds") return tr("Manual sleep duration");
  const label = source === "intervals_icu" ? "Intervals.icu" : source === "user" ? tr("Manual record") : source === "ai" ? tr("AI record") : source;
  return key === "hrvRmssdMs" ? `${label} RMSSD` : key === "hrvSdnnMs" ? `${label} SDNN` : label;
}
function pointLabel(point: WellnessPoint, unit: string) {
  return `${dateLabel(point.day)} · ${numberLabel(point.value)} ${tr(unit)} · ${sourceLabel(point.source, point.key)}`;
}

export function WellnessMetricRow({ metric, records, start, end, weekly = false, sortHandle, sorting = false }: { metric: WellnessMetric; records: WellnessRecord[]; start: string; end: string; weekly?: boolean; sortHandle?: React.ReactNode; sorting?: boolean }) {
  const chart = wellnessSeries(records, metric, start, end);
  const describe = (point: WellnessPoint) => pointLabel(point, metric.unit);
  const ticks = weekly ? Array.from({ length: 7 }, (_, index) => index / 6) : [0, .5, 1];
  return <article className={`wellness-metric-row${sorting ? " wellness-metric-sorting" : ""}`} data-metric-id={metric.id}>
    <header><div className="wellness-metric-title"><h2>{tr(metric.label)}</h2></div><div className="wellness-metric-actions"><span className="wellness-unit">{tr(metric.unit)}</span>{sortHandle}</div></header>
    <svg className="wellness-trend-chart" viewBox="0 0 800 103" role="group" aria-label={`${tr(metric.label)} · ${dateLabel(start)} – ${dateLabel(end)}`}>
      {[0, .5, 1].map((fraction) => { const y = 83 - fraction * 70; return <g key={fraction}><line x1="58" x2="758" y1={y} y2={y} className="wellness-chart-grid"/><text x="47" y={y + 4} textAnchor="end">{numberLabel(chart.low + fraction * (chart.high - chart.low))}</text></g>; })}
      {ticks.map((fraction) => {
        const day = addDays(start, Math.round((Date.parse(end) - Date.parse(start)) / 86400000 * fraction));
        const label = weekly ? new Intl.DateTimeFormat(currentLanguage() === "zh-CN" ? "zh-CN" : "en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`)) : dateLabel(day, true);
        return <text key={fraction} x={58 + fraction * 700} y="97" textAnchor={fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"}>{label}</text>;
      })}
      {chart.series.map((series) => <g key={`${series.key}-${series.source}`} className={`wellness-series-${series.tone}`} data-entrance={series.points.length === 1 ? "point" : "trend"}>
        {series.segments.filter((segment) => segment.length > 1).map((segment) => <polyline key={segment[0]!.day} points={segment.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="2"/>)}
        {series.points.map((point) => <g key={point.day}><circle cx={point.x} cy={point.y} r="3" fill="currentColor"/><circle cx={point.x} cy={point.y} r="9" className="wellness-point-target" tabIndex={0} role="img" aria-label={describe(point)}><title>{describe(point)}</title></circle></g>)}
      </g>)}
    </svg>
    {chart.series.length > 0 && <div className="wellness-chart-legend">{chart.series.map((series) => <span key={`${series.key}-${series.source}`}><i className={`wellness-series-${series.tone}`}/>{sourceLabel(series.source, series.key)}</span>)}</div>}
  </article>;
}

interface WellnessDay { record?: WellnessRecord; snapshotHash: string }
export function SleepDurationInput({ unit, value, disabled, onChange }: { unit: "hours" | "minutes"; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const label = tr(unit === "hours" ? "Hours" : "Minutes");
  const max = unit === "hours" ? 24 : 59;
  const step = unit === "hours" ? 1 : 5;
  const numericValue = Number(value || 0);
  const latest = useRef({ value, disabled, onChange });
  latest.current = { value, disabled, onChange };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerClick = useRef(false);
  const stop = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const adjust = (direction: number) => {
    if (latest.current.disabled) return false;
    const current = Number(latest.current.value || 0);
    const next = String(Math.min(max, Math.max(0, (Number.isFinite(current) ? Math.trunc(current) : 0) + direction * step)));
    if (next === latest.current.value) return false;
    latest.current.value = next;
    latest.current.onChange(next);
    return true;
  };
  const repeat = (direction: number) => {
    if (adjust(direction)) timer.current = setTimeout(() => repeat(direction), 100);
    else stop();
  };
  useEffect(() => {
    if (disabled) stop();
  }, [disabled]);
  useEffect(() => {
    window.addEventListener("blur", stop);
    return () => { stop(); window.removeEventListener("blur", stop); };
  }, []);
  return <div className="sleep-duration-control">
    <label><span>{label}</span><input type="number" min={0} max={max} step={1} value={value} placeholder="—" disabled={disabled} onChange={(event) => onChange(event.target.value)}/></label>
    <div className="sleep-duration-stepper">{([1, -1] as const).map((direction) => <button key={direction} type="button" disabled={disabled || (value !== "" && (direction === 1 ? numericValue >= max : numericValue <= 0))} aria-label={`${currentLanguage() === "zh-CN" ? direction === 1 ? "增加" : "减少" : direction === 1 ? "Increase" : "Decrease"} · ${label}`} onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0) return;
      stop(); pointerClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      if (adjust(direction)) timer.current = setTimeout(() => repeat(direction), 400);
    }} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop} onLostPointerCapture={stop} onBlur={stop} onClick={(event) => {
      if (pointerClick.current && event.detail !== 0) { pointerClick.current = false; return; }
      pointerClick.current = false;
      adjust(direction);
    }}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={direction === 1 ? "m3 10 5-5 5 5" : "m3 6 5 5 5-5"}/></svg></button>)}</div>
  </div>;
}
export function SleepSlider({ label, value, max, step, valueLabel, disabled, onChange, onReset, confirmReset = false, resetDisabled }: { label: string; value: number | null; max: number; step: number; valueLabel: string; disabled: boolean; onChange: (value: number) => void; onReset: () => void; confirmReset?: boolean; resetDisabled?: boolean }) {
  const sliderValue = Math.min(max, Math.max(0, Math.round((value ?? 0) / step) * step));
  return <div className="sleep-slider-field">
    <div className="sleep-slider-heading"><span>{label}</span><output className={value === null ? "not-recorded" : undefined}>{valueLabel}</output><button type="button" className="sleep-slider-reset" disabled={disabled || (resetDisabled ?? value === null)} aria-label={`${tr(confirmReset ? "Confirm reset" : "Reset")} · ${label}`} onClick={onReset}><T>{confirmReset ? "Confirm reset" : "Reset"}</T></button></div>
    <input type="range" aria-label={label} aria-valuetext={valueLabel} min={0} max={max} step={step} value={sliderValue} disabled={disabled} style={{ "--sleep-slider-progress": `${sliderValue / max * 100}%` } as CSSProperties} onChange={(event) => onChange(Number(event.target.value))} onPointerUp={(event) => { if (value === null) onChange(Number(event.currentTarget.value)); }} onKeyUp={(event) => { if (value === null && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) onChange(Number(event.currentTarget.value)); }}/>
  </div>;
}
export function HealthRecordModal({ today, databaseUuid, onClose }: { today: string; databaseUuid: string; onClose: () => void }) {
  const [day, setDay] = useState(addDays(today, -1));
  const [draft, setDraft] = useState<SleepDraft | null>(null);
  const [baseline, setBaseline] = useState<WellnessDay | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmResetKey, setConfirmResetKey] = useState<"score" | "duration" | null>(null);
  const [cleared, setCleared] = useState<SleepCleared>({});
  useModalDismiss(() => { if (!saving) onClose(); });
  const client = useQueryClient();
  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && day <= today;
  const storageDay = validDay ? sleepStorageDay(day) : "";
  const query = useQuery({ queryKey: ["wellness", "day", databaseUuid, storageDay], queryFn: () => api<WellnessDay>(`/api/wellness/${storageDay}`), enabled: validDay });
  useEffect(() => { if (query.data && draft === null) { setDraft(sleepDraft(query.data.record)); setCleared({}); setBaseline(query.data); } }, [query.data, draft]);
  const update = (key: keyof SleepDraft, value: string) => { setConfirmResetKey(null); setCleared((current) => ({ ...current, [key === "score" ? "score" : "duration"]: false })); setDraft((current) => ({ ...(current ?? sleepDraft()), [key]: value })); setError(null); };
  const hasChanges = !!draft && !!baseline && sleepHasChanges(draft, baseline.record, cleared);
  const reset = (key: "score" | "duration") => {
    if (confirmResetKey !== key) { setConfirmResetKey(key); return; }
    const fallback = sleepDraft(baseline?.record, { score: true, duration: true });
    setCleared((current) => ({ ...current, [key]: true }));
    setDraft((current) => ({ ...(current ?? sleepDraft()), ...(key === "score" ? { score: fallback.score } : { hours: fallback.hours, minutes: fallback.minutes }) }));
    setConfirmResetKey(null); setError(null);
  };
  const apiDuration = baseline?.record?.fields.sleepSeconds;
  const durationSource = apiDuration?.source === "intervals_icu" ? "Intervals.icu" : apiDuration?.source === "user" ? tr("Manual record") : apiDuration?.source === "llm" ? tr("AI record") : apiDuration?.source;
  const save = async () => {
    if (!baseline || !draft || !validDay || !hasChanges || query.isFetching || query.error || error || saving || conflict) return;
    try {
      const fields = sleepPatch(draft, baseline.record, cleared);
      if (!Object.keys(fields).length) return;
      setSaving(true); setError(null);
      await api(`/api/wellness/${storageDay}`, { method: "PATCH", body: JSON.stringify({ confirmed: true, source: "user", expectedSnapshotHash: baseline.snapshotHash, fields }) });
      await Promise.all(["wellness", "state", "plan-adjustment-review"].map((key) => client.invalidateQueries({ queryKey: [key] })));
      onClose();
    } catch (value) {
      setError(value);
      if (String(value).includes("Wellness changed") || String(value).includes("INPUT_SNAPSHOT_CHANGED")) setConflict(true);
    } finally { setSaving(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}><section className="connection-modal sleep-record-modal" role="dialog" aria-modal="true" aria-labelledby="health-record-title" aria-describedby="health-record-description">
    <header><div><h2 id="health-record-title"><T>{"Record health data"}</T></h2><p id="health-record-description"><T>{"Record your sleep experience and duration for the selected evening."}</T></p></div><button type="button" className="modal-close" aria-label={tr("Close dialog")} disabled={saving} onClick={onClose}><svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
    <form className="modal-body" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="sleep-record-card sleep-date-card"><label><T>{"Record date"}</T><input type="date" value={day} max={today} required disabled={saving} onChange={(event) => { setConfirmResetKey(null); setCleared({}); setDay(event.target.value); setDraft(null); setBaseline(null); setError(null); setConflict(false); }}/></label>
        <p className="sleep-record-note"><T>{"Sleep belongs to the selected evening and ends the following day."}</T></p>
      </div>
      {!validDay ? <p role="alert"><T>{"Choose today or an earlier date."}</T></p> : query.isPending ? <Loading/> : query.error ? <><ErrorBanner error={query.error}/><button type="button" onClick={() => void query.refetch()}><T>{"Retry"}</T></button></> : draft && <>
        <div className="sleep-record-card sleep-score-card">
          <SleepSlider label={tr("Subjective sleep score")} value={draft.score === "" ? null : Number(draft.score)} max={100} step={1} valueLabel={draft.score === "" ? tr("Not recorded") : `${numberLabel(Number(draft.score))} ${tr("points")}`} disabled={saving || query.isFetching} onChange={(value) => update("score", String(value))} confirmReset={confirmResetKey === "score"} resetDisabled={!sleepCanReset(draft, baseline?.record, cleared, "score")} onReset={() => reset("score")}/>
          <div className="sleep-slider-scale" aria-hidden="true"><span>0</span><span>100</span></div>
          <p className="sleep-record-note"><T>{"How did your sleep feel? 0 is very poor and 100 is excellent."}</T></p>
        </div>
        <div className="sleep-record-card sleep-duration-card">
          <div className="sleep-slider-heading"><span>{tr("Sleep duration")}</span><output className={draft.hours === "" && draft.minutes === "" ? "not-recorded" : undefined}>{draft.hours === "" && draft.minutes === "" ? tr("Not recorded") : `${Number(draft.hours || 0)} ${tr("Hours")} ${Number(draft.minutes || 0)} ${tr("Minutes")}`}</output><button type="button" className="sleep-slider-reset" disabled={saving || query.isFetching || !sleepCanReset(draft, baseline?.record, cleared, "duration")} aria-label={`${tr(confirmResetKey === "duration" ? "Confirm reset" : "Reset")} · ${tr("Sleep duration")}`} onClick={() => reset("duration")}><T>{confirmResetKey === "duration" ? "Confirm reset" : "Reset"}</T></button></div>
          <div className="sleep-duration-inputs">{(["hours", "minutes"] as const).map((key) => <SleepDurationInput key={key} unit={key} value={draft[key]} disabled={saving || query.isFetching} onChange={(value) => update(key, value)}/>)}</div>
          {typeof apiDuration?.value === "number" && Number.isFinite(apiDuration.value) && <p className="sleep-record-note sleep-duration-source">{tr("Manual entries take priority; the original {source} data will be kept.").replace("{source}", durationSource ?? "")}</p>}
        </div>
      </>}
      <ErrorBanner error={error}/>
      {conflict && <div className="sleep-conflict"><p><T>{"This day changed while you were editing. Reload the latest data, then review and save your entries again."}</T></p><button type="button" disabled={query.isFetching} onClick={async () => { setConfirmResetKey(null); const refreshed = await query.refetch(); if (!refreshed.error && refreshed.data) { setBaseline(refreshed.data); setConflict(false); setError(null); } }}><T>{"Reload latest data"}</T></button></div>}
      <footer className="modal-actions"><button type="button" className="secondary" disabled={saving} onClick={onClose}><T>{"Cancel"}</T></button><button type="submit" disabled={!validDay || !hasChanges || !!error || !!query.error || query.isFetching || saving || conflict}>{tr(saving ? "Saving…" : "Save")}</button></footer>
    </form>
  </section></div>;
}

export function WellnessPage({ today, databaseUuid }: { today: string; databaseUuid: string }) {
  useLanguage();
  const [range, setRange] = useState<WellnessRange>(7);
  const [offset, setOffset] = useState(0);
  const window = wellnessWindow(today, range, offset);
  const query = useQuery({ queryKey: ["wellness", "trends", databaseUuid, window.days, today], queryFn: () => api<WellnessRecord[]>(`/api/wellness?days=${window.days}`) });
  const [entranceReady, setEntranceReady] = useState(false);
  const [entering, setEntering] = useState(false);
  useLayoutEffect(() => {
    if (query.isSuccess) setEntranceReady(true);
  }, [query.isSuccess]);
  useLayoutEffect(() => {
    if (!entranceReady) return;
    const motion = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { clearTimeout(timer); setEntering(false); };
    const onMotionChange = () => { if (motion.matches) finish(); };
    if (!motion.matches) {
      setEntering(true);
      timer = setTimeout(finish, 1600);
    }
    motion.addEventListener("change", onMotionChange);
    return () => { clearTimeout(timer); motion.removeEventListener("change", onMotionChange); };
  }, [entranceReady]);
  const records = (query.data ?? []).filter((record) => record.day <= sleepStorageDay(today));
  const labels = [currentLanguage() === "zh-CN" ? tr("Wellness week") : "Week", tr("Month"), tr("Six months"), tr("Year")];
  const visibleMetrics = wellnessMetrics.filter((metric) => metric.always || records.some((record) => metric.keys.some((key) => metricNumber(record, key) !== null)));
  const sort = useWellnessSort(databaseUuid, visibleMetrics.map((metric) => metric.id));
  return <section className="wellness-page" data-entering={entering ? "true" : undefined}>
    <div className="wellness-toolbar">
      <div className="wellness-date-navigation">
        <button type="button" className="wellness-period-arrow" aria-label={tr("Previous period")} onClick={() => { setEntering(false); setOffset((value) => value + 1); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg></button>
        <span><time dateTime={window.start}>{dateLabel(window.start)}</time> – <time dateTime={window.end}>{dateLabel(window.end)}</time></span>
        <button type="button" className="wellness-period-arrow" aria-label={tr("Next period")} disabled={offset === 0} onClick={() => { setEntering(false); setOffset((value) => Math.max(0, value - 1)); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>
        <button type="button" className="wellness-current" disabled={offset === 0} onClick={() => { setEntering(false); setOffset(0); }}><T>{"Current period"}</T></button>
      </div>
      <div className="wellness-range-switch" aria-label={tr("Wellness time range")}>{wellnessRanges.map((value, index) => <button type="button" key={value} aria-pressed={range === value} onClick={() => { setEntering(false); setRange(value); setOffset(0); }}>{labels[index]!}</button>)}</div>
    </div>
    <ErrorBanner error={query.error}/>{query.isPending && <Loading/>}
    <div className="wellness-sort-announcement" role="status" aria-live="polite" aria-atomic="true">{sort.announcement}</div>
    <div className="wellness-metric-list" ref={sort.listRef} {...sort.listProps}>{sort.order.flatMap((id) => { const metric = visibleMetrics.find((value) => value.id === id); return metric ? [<WellnessMetricRow key={metric.id} metric={metric} records={records} start={window.start} end={window.end} weekly={range === 7} sorting={sort.activeId === id} sortHandle={<button type="button" {...sort.handleProps(id)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h14"/></svg></button>}/>] : []; })}</div>
  </section>;
}
