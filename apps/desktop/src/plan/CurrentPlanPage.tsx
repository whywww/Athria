import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import {
  editableTemplate, formatDuration, friendlyLabel,
  type AthleteProfile, type CalendarSession, type CurrentPlan, type NextTrainingDay,
  type SessionTemplate, type StoredSessionTemplate, type TemplateComponentDomain, type TrainingTaxonomy,
} from "../view-models";
import { EmptyState, ErrorBanner, Loading, PrimaryPageHeader, weekdays } from "../components";
import { domainIconPath } from "../domain-icons";
import { MesocycleTarget } from "./MesocycleTarget";
import { ProgressionByDomain } from "./ProgressionByDomain";
import { TemplateEditorModal, emptyTemplate, type TemplateEditorMode } from "./TemplateEditorModal";
import { TemplateNodes } from "./TemplateNodes";
import { WeeklyCalendar } from "./WeeklyCalendar";
import { SessionDetailDrawer } from "./SessionDetailDrawer";
import { Prescription } from "./Prescription";
import { addDays, localDateForTimezone, planPosition } from "./view";

function TemplateBackIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>;
}

function TemplatePlusIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>;
}

function TemplateDomainIcon({ domain }: { domain: TemplateComponentDomain }) {
  return <span className="template-library-icon" data-domain={domain}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{domainIconPath(domain)}</svg></span>;
}

function TemplateCard({ item, onEdit, onRemove }: {
  item: StoredSessionTemplate;
  onEdit: (item: StoredSessionTemplate) => void;
  onRemove: (item: StoredSessionTemplate) => void;
}) {
  const closeMenu = (event: MouseEvent<HTMLButtonElement>) => event.currentTarget.closest("details")?.removeAttribute("open");
  return <article className="card template-library-card">
    <div className="template-library-card-header">
      <TemplateDomainIcon domain={item.domain}/>
      <div className="template-library-heading">
        <div className="template-library-badges"><span className={`template-library-origin${item.origin === "user" ? " mine" : ""}`}>{item.origin === "builtin" ? "Built-in" : "My template"}</span><span className="template-library-domain">{friendlyLabel(item.domain)}</span></div>
        <h2>{item.name}</h2>
        <p>{item.intent}</p>
      </div>
      <details className="template-library-menu">
        <summary aria-label={`More options for ${item.name}`}>•••</summary>
        <div>
          <button type="button" onClick={(event) => { closeMenu(event); onEdit(item); }}>Edit</button>
          <button type="button" className="danger" onClick={(event) => { closeMenu(event); void onRemove(item); }}>Delete</button>
        </div>
      </details>
    </div>
    <TemplateNodes template={item}/>
  </article>;
}

