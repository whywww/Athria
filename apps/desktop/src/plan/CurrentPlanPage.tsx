import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import {
  editableTemplate, formatDuration, friendlyLabel, templateEditorErrors,
  type AthleteProfile, type CalendarSession, type CurrentPlan, type NextTrainingDay,
  type SessionTemplate, type StoredSessionTemplate, type StrengthTemplateSlot, type TemplateBlock, type TemplateComponentDomain, type TrainingTaxonomy,
} from "../view-models";
import { Card, Empty, ErrorBanner, Loading, weekdays } from "../components";
import { MesocycleTarget } from "./MesocycleTarget";
import { ProgressionByDomain } from "./ProgressionByDomain";
import { WeeklyCalendar } from "./WeeklyCalendar";
import { SessionDetailDrawer } from "./SessionDetailDrawer";
import { addDays, localDateForTimezone, planPosition } from "./view";

const componentDomains: TemplateComponentDomain[] = ["strength", "endurance", "sport_skill", "mind_body", "recovery"];
const roles: Record<TemplateComponentDomain, string[]> = { strength: ["primary", "secondary", "accessory", "trunk"], endurance: ["warm_up", "steady", "repeat_work_recovery", "cool_down"], sport_skill: ["preparation", "technical", "tactical", "small_sided_game", "match", "competition", "conditioning", "cool_down"], recovery: ["down_regulation", "mobility", "easy_movement"], mind_body: ["centering", "practice_flow", "breathing", "down_regulation"] };
const emptyTemplate = (domain: TemplateComponentDomain = "strength"): SessionTemplate => {
  const base = { id: crypto.randomUUID(), name: "", intent: "", domain, commonUseCases: [], notes: "" };
  const node = { id: crypto.randomUUID(), name: "", role: roles[domain][0]!, required: true, variables: [{ key: domain === "strength" ? "exercise_selection" : domain === "sport_skill" ? "drill" : domain === "mind_body" ? "technique" : domain === "recovery" ? "movement" : "duration", required: true }] };
  return domain === "strength" ? { ...base, structure: { kind: "strength", slots: [{ ...node, movementPatternIds: [], targetMuscleIds: [], matchPolicy: "any" }] } } : { ...base, structure: { kind: domain, blocks: [node] } } as SessionTemplate;
};
const selectedValues = (event: ChangeEvent<HTMLSelectElement>) => [...event.currentTarget.selectedOptions].map((option) => option.value);

