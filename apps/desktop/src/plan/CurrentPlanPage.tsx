import { notify, notifyError, useOperationError } from "../toasts";
import { captureMainScroll } from "../scroll-position";
import { T } from "../i18n";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import {
  editableTemplate, formatDuration, friendlyLabel,
  type AthleteProfile, type CalendarSession, type CurrentPlan, type NextTrainingDay,
  type SessionTemplate, type StoredSessionTemplate, type TemplateComponentDomain, type TrainingTaxonomy,
} from "../view-models";
import { EmptyState, ErrorBanner, Loading, PrimaryPageHeader, localizedWeekdays } from "../components";
import { displayBuiltinTemplate, useLanguage, useT, currentLanguage } from "../i18n";
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
  const t = useT();
  const closeMenu = (event: MouseEvent<HTMLButtonElement>) => event.currentTarget.closest("details")?.removeAttribute("open");
  return <article className="card template-library-card">
    <div className="template-library-card-header">
      <TemplateDomainIcon domain={item.domain}/>
      <div className="template-library-heading">
        <div className="template-library-badges"><span className={`template-library-origin${item.origin === "user" ? " mine" : ""}`}>{t(item.origin === "builtin" ? "Built-in" : "My template")}</span><span className="template-library-domain">{friendlyLabel(item.domain)}</span></div>
        <h2>{item.name}</h2>
        <p>{item.intent}</p>
      </div>
      <details className="template-library-menu">
        <summary aria-label={`${t("More options for")} ${item.name}`}>•••</summary>
        <div>
          <button type="button" onClick={(event) => { closeMenu(event); onEdit(item); }}><T>{"Edit"}</T></button>
          <button type="button" className="danger" onClick={(event) => { closeMenu(event); void onRemove(item); }}><T>{"Delete"}</T></button>
        </div>
      </details>
    </div>
    <TemplateNodes template={item}/>
  </article>;
}

export function TemplateLibrary({ onBack, preferredName }: { onBack: () => void; preferredName?: string | null | undefined }) {
  const { language } = useLanguage();
  const t = useT();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["templates"], queryFn: () => api<StoredSessionTemplate[]>("/api/templates") });
  const taxonomy = useQuery({ queryKey: ["training-taxonomy"], queryFn: () => api<TrainingTaxonomy>("/api/training-taxonomy") });
  const [editing, setEditing] = useState<{ template: SessionTemplate; revision?: number; mode: TemplateEditorMode } | null>(null);
  const [saving, setSaving] = useState(false);
  const [, setError] = useOperationError();
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
    catch (value) { notifyError(value); }
  };
  return <div className="plan-page template-library">
    <PrimaryPageHeader preferredName={preferredName} subtitle="Reusable workout patterns you can create, edit or delete." actions={<div className="actions"><button type="button" className="secondary template-library-back" onClick={onBack}><TemplateBackIcon/><T>{"Back to plan"}</T></button><button type="button" className="template-library-create" onClick={() => begin(emptyTemplate(), "create")}><TemplatePlusIcon/><T>{"Create template"}</T></button></div>}/>
    <ErrorBanner error={query.error}/>
    {query.isPending ? <Loading/> : !query.data?.length ? <EmptyState title={t("No templates yet.")}/> : <div className="template-library-grid">{query.data.map((item: StoredSessionTemplate) => <TemplateCard key={item.id} item={displayBuiltinTemplate(item, language)} onEdit={(value) => begin(value, "edit")} onRemove={remove}/>)}</div>}
    {editing && <TemplateEditorModal value={{ template: editing.template, mode: editing.mode }} taxonomy={taxonomy.data} error={taxonomy.error} busy={saving} onChange={(template) => setEditing((current) => current ? { ...current, template } : current)} onClose={() => setEditing(null)} onSave={() => void save()}/>}
  </div>;
}