function TemplateLibrary({ onBack, preferredName }: { onBack: () => void; preferredName?: string | null | undefined }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["templates"], queryFn: () => api<StoredSessionTemplate[]>("/api/templates") });
  const taxonomy = useQuery({ queryKey: ["training-taxonomy"], queryFn: () => api<TrainingTaxonomy>("/api/training-taxonomy") });
  const [editing, setEditing] = useState<{ template: SessionTemplate; revision?: number; mode: TemplateEditorMode } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const begin = (value: StoredSessionTemplate | SessionTemplate, mode: TemplateEditorMode) => {
    const template = editableTemplate(value);
    const revision = "origin" in value && value.origin === "user" ? value.revision : undefined;
    setEditing(revision === undefined ? { template, mode } : { template, revision, mode });
    setError(undefined);
  };
  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const payload = editing.template;
      const revision = editing.revision;
      if (!revision) await api("/api/templates", { method: "POST", body: JSON.stringify(payload) });
      else {
        await api(`/api/templates/${encodeURIComponent(payload.id)}`, { method: "PUT", body: JSON.stringify({ template: payload, expectedRevision: revision }) });
      }
      setEditing(null); await client.invalidateQueries({ queryKey: ["templates"] }); await client.invalidateQueries({ queryKey: ["current-plan"] });
    } catch (value) { setError(value); }
    finally { setSaving(false); }
  };
  const remove = async (item: StoredSessionTemplate) => {
    if (!window.confirm(`Delete “${item.name}”? This cannot be undone.`)) return;
    try {
      // Built-ins have no stored revision; deleting one only hides the code-defined original.
      const init = item.origin === "user" ? { method: "DELETE", body: JSON.stringify({ expectedRevision: item.revision }) } : { method: "DELETE" };
      await api(`/api/templates/${encodeURIComponent(item.id)}`, init);
      await client.invalidateQueries({ queryKey: ["templates"] });
    }
    catch (value) { setError(value); }
  };
  return <div className="plan-page template-library">
    <PrimaryPageHeader preferredName={preferredName} subtitle="Reusable workout patterns you can create, edit or delete." actions={<div className="actions"><button type="button" className="secondary template-library-back" onClick={onBack}><TemplateBackIcon/>Back to plan</button><button type="button" className="template-library-create" onClick={() => begin(emptyTemplate(), "create")}><TemplatePlusIcon/>Create template</button></div>}/>
    <ErrorBanner error={query.error ?? (editing ? undefined : error)}/>
    {query.isPending ? <Loading/> : !query.data?.length ? <EmptyState title="No templates yet."/> : <div className="template-library-grid">{query.data.map((item: StoredSessionTemplate) => <TemplateCard key={item.id} item={item} onEdit={(value) => begin(value, "edit")} onRemove={remove}/>)}</div>}
    {editing && <TemplateEditorModal value={{ template: editing.template, mode: editing.mode }} taxonomy={taxonomy.data} error={error ?? taxonomy.error} busy={saving} onChange={(template) => setEditing((current) => current ? { ...current, template } : current)} onClose={() => setEditing(null)} onSave={() => void save()}/>}
  </div>;
}

function CurrentPlanView({ plan, templates, profile }: { plan: CurrentPlan; templates: StoredSessionTemplate[]; profile: AthleteProfile }) {
  const client = useQueryClient();
  // ── P0 orchestration: calendar data, week/phase derivation, selection & scroll (§4) ──
  const today = localDateForTimezone(profile.timezone);
  const durationWeeks = plan.mesocycle.durationWeeks;
  const position = planPosition(plan.effectiveStartDate, today, durationWeeks);
  const storageKey = `athria:plan:${plan.revision}`;
  const calendarQuery = useQuery({
    queryKey: ["calendar", plan.effectiveStartDate, durationWeeks],
    queryFn: () => api<CalendarSession[]>(`/api/plans/calendar?from=${plan.effectiveStartDate}&to=${addDays(plan.effectiveStartDate, durationWeeks * 7 - 1)}`),
  });
  const calendarSessions = calendarQuery.data ?? [];
  const currentWeek = position.weekNumber;
  const currentPhaseNames = plan.mesocycle.domainProgressions.flatMap((progression) => {
    const phase = progression.phases.find((item) => currentWeek >= item.startWeek && currentWeek <= item.endWeek);
    return phase ? [`${friendlyLabel(progression.domain)} · ${phase.name}`] : [];
  });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => sessionStorage.getItem(`${storageKey}:session`));
  const triggerRef = useRef<HTMLElement | null>(null);
  const [scrollToWeek, setScrollToWeek] = useState<number | null>(null);
  const requestWeek = (weekNumber: number) => { setScrollToWeek(null); requestAnimationFrame(() => setScrollToWeek(weekNumber)); };
  const handleSelectSession = (sessionId: string, triggerEl: HTMLElement | null) => { setSelectedSessionId(sessionId); sessionStorage.setItem(`${storageKey}:session`, sessionId); triggerRef.current = triggerEl; };
  const selectedSession = calendarSessions.find((session: CalendarSession) => session.id === selectedSessionId) ?? null;
  const refresh = () => { void client.invalidateQueries({ queryKey: ["calendar"] }); void client.invalidateQueries({ queryKey: ["next-training-day"] }); void client.invalidateQueries({ queryKey: ["current-plan"] }); };
  useEffect(() => {
    const main = document.querySelector("main"); if (!main) return;
    const saved = Number(sessionStorage.getItem(`${storageKey}:scroll`) ?? "0");
    requestAnimationFrame(() => { main.scrollTop = saved; });
    const saveScroll = () => sessionStorage.setItem(`${storageKey}:scroll`, String(main.scrollTop));
    main.addEventListener("scroll", saveScroll, { passive: true });
    return () => { saveScroll(); main.removeEventListener("scroll", saveScroll); };
  }, [storageKey]);
  return <>
    {/* Layer 1 — Mesocycle Target (§5) */}
    <MesocycleTarget plan={plan} today={today} currentWeek={currentWeek} currentPhaseNames={currentPhaseNames} status={position.state === "completed" ? "completed" : position.state === "future" ? "upcoming" : "current"} />
    {/* Layer 2 — domain timelines; selecting a phase scrolls the Weekly Plan, never filters it */}
    <ProgressionByDomain progressions={plan.mesocycle.domainProgressions} currentWeek={currentWeek} onSelectPhase={(_domain, _phaseId, startWeek) => requestWeek(startWeek)} />
    {/* Layer 3 — Weekly Plan (§7) */}
    {calendarQuery.isPending ? <Loading/> : calendarQuery.isError ? <div className="card"><ErrorBanner error={calendarQuery.error}/><button type="button" className="secondary compact" onClick={() => void calendarQuery.refetch()}>Retry calendar</button></div> : <WeeklyCalendar key={storageKey} plan={plan} sessions={calendarSessions} templates={templates} today={today} onSelectSession={handleSelectSession} selectedSessionId={selectedSessionId} scrollToWeek={scrollToWeek} storageKey={storageKey} />}
    {/* Session Detail Drawer — rendered at page level, outside the three-layer shell; PATCH happens inside the drawer (§8) */}
    <SessionDetailDrawer session={selectedSession} templates={templates} plan={plan} today={today} onClose={() => { setSelectedSessionId(null); sessionStorage.removeItem(`${storageKey}:session`); }} onMutated={refresh} returnFocusRef={triggerRef} />
  </>;
}