function TemplateEditor({ template, taxonomy, onChange }: { template: SessionTemplate; taxonomy: TrainingTaxonomy; onChange: (value: SessionTemplate) => void }) {
  const nodes = template.structure.kind === "strength" ? template.structure.slots : template.structure.blocks;
  const updateNodes = (next: Array<TemplateBlock | StrengthTemplateSlot>) => onChange(template.structure.kind === "strength" ? { ...template, structure: { kind: "strength", slots: next as StrengthTemplateSlot[] } } : { ...template, structure: { kind: template.structure.kind, blocks: next as TemplateBlock[] } } as SessionTemplate);
  const updateNode = (id: string, patch: Partial<StrengthTemplateSlot>) => updateNodes(nodes.map((item) => item.id === id ? { ...item, ...patch } : item));
  const variableOptions = taxonomy.templateVariables[template.domain] ?? [];
  return <Card title="Template details" className="template-editor">
    <div className="template-basics"><label>Name<input required placeholder="e.g. Lower Strength A" value={template.name} onChange={(event) => onChange({ ...template, name: event.target.value })}/></label><label>Single training domain<select value={template.domain} onChange={(event) => onChange(emptyTemplate(event.target.value as TemplateComponentDomain))}>{componentDomains.map((domain) => <option key={domain} value={domain}>{friendlyLabel(domain)}</option>)}</select></label></div>
    <label>Purpose<textarea rows={2} value={template.intent} onChange={(event) => onChange({ ...template, intent: event.target.value })}/></label><label>Common use cases<input placeholder="Comma-separated" value={template.commonUseCases.join(", ")} onChange={(event) => onChange({ ...template, commonUseCases: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })}/></label><label>Template notes<textarea rows={2} value={template.notes} onChange={(event) => onChange({ ...template, notes: event.target.value })}/></label>
    <div className="component-heading"><div><h3>Stable structure</h3><p>Describe ordered roles and variables, never a concrete workout.</p></div><button type="button" className="secondary compact" onClick={() => { const base = { id: crypto.randomUUID(), name: "", role: roles[template.domain][0]!, required: true, variables: [{ key: variableOptions[0]!, required: true }] }; updateNodes([...nodes, ...(template.domain === "strength" ? [{ ...base, movementPatternIds: [], targetMuscleIds: [], matchPolicy: "any" as const }] : [base])]); }}>+ Add node</button></div>
    <div className="template-components">{nodes.map((node, index) => <section className="template-component-editor" key={node.id}><div className="component-title"><span className={`phase-number tone-${index % 4}`}>{index + 1}</span><label>Node name<input value={node.name} onChange={(event) => updateNode(node.id, { name: event.target.value })}/></label><label>Role<select value={node.role} onChange={(event) => updateNode(node.id, { role: event.target.value })}>{roles[template.domain].map((role) => <option key={role} value={role}>{friendlyLabel(role)}</option>)}</select></label><label><input type="checkbox" checked={node.required} onChange={(event) => updateNode(node.id, { required: event.target.checked })}/> Required</label><button type="button" className="icon-button remove-button" disabled={nodes.length === 1} onClick={() => updateNodes(nodes.filter((item) => item.id !== node.id))}>×</button></div>
      {template.structure.kind === "strength" && <div className="custom-classification"><label>Movement patterns<select multiple value={(node as StrengthTemplateSlot).movementPatternIds} onChange={(event) => updateNode(node.id, { movementPatternIds: selectedValues(event) })}>{taxonomy.strength.movementPatterns.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>Target muscles<select multiple value={(node as StrengthTemplateSlot).targetMuscleIds} onChange={(event) => updateNode(node.id, { targetMuscleIds: selectedValues(event) })}>{taxonomy.strength.muscleGroups.map((item) => <option key={item.id} value={item.id}>{item.parentId ? `  ${item.label}` : item.label}</option>)}</select></label><label>Match policy<select value={(node as StrengthTemplateSlot).matchPolicy} onChange={(event) => updateNode(node.id, { matchPolicy: event.target.value as "any" | "all" })}><option value="any">Any selector</option><option value="all">All selectors</option></select></label></div>}
      <fieldset><legend>Weekly variables</legend><div className="choice-grid">{variableOptions.map((key) => <label key={key}><input type="checkbox" checked={node.variables.some((item) => item.key === key)} onChange={(event) => updateNode(node.id, { variables: event.target.checked ? [...node.variables, { key, required: true }] : node.variables.filter((item) => item.key !== key) })}/>{friendlyLabel(key)}</label>)}</div></fieldset>
    </section>)}</div>
    {templateEditorErrors(template).length > 0 && <div className="editor-errors" role="alert"><strong>Complete these template details</strong><ul>{templateEditorErrors(template).map((message) => <li key={message}>{message}</li>)}</ul></div>}
  </Card>;
}

function TemplateLibrary({ onBack }: { onBack: () => void }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["templates"], queryFn: () => api<StoredSessionTemplate[]>("/api/templates") });
  const taxonomy = useQuery({ queryKey: ["training-taxonomy"], queryFn: () => api<TrainingTaxonomy>("/api/training-taxonomy") });
  const [editing, setEditing] = useState<{ template: SessionTemplate; revision?: number } | null>(null);
  const [error, setError] = useState<unknown>();
  const begin = (value: StoredSessionTemplate | SessionTemplate) => {
    const template = editableTemplate(value);
    const revision = "origin" in value && value.origin === "user" ? value.revision : undefined;
    setEditing(revision === undefined ? { template } : { template, revision });
    setError(undefined);
  };
  const copy = (value: StoredSessionTemplate) => begin({ ...editableTemplate(value), id: crypto.randomUUID(), name: `${value.name} Copy` });
  const save = async () => {
    if (!editing) return;
    try {
      const payload = editing.template;
      const revision = editing.revision;
      if (!revision) await api("/api/templates", { method: "POST", body: JSON.stringify(payload) });
      else {
        await api(`/api/templates/${encodeURIComponent(payload.id)}`, { method: "PUT", body: JSON.stringify({ template: payload, expectedRevision: revision }) });
      }
      setEditing(null); await client.invalidateQueries({ queryKey: ["templates"] }); await client.invalidateQueries({ queryKey: ["current-plan"] });
    } catch (value) { setError(value); }
  };
  const remove = async (item: StoredSessionTemplate & { origin: "user"; revision: number }) => {
    if (!window.confirm(`Delete “${item.name}”? This cannot be undone.`)) return;
    try { await api(`/api/templates/${encodeURIComponent(item.id)}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: item.revision }) }); await client.invalidateQueries({ queryKey: ["templates"] }); }
    catch (value) { setError(value); }
  };
  if (editing) { const errors = templateEditorErrors(editing.template); return <div className="plan-page"><div className="plan-page-header"><div><h1>{editing.revision ? "Edit template" : "Create template"}</h1><p>Define a stable single-domain pattern. Weekly Sessions own every executable dose.</p></div><div className="actions"><button className="secondary" onClick={() => setEditing(null)}>Cancel</button><button disabled={errors.length > 0 || taxonomy.isPending} onClick={() => void save()}>Save template</button></div></div><ErrorBanner error={error ?? taxonomy.error}/>{taxonomy.data ? <TemplateEditor template={editing.template} taxonomy={taxonomy.data} onChange={(template) => setEditing((current) => current ? { ...current, template } : current)}/> : <Loading/>}</div>; }
  return <div className="plan-page"><div className="plan-page-header"><div><button className="text-button" onClick={onBack}>← Back to plan</button><h1>Template Library</h1><p>Stable archetypes only—no exercises, distance, duration or dose.</p></div><button onClick={() => begin(emptyTemplate())}>Create template</button></div><ErrorBanner error={query.error ?? error}/>{query.isPending ? <Loading/> : !query.data?.length ? <Empty>No templates yet.</Empty> : <div className="template-library-grid">{query.data.map((item) => { const count = item.structure.kind === "strength" ? item.structure.slots.length : item.structure.blocks.length; return <article className="card template-library-card" key={item.id}><div><div className="badge">{item.origin === "builtin" ? "Built-in" : "My template"}</div><h2>{item.name}</h2><p>{item.intent}</p><div className="template-summary"><span>{friendlyLabel(item.domain)}</span><span>{count} structure nodes</span></div></div><div className="actions">{item.origin === "builtin" ? <button className="secondary compact" onClick={() => copy(item)}>Copy to my templates</button> : <><button className="secondary compact" onClick={() => begin(item)}>Edit</button><button className="danger compact" onClick={() => void remove(item)}>Delete</button></>}</div></article>; })}</div>}</div>;
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
  const selectedSession = calendarSessions.find((session) => session.id === selectedSessionId) ?? null;
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
    <MesocycleTarget plan={plan} today={today} currentWeek={currentWeek} currentPhaseNames={currentPhaseNames} status={position.state === "completed" ? "completed" : position.state === "future" ? "upcoming" : "current"} storageKey={storageKey} />
    {/* Layer 2 — domain timelines; selecting a phase scrolls the Weekly Plan, never filters it */}
    <ProgressionByDomain progressions={plan.mesocycle.domainProgressions} currentWeek={currentWeek} onSelectPhase={(_domain, _phaseId, startWeek) => requestWeek(startWeek)} />
    {/* Layer 3 — Weekly Plan (§7) */}
    {calendarQuery.isPending ? <Loading/> : calendarQuery.isError ? <div className="card"><ErrorBanner error={calendarQuery.error}/><button type="button" className="secondary compact" onClick={() => void calendarQuery.refetch()}>Retry calendar</button></div> : <WeeklyCalendar key={storageKey} plan={plan} sessions={calendarSessions} templates={templates} today={today} onSelectSession={handleSelectSession} selectedSessionId={selectedSessionId} scrollToWeek={scrollToWeek} storageKey={storageKey} />}
    {/* Session Detail Drawer — rendered at page level, outside the three-layer shell; PATCH happens inside the drawer (§8) */}
    <SessionDetailDrawer session={selectedSession} templates={templates} plan={plan} today={today} onClose={() => { setSelectedSessionId(null); sessionStorage.removeItem(`${storageKey}:session`); }} onMutated={refresh} returnFocusRef={triggerRef} />
  </>;
}

export function NextTrainingDayCard({ value, templates = [], plan }: { value: NextTrainingDay | undefined; templates?: StoredSessionTemplate[]; plan?: CurrentPlan | null }) {
  const client = useQueryClient();
  const day = value?.nextTrainingDay;
  const [error, setError] = useState<unknown>(); const [busy, setBusy] = useState(false);
  const tomorrow = day ? new Date(`${day.scheduledDate}T12:00:00Z`) : null;
  if (tomorrow) tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const [moveDate, setMoveDate] = useState(tomorrow?.toISOString().slice(0, 10) ?? "");
  const [postponeId, setPostponeId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => { if (!day) return; const date = new Date(`${day.scheduledDate}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); setMoveDate(date.toISOString().slice(0, 10)); setPostponeId(null); }, [day?.occurrenceId, day?.scheduledDate]);
  const refresh = async () => { await client.invalidateQueries({ queryKey: ["next-training-day"] }); await client.invalidateQueries({ queryKey: ["current-plan"] }); };
  const act = async (id: string, update: Record<string, unknown>) => { setBusy(true); setError(undefined); try { await api(`/api/planned-sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ ...update, expectedRevision: day!.revision }) }); await refresh(); } catch (value) { setError(value); } finally { setBusy(false); } };
  if (!day) return <section className="success next-day-complete"><strong>Plan up to date</strong><span>{value?.reasonCode === "PLAN_ENDED" ? "There are no unfinished training sessions remaining in this mesocycle." : "No upcoming training day is currently available."}</span></section>;
  const selected = day.existingSessions.find((session) => session.id === detailId);
  const calendarDetail: CalendarSession | null = selected ? { ...selected, revision: day.revision, weekNumber: day.weekNumber, keySession: selected.keySession ?? false, progressionNote: selected.progressionNote ?? null, schedulingRationale: selected.schedulingRationale ?? null } : null;
  const isToday = day.scheduledDate === localDateForTimezone(day.timezone);
  const phaseSummary = day.domainPhases.map((phase) => `${friendlyLabel(phase.domain)} ${phase.name}`).join(" / ");
  return <><section className="mesocycle-card next-training-day"><div className="proposal-heading"><div><span className="proposal-mark" aria-hidden="true">›</span><div><h2>{isToday ? "Today" : "Next Training Day"}</h2><p>{weekdays[day.dayOfWeek]} · {day.scheduledDate} · Week {day.weekNumber}{phaseSummary ? ` · ${phaseSummary}` : ""}</p></div></div></div><ErrorBanner error={error}/><div className="session-list">{day.existingSessions.map((session) => <article className={`session-card ${session.status}`} key={session.id}><div className="session-heading"><div><span className="badge">{friendlyLabel(session.status)}</span><h3>{session.name}</h3></div><span>{formatDuration(session.durationMinutes)}</span></div><p>{session.intent}</p><button type="button" className="secondary compact" onClick={(event) => { detailTrigger.current = event.currentTarget; setDetailId(session.id); }}>Open details</button>{session.status === "planned" && <><div className="actions"><button disabled={busy} onClick={() => void act(session.id, { action: "complete" })}>✓ Complete</button><button className="secondary" disabled={busy} onClick={() => void act(session.id, { action: "skip" })}>Skip</button><button className="secondary" disabled={busy} aria-expanded={postponeId === session.id} aria-controls={`postpone-panel-${session.id}`} onClick={() => { if (postponeId === session.id) { setPostponeId(null); return; } const next = new Date(`${day.scheduledDate}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1); setMoveDate(next.toISOString().slice(0, 10)); setPostponeId(session.id); }}>Postpone</button></div>{postponeId === session.id && <div className="postpone-panel" id={`postpone-panel-${session.id}`}><label>Move this session to {moveDate}<input type="date" min={day.scheduledDate} value={moveDate} onChange={(event) => setMoveDate(event.target.value)}/></label><button className="secondary" disabled={busy || !moveDate || moveDate <= day.scheduledDate} onClick={() => void act(session.id, { action: "move_occurrence", scheduledDate: moveDate })}>Confirm</button></div>}</>}</article>)}</div></section><SessionDetailDrawer session={calendarDetail} templates={templates} plan={plan ?? null} today={localDateForTimezone(day.timezone)} onClose={() => setDetailId(null)} onMutated={() => { setDetailId(null); void refresh(); }} returnFocusRef={detailTrigger}/></>;
}