function CurrentPlanView({ plan, templates, profile }: { plan: CurrentPlan; templates: StoredSessionTemplate[]; profile: AthleteProfile }) {
  const client = useQueryClient();
  // ── P0 orchestration: calendar data, week/phase derivation, selection & scroll (§4) ──
  const today = localDateForTimezone(profile.timezone);
  const durationWeeks = plan.mesocycle.durationWeeks;
  const position = planPosition(plan.effectiveStartDate, today, durationWeeks);
  const storageKey = `athria:plan:${plan.ownerId}:${plan.effectiveStartDate}:${durationWeeks}`;
  for (const suffix of ["scroll", "weeks", "session"]) {
    if (sessionStorage.getItem(`${storageKey}:${suffix}`) === null) {
      const previous = sessionStorage.getItem(`athria:plan:${plan.revision}:${suffix}`);
      if (previous !== null) {
        sessionStorage.setItem(`${storageKey}:${suffix}`, previous);
        sessionStorage.removeItem(`athria:plan:${plan.revision}:${suffix}`);
      }
    }
  }
  const calendarQuery = useQuery({
    queryKey: ["calendar", plan.effectiveStartDate, durationWeeks],
    queryFn: () => api<CalendarSession[]>(`/api/plans/calendar?from=${plan.effectiveStartDate}&to=${addDays(plan.effectiveStartDate, durationWeeks * 7 - 1)}`),
  });
  const calendarSessions = calendarQuery.data ?? [];
  const currentWeek = position.weekNumber;
  const currentPhases = plan.mesocycle.domainProgressions.flatMap((progression) => {
    const phase = progression.phases.find((item) => currentWeek >= item.startWeek && currentWeek <= item.endWeek);
    return phase ? [{ domain: progression.domain, name: `${friendlyLabel(progression.domain)} · ${phase.name}` }] : [];
  });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => sessionStorage.getItem(`${storageKey}:session`));
  const triggerRef = useRef<HTMLElement | null>(null);
  const [scrollToWeek, setScrollToWeek] = useState<number | null>(null);
  const requestWeek = (weekNumber: number) => { setScrollToWeek(null); requestAnimationFrame(() => setScrollToWeek(weekNumber)); };
  const handleSelectSession = (sessionId: string, triggerEl: HTMLElement | null) => { setSelectedSessionId(sessionId); sessionStorage.setItem(`${storageKey}:session`, sessionId); triggerRef.current = triggerEl; };
  const selectedSession = calendarSessions.find((session: CalendarSession) => session.id === selectedSessionId) ?? null;
  const refresh = async () => { await Promise.all(["calendar", "next-training-day", "current-plan"].map((key) => client.invalidateQueries({ queryKey: [key] }))); };
  useEffect(() => {
    const main = document.querySelector("main"); if (!main) return;
    if (calendarQuery.isPending) return;
    const saved = Number(sessionStorage.getItem(`${storageKey}:scroll`) ?? "0");
    const frame = requestAnimationFrame(() => { main.scrollTop = Math.min(saved, Math.max(0, main.scrollHeight - main.clientHeight)); });
    const saveScroll = () => sessionStorage.setItem(`${storageKey}:scroll`, String(main.scrollTop));
    main.addEventListener("scroll", saveScroll, { passive: true });
    return () => { cancelAnimationFrame(frame); main.removeEventListener("scroll", saveScroll); };
  }, [storageKey, calendarQuery.isPending]);
  return <>
    {/* Layer 1 — Mesocycle Target (§5) */}
    <MesocycleTarget plan={plan} today={today} currentWeek={currentWeek} currentPhases={currentPhases} status={position.state === "completed" ? "completed" : position.state === "future" ? "upcoming" : "current"} />
    {/* Layer 2 — domain timelines; selecting a phase scrolls the Weekly Plan, never filters it */}
    <ProgressionByDomain progressions={plan.mesocycle.domainProgressions} currentWeek={currentWeek} onSelectPhase={(_domain, _phaseId, startWeek) => requestWeek(startWeek)} />
    {/* Layer 3 — Weekly Plan (§7) */}
    {calendarQuery.isPending ? <Loading/> : calendarQuery.isError ? <div className="card"><ErrorBanner error={calendarQuery.error}/><button type="button" className="secondary compact" onClick={() => void calendarQuery.refetch()}><T>{"Retry calendar"}</T></button></div> : <WeeklyCalendar key={storageKey} plan={plan} sessions={calendarSessions} templates={templates} today={today} onSelectSession={handleSelectSession} selectedSessionId={selectedSessionId} scrollToWeek={scrollToWeek} storageKey={storageKey} />}
    {/* Session Detail Drawer — rendered at page level, outside the three-layer shell; PATCH happens inside the drawer (§8) */}
    <SessionDetailDrawer session={selectedSession} templates={templates} plan={plan} today={today} onClose={() => { setSelectedSessionId(null); sessionStorage.removeItem(`${storageKey}:session`); }} onMutated={refresh} returnFocusRef={triggerRef} />
  </>;
}