export function NextTrainingDayCard({ value, plan }: { value: NextTrainingDay | undefined; plan?: CurrentPlan | null }) {
  const client = useQueryClient();
  const day = value?.nextTrainingDay;
  const [error, setError] = useState<unknown>(); const [busy, setBusy] = useState(false);
  const tomorrow = day ? new Date(`${day.scheduledDate}T12:00:00Z`) : null;
  if (tomorrow) tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const [moveDate, setMoveDate] = useState(tomorrow?.toISOString().slice(0, 10) ?? "");
  const [postponeId, setPostponeId] = useState<string | null>(null);
  useEffect(() => { if (!day) return; const date = new Date(`${day.scheduledDate}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); setMoveDate(date.toISOString().slice(0, 10)); setPostponeId(null); }, [day?.occurrenceId, day?.scheduledDate]);
  const refresh = async () => { await Promise.all(["next-training-day", "current-plan", "calendar", "sessions", "summary", "state"].map((key) => client.invalidateQueries({ queryKey: [key] }))); };
  const act = async (id: string, update: Record<string, unknown>) => { setBusy(true); setError(undefined); try { await api(`/api/planned-sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ ...update, expectedRevision: day!.revision }) }); await refresh(); } catch (value) { setError(value); } finally { setBusy(false); } };
  if (!day) return <section className="success next-day-complete"><strong>Plan up to date</strong><span>{value?.reasonCode === "PLAN_ENDED" ? "There are no unfinished training sessions remaining in this mesocycle." : "No upcoming training day is currently available."}</span></section>;
  const isToday = day.scheduledDate === localDateForTimezone(day.timezone);
  const phaseSummary = day.domainPhases.map((phase) => `${friendlyLabel(phase.domain)} ${phase.name}`).join(" / ");
  const planEnd = plan ? addDays(plan.effectiveStartDate, plan.mesocycle.durationWeeks * 7 - 1) : undefined;
  return <section className="mesocycle-card next-training-day">
    <div className="proposal-heading"><div><div><h2>{isToday ? "Today" : "Next Training Day"}</h2><p>{weekdays[day.dayOfWeek]} · {day.scheduledDate} · Week {day.weekNumber}{phaseSummary ? ` · ${phaseSummary}` : ""}</p></div></div></div>
    <ErrorBanner error={error}/>
    <div className="session-list">{day.existingSessions.map((session) => <article className={`session-card ${session.status}`} key={session.id}>
      {session.components.length > 0 ? <div className="next-prescriptions">{session.components.map((component) => <Prescription component={component} variant="detailed" fallbackNotes={session.intent} summary={session.intent} meta={formatDuration(session.durationMinutes)} key={component.id}/>)}</div> : <p className="next-prescription-empty">No structured prescription is available for this session.</p>}
      {session.status === "planned" && <><div className="actions"><button disabled={busy || !isToday} title={!isToday ? "Move this session to the date you completed it first." : undefined} onClick={() => void act(session.id, { action: "complete" })}>✓ Add as completed workout</button><button className="secondary" disabled={busy} onClick={() => void act(session.id, { action: "skip" })}>Skip</button><button className="secondary" disabled={busy} aria-expanded={postponeId === session.id} aria-controls={`postpone-panel-${session.id}`} onClick={() => { if (postponeId === session.id) { setPostponeId(null); return; } const next = new Date(`${day.scheduledDate}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1); setMoveDate(next.toISOString().slice(0, 10)); setPostponeId(session.id); }}>Move</button></div>{!isToday && <small>Move this plan to the date it was completed before adding a completed workout.</small>}{postponeId === session.id && <div className="postpone-panel" id={`postpone-panel-${session.id}`}><label>Move to date<input type="date" min={plan?.effectiveStartDate} max={planEnd} value={moveDate} onChange={(event) => setMoveDate(event.target.value)}/></label><button className="secondary" disabled={busy || !moveDate || moveDate === day.scheduledDate} onClick={() => void act(session.id, { action: "move_occurrence", scheduledDate: moveDate })}>Confirm move</button></div>}</>}
    </article>)}</div></section>;
}

export function PlanEmptyState() {
  return <section className="plan-empty">
    <h2>No current plan</h2>
    <p>Plans are created by your connected AI Agent — not inside Athria.</p>
    <ol className="plan-empty-steps">
      <li><span aria-hidden="true">1</span><div><strong>Connect your AI agent</strong><p>Set up MCP from Help &amp; Support, then enable the Athria server in your agent.</p></div></li>
      <li><span aria-hidden="true">2</span><div><strong>Ask it to build your plan</strong><p>It creates complete Weekly Sessions from your profile, training history and synced workouts.</p></div></li>
      <li><span aria-hidden="true">3</span><div><strong>Review it here</strong><p>Phases, progressions and the weekly calendar open on this page.</p></div></li>
    </ol>
  </section>;
}

export function CurrentPlanPage() {
  const [library, setLibrary] = useState(false);
  const planQuery = useQuery({ queryKey: ["current-plan"], queryFn: () => api<CurrentPlan | null>("/api/plans/current") });
  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: () => api<StoredSessionTemplate[]>("/api/templates") });
  const profileQuery = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile>("/api/profile") });
  const today = profileQuery.data ? localDateForTimezone(profileQuery.data.timezone) : null;
  const nextDay = useQuery({ queryKey: ["next-training-day", today], queryFn: () => api<NextTrainingDay>(`/api/plans/next-training-day?onOrAfterDate=${today}`), enabled: today !== null });
  if (library) return <TemplateLibrary onBack={() => setLibrary(false)} preferredName={profileQuery.data?.preferredName}/>;
  const templates = templatesQuery.data ?? [];
  const loading = planQuery.isPending || templatesQuery.isPending || profileQuery.isPending;
  return <div className="plan-page"><PrimaryPageHeader preferredName={profileQuery.data?.preferredName} subtitle="Your AI-guided training plan — tailored to you, covering every domain." actions={<div className="actions"><button className="secondary plan-templates-button" onClick={() => setLibrary(true)}>View all templates<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button></div>}/><ErrorBanner error={planQuery.error ?? templatesQuery.error ?? profileQuery.error ?? nextDay.error}/>{loading ? <Loading/> : !planQuery.data ? <PlanEmptyState/> : <CurrentPlanView plan={planQuery.data} templates={templates} profile={profileQuery.data!}/>}</div>;
}