export function CurrentPlanPage() {
  const [library, setLibrary] = useState(false);
  const planQuery = useQuery({ queryKey: ["current-plan"], queryFn: () => api<CurrentPlan | null>("/api/plans/current") });
  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: () => api<StoredSessionTemplate[]>("/api/templates") });
  const profileQuery = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile>("/api/profile") });
  const today = profileQuery.data ? localDateForTimezone(profileQuery.data.timezone) : null;
  const nextDay = useQuery({ queryKey: ["next-training-day", today], queryFn: () => api<NextTrainingDay>(`/api/plans/next-training-day?onOrAfterDate=${today}`), enabled: today !== null });
  if (library) return <TemplateLibrary onBack={() => setLibrary(false)}/>;
  const templates = templatesQuery.data ?? [];
  const loading = planQuery.isPending || templatesQuery.isPending || profileQuery.isPending;
  return <div className="plan-page"><div className="plan-page-header"><div><h1>Mesocycle Planner</h1><p>Sessions are complete prescriptions; templates are optional provenance.</p></div><div className="actions"><button className="secondary" onClick={() => setLibrary(true)}>View all templates</button></div></div><ErrorBanner error={planQuery.error ?? templatesQuery.error ?? profileQuery.error ?? nextDay.error}/>{loading ? <Loading/> : !planQuery.data ? <div className="card empty-plan"><h2>No current plan</h2><p>Ask your connected AI Agent to create a plan using your profile, training history and complete Weekly Sessions.</p><button type="button" className="secondary" onClick={() => setLibrary(true)}>Browse templates</button></div> : <CurrentPlanView plan={planQuery.data} templates={templates} profile={profileQuery.data!}/>}</div>;
}