export function NextTrainingDayCard({ value, plan }: { value: NextTrainingDay | undefined; plan?: CurrentPlan | null }) {
  const t = useT();
  const client = useQueryClient();
  const day = value?.nextTrainingDay;
  const [, setError] = useOperationError(); const [busy, setBusy] = useState(false);
  const [moveDate, setMoveDate] = useState(day?.scheduledDate ?? "");
  const [postponeId, setPostponeId] = useState<string | null>(null);
  useEffect(() => { setMoveDate(day?.scheduledDate ?? ""); setPostponeId(null); }, [day?.occurrenceId, day?.scheduledDate]);
  const refresh = async () => { await Promise.all(["next-training-day", "current-plan", "calendar", "sessions", "summary", "state"].map((key) => client.invalidateQueries({ queryKey: [key] }))); };
  const act = async (id: string, update: Record<string, unknown>) => {
    const restoreScroll = captureMainScroll();
    setBusy(true); setError(undefined);
    try {
      await api(`/api/planned-sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ ...update, expectedRevision: day!.revision }) });
      if (update.action === "move_occurrence") {
        notify(t("Workout moved to {date}.").replace("{date}", String(update.scheduledDate)), "success");
        setPostponeId(null);
      }
      await refresh(); restoreScroll();
    } catch (value) { setError(value); } finally { setBusy(false); }
  };
  if (!day) return <section className="success next-day-complete"><strong><T>{"Plan up to date"}</T></strong><span>{t(value?.reasonCode === "PLAN_ENDED" ? "There are no unfinished training sessions remaining in this mesocycle." : "No upcoming training day is currently available.")}</span></section>;
  const today = localDateForTimezone(day.timezone);
  const isToday = day.scheduledDate === today;
  const phaseSummary = day.domainPhases.map((phase) => phase.name).join(" / ");
  const planEnd = plan ? addDays(plan.effectiveStartDate, plan.mesocycle.durationWeeks * 7 - 1) : undefined;
  const moveOutsidePlan = Boolean(plan && moveDate && (moveDate < plan.effectiveStartDate || (planEnd && moveDate > planEnd)));
  return <section className="mesocycle-card next-training-day">
    <div className="proposal-heading"><div><div><h2>{t(isToday ? "Today" : "Next Training Day")}</h2><p>{localizedWeekdays()[day.dayOfWeek]} · {day.scheduledDate} · {currentLanguage() === "zh-CN" ? `第 ${day.weekNumber} 周` : `Week ${day.weekNumber}`}{phaseSummary ? ` · ${phaseSummary}` : ""}</p></div></div></div>
    <div className="session-list">{day.existingSessions.map((session) => <article className={`session-card ${session.status}`} key={session.id}>
      {session.components.length > 0 ? <div className="next-prescriptions">{session.components.map((component) => <Prescription component={component} sessionDomain={session.domain} variant="detailed" fallbackNotes={session.intent} summary={session.intent} meta={formatDuration(session.durationMinutes)} key={component.id}/>)}</div> : <p className="next-prescription-empty"><T>{"No structured prescription is available for this session."}</T></p>}
      {session.status === "planned" && <><div className="actions"><button className="complete-training-button" disabled={busy || !isToday} title={day.scheduledDate > today ? t("This is a future workout. Move it to your planned date first.") : undefined} onClick={() => void act(session.id, { action: "complete" })}><T>{"Complete"}</T></button><button className="secondary" disabled={busy} onClick={() => void act(session.id, { action: "skip" })}><T>{"Skip"}</T></button><button className="secondary" disabled={busy} aria-expanded={postponeId === session.id} aria-controls={`postpone-panel-${session.id}`} onClick={() => { if (postponeId === session.id) { setPostponeId(null); return; } setMoveDate(day.scheduledDate); setPostponeId(session.id); }}><T>{"Move"}</T></button></div>{postponeId === session.id && <div className="postpone-panel" id={`postpone-panel-${session.id}`}><label><T>{"Move to date"}</T><input type="date" min={plan?.effectiveStartDate} max={planEnd} value={moveDate} onChange={(event) => setMoveDate(event.target.value)}/></label><button className="secondary" disabled={busy || moveOutsidePlan || !moveDate || moveDate === day.scheduledDate} onClick={() => void act(session.id, { action: "move_occurrence", scheduledDate: moveDate })}><T>{"Confirm"}</T></button>{moveOutsidePlan && <small role="alert"><T>{"The workout must stay within this mesocycle."}</T></small>}</div>}</>}
    </article>)}</div></section>;
}

export function PlanEmptyState() {
  return <section className="plan-empty">
    <h2><T>{"No current plan"}</T></h2>
    <p><T>{"Plans are created by your connected AI Agent — not inside Athria."}</T></p>
    <ol className="plan-empty-steps">
      <li><span aria-hidden="true">1</span><div><strong><T>{"Connect your AI agent"}</T></strong><p><T>{"Connect it in Settings under AI Agents, then enable the Athria server in your agent."}</T></p></div></li>
      <li><span aria-hidden="true">2</span><div><strong><T>{"Ask it to build your plan"}</T></strong><p><T>{"It creates complete Weekly Sessions from your profile, training history and synced workouts."}</T></p></div></li>
      <li><span aria-hidden="true">3</span><div><strong><T>{"Review it here"}</T></strong><p><T>{"Phases, progressions and the weekly calendar open on this page."}</T></p></div></li>
    </ol>
  </section>;
}

export function CurrentPlanPage() {
  const { language } = useLanguage();
  const planQuery = useQuery({ queryKey: ["current-plan"], queryFn: () => api<CurrentPlan | null>("/api/plans/current") });
  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: () => api<StoredSessionTemplate[]>("/api/templates") });
  const profileQuery = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile>("/api/profile") });
  const today = profileQuery.data ? localDateForTimezone(profileQuery.data.timezone) : null;
  const nextDay = useQuery({ queryKey: ["next-training-day", today], queryFn: () => api<NextTrainingDay>(`/api/plans/next-training-day?onOrAfterDate=${today}`), enabled: today !== null });
  const templates = (templatesQuery.data ?? []).map((item) => displayBuiltinTemplate(item, language));
  const loading = planQuery.isPending || templatesQuery.isPending || profileQuery.isPending;
  return <div className="plan-page"><PrimaryPageHeader preferredName={profileQuery.data?.preferredName} subtitle="Your AI-guided training plan — tailored to you, covering every domain."/><ErrorBanner error={planQuery.error ?? templatesQuery.error ?? profileQuery.error ?? nextDay.error}/>{loading ? <Loading/> : !planQuery.data ? <PlanEmptyState/> : <CurrentPlanView plan={planQuery.data} templates={templates} profile={profileQuery.data!}/>}</div>;
}
